// ---------------------------------------------------------------------------
// Contextual coaching for the descent.
//
// The hard part of a lunar landing is not knowing which key does what — it is
// knowing *when* to do it. This watches the flight and says the one thing that
// matters right now, rather than dumping a control list at the start.
//
// Each cue fires at most once per attempt, and never within COOLDOWN of the
// previous one, so the player is never buried in text.
// ---------------------------------------------------------------------------

const COOLDOWN = 3.6; // seconds between any two cues

/**
 * Cues are evaluated top to bottom; the first one whose `when` matches and
 * which hasn't already fired is shown. Order is therefore priority order.
 *
 * There is one script per assist mode, because the right advice differs:
 * in full assist the computer flies the descent and the player only steers,
 * while in the manual modes the player owns the throttle.
 */
const MANUAL_CUES = [
  {
    id: "intro",
    text: "Hold SPACE for the engine. Lean with W A S D — leaning is how you steer.",
    duration: 6,
    when: (c) => c.elapsed < 0.6,
  },
  {
    id: "brakeDrift",
    text: "You are drifting. Lean AGAINST the amber arrow on the DRIFT dial and hold SPACE.",
    duration: 6,
    when: (c) => c.elapsed > 3 && c.drift > 4 && c.altitude > 60,
  },
  {
    id: "driftGood",
    text: "Drift under control. Now bring the descent rate down before you arrive.",
    duration: 4.5,
    when: (c) => c.firedIds.has("brakeDrift") && c.drift < 1.6 && c.altitude > 30,
  },
  {
    id: "rateHold",
    text: "Struggling with the throttle? Press G — descent-rate hold throttles for you.",
    duration: 5.5,
    when: (c) => !c.rateHold && c.altitude < 110 && c.descentRate > c.limits.maxVerticalSpeed * 1.8,
  },
  {
    id: "comingInHot",
    text: "Descent rate too high — hold SPACE now, not at the last second.",
    duration: 5,
    when: (c) => !c.rateHold && c.altitude < 90 && c.descentRate > c.limits.maxVerticalSpeed * 1.6,
  },
  {
    id: "levelOff",
    text: "Level the vehicle: release the lean and let attitude hold settle it upright.",
    duration: 5,
    when: (c) => c.altitude < 45 && c.tilt > c.limits.maxTilt * 0.9,
  },
  {
    id: "offPad",
    text: "You are off the pad — follow the blue marker on the DRIFT dial.",
    duration: 5,
    when: (c) => c.altitude < 70 && c.padRange > c.padRadius * 2.2,
  },
  {
    id: "nearlyThere",
    text: "Good approach. Ease the descent under the limit and let it settle on.",
    duration: 4,
    when: (c) =>
      c.altitude < 25 &&
      c.descentRate < c.limits.maxVerticalSpeed &&
      c.drift < c.limits.maxHorizontalSpeed &&
      c.padRange < c.padRadius,
  },
  {
    id: "fuelLow",
    text: "Propellant low — stop hovering and commit to the landing.",
    duration: 5,
    when: (c) => c.fuelFraction < 0.18 && c.altitude > 8,
  },
];

const PILOT_INTRO = {
  id: "intro",
  text: "Hold SPACE for the engine and tap W A S D to lean. Let go and it kills its own drift. G holds the descent rate.",
  duration: 7,
  when: (c) => c.elapsed < 0.6,
};

const AUTOPILOT_CUES = [
  {
    id: "intro",
    text: "The autopilot is flying the descent. Steer to the landing pad with W A S D.",
    duration: 6,
    when: (c) => c.elapsed < 0.6,
  },
  {
    id: "steer",
    text: (c) => `The pad is ${c.padWords} — hold ${c.padKeys} to fly toward it.`,
    duration: 5,
    when: (c) => c.elapsed > 6.5 && c.padRange > c.padRadius * 2 && c.altitude > 40,
  },
  {
    id: "hover",
    text: "Running out of height? Hold SHIFT to hover while you move over the pad.",
    duration: 5,
    when: (c) => c.altitude < 55 && c.padRange > c.padRadius * 1.6,
  },
  {
    id: "steerAgain",
    text: (c) => `Pad is ${c.padWords} — ${c.padKeys}.`,
    duration: 3.5,
    when: (c) => c.firedIds.has("hover") && c.altitude < 40 && c.padRange > c.padRadius * 1.3,
  },
  {
    id: "arrest",
    text: "Holding height to kill the drift before touchdown.",
    duration: 3.5,
    when: (c) => c.arresting,
  },
  {
    id: "overPad",
    text: "Over the pad. Let go of the keys and it will set itself down.",
    duration: 4.5,
    when: (c) => c.altitude < 30 && c.padRange < c.padRadius * 0.8,
  },
  {
    id: "fuelLow",
    text: "Propellant low — stop hovering and land now.",
    duration: 5,
    when: (c) => c.fuelFraction < 0.15 && c.altitude > 6,
  },
];

