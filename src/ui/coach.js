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
 */
const CUES = [
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
    id: "comingInHot",
    text: "Descent rate too high — hold SPACE now, not at the last second.",
    duration: 5,
    when: (c) => c.altitude < 90 && c.descentRate > c.limits.maxVerticalSpeed * 1.6,
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

export default class Coach {
  constructor(hud) {
    this.hud = hud;
    this.reset();
  }

  reset() {
    this.firedIds = new Set();
    this.cooldown = 0;
    this.enabled = true;
  }

  /** Coaching is only shown on the early levels; later ones assume competence. */
  setLevel(config) {
    this.reset();
    this.enabled = config.id <= 2;
  }

  update(runtime, dt) {
    if (!this.enabled || runtime.status !== "flying") return;
    // Once the pads are down the outcome is already decided; coaching during
    // the settle window would comment on a landing that has already happened.
    if (runtime.hasTouchedDown) return;

    this.cooldown -= dt;
    if (this.cooldown > 0) return;

    const t = runtime.telemetry;
    const s = runtime.lander.state;
    const drift = t.surfaceMoving ? t.relativeHorizontalSpeed : t.horizontalSpeed;

    const ctx = {
      elapsed: runtime.elapsed,
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

    for (const cue of CUES) {
      if (this.firedIds.has(cue.id)) continue;
      if (!cue.when(ctx)) continue;
      this.firedIds.add(cue.id);
      this.cooldown = COOLDOWN;
      this.hud.showHint(cue.text, cue.duration);
      return;
    }
  }
}
