import * as THREE from "three";
import { EARTH_GRAVITY } from "../constants.js";
import {
  ASCENT_MISSION,
  programmedPitch,
  airDensity,
  pressureRatio,
} from "../levels/ascentConfig.js";

// ---------------------------------------------------------------------------
// Phase 2 — ascent dynamics.
//
// Same integration philosophy as the descent: explicit (semi-implicit) Euler,
// hand-rolled, no physics-engine force model. What is added here is what
// actually matters when leaving a planet with an atmosphere:
//
//   * thrust that varies with ambient pressure (sea-level vs vacuum rating)
//   * mass that falls as propellant burns, so acceleration climbs through
//     the burn until staging resets it
//   * aerodynamic drag against an exponential atmosphere, which produces a
//     real max-Q around 13 km
//   * a scripted gravity-turn pitch schedule the player biases, rather than a
//     guidance law — this is the simplification the project brief asks for
//
// There is deliberately NO orbital mechanics: gravity is a constant downward
// 9.81 m/s^2 with a mild altitude falloff, "orbit" is a threshold check on
// altitude and horizontal speed, and nothing here integrates a trajectory
// around a central body.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

// Earth's radius, used only to soften gravity with altitude so the upper
// stages don't feel unrealistically heavy. Not an orbital model.
const EARTH_RADIUS = 6371000; // m

// Drag coefficient of a slender launch vehicle, roughly constant subsonic,
// spiking transonic. A simple Mach-dependent curve is enough to put the drag
// peak in the right place.
const BASE_DRAG_COEFFICIENT = 0.32;

// Speed of sound at sea level; used only to shape the transonic drag rise.
const SPEED_OF_SOUND = 340; // m/s

// How fast the vehicle's actual pitch chases the commanded pitch. A real
// vehicle cannot snap its attitude around; this is the gimbal response.
const PITCH_TRACKING_RATE = 1.6; // 1/s

// How fast W/S (or the autopilot) move the pitch bias, degrees per second.
const BIAS_RATE = 22;

const _thrustDir = new THREE.Vector3();
const _dragDir = new THREE.Vector3();
const _accel = new THREE.Vector3();

/** Gravitational acceleration at altitude (inverse-square falloff). */
export function gravityAtAltitude(altitude) {
  const r = EARTH_RADIUS / (EARTH_RADIUS + Math.max(0, altitude));
  return EARTH_GRAVITY * r * r;
}

/** Mach-dependent drag coefficient: subsonic plateau, transonic rise, decay. */
export function dragCoefficient(mach) {
  if (mach < 0.8) return BASE_DRAG_COEFFICIENT;
  if (mach < 1.2) {
    // Transonic drag rise.
    const t = (mach - 0.8) / 0.4;
    return BASE_DRAG_COEFFICIENT * (1 + t * 1.6);
  }
  // Supersonic decay back toward a lower plateau.
  return BASE_DRAG_COEFFICIENT * (1 + 1.6 * Math.exp(-(mach - 1.2) * 0.7));
}

/**
 * Creates the mutable flight state for a launch.
 */
export function createAscentState(mission = ASCENT_MISSION) {
  const stages = mission.stages.map((s) => ({
    config: s,
    propellant: s.propellant,
    dryMass: s.dryMass,
  }));

  return {
    // Downrange (x) / altitude (y) plane. The ascent is flown in a single
    // vertical plane, which is how a launch azimuth actually works.
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, 0),

    stages,
    stageIndex: 0,
    separatedStages: [],

    // Pitch from the horizon, degrees. Starts vertical on the pad.
    pitch: 90,
    commandedPitch: 90,
    pitchBias: 0,
    // Highest altitude reached, which the pitch schedule is keyed on.
    programAltitude: 0,

    throttle: 0,
    commandedThrottle: 1,

    mass: 0,
    thrust: 0,
    acceleration: 0,
    dynamicPressure: 0,
    mach: 0,
    angleOfAttack: 0,
    drag: 0,

    ignited: false,
    liftedOff: false,
    // Set when the count reaches zero; until then the hold-downs retain the
    // vehicle no matter how much thrust the engines are making.
    holdDownArmed: false,
    holdDownRelease: false,
    engineOn: false,
    failed: false,
    inserted: false,

    missionTime: 0,
  };
}

/** Total current vehicle mass: remaining stages + payload. */
export function vehicleMass(state, mission = ASCENT_MISSION) {
  let m = mission.payloadMass;
  for (let i = state.stageIndex; i < state.stages.length; i++) {
    m += state.stages[i].dryMass + state.stages[i].propellant;
  }
  return m;
}

/** The stage currently burning, or null once everything is spent. */
export function activeStage(state) {
  return state.stages[state.stageIndex] ?? null;
}

/**
 * Reference area for drag: the widest remaining stage. Once the big first
 * stage is gone the vehicle is much slimmer.
 */
