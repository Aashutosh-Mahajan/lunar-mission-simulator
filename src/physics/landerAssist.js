import * as THREE from "three";
import { ENGINE_MAX_THRUST, ENGINE_MIN_THROTTLE, ASSIST } from "../constants.js";

// ---------------------------------------------------------------------------
// Flight-control assists for the descent.
//
// The real LM's digital autopilot could fly the whole approach, hold attitude
// while the crew flew, or hold a commanded descent rate while the commander
// steered with the hand controller (program P66, used for every actual
// landing). The assists here are modelled on those modes. They never touch the
// physics: they take the player's inputs and turn them into the same two
// things a pilot controls — a throttle setting and an attitude — which the
// physics then flies exactly as it would a human's commands.
//
// Every mode works the same way underneath, thrust-vector guidance:
//
//   1. Work out the acceleration the vehicle needs: a horizontal part that
//      drives the drift toward a target velocity, and a vertical part that
//      drives the sink rate toward a target rate while cancelling gravity.
//   2. Point the thrust axis along that acceleration (tilt, capped).
//   3. Throttle to the magnitude needed to supply its vertical component.
//
//   full   — throttle and attitude both automatic. W A S D pick a direction
//            of travel relative to the camera; letting go stops the drift.
//   drift  — throttle stays manual. Attitude is manual while steering, but on
//            release the vehicle leans to null its own drift instead of just
//            standing upright, so a correction does not have to be undone.
//   none   — direct control.
//
// Descent-rate hold (G) can be switched on in any mode; in 'full' it is
// always on.
// ---------------------------------------------------------------------------

const _accel = new THREE.Vector3();
const _up = new THREE.Vector3();
const _targetUp = new THREE.Vector3();

/**
 * Sink rate to aim for at a given height above the footpads, m/s (positive
 * down). Roughly the LM's own approach: brisk up high, about 1 m/s at contact.
 */
export function scheduledSinkRate(gearAltitude) {
  return THREE.MathUtils.clamp(
    ASSIST.SINK_RATE_MIN + gearAltitude * ASSIST.SINK_RATE_PER_METRE,
    ASSIST.SINK_RATE_MIN,
    ASSIST.SINK_RATE_MAX
  );
}

export default class LanderAssist {
  /** @param {'full'|'drift'|'none'} mode */
  constructor(mode = "none") {
    this.mode = mode;
    // Descent-rate hold, toggled with G. Always on in 'full'.
    this.rateHold = mode === "full";
    // Set by autoplay: fly as full assist regardless of `mode`.
    this.autopilot = false;
    // Last targets, exposed for the HUD.
    this.targetSinkRate = 0;
    this.targetVelocity = new THREE.Vector3();
    this.active = false;
  }

  toggleRateHold() {
    if (this.mode === "full") return this.rateHold;
    this.rateHold = !this.rateHold;
    return this.rateHold;
  }

