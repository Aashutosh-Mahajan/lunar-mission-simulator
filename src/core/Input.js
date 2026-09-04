// ---------------------------------------------------------------------------
// Input: keyboard + mouse + gamepad, mapped to normalised flight demands.
//
// Continuous axes (attitude, throttle, translation) are polled each frame;
// discrete actions (camera, pause, restart) are dispatched as edge-triggered
// events so they fire once per press.
// ---------------------------------------------------------------------------

const AXIS_KEYS = {
  // Attitude
  KeyW: ["pitch", +1],
  KeyS: ["pitch", -1],
  KeyA: ["roll", +1],
  KeyD: ["roll", -1],
  KeyQ: ["yaw", +1],
  KeyE: ["yaw", -1],
  // RCS translation
  ArrowUp: ["translateZ", +1],
  ArrowDown: ["translateZ", -1],
  ArrowLeft: ["translateX", -1],
  ArrowRight: ["translateX", +1],
  // Throttle
  ShiftLeft: ["throttleUp", 1],
  ShiftRight: ["throttleUp", 1],
  ControlLeft: ["throttleDown", 1],
  ControlRight: ["throttleDown", 1],
};

const ACTION_KEYS = {
  KeyC: "cameraNext",
  KeyV: "cameraPrev",
  KeyT: "toggleStabiliser",
  KeyZ: "throttleFull",
  KeyX: "throttleCut",
  KeyR: "restart",
  KeyH: "help",
  KeyM: "mute",
  KeyP: "pause",
  Escape: "pause",
  Enter: "confirm",
  // Phase 2 (launch). Space is both a held axis (descent thrust) and an
  // edge-triggered action (staging); the game shell only listens to the
  // action while flying an ascent.
  Space: "stage",
  KeyI: "insert",
  Comma: "warpDown",
  Period: "warpUp",
  // Phase 3.
  KeyK: "skip",
};

// Actions that must not fire while a menu is up.
const FLIGHT_ONLY_ACTIONS = new Set([
  "throttleFull",
  "throttleCut",
  "stage",
  "insert",
  "warpUp",
  "warpDown",
  "skip",
]);

// Keys we swallow so the browser doesn't scroll or activate UI behind us.
const SWALLOW = new Set([
  "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "Tab",
]);