function referenceArea(state) {
  const stage = activeStage(state);
  const d = stage ? stage.config.diameter : 6.6;
  return Math.PI * (d / 2) * (d / 2);
}

/**
 * Advances the launch vehicle one step.
 *
 * @param {object} state from createAscentState
 * @param {object} controls { throttleUp, throttleDown, pitchUp, pitchDown, burn }
 * @param {number} dt seconds
 * @param {object} mission
 * @returns {object} derived telemetry for the HUD
 */
export function stepRocketPhysics(state, controls, dt, mission = ASCENT_MISSION) {
  const altitude = state.position.y;
  const stage = activeStage(state);

  // -----------------------------------------------------------------------
  // Throttle
  // -----------------------------------------------------------------------
  if (stage) {
    state.commandedThrottle += (controls.throttleUp - controls.throttleDown) * 0.8 * dt;
    state.commandedThrottle = THREE.MathUtils.clamp(
      state.commandedThrottle,
      stage.config.minThrottle,
      1
    );
  }

  const hasPropellant = stage && stage.propellant > 0;
  const wantEngine = state.ignited && hasPropellant && !state.failed;
  const targetThrottle = wantEngine ? state.commandedThrottle : 0;
  // Engines spool rather than step.
  state.throttle += (targetThrottle - state.throttle) * (1 - Math.exp(-5 * dt));
  if (state.throttle < 0.004) state.throttle = 0;
  state.engineOn = state.throttle > 0.01 && hasPropellant;

  // -----------------------------------------------------------------------
  // Thrust, scaled between the sea-level and vacuum ratings by ambient
  // pressure — a bell optimised for vacuum is choked down low in the
  // atmosphere, which is why the S-IC gains thrust as it climbs.
  // -----------------------------------------------------------------------
  const pRatio = pressureRatio(altitude);
  let thrust = 0;
  if (state.engineOn && stage) {
    const c = stage.config;
    thrust =
      (c.thrustSeaLevel * pRatio + c.thrustVacuum * (1 - pRatio)) * state.throttle;
    const isp = c.ispSeaLevel * pRatio + c.ispVacuum * (1 - pRatio);
    // Mass flow from the rocket equation: mdot = F / (Isp * g0).
    const flow = thrust / (isp * 9.80665);
    stage.propellant = Math.max(0, stage.propellant - flow * dt);
    if (stage.propellant <= 0) state.engineOn = false;
  }
  state.thrust = thrust;

  const mass = vehicleMass(state, mission);
  state.mass = mass;

  // -----------------------------------------------------------------------
  // Attitude: scripted gravity turn plus the player's bias
  // -----------------------------------------------------------------------
  const authority = mission.pitchAuthority;
  const manualPitch = controls.pitchUp - controls.pitchDown;
  if (Math.abs(manualPitch) < 1e-3 && controls.autoBias !== undefined) {
    // Autopilot: move the bias toward the flight director's value at the same
    // rate a held key would. The player always overrides by pressing W/S.
    const step = BIAS_RATE * dt;
    state.pitchBias += THREE.MathUtils.clamp(controls.autoBias - state.pitchBias, -step, step);
  } else {
    state.pitchBias += manualPitch * BIAS_RATE * dt;
  }
  state.pitchBias = THREE.MathUtils.clamp(state.pitchBias, -authority, authority);

  // The program is keyed on the highest altitude reached, not the current
  // one. Keying it on raw altitude makes it run *backwards* if the vehicle
  // ever sinks — commanding the nose back up while the velocity vector points
  // down, which is a guaranteed loss-of-vehicle angle of attack. Ratcheting
  // keeps it a monotonic altitude schedule, as a real pitch program is.
  state.programAltitude = Math.max(state.programAltitude ?? 0, altitude);
  const scheduled = programmedPitch(state.programAltitude);
  // Hold vertical until the tower is cleared, whatever the program says.
  const commanded =
    altitude < mission.verticalRiseAltitude ? 90 : scheduled + state.pitchBias;
  state.commandedPitch = THREE.MathUtils.clamp(commanded, -10, 90);

  if (state.liftedOff) {
    state.pitch += (state.commandedPitch - state.pitch) * (1 - Math.exp(-PITCH_TRACKING_RATE * dt));
  } else {
    state.pitch = 90;
  }

  // -----------------------------------------------------------------------
  // Forces
  // -----------------------------------------------------------------------
  const speed = state.velocity.length();
  const rho = airDensity(altitude);
  state.mach = speed / SPEED_OF_SOUND;

  // Dynamic pressure q = 0.5 * rho * v^2. Peaks around 13 km on this profile.
  const q = 0.5 * rho * speed * speed;
  state.dynamicPressure = q;

  // Angle of attack: how far the vehicle points away from where it is going.
  // Meaningless at rest and irrelevant in vacuum, but structurally critical
  // in between.
  const pitchRad = state.pitch * DEG;
  _thrustDir.set(Math.cos(pitchRad), Math.sin(pitchRad), 0);
  if (speed > 12) {
    const vDir = _dragDir.copy(state.velocity).normalize();
    const cosA = THREE.MathUtils.clamp(vDir.dot(_thrustDir), -1, 1);
    state.angleOfAttack = Math.acos(cosA) / DEG;
  } else {
    state.angleOfAttack = 0;
  }

  const drag = q * dragCoefficient(state.mach) * referenceArea(state);
  state.drag = drag;

  const gravity = gravityAtAltitude(altitude);

  // Effective gravity is reduced by the vehicle's own horizontal motion over
  // a curved surface: a_c = v_h^2 / (R + h).
  //
  // This is deliberately the *only* concession to the planet being round. It
  // is not an orbital model — nothing here integrates a trajectory around a
  // central body, and the insertion test remains a threshold check. But
  // without this term a gravity turn cannot physically close: the vehicle
  // would need thrust to hold itself up no matter how fast it were going, so
  // "orbit" would be unreachable rather than merely difficult. With it, the
  // vehicle becomes self-supporting exactly at orbital velocity, which is
  // what makes the pitch program behave the way a real ascent does.
  const radius = EARTH_RADIUS + Math.max(0, altitude);
  const centrifugalRelief = (state.velocity.x * state.velocity.x) / radius;
  state.centrifugalRelief = centrifugalRelief;

  // a = (thrust - drag) / m - (g - a_c)
  _accel.copy(_thrustDir).multiplyScalar(thrust / mass);
  if (speed > 0.01) {
    _dragDir.copy(state.velocity).normalize().multiplyScalar(-drag / mass);
    _accel.add(_dragDir);
  }
  _accel.y -= gravity - centrifugalRelief;

  // -----------------------------------------------------------------------
  // Hold-downs.
  //
  // The vehicle is clamped to the launcher until BOTH conditions are met:
  // the count has reached zero (holdDownArmed), and thrust has actually built
  // past the vehicle's weight. That is why a Saturn V sits on the pad at full
  // power for several seconds after ignition before it moves.
  // -----------------------------------------------------------------------
  if (!state.liftedOff) {
    if (state.holdDownArmed && thrust > mass * gravity * 1.02) {
      state.liftedOff = true;
      state.holdDownRelease = true;
    } else {
      state.velocity.set(0, 0, 0);
      // Sensed acceleration on the pad is 1 g, straight up through the seat.
      state.acceleration = 1;
      return buildTelemetry(state, mission, gravity, q, 0, 0);
    }
  }

  // -----------------------------------------------------------------------
  // Explicit Euler step
  // -----------------------------------------------------------------------
  state.velocity.addScaledVector(_accel, dt);
  state.position.addScaledVector(state.velocity, dt);

  if (state.position.y < 0) {
    state.position.y = 0;
    state.velocity.set(0, 0, 0);
  }

  // Sensed acceleration (what the crew and the structure feel): thrust and
  // drag only — free-fall gravity is not sensed.
  const sensed = Math.hypot(
    (thrust * Math.cos(pitchRad) - (speed > 0.01 ? (drag * state.velocity.x) / speed : 0)) / mass,
    (thrust * Math.sin(pitchRad) - (speed > 0.01 ? (drag * state.velocity.y) / speed : 0)) / mass
  );
  state.acceleration = sensed / EARTH_GRAVITY;

  state.missionTime += dt;

  return buildTelemetry(state, mission, gravity, q, drag, centrifugalRelief);
}