  /**
   * Turns raw player input into flight-control demands.
   *
   * @param {object} raw controls from Input (never mutated)
   * @param {object} ctx { lander, telemetry, gravity, padVelocity, padDistance, view }
   * @returns {object} controls for stepLanderPhysics
   */
  apply(raw, ctx) {
    // Autoplay takes the full autopilot whatever the difficulty the flight
    // started on, so control can be handed over and back mid-flight.
    const mode = this.autopilot ? "full" : this.mode;
    const out = { ...raw, targetUp: null, throttleOverride: undefined };
    this.active = false;
    this.arresting = false;
    if (mode === "none" && !this.rateHold) return out;

    const { lander, telemetry, gravity } = ctx;
    const s = lander.state;
    if (s.landed || s.crashed) return out;

    const alt = telemetry.gearAltitude;
    const steering = Math.abs(raw.pitch) > 0.001 || Math.abs(raw.roll) > 0.001;

    // --- Horizontal: what drift do we want? -------------------------------
    let wantHorizontal = false;
    _accel.set(0, 0, 0);

    if (mode === "full") {
      // Camera-relative travel: W is "away from me", D is "to my right",
      // whatever way the vehicle happens to be facing. This is the single
      // biggest difference in how approachable the descent feels.
      const f = ctx.view ?? { x: 0, z: 1 };
      const fwd = raw.pitch;
      const right = raw.roll; // +1 is D, "to my right"
      const speed = THREE.MathUtils.clamp(
        ASSIST.TRAVEL_SPEED_MIN + alt * ASSIST.TRAVEL_SPEED_PER_METRE,
        ASSIST.TRAVEL_SPEED_MIN,
        ASSIST.TRAVEL_SPEED_MAX
      );
      let tx = f.x * fwd + -f.z * right;
      let tz = f.z * fwd + f.x * right;
      const mag = Math.hypot(tx, tz);
      if (mag > 1) {
        tx /= mag;
        tz /= mag;
      }
      this.targetVelocity.set(tx * speed, 0, tz * speed);

      // Over a moving deck, "stopped" means stopped relative to the deck.
      if (ctx.padVelocity && ctx.padDistance < ASSIST.DECK_MATCH_RANGE) {
        this.targetVelocity.x += ctx.padVelocity.x;
        this.targetVelocity.z += ctx.padVelocity.z;
      }
      wantHorizontal = true;
    } else if (mode === "drift" && !steering && s.stabiliser) {
      // Hands off the stick: lean to cancel drift rather than stand upright.
      this.targetVelocity.set(0, 0, 0);
      if (ctx.padVelocity && ctx.padDistance < ASSIST.DECK_MATCH_RANGE) {
        this.targetVelocity.x = ctx.padVelocity.x;
        this.targetVelocity.z = ctx.padVelocity.z;
      }
      wantHorizontal = true;
    }

    if (wantHorizontal) {
      _accel.x = (this.targetVelocity.x - s.velocity.x) * ASSIST.VELOCITY_GAIN;
      _accel.z = (this.targetVelocity.z - s.velocity.z) * ASSIST.VELOCITY_GAIN;
    }

    // --- Vertical: what sink rate do we want? -----------------------------
    const holdVertical = mode === "full" || this.rateHold;
    // null means "no vertical target": the player's own throttle applies.
    let sink = holdVertical ? scheduledSinkRate(alt) : null;
    if (holdVertical && mode === "full") {
      // Space climbs, Shift hovers, Ctrl comes down faster.
      if (raw.burn) sink = -ASSIST.CLIMB_RATE;
      else if (raw.throttleUp > 0) sink = 0;
      else if (raw.throttleDown > 0) {
        sink = Math.min(sink * ASSIST.FAST_DESCENT_FACTOR, ASSIST.SINK_RATE_MAX * 1.6);
      }
    } else if (holdVertical && raw.burn) {
      // Under rate hold in the manual modes, Space is still full thrust.
      sink = null;
    }

    // Drift arrest: low down with drift still to kill, hold height first.
    // Arriving with drift is the most common way a descent is lost, and near
    // the ground the lean limits leave too little authority to remove it.
    if (sink !== null && sink > 0 && wantHorizontal && alt < ASSIST.ARREST_ALTITUDE && !raw.throttleDown) {
      const driftError = Math.hypot(
        this.targetVelocity.x - s.velocity.x,
        this.targetVelocity.z - s.velocity.z
      );
      if (driftError > ASSIST.ARREST_DRIFT) {
        sink = alt < ASSIST.ARREST_CLIMB_BELOW ? -ASSIST.ARREST_CLIMB_RATE : 0;
        this.arresting = true;
      }
    }
    this.targetSinkRate = sink ?? 0;

    const vyTarget = sink === null ? null : -sink;
    // Vertical acceleration needed: close the rate error and cancel gravity.
    // A rocket cannot pull downward, so never ask for less than a fraction of
    // g — demanding negative vertical acceleration would have the attitude
    // solver try to invert the vehicle.
    const ay = vyTarget === null
      ? gravity
      : Math.max(gravity * ASSIST.MIN_VERTICAL_G, (vyTarget - s.velocity.y) * ASSIST.RATE_GAIN + gravity);

    // --- Attitude --------------------------------------------------------
    if (wantHorizontal) {
      // Tighter lean limits close to the ground: arriving tilted tips the gear.
      const maxTilt =
        alt < ASSIST.FLARE_ALTITUDE ? ASSIST.FLARE_TILT :
        alt < ASSIST.LOW_ALTITUDE ? ASSIST.LOW_TILT :
        mode === "full" ? ASSIST.MAX_TILT : ASSIST.DRIFT_KILL_TILT;
      const maxLateral = ay * Math.tan(THREE.MathUtils.degToRad(maxTilt));
      const lateral = Math.hypot(_accel.x, _accel.z);
      if (lateral > maxLateral && lateral > 1e-6) {
        const k = maxLateral / lateral;
        _accel.x *= k;
        _accel.z *= k;
      }
      _targetUp.set(_accel.x, ay, _accel.z).normalize();
      out.targetUp = _targetUp;
      // Attitude is now the computer's; pitch/roll keys are consumed by the
      // travel command rather than also rotating the vehicle directly.
      if (mode === "full") {
        out.pitch = 0;
        out.roll = 0;
      }
    }

    // --- Throttle --------------------------------------------------------
    if (holdVertical && vyTarget !== null) {
      // Supply the vertical component through whatever tilt the vehicle has
      // right now, so a lean in progress does not cost height.
      lander.upVector(_up);
      const cosTilt = Math.max(_up.y, 0.55);
      const throttle = ((ay / cosTilt) * s.mass) / ENGINE_MAX_THRUST;
      out.throttleOverride = THREE.MathUtils.clamp(throttle, ENGINE_MIN_THROTTLE, 1);
      out.burn = false;
    }

    this.active = Boolean(out.targetUp) || out.throttleOverride !== undefined;
    return out;
  }
}
