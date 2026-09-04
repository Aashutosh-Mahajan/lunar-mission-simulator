import * as THREE from "three";

// ---------------------------------------------------------------------------
// Phase 3 HUD. A coast needs very little: which leg of the journey this is,
// how far across, and — during a burn — the delta-v gauge with its target band
// marked, since hitting that band is the whole task.
// ---------------------------------------------------------------------------

const PHASE_LABELS = {
  parking: "Parking Orbit",
  tli: "Trans-Lunar Injection",
  cruise: "Trans-Lunar Coast",
  loi: "Lunar Orbit Insertion",
  arrived: "Lunar Orbit",
};

function el(id) {
  return document.getElementById(id);
}

export default class CoastHud {
  constructor() {
    this.dom = {
      phase: el("coast-phase"),
      met: el("coast-met"),
      timescale: el("coast-timescale"),

      burnPanel: el("coast-burn-panel"),
      burnLabel: el("coast-burn-label"),
      deltaV: el("coast-dv"),
      target: el("coast-dv-target"),
      track: el("coast-dv-track"),
      fill: el("coast-dv-fill"),
      bandLo: el("coast-band-lo"),
      bandHi: el("coast-band-hi"),
      burnHint: el("coast-burn-hint"),

      journeyPanel: el("coast-journey-panel"),
      journeyFill: el("coast-journey-fill"),
      journeyPct: el("coast-journey-pct"),

      log: el("coast-log"),
      hint: el("coast-hint"),
    };
    this._hintTimer = 0;
  }

  reset() {
    this.dom.log.innerHTML = "";
    this.dom.hint.classList.remove("show");
    this._hintTimer = 0;
    this.dom.burnPanel.classList.remove("ready", "over");
  }

  showHint(text, duration = 4.5) {
    this.dom.hint.textContent = text;
    this.dom.hint.classList.add("show");
    this._hintTimer = duration;
  }

  pushLogEntry(t, text) {
    const line = document.createElement("div");
    line.className = "log-line";
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    line.innerHTML = `<span class="log-time">${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}</span> ${text}`;
    this.dom.log.prepend(line);
    while (this.dom.log.children.length > 5) this.dom.log.removeChild(this.dom.log.lastChild);
  }

  update(runtime, dt) {
    const t = runtime.telemetry;

    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.dom.hint.classList.remove("show");
    }

    this.dom.phase.textContent = PHASE_LABELS[t.phase] ?? t.phase;
    const mins = Math.floor(t.elapsed / 60);
    const secs = t.elapsed % 60;
    this.dom.met.textContent = `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
    this.dom.timescale.textContent = `${t.timeScale}×`;
    this.dom.timescale.classList.toggle("warp", t.timeScale > 1);

    // --- Burn gauge -------------------------------------------------------
    this.dom.burnPanel.classList.toggle("hidden", !t.inBurnWindow);
    if (t.inBurnWindow) {
      // The gauge runs to a little past the top of the band, so overburning
      // is visible rather than just pinning the bar.
      const full = t.band[1] * 1.15;
      const pct = (v) => `${THREE.MathUtils.clamp(v / full, 0, 1) * 100}%`;

      this.dom.burnLabel.textContent =
        t.phase === "tli" ? "TLI BURN · ΔV" : "LOI BURN · ΔV";
      this.dom.deltaV.textContent = t.deltaV.toFixed(0);
      this.dom.target.textContent = `${t.band[0]}–${t.band[1]} m/s`;
      this.dom.fill.style.width = pct(t.deltaV);
      this.dom.bandLo.style.left = pct(t.band[0]);
      this.dom.bandHi.style.left = pct(t.band[1]);

      const inBand = t.deltaV >= t.band[0] && t.deltaV <= t.band[1];
      const over = t.deltaV > t.band[1];
      this.dom.burnPanel.classList.toggle("ready", inBand);
      this.dom.burnPanel.classList.toggle("over", over);
      this.dom.fill.className = `coast-dv-fill${over ? " over" : inBand ? " ready" : ""}`;
      this.dom.burnHint.textContent = over
        ? "OVERBURN — cut off immediately"
        : inBand
          ? "IN BAND — press I to cut off"
          : "Hold SPACE to burn  ·  , and . to time-warp";
    }

    // --- Journey ----------------------------------------------------------
    const cruising = t.phase === "cruise";
    this.dom.journeyPanel.classList.toggle("hidden", !cruising);
    if (cruising) {
      this.dom.journeyFill.style.width = `${t.journey * 100}%`;
      this.dom.journeyPct.textContent = `${(t.journey * 100).toFixed(0)}%`;
    }
  }
}