function buildTelemetry(state, mission, gravity, q, drag, centrifugalRelief = 0) {
  const speed = state.velocity.length();
  const horizontal = Math.abs(state.velocity.x);
  const vertical = state.velocity.y;
  const stage = activeStage(state);

  // Flight path angle: the direction the vehicle is actually travelling,
  // which is what insertion is judged on — not where the nose points.
  const flightPathAngle = speed > 5 ? Math.atan2(vertical, horizontal) / DEG : 90;

  return {
    altitude: state.position.y,
    downrange: state.position.x,
    speed,
    horizontalSpeed: horizontal,
    verticalSpeed: vertical,
    flightPathAngle,
    pitch: state.pitch,
    commandedPitch: state.commandedPitch,
    angleOfAttack: state.angleOfAttack,
    dynamicPressure: q,
    mach: state.mach,
    drag,
    gravity,
    // What the vehicle actually fights: gravity less the relief its own
    // horizontal speed provides. Reaches zero at orbital velocity.
    effectiveGravity: Math.max(0, gravity - centrifugalRelief),
    centrifugalRelief,
    mass: state.mass,
    thrust: state.thrust,
    throttle: state.throttle,
    acceleration: state.acceleration,
    twr: state.mass > 0 ? state.thrust / (state.mass * gravity) : 0,
    stageName: stage ? stage.config.name : "—",
    stageIndex: state.stageIndex,
    stagePropellant: stage ? stage.propellant : 0,
    stagePropellantFraction: stage ? stage.propellant / stage.config.propellant : 0,
    inAtmosphere: state.position.y < mission.atmosphere.karmanLine,
  };
}

