import * as THREE from "three";
import { applyShake } from "./shake.js";
import MouseLook from "./MouseLook.js";

// ---------------------------------------------------------------------------
// Launch cameras. Ascent needs a different set from the descent: the classic
// pad and tracking views that make a launch legible, plus onboard views.
//
//   pad       fixed at the pad, pans up to follow — the iconic liftoff shot
//   tracking  long-lens ground tracker, falls behind as the vehicle climbs
//   chase     rides alongside, framing the stack against the sky
//   onboard   looks back down the vehicle at the plume and the receding Earth
//   nose      forward from the spacecraft, toward the horizon it is chasing
// ---------------------------------------------------------------------------

export const ASCENT_CAMERA_MODES = ["pad", "tracking", "chase", "onboard", "nose"];

export const ASCENT_CAMERA_LABELS = {
  pad: "Pad Cam",
  tracking: "Tracker",
  chase: "Chase",
  onboard: "Onboard",
  nose: "Forward",
};

const FOV = { pad: 42, tracking: 18, chase: 48, onboard: 62, nose: 65 };

// Tracker auto-zoom: the frame height covers this many vehicle lengths (the
// stack plus a good length of plume), never narrower than TRACKER_MIN_FOV.
const TRACKER_FRAMING = 3.2;
const TRACKER_MIN_FOV = 0.35; // degrees

// Within this range of the vehicle, a ground camera takes the full acoustic
// shake; beyond it the shake falls off with distance.
const ACOUSTIC_RANGE = 400; // m

