import { ASCENT_MISSION } from "../levels/ascentConfig.js";

// ---------------------------------------------------------------------------
// Phase 2 — terminal count.
//
// Runs the clock from T-10 to liftoff, firing the callouts in ascentConfig and
// signalling ignition (which happens several seconds *before* release, while
// the vehicle is still held down and the engines build to full thrust).
// ---------------------------------------------------------------------------

// The F-1s lit at T-8.9 s; the hold-downs did not release until thrust was
// verified. That gap is the reason a Saturn V appears to sit still, roaring,
// before it moves.
const IGNITION_T = 8.5;

export default class Countdown {
  constructor() {
    this.root = document.getElementById("screen-countdown");
    this.numberEl = document.getElementById("countdown-number");
    this.calloutEl = document.getElementById("countdown-callout");
    this.reset();
  }

  reset() {
    this.t = 10;
    this.running = false;
    this.done = false;
    this.ignitionFired = false;
    this._spoken = new Set();
    this.root.classList.add("hidden");
  }

  start() {
    this.reset();
    this.running = true;
    this.root.classList.remove("hidden");
  }

  /** Skips straight to zero — used by the "hold/resume" and skip controls. */
  skip() {
    this.t = 0;
  }

  /**
   * @param {number} dt
   * @param {object} handlers { onCallout, onIgnition, onLiftoff }
   */
  update(dt, handlers = {}) {
    if (!this.running || this.done) return;

    const prev = this.t;
    this.t -= dt;

    // Ignition, several seconds before release.
    if (!this.ignitionFired && this.t <= IGNITION_T) {
      this.ignitionFired = true;
      handlers.onIgnition?.();
    }

    // Fire each integer callout once as the clock passes it.
    for (const line of ASCENT_MISSION.countdown) {
      if (this._spoken.has(line.t)) continue;
      if (prev > line.t && this.t <= line.t) {
        this._spoken.add(line.t);
        this.calloutEl.textContent = line.text;
        handlers.onCallout?.(line);
      }
    }

    const shown = Math.max(0, Math.ceil(this.t));
    this.numberEl.textContent = this.t > 0 ? `T-${shown}` : "LIFTOFF";
    this.numberEl.classList.toggle("liftoff", this.t <= 0);

    if (this.t <= 0) {
      this.done = true;
      this.running = false;
      handlers.onLiftoff?.();
      // Leave the banner up for a beat, then clear it.
      setTimeout(() => this.root.classList.add("hidden"), 1400);
    }
  }

  get isCounting() {
    return this.running && !this.done;
  }
}