export default class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.actionHandlers = new Set();
    this.enabled = true;

    this.controls = {
      pitch: 0,
      roll: 0,
      yaw: 0,
      translateX: 0,
      translateZ: 0,
      throttleUp: 0,
      throttleDown: 0,
      throttleFull: false,
      throttleCut: false,
      burn: false,
    };

    this.mouse = { dragging: false, dx: 0, dy: 0, wheel: 0, lastX: 0, lastY: 0 };
    this.gamepadIndex = null;
    this._prevGamepadButtons = [];

    this._bind();
  }

  onAction(handler) {
    this.actionHandlers.add(handler);
    return () => this.actionHandlers.delete(handler);
  }

  _emit(action) {
    for (const h of this.actionHandlers) h(action);
  }

  _bind() {
    this._onKeyDown = (e) => {
      if (SWALLOW.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);

      const action = ACTION_KEYS[e.code];
      // Camera/pause/help stay live even when flight input is disabled, but
      // flight actions must not leak through menus.
      if (action && (!FLIGHT_ONLY_ACTIONS.has(action) || this.enabled)) {
        this._emit(action);
      }
    };

    this._onKeyUp = (e) => {
      if (SWALLOW.has(e.code)) e.preventDefault();
      this.keys.delete(e.code);
    };

    this._onBlur = () => this.keys.clear();

    this._onMouseDown = (e) => {
      if (e.button !== 0) return;
      this.mouse.dragging = true;
      this.mouse.lastX = e.clientX;
      this.mouse.lastY = e.clientY;
    };
    this._onMouseUp = () => {
      this.mouse.dragging = false;
    };
    this._onMouseMove = (e) => {
      if (!this.mouse.dragging) return;
      this.mouse.dx += (e.clientX - this.mouse.lastX) * 0.005;
      this.mouse.dy += (e.clientY - this.mouse.lastY) * 0.005;
      this.mouse.lastX = e.clientX;
      this.mouse.lastY = e.clientY;
    };
    this._onWheel = (e) => {
      e.preventDefault();
      this.mouse.wheel += Math.sign(e.deltaY) * 3;
    };

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);
    this.canvas.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mouseup", this._onMouseUp);
    window.addEventListener("mousemove", this._onMouseMove);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });

    window.addEventListener("gamepadconnected", (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener("gamepaddisconnected", () => {
      this.gamepadIndex = null;
    });
  }

  /** True while any flight key is held (used to auto-disengage autopilot). */
  isManualInput() {
    const c = this.controls;
    return (
      Math.abs(c.pitch) > 0.01 ||
      Math.abs(c.roll) > 0.01 ||
      Math.abs(c.yaw) > 0.01 ||
      Math.abs(c.translateX) > 0.01 ||
      Math.abs(c.translateZ) > 0.01 ||
      c.burn ||
      c.throttleUp > 0 ||
      c.throttleDown > 0
    );
  }

  /** Polls hardware and rebuilds the normalised control demands. */
  update() {
    const c = this.controls;
    c.pitch = 0;
    c.roll = 0;
    c.yaw = 0;
    c.translateX = 0;
    c.translateZ = 0;
    c.throttleUp = 0;
    c.throttleDown = 0;
    c.throttleFull = false;
    c.throttleCut = false;
    c.burn = false;

    if (!this.enabled) return c;

    for (const code of this.keys) {
      const axis = AXIS_KEYS[code];
      if (axis) c[axis[0]] += axis[1];
    }
    c.burn = this.keys.has("Space");

    this._applyGamepad(c);

    // Clamp after summing opposing keys.
    c.pitch = Math.max(-1, Math.min(1, c.pitch));
    c.roll = Math.max(-1, Math.min(1, c.roll));
    c.yaw = Math.max(-1, Math.min(1, c.yaw));
    c.translateX = Math.max(-1, Math.min(1, c.translateX));
    c.translateZ = Math.max(-1, Math.min(1, c.translateZ));
    c.throttleUp = Math.min(1, c.throttleUp);
    c.throttleDown = Math.min(1, c.throttleDown);

    return c;
  }

  _applyGamepad(c) {
    if (this.gamepadIndex === null || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    if (!pad) return;

    const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);

    // Left stick: pitch/roll. Right stick X: yaw.
    c.pitch += -dz(pad.axes[1] ?? 0);
    c.roll += -dz(pad.axes[0] ?? 0);
    c.yaw += -dz(pad.axes[2] ?? 0);

    // Right trigger is the main engine; left/right bumpers trim throttle.
    const rt = pad.buttons[7]?.value ?? 0;
    if (rt > 0.1) c.burn = true;
    if (pad.buttons[5]?.pressed) c.throttleUp += 1;
    if (pad.buttons[4]?.pressed) c.throttleDown += 1;

    // D-pad: RCS translation.
    if (pad.buttons[12]?.pressed) c.translateZ += 1;
    if (pad.buttons[13]?.pressed) c.translateZ -= 1;
    if (pad.buttons[14]?.pressed) c.translateX -= 1;
    if (pad.buttons[15]?.pressed) c.translateX += 1;

    // Face buttons, edge-triggered.
    const edge = (i, action) => {
      const now = pad.buttons[i]?.pressed ?? false;
      if (now && !this._prevGamepadButtons[i]) this._emit(action);
      this._prevGamepadButtons[i] = now;
    };
    edge(0, "throttleCut");
    edge(3, "toggleStabiliser");
    edge(1, "cameraNext");
    edge(9, "pause");
  }

  /** Consumes accumulated mouse deltas (orbit/zoom). */
  consumeMouse() {
    const out = { dx: this.mouse.dx, dy: this.mouse.dy, wheel: this.mouse.wheel };
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    return out;
  }

  setEnabled(value) {
    this.enabled = value;
    if (!value) this.keys.clear();
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
    window.removeEventListener("mouseup", this._onMouseUp);
    window.removeEventListener("mousemove", this._onMouseMove);
    this.canvas.removeEventListener("mousedown", this._onMouseDown);
    this.canvas.removeEventListener("wheel", this._onWheel);
  }
}
