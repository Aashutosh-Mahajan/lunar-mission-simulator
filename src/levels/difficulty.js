// ---------------------------------------------------------------------------
// Difficulty presets.
//
// The simulation is the same at every setting — gravity, thrust, mass flow and
// the vehicles do not change. What changes is how much of the flying the
// computer does for you, and how much margin the landing gear and propellant
// tanks give you. That mirrors the real vehicles: the Apollo LM could be flown
// in fully automatic, attitude-hold or direct modes, and the crews chose
// between them depending on the phase of flight.
//
//   cadet      Autopilot flies the vertical profile; you steer where to go.
//   pilot      You fly it, with drift-kill on key release and wider margins.
//   commander  Direct control and the real LM design limits. No help.
// ---------------------------------------------------------------------------

export const DIFFICULTY_ORDER = ["cadet", "pilot", "commander"];
export const DEFAULT_DIFFICULTY = "cadet";

export const DIFFICULTIES = {
  cadet: {
    id: "cadet",
    label: "Cadet",
    summary: "Autopilot holds a safe descent rate and launch profile. You pick where to go.",
    descent: {
      // 'full' — the computer manages throttle to hold a safe sink rate, and
      // W A S D command a direction of travel relative to the camera. Letting
      // go of the keys brings the vehicle to a hover-drift stop.
      assist: "full",
      fuelScale: 1.6,
      rcsScale: 1.5,
      limits: { vertical: 1.7, horizontal: 1.8, tiltAdd: 10 },
      padScale: 1.25,
    },
    ascent: {
      autoStage: true,
      // Flies the late pitch-down itself, inside the same ±authority the player
      // has on W/S — the pitch program is untouched.
      autoGuidance: true,
      autoInsert: true,
      bandScale: 1.6,
      limits: { maxAngleOfAttack: 24, maxDynamicPressure: 60000, maxAcceleration: 7 },
    },
    coast: { autoCutoff: true, bandScale: 1.8 },
  },

  pilot: {
    id: "pilot",
    label: "Pilot",
    summary: "You fly it. Releasing the stick kills drift, staging is automatic, margins are generous.",
    descent: {
      // 'drift' — manual throttle and attitude, but when the steering keys are
      // released the vehicle leans to null its own drift instead of just
      // standing upright. Descent-rate hold is available on G.
      assist: "drift",
      fuelScale: 1.25,
      rcsScale: 1.2,
      limits: { vertical: 1.3, horizontal: 1.35, tiltAdd: 4 },
      padScale: 1.1,
    },
    ascent: {
      autoStage: true,
      autoGuidance: false,
      autoInsert: false,
      bandScale: 1.25,
      limits: { maxAngleOfAttack: 18, maxDynamicPressure: 52000, maxAcceleration: 6.5 },
    },
    coast: { autoCutoff: false, bandScale: 1.35 },
  },

  commander: {
    id: "commander",
    label: "Commander",
    summary: "Direct control, manual staging and the real design limits. The simulator as flown.",
    descent: {
      assist: "none",
      fuelScale: 1,
      rcsScale: 1,
      limits: { vertical: 1, horizontal: 1, tiltAdd: 0 },
      padScale: 1,
    },
    ascent: {
      autoStage: false,
      autoGuidance: false,
      autoInsert: false,
      bandScale: 1,
      limits: null,
    },
    coast: { autoCutoff: false, bandScale: 1 },
  },
};

export function getDifficulty(id) {
  return DIFFICULTIES[id] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];
}

/**
 * Widens a [lo, hi] band about its centre. Used for the insertion and burn
 * windows, so an easier setting is more forgiving without moving the target.
 */
export function scaleBand(band, scale) {
  const mid = (band[0] + band[1]) / 2;
  const half = ((band[1] - band[0]) / 2) * scale;
  return [mid - half, mid + half];
}

/**
 * Returns a copy of the ascent mission with the difficulty's windows and
 * structural margins applied. The vehicle and pitch program are unchanged.
 */
export function applyAscentDifficulty(mission, difficulty) {
  const d = getDifficulty(difficulty).ascent;
  const o = mission.orbit;
  return {
    ...mission,
    orbit: {
      ...o,
      altitudeBand: scaleBand(o.altitudeBand, d.bandScale),
      speedBand: scaleBand(o.speedBand, d.bandScale).map(Math.round),
      maxFlightPathAngle: +(o.maxFlightPathAngle * d.bandScale).toFixed(1),
    },
    limits: d.limits ? { ...mission.limits, ...d.limits } : mission.limits,
    assists: {
      autoStage: d.autoStage,
      autoGuidance: d.autoGuidance,
      autoInsert: d.autoInsert,
    },
  };
}

/**
 * Returns a copy of the coast mission with the difficulty's burn windows.
 * Cadet also cuts the engine off automatically at the target.
 */
export function applyCoastDifficulty(mission, difficulty) {
  const d = getDifficulty(difficulty).coast;
  return {
    ...mission,
    deltaVBand: scaleBand(mission.deltaVBand, d.bandScale).map(Math.round),
    loiBand: scaleBand(mission.loiBand, d.bandScale).map(Math.round),
    autoCutoff: d.autoCutoff,
  };
}

/**
 * Returns a copy of a descent level with the difficulty's margins applied.
 * The source config is never mutated, so switching difficulty between flights
 * cannot compound.
 */
export function applyDescentDifficulty(config, difficulty) {
  const d = getDifficulty(difficulty).descent;
  const t = config.thresholds;
  return {
    ...config,
    // `difficulty` on a level is the site's own rating ("Training", "Expert");
    // the setting it is being flown at is kept separately.
    flightDifficulty: getDifficulty(difficulty).id,
    assist: d.assist,
    fuel: {
      ...config.fuel,
      descent: Math.round(config.fuel.descent * d.fuelScale),
      rcs: Math.round(config.fuel.rcs * d.rcsScale),
    },
    pad: { ...config.pad, radius: config.pad.radius * d.padScale },
    thresholds: {
      ...t,
      maxVerticalSpeed: +(t.maxVerticalSpeed * d.limits.vertical).toFixed(1),
      maxHorizontalSpeed: +(t.maxHorizontalSpeed * d.limits.horizontal).toFixed(1),
      maxTilt: t.maxTilt + d.limits.tiltAdd,
    },
  };
}