export default class AscentCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = "pad";
    this.modeIndex = 0;
    this.distance = 90;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    // Camera position relative to the vehicle, for the flying camera modes.
    this._offset = new THREE.Vector3();

    // Ground camera positions, in metres from the pad.
    this.padCamPos = new THREE.Vector3(-55, 14, 78);
    this.trackerPos = new THREE.Vector3(-1800, 30, 2600);

    this.impulse = 0;
    this.initialised = false;
    this.autoSwitched = new Set();

    // Chase swings around the vehicle; the ground cameras and the onboard
    // mounts cannot move, so they pan instead.
    this.mouse = new MouseLook();
  }

  /** Feeds a mouse drag to the active view. */
  drag(dx, dy) {
    this.mouse.applyDrag(dx, dy);
  }

  /** True where the mouse swings the camera rather than panning the view. */
  get orbits() {
    return this.mode === "chase";
  }

  setMode(mode) {
    if (!ASCENT_CAMERA_MODES.includes(mode)) return;
    this.mode = mode;
    this.modeIndex = ASCENT_CAMERA_MODES.indexOf(mode);
    this.initialised = false;
    this.mouse.reset();
    this.camera.fov = FOV[mode];
    this.camera.updateProjectionMatrix();
  }

  cycleMode(dir = 1) {
    const next = (this.modeIndex + dir + ASCENT_CAMERA_MODES.length) % ASCENT_CAMERA_MODES.length;
    this.setMode(ASCENT_CAMERA_MODES[next]);
    return this.mode;
  }

  zoom(delta) {
    this.distance = THREE.MathUtils.clamp(this.distance + delta * 6, 30, 600);
  }

  kick(amount) {
    this.impulse = Math.min(4, this.impulse + amount);
  }

  /**
   * Hands off from the pad camera automatically once the vehicle has climbed
   * out of its useful range, the way a real range does between cameras.
   */
  autoHandoff(altitude) {
    if (this.mode === "pad" && altitude > 1400 && !this.autoSwitched.has("tracking")) {
      this.autoSwitched.add("tracking");
      this.setMode("tracking");
      return "tracking";
    }
    if (this.mode === "tracking" && altitude > 26000 && !this.autoSwitched.has("chase")) {
      this.autoSwitched.add("chase");
      this.setMode("chase");
      return "chase";
    }
    return null;
  }

  /**
   * @param {number} dt
   * @param {object} state ascent physics state
   * @param {THREE.Vector3} vehiclePos world position of the burning stage base
   * @param {number} vehicleHeight metres of stack above that point
   * @param {number} elapsed
   */
  update(dt, state, vehiclePos, vehicleHeight, elapsed) {
    // Aim at the middle of the remaining stack, not its base.
    const pitchRad = THREE.MathUtils.degToRad(state.pitch);
    this._tmp.set(Math.cos(pitchRad), Math.sin(pitchRad), 0).multiplyScalar(vehicleHeight * 0.45);
    this._target.copy(vehiclePos).add(this._tmp);

    switch (this.mode) {
      case "tracking":
        this._desired.copy(this.trackerPos);
        this._look.copy(this._target);
        break;

      case "chase": {
        // Sits off the vehicle's flank, holding it against the sky.
        const back = this._tmp.set(Math.cos(pitchRad), Math.sin(pitchRad), 0).multiplyScalar(-this.distance * 0.6);
        this._desired.copy(this._target).add(back);
        this._desired.z += this.distance * 0.85;
        this._desired.y += this.distance * 0.12;
        this._look.copy(this._target);
        break;
      }

      case "onboard": {
        // Mounted on the stack looking aft, down the plume.
        const up = this._tmp.set(Math.cos(pitchRad), Math.sin(pitchRad), 0);
        this._desired.copy(vehiclePos).addScaledVector(up, vehicleHeight * 0.62);
        this._desired.z += 7.5;
        this._look.copy(vehiclePos).addScaledVector(up, -40);
        break;
      }

      case "nose": {
        const up = this._tmp.set(Math.cos(pitchRad), Math.sin(pitchRad), 0);
        this._desired.copy(vehiclePos).addScaledVector(up, vehicleHeight + 6);
        this._look.copy(this._desired).addScaledVector(up, 400);
        // Bias the view forward along the flight path so the horizon shows.
        this._look.x += Math.cos(pitchRad) * 900;
        break;
      }

      default: // pad
        this._desired.copy(this.padCamPos);
        this._look.copy(this._target);
        break;
    }

    // Mouse control, applied before smoothing so a swing eases in.
    if (this.orbits) {
      this.mouse.orbit(this._desired, this._look);
    } else {
      this.mouse.freeLook(this._look, this._desired);
    }

    const fixed = this.mode === "pad" || this.mode === "tracking";

    if (fixed) {
      // Ground cameras don't move at all.
      this._pos.copy(this._desired);
      this._offset.set(0, 0, 0);
      this.initialised = true;
    } else {
      // Flying cameras smooth their offset *relative to the vehicle*, never
      // their world position. Smoothing in world space cannot work here: at
      // 2.5 km/s an exponential follow lags hundreds of metres behind and the
      // vehicle shrinks to a dot. Relative smoothing keeps the vehicle pinned
      // in frame while the framing itself still eases.
      this._tmp.subVectors(this._desired, this._target);
      if (!this.initialised) {
        this._offset.copy(this._tmp);
        this.initialised = true;
      } else {
        const lambda = this.mode === "chase" ? 2.4 : 14;
        this._offset.lerp(this._tmp, 1 - Math.exp(-lambda * dt));
      }
      this._pos.copy(this._target).add(this._offset);
    }

    // --- Tracker zoom --------------------------------------------------------
    // Range cameras were long-lens telescopes with an operator riding the
    // zoom. A fixed lens left the Saturn V a few pixels tall within a minute
    // of liftoff; this keeps the stack and its plume at a steady size.
    if (this.mode === "tracking") {
      const range = Math.max(1, this._pos.distanceTo(this._target));
      const framed = vehicleHeight * TRACKER_FRAMING;
      const want = THREE.MathUtils.radToDeg(2 * Math.atan(framed / (2 * range)));
      const fov = THREE.MathUtils.clamp(want, TRACKER_MIN_FOV, FOV.tracking);
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-2.5 * dt));
      this.camera.updateProjectionMatrix();
    }

    // --- Shake -------------------------------------------------------------
    // Driven by what physically shakes each camera (see core/shake.js for the
    // rotational, low-frequency, lens-relative form).
    //
    //   Ground cameras (pad, tracker): the acoustic field of five F-1s, which
    //     falls off with range and only exists near the ground.
    //   Onboard views: structure-borne engine vibration, plus aerodynamic
    //     buffet that peaks with dynamic pressure around max-Q.
    //   The chase view is a virtual camera flying alongside: it shakes only
    //     for events — ignition, liftoff, staging.
    //
    // Previously every view got the acoustic term, capped at a 2.5 m
    // positional offset at 10-35 Hz: the chase view moved 3.7 m and 2 degrees
    // every frame, all the way to orbit.
    this.impulse = Math.max(0, this.impulse - dt * 2.2);
    let amount = this.impulse * 0.45;
    const firing = state.engineOn ? state.throttle : 0;
    if (this.mode === "pad" || this.mode === "tracking") {
      const range = this._pos.distanceTo(vehiclePos);
      amount += firing * THREE.MathUtils.clamp(ACOUSTIC_RANGE / Math.max(range, 1), 0, 1) * 0.55;
    } else if (this.mode === "onboard" || this.mode === "nose") {
      const q = this._dynamicPressure ?? 0;
      amount += firing * 0.1 + THREE.MathUtils.clamp(q / 35000, 0, 1) * 0.35;
    }

    this.camera.position.copy(this._pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._look);
    applyShake(this.camera, elapsed, amount);
  }

  /** Dynamic pressure, Pa, for the onboard buffet. Set by the shell. */
  setDynamicPressure(q) {
    this._dynamicPressure = q;
  }

  reset() {
    this.initialised = false;
    this.impulse = 0;
    this.autoSwitched.clear();
    this.distance = 90;
    this.mouse.reset();
    this.setMode("pad");
  }
}
