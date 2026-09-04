// Screen manager: exactly one overlay screen visible at a time. The two HUDs
// (descent and ascent) are handled separately, since they coexist with the
// pause and debrief overlays.

const IDS = {
  loading: "screen-loading",
  menu: "screen-menu",
  sites: "screen-sites",
  pause: "screen-pause",
  help: "screen-help",
  settings: "screen-settings",
  result: "screen-result",
  ascentResult: "screen-ascent-result",
  coastResult: "screen-coast-result",
};

export default class Screens {
  constructor() {
    this.nodes = {};
    for (const [key, id] of Object.entries(IDS)) {
      this.nodes[key] = document.getElementById(id);
    }
    this.huds = {
      descent: document.getElementById("screen-hud"),
      ascent: document.getElementById("screen-ascent-hud"),
      coast: document.getElementById("screen-coast-hud"),
    };
    this.countdown = document.getElementById("screen-countdown");
    this.current = "loading";
    this._previous = null;
  }

  show(name) {
    for (const [key, node] of Object.entries(this.nodes)) {
      node.classList.toggle("hidden", key !== name);
    }
    this._previous = this.current;
    this.current = name;
  }

  /** Hides every overlay, leaving only the active HUD (i.e. live flight). */
  showFlight() {
    for (const node of Object.values(this.nodes)) node.classList.add("hidden");
    this._previous = this.current;
    this.current = "flight";
  }

  /** Selects which HUD is on screen: 'descent', 'ascent' or null for none. */
  setHud(which) {
    for (const [key, node] of Object.entries(this.huds)) {
      node.classList.toggle("hidden", key !== which);
    }
  }

  setCountdownVisible(visible) {
    this.countdown.classList.toggle("hidden", !visible);
  }

  get previous() {
    return this._previous;
  }
}
