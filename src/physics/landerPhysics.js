import * as THREE from "three";
import { GEAR_HEIGHT } from "../entities/Lander.js";
import {
  LUNAR_GRAVITY,
  LANDER_DRY_MASS,
  ENGINE_MAX_THRUST,
  ENGINE_MIN_THROTTLE,
  ENGINE_EXHAUST_VELOCITY,
  THROTTLE_RATE,
  RCS_ANGULAR_ACCEL,
  RCS_MAX_RATE,
  RCS_DAMPING,
  RCS_TILT_LIMIT,
  RCS_LEVEL_RATE,
  RCS_FLOW_PER_AXIS,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Flight dynamics for the descent.
//
// Translation uses explicit (semi-implicit) Euler integration — v += a*dt,
// then x += v*dt — which is the scheme the project's literature review calls
// out. Cannon-es is used only to detect contacts; it never integrates the
// lander, so all of the motion below is hand-rolled.
//
// Attitude is a quaternion advanced from body-frame angular rates, driven by
// RCS angular acceleration with optional rate damping (the LM's attitude-hold
// autopilot). Mass is not constant: burning propellant lightens the vehicle,
// so acceleration rises through the burn exactly as it did on Apollo.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

// Engine thrust cannot step instantly; the DPS took a few tenths of a second
// to settle after a throttle command.
const THROTTLE_RESPONSE = 6.0; // 1/s

// Lateral translation authority from the RCS (used for fine drift trimming).
const RCS_TRANSLATE_ACCEL = 0.55; // m/s^2

const _up = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _limitQuat = new THREE.Quaternion();
const _omegaWorld = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Local gravitational acceleration at a world position.
 *
 * Real lunar gravity is not uniform: mass concentrations ("mascons") buried
 * under the mare basins measurably strengthen the local field. The anomaly
 * levels model that as a Gaussian bump in g rather than as a time-varying
 * fudge, so the effect is a property of *where* you are.
 */
export function gravityAt(config, x, z) {
  let g = LUNAR_GRAVITY * (config.gravityScale ?? 1);
  const mascons = config.mascons;
  if (mascons) {
    for (const m of mascons) {
      const d = Math.hypot(x - m.x, z - m.z);
      g *= 1 + m.amplitude * Math.exp(-(d * d) / (2 * m.radius * m.radius));
    }
  }
  return g;
}

/**
 * Net lateral acceleration from volatile outgassing vents.
 *
 * There is no wind on the Moon, so the "gusts" the project spec calls for are
 * modelled as transient gas jets from subsurface volatile pockets: each vent
 * pushes radially outward and upward, pulsing over time.
 */
export function ventAccelAt(config, x, y, z, elapsed, target = new THREE.Vector3()) {
  target.set(0, 0, 0);
  if (!config.vents) return target;

  for (const v of config.vents) {
    const dx = x - v.x;
    const dz = z - v.z;
    const dist = Math.hypot(dx, dz);
    if (dist > v.radius * 3) continue;

    // Pulsing duty cycle, each vent with its own phase.
    const pulse = Math.max(0, Math.sin(elapsed * v.rate + (v.phase ?? 0)));
    if (pulse <= 0) continue;

    // Falls off with horizontal distance and with height above the vent.
    const falloff = Math.exp(-(dist * dist) / (2 * v.radius * v.radius));
    const heightFalloff = Math.exp(-Math.max(0, y - v.y) / (v.reach ?? 120));
    const mag = v.strength * pulse * falloff * heightFalloff;

    if (dist > 0.001) {
      target.x += (dx / dist) * mag * 0.75;
      target.z += (dz / dist) * mag * 0.75;
    }
    target.y += mag * 0.5;
  }
  return target;
}

/**
 * Advances the lander one step.
 *
 * @param {Lander} lander
 * @param {object} config active level config
 * @param {object} controls normalised control demands from Input
 * @param {number} dt seconds
 * @param {number} elapsed mission elapsed time, seconds
 * @returns {object} diagnostics for the HUD/FX layers
 */
export function stepLanderPhysics(lander, config, controls, dt, elapsed) {
  const s = lander.state;

  if (s.landed || s.crashed) {
    s.throttle = 0;
    s.engineOn = false;
    s.rcsFiring.set(0, 0, 0);
    lander.syncTransform();
    return { gravity: gravityAt(config, s.position.x, s.position.z), thrustAccel: 0 };
  }

  // -----------------------------------------------------------------------
  // Throttle command
  // -----------------------------------------------------------------------
  if (controls.throttleCut) s.commandedThrottle = 0;
  if (controls.throttleFull) s.commandedThrottle = 1;
  s.commandedThrottle += (controls.throttleUp - controls.throttleDown) * THROTTLE_RATE * dt;
  s.commandedThrottle = THREE.MathUtils.clamp(s.commandedThrottle, 0, 1);

  // The momentary "burn" key overrides the throttle setting while held, which
  // keeps the vehicle flyable without constantly nursing the throttle.
  const demanded = controls.burn ? 1 : s.commandedThrottle;

  // Engine only lights above its minimum throttle and only with propellant.
  const hasFuel = s.fuel > 0;
  const wantEngine = hasFuel && demanded >= ENGINE_MIN_THROTTLE;
  const targetThrottle = wantEngine ? demanded : 0;

  // First-order engine response lag.
  s.throttle += (targetThrottle - s.throttle) * (1 - Math.exp(-THROTTLE_RESPONSE * dt));
  if (s.throttle < 0.005) s.throttle = 0;
  s.engineOn = s.throttle > 0.01;

  // -----------------------------------------------------------------------
  // Propellant and mass
  // -----------------------------------------------------------------------
  if (s.engineOn) {
    // Mass flow = thrust / effective exhaust velocity (rocket equation form).
    const flow = (ENGINE_MAX_THRUST * s.throttle) / ENGINE_EXHAUST_VELOCITY;
    s.fuel = Math.max(0, s.fuel - flow * dt);
  }

  // -----------------------------------------------------------------------
  // Attitude: RCS torque, damping, rate limit, quaternion integration
  // -----------------------------------------------------------------------
  const cmdPitch = controls.pitch;
  const cmdYaw = controls.yaw;
  const cmdRoll = controls.roll;
  const rcsActive = Math.abs(cmdPitch) + Math.abs(cmdYaw) + Math.abs(cmdRoll) > 0.001;
  const rcsAvailable = s.rcsFuel > 0;

  const alpha = RCS_ANGULAR_ACCEL * DEG; // rad/s^2
  const w = s.angularVelocity;

  if (rcsAvailable) {
    w.x += cmdPitch * alpha * dt;
    w.y += cmdYaw * alpha * dt;
    w.z += cmdRoll * alpha * dt;
  }

  // Attitude-hold: bleed off residual rates on any axis with no command.
  if (s.stabiliser && rcsAvailable) {
    const damp = 1 - Math.exp(-RCS_DAMPING * dt);
    if (Math.abs(cmdPitch) < 0.001) w.x -= w.x * damp;
    if (Math.abs(cmdYaw) < 0.001) w.y -= w.y * damp;
    if (Math.abs(cmdRoll) < 0.001) w.z -= w.z * damp;
  }

  const maxRate = RCS_MAX_RATE * DEG;
  w.x = THREE.MathUtils.clamp(w.x, -maxRate, maxRate);
  w.y = THREE.MathUtils.clamp(w.y, -maxRate, maxRate);
  w.z = THREE.MathUtils.clamp(w.z, -maxRate, maxRate);

  // Body-frame rate integration: q' = q * (1, 0.5*omega*dt), renormalised.
  _dq.set(w.x * 0.5 * dt, w.y * 0.5 * dt, w.z * 0.5 * dt, 1);
  s.quaternion.multiply(_dq).normalize();

  // Attitude hold: cap the lean, and fly back to vertical when the player
  // lets go. Without the cap, holding a steering input rotates the vehicle
  // until the engine points downward, which is unrecoverable; without the
  // levelling, every correction leaves the vehicle permanently leaning and
  // thrusting sideways.
  if (s.stabiliser) {
    lander.upVector(_up);
    const tilt = Math.acos(THREE.MathUtils.clamp(_up.y, -1, 1));
    const limit = RCS_TILT_LIMIT * DEG;
    const steering = Math.abs(cmdPitch) > 0.001 || Math.abs(cmdRoll) > 0.001;

    // How far to rotate back toward vertical this step.
    let correction = 0;
    if (tilt > limit) correction = tilt - limit;
    if (!steering && rcsAvailable) {
      correction = Math.max(correction, Math.min(tilt, RCS_LEVEL_RATE * DEG * dt));
    }

    if (correction > 1e-6) {
      // Rotate about the axis that takes the vehicle's up vector to world up.
      _tmp.crossVectors(_up, WORLD_UP);
      if (_tmp.lengthSq() > 1e-8) {
        _tmp.normalize();
        _limitQuat.setFromAxisAngle(_tmp, correction);
        s.quaternion.premultiply(_limitQuat).normalize();
      }
      // Bleed the rate driving it past the stop so it rests on the limit
      // rather than grinding against it.
      if (tilt > limit) w.multiplyScalar(Math.exp(-8 * dt));
    }
  }

  s.rcsFiring.set(cmdPitch, cmdYaw, cmdRoll);

  // -----------------------------------------------------------------------
  // Translation
  // -----------------------------------------------------------------------
  const gravity = gravityAt(config, s.position.x, s.position.z);
  s.mass = LANDER_DRY_MASS + s.fuel + s.rcsFuel;

  // a = F/m along the vehicle's thrust axis. Mass shrinks as propellant
  // burns, so the same throttle produces more acceleration over time.
  const thrustAccel = s.engineOn ? (ENGINE_MAX_THRUST * s.throttle) / s.mass : 0;

  lander.upVector(_up);
  _accel.copy(_up).multiplyScalar(thrustAccel);
  _accel.y -= gravity;

  // RCS translation jets for fine drift control, in the vehicle's frame.
  let rcsTranslating = false;
  if (rcsAvailable && (controls.translateX || controls.translateZ)) {
    rcsTranslating = true;
    _tmp.set(controls.translateX, 0, controls.translateZ)
      .normalize()
      .applyQuaternion(s.quaternion)
      .multiplyScalar(RCS_TRANSLATE_ACCEL);
    _accel.add(_tmp);
  }

  // Environmental vent jets.
  const vent = ventAccelAt(config, s.position.x, s.position.y, s.position.z, elapsed, _tmp);
  _accel.add(vent);

  // RCS propellant burn.
  if ((rcsActive || rcsTranslating) && rcsAvailable) {
    const axes =
      Math.abs(cmdPitch) + Math.abs(cmdYaw) + Math.abs(cmdRoll) + (rcsTranslating ? 1 : 0);
    s.rcsFuel = Math.max(0, s.rcsFuel - RCS_FLOW_PER_AXIS * axes * dt);
  }

  // --- Explicit Euler step ------------------------------------------------
  s.velocity.addScaledVector(_accel, dt);
  s.position.addScaledVector(s.velocity, dt);

  // World-frame angular rate, handy for the HUD rate needles.
  _omegaWorld.copy(w).applyQuaternion(s.quaternion);

  lander.syncTransform();

  return {
    gravity,
    thrustAccel,
    ventAccel: vent.length(),
    angularRateDeg: _omegaWorld.length() / DEG,
  };
}

/** Speeds the HUD and landing checks care about. */
export function flightData(lander, terrain) {
  const s = lander.state;
  const surface = terrain.surfaceHeightAt(s.position.x, s.position.z);
  const horizontal = Math.hypot(s.velocity.x, s.velocity.z);

  // Drift relative to the landing surface. Over a traversing deck this is
  // what the gear actually experiences, and it is what the crew would fly.
  const padVel = terrain.movingPad ? terrain.padVelocity : null;
  const relativeHorizontal = padVel
    ? Math.hypot(s.velocity.x - padVel.x, s.velocity.z - padVel.z)
    : horizontal;

  return {
    relativeHorizontalSpeed: relativeHorizontal,
    surfaceMoving: Boolean(padVel),
    altitude: Math.max(0, s.position.y - surface),
    // Radar altimeter reads to the footpads, not to the vehicle's origin —
    // which is what the crew actually needed on final descent.
    gearAltitude: Math.max(0, s.position.y - GEAR_HEIGHT - surface),
    verticalSpeed: s.velocity.y,
    horizontalSpeed: horizontal,
    speed: s.velocity.length(),
    tilt: lander.tiltDegrees(),
    surfaceHeight: surface,
  };
}
