import * as THREE from "three";
import { ASSIST } from "../constants.js";

// ---------------------------------------------------------------------------
// Autoplay: the game flies itself.
//
// Autoplay is a virtual pilot, not a second physics model. It produces the
// same controls a player does and hands them to the same runtimes, so what
// you watch is the real simulation being flown well:
//
//   descent  an analog stick pointed at the pad through the full assist,
//            which holds the sink rate; it hovers if it is getting low
//            before it is over the pad, exactly as the coach tells a player
//   ascent   the full launch autopilot — staging, flight director, cut-off
//   coast    holds the engine through both burns, which cut off on target,
//            and runs the clock fast through the quiet stretches
//
// It can be engaged at the start of a flight or handed control mid-flight,
// and handed back at any time.
// ---------------------------------------------------------------------------

const AUTO = {
  // Commanded closing speed is this fraction of the remaining distance per
  // second, capped by the assist's travel-speed limit for the height.
  APPROACH_GAIN: 0.22, // 1/s
  // Hover rather than descend while below this height and not yet over the
  // pad: min(HOVER_CEILING, distance * HOVER_SLOPE).
  HOVER_CEILING: 45, // m
  HOVER_SLOPE: 0.7,
  // Above this height, descend at the assist's faster rate.
  FAST_DESCENT_BELOW: 28, // m
  // Counts as "over the pad" within this fraction of its radius.
  OVER_PAD: 0.45,
  // Launch clock: real time for the liftoff, then compressed.
  ASCENT_WARP: 6,
  ASCENT_WARP_ALTITUDE: 2500, // m
  // Coast clock during the burns and the crossing.
  COAST_WARP: 8,
  // Stop warping a burn this far short of its target. The cut-off is
  // automatic under autoplay, so warp can run almost to the end.
  COAST_WARP_MARGIN: 15, // m/s
};

/** The assist's commanded travel speed at a given height, m/s. */
function travelSpeed(gearAltitude) {
  return THREE.MathUtils.clamp(
    ASSIST.TRAVEL_SPEED_MIN + gearAltitude * ASSIST.TRAVEL_SPEED_PER_METRE,
    ASSIST.TRAVEL_SPEED_MIN,
    ASSIST.TRAVEL_SPEED_MAX
  );
}

/**
 * Descent: returns controls that fly the lander onto the pad.
 * @param {LevelRuntime} runtime
 * @param {object} neutral a neutral controls object to fill in
 * @param {{x:number,z:number}} view camera heading on the ground plane
 */
export function descentControls(runtime, neutral, view) {
  const c = { ...neutral, view };
  const lander = runtime.lander;
  const terrain = runtime.terrain;
  const p = lander.state.position;
  const alt = runtime.telemetry.gearAltitude;

  const dx = terrain.padCenter.x - p.x;
  const dz = terrain.padCenter.z - p.z;
  const distance = Math.hypot(dx, dz);

  // Closing velocity toward the pad, tapering as it arrives. Over a moving
  // deck this is relative to the deck: the assist adds the deck's own
  // motion when it is close.
  const maxSpeed = travelSpeed(alt);
  const speed = Math.min(maxSpeed, distance * AUTO.APPROACH_GAIN);
  const vx = distance > 1e-3 ? (dx / distance) * speed : 0;
  const vz = distance > 1e-3 ? (dz / distance) * speed : 0;

  // Express it as a stick deflection in the camera's frame, which is how the
  // full assist reads W A S D.
  const f = view ?? { x: 0, z: 1 };
  c.pitch = THREE.MathUtils.clamp((vx * f.x + vz * f.z) / maxSpeed, -1, 1);
  c.roll = THREE.MathUtils.clamp((vx * -f.z + vz * f.x) / maxSpeed, -1, 1);

  // Hold height until over the pad; a descent that arrives beside the target
  // has nothing left to spend getting onto it.
  const overPad = distance < terrain.padRadius * AUTO.OVER_PAD;
  const floor = Math.min(AUTO.HOVER_CEILING, distance * AUTO.HOVER_SLOPE);
  c.throttleUp = !overPad && alt < floor ? 1 : 0;

  // Come down briskly while high: every second spent hovering costs 1.62 m/s
  // of propellant to gravity, and the polar site's tank has almost no margin
  // for a leisurely descent. Below FAST_DESCENT_BELOW the normal taper takes
  // over, so the touchdown itself is as gentle as ever.
  if (!c.throttleUp && alt > AUTO.FAST_DESCENT_BELOW) c.throttleDown = 1;
  return c;
}

export default class Autoplay {
  constructor() {
    this.active = false;
    this._saved = null;
  }

  /**
   * Hands a phase to the autopilot. Remembers what the phase's own settings
   * were so handing back restores them.
   * @param {'descent'|'ascent'|'coast'} mode
   * @param {object} runtime the phase's runtime
   */
  engage(mode, runtime) {
    this.active = true;
    if (!runtime) return;
    if (mode === "descent") {
      runtime.assist.autopilot = true;
      // The assist flies through attitude hold.
      runtime.lander.state.stabiliser = true;
    } else if (mode === "ascent") {
      this._saved = { ...runtime.assists };
      runtime.assists = { autoStage: true, autoGuidance: true, autoInsert: true };
    } else if (mode === "coast") {
      this._saved = { autoCutoff: runtime.mission.autoCutoff };
      runtime.mission = { ...runtime.mission, autoCutoff: true };
    }
  }

  /** Gives control back to the player. */
  release(mode, runtime) {
    this.active = false;
    if (!runtime) return;
    if (mode === "descent") {
      runtime.assist.autopilot = false;
    } else if (mode === "ascent") {
      if (this._saved) runtime.assists = this._saved;
      runtime.timeScale = 1;
    } else if (mode === "coast") {
      if (this._saved) runtime.mission = { ...runtime.mission, ...this._saved };
      runtime.timeScale = 1;
    }
    this._saved = null;
  }

  /** Launch: the runtime's autopilot flies it; autoplay only runs the clock. */
  ascentControls(ascent) {
    if (ascent.status === "flying") {
      ascent.timeScale = ascent.telemetry.altitude > AUTO.ASCENT_WARP_ALTITUDE ? AUTO.ASCENT_WARP : 1;
    }
    return { throttleUp: 0, throttleDown: 0, pitchUp: 0, pitchDown: 0 };
  }

  /** Coast: hold the engine through each burn; compress the crossing. */
  coastControls(coast) {
    const burning = coast.phase === "tli" || coast.phase === "loi";
    // Warp the crossing, and the long early part of each burn. The runtime
    // drops out of warp as a burn nears its band; do not fight it.
    let warp = coast.phase === "cruise";
    if (burning) {
      const tli = coast.phase === "tli";
      const done = tli ? coast.deltaV : coast.loiDeltaV;
      const target = tli ? coast.mission.targetDeltaV : coast.mission.loiTargetDeltaV;
      warp = target - done > AUTO.COAST_WARP_MARGIN;
    }
    if (warp && coast.timeScale < AUTO.COAST_WARP) coast.timeScale = AUTO.COAST_WARP;
    return { burn: burning };
  }
}
