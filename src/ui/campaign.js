// ---------------------------------------------------------------------------
// Campaign mode: the three phases flown as one mission, pad to surface.
//
// Holds no game logic of its own — it tracks which leg is in progress, banks
// each leg's score as it completes, and renders the progress strip and the
// combined total onto whichever debrief screen is showing.
// ---------------------------------------------------------------------------

export const LEGS = [
  { id: "ascent", label: "Ascent" },
  { id: "coast", label: "Coast" },
  { id: "descent", label: "Landing" },
];

export default class Campaign {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.scores = { ascent: null, coast: null, descent: null };
    this.legIndex = 0;
  }

  start() {
    this.reset();
    this.active = true;
  }

  /** Which leg is being flown right now. */
  get currentLeg() {
    return LEGS[this.legIndex]?.id ?? null;
  }

  /** Banks a leg's score and advances. */
  complete(legId, score) {
    if (!this.active) return;
    this.scores[legId] = Math.round(score ?? 0);
    const index = LEGS.findIndex((l) => l.id === legId);
    if (index >= 0) this.legIndex = Math.min(LEGS.length - 1, index + 1);
  }

  /** A leg was failed — the mission is over. */
  fail() {
    this.active = false;
  }

  get isComplete() {
    return LEGS.every((l) => this.scores[l.id] !== null);
  }

  /** Mission score is the mean of the three legs. */
  get total() {
    const values = LEGS.map((l) => this.scores[l.id] ?? 0);
    return Math.round(values.reduce((a, b) => a + b, 0) / LEGS.length);
  }

  /**
   * Renders the progress strip into a debrief panel, above its heading.
   * @param {string} containerId element the strip should be inserted into
   * @param {string} currentLegId
   */
  renderStrip(containerId, currentLegId) {
    const host = document.getElementById(containerId);
    if (!host) return;

    let strip = host.querySelector(".campaign-strip");
    if (!this.active) {
      if (strip) strip.remove();
      return;
    }
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "campaign-strip";
      // Sit directly under the mission tag, above the heading. The heading is
      // nested inside the panel, so insert relative to *its* parent — the
      // screen element is not its direct parent.
      const heading = host.querySelector(".heading");
      if (!heading) return;
      heading.parentNode.insertBefore(strip, heading);
    }

    strip.innerHTML = LEGS.map((leg, i) => {
      const score = this.scores[leg.id];
      const state = score !== null ? "done" : leg.id === currentLegId ? "current" : "";
      const value = score !== null ? ` <b>${score}</b>` : "";
      const arrow = i < LEGS.length - 1 ? '<span class="campaign-arrow">→</span>' : "";
      return `<span class="campaign-leg ${state}">${leg.label}${value}</span>${arrow}`;
    }).join("");
  }

  /** Renders the combined total once every leg is banked. */
  renderTotal(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;

    let node = host.querySelector(".campaign-total");
    if (!this.active || !this.isComplete) {
      if (node) node.remove();
      return;
    }
    if (!node) {
      node = document.createElement("div");
      node.className = "campaign-total";
      const actions = host.querySelector(".menu-actions");
      if (!actions) return;
      actions.parentNode.insertBefore(node, actions);
    }
    const detail = LEGS.map((l) => `${l.label} ${this.scores[l.id]}`).join("  ·  ");
    node.innerHTML = `
      <span class="label">Mission Score</span>
      <span class="value">${this.total}</span>
      <span class="detail">${detail}</span>
    `;
  }
}