/**
 * Jettisons the burning stage. Returns the separated stage's descriptor so
 * the renderer can spawn a falling husk, or null if there is nothing to drop.
 */
export function separateStage(state) {
  const stage = activeStage(state);
  if (!stage) return null;
  if (state.stageIndex >= state.stages.length - 1) return null;

  state.stageIndex += 1;
  state.throttle = 0;
  state.engineOn = false;
  // Newly lit stage starts at full throttle, as the real sequence did.
  state.commandedThrottle = 1;

  const husk = {
    config: stage.config,
    position: state.position.clone(),
    velocity: state.velocity.clone(),
    pitch: state.pitch,
    age: 0,
  };
  state.separatedStages.push(husk);
  return husk;
}

/**
 * Checks the flight against the mission's structural and crew limits.
 * Returns a failure description, or null if everything is inside limits.
 */
export function checkLimits(state, telemetry, mission = ASCENT_MISSION) {
  const L = mission.limits;

  if (telemetry.dynamicPressure > L.maxDynamicPressure) {
    return {
      kind: "maxQ",
      reason: `Dynamic pressure reached ${(telemetry.dynamicPressure / 1000).toFixed(1)} kPa, past the ${(L.maxDynamicPressure / 1000).toFixed(0)} kPa structural limit — the vehicle broke up.`,
    };
  }

  if (
    telemetry.dynamicPressure > L.angleOfAttackQThreshold &&
    telemetry.angleOfAttack > L.maxAngleOfAttack
  ) {
    return {
      kind: "aoa",
      reason: `Angle of attack hit ${telemetry.angleOfAttack.toFixed(0)}° in dense air — aerodynamic loads tore the interstage apart.`,
    };
  }

  if (telemetry.acceleration > L.maxAcceleration) {
    return {
      kind: "gLoad",
      reason: `Acceleration reached ${telemetry.acceleration.toFixed(1)} g, beyond the ${L.maxAcceleration.toFixed(1)} g limit.`,
    };
  }

  return null;
}

/**
 * Orbit insertion check.
 *
 * Deliberately a threshold test on altitude, horizontal speed and flight path
 * angle rather than an orbit determination — the project brief rules out real
 * orbital mechanics. Passing it means the parking orbit is good enough to
 * hand off to the trans-lunar burn.
 */
export function evaluateInsertion(telemetry, mission = ASCENT_MISSION) {
  const o = mission.orbit;
  const checks = {
    altitude: {
      label: "Insertion altitude",
      value: telemetry.altitude,
      band: o.altitudeBand,
      pass: telemetry.altitude >= o.altitudeBand[0] && telemetry.altitude <= o.altitudeBand[1],
      format: (v) => `${(v / 1000).toFixed(1)} km`,
      bandFormat: (b) => `${(b[0] / 1000).toFixed(0)}–${(b[1] / 1000).toFixed(0)} km`,
    },
    speed: {
      label: "Horizontal velocity",
      value: telemetry.horizontalSpeed,
      band: o.speedBand,
      pass:
        telemetry.horizontalSpeed >= o.speedBand[0] &&
        telemetry.horizontalSpeed <= o.speedBand[1],
      format: (v) => `${v.toFixed(0)} m/s`,
      bandFormat: (b) => `${b[0]}–${b[1]} m/s`,
    },
    flightPath: {
      label: "Flight path angle",
      value: Math.abs(telemetry.flightPathAngle),
      band: [0, o.maxFlightPathAngle],
      pass: Math.abs(telemetry.flightPathAngle) <= o.maxFlightPathAngle,
      format: (v) => `${v.toFixed(1)}°`,
      bandFormat: (b) => `≤ ${b[1]}°`,
    },
  };

  const passed = Object.values(checks).every((c) => c.pass);
  return { passed, checks };
}

/**
 * How close the vehicle is to a valid insertion, 0..1 — drives the HUD's
 * insertion cue so the player can see the window approaching.
 */
export function insertionReadiness(telemetry, mission = ASCENT_MISSION) {
  const o = mission.orbit;
  const alt = THREE.MathUtils.clamp(telemetry.altitude / o.altitudeBand[0], 0, 1);
  const spd = THREE.MathUtils.clamp(telemetry.horizontalSpeed / o.speedBand[0], 0, 1);
  return Math.min(alt, spd);
}