/** "ahead and to your left", plus which keys get there, relative to the camera. */
function padDirection(dx, dz, view) {
  const f = view ?? { x: 0, z: 1 };
  const fwd = dx * f.x + dz * f.z;
  const right = dx * -f.z + dz * f.x;
  const words = [];
  const keys = [];
  const big = Math.max(Math.abs(fwd), Math.abs(right));
  if (Math.abs(fwd) > big * 0.4) {
    words.push(fwd > 0 ? "ahead" : "behind you");
    keys.push(fwd > 0 ? "W" : "S");
  }
  if (Math.abs(right) > big * 0.4) {
    words.push(right > 0 ? "to your right" : "to your left");
    keys.push(right > 0 ? "D" : "A");
  }
  return { words: words.join(" and "), keys: keys.join(" + ") };
}

export default class Coach {
  constructor(hud) {
    this.hud = hud;
    this.cues = MANUAL_CUES;
    this.reset();
  }

  reset() {
    this.firedIds = new Set();
    this.cooldown = 0;
    this.enabled = true;
  }

  /**
   * Manual flying is coached on the early levels only; later ones assume
   * competence. Under the autopilot the cues are about where to go, which is
   * worth saying on every site.
   */
  setLevel(config) {
    this.reset();
    this.assist = config.assist ?? "none";
    this.cues =
      this.assist === "full" ? AUTOPILOT_CUES :
      this.assist === "drift" ? [PILOT_INTRO, ...MANUAL_CUES.slice(1)] :
      MANUAL_CUES;
    this.enabled = this.assist === "full" || config.id <= 2;
  }

  /**
   * @param {object} runtime LevelRuntime
   * @param {number} dt
   * @param {{x:number,z:number}} [view] camera heading on the ground plane
   */
  update(runtime, dt, view) {
    if (!this.enabled || runtime.status !== "flying") return;
    // Once the pads are down the outcome is already decided; coaching during
    // the settle window would comment on a landing that has already happened.
    if (runtime.hasTouchedDown) return;

    this.cooldown -= dt;
    if (this.cooldown > 0) return;

    const t = runtime.telemetry;
    const s = runtime.lander.state;
    const drift = t.surfaceMoving ? t.relativeHorizontalSpeed : t.horizontalSpeed;

    const dx = runtime.terrain.padCenter.x - s.position.x;
    const dz = runtime.terrain.padCenter.z - s.position.z;
    const dir = padDirection(dx, dz, view);

    const ctx = {
      elapsed: runtime.elapsed,
      padWords: dir.words,
      padKeys: dir.keys,
      rateHold: runtime.assist?.rateHold ?? false,
      arresting: runtime.assist?.arresting ?? false,
      altitude: t.gearAltitude,
      descentRate: Math.max(0, -t.verticalSpeed),
      drift,
      tilt: t.tilt,
      limits: runtime.config.thresholds,
      padRange: runtime.terrain.distanceToPad(s.position.x, s.position.z),
      padRadius: runtime.terrain.padRadius,
      fuelFraction: s.fuelCapacity > 0 ? s.fuel / s.fuelCapacity : 0,
      firedIds: this.firedIds,
    };

    for (const cue of this.cues) {
      if (this.firedIds.has(cue.id)) continue;
      if (!cue.when(ctx)) continue;
      this.firedIds.add(cue.id);
      this.cooldown = COOLDOWN;
      this.hud.showHint(typeof cue.text === "function" ? cue.text(ctx) : cue.text, cue.duration);
      return;
    }
  }
}
