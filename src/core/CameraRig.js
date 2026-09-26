import * as THREE from "three";
import { applyShake } from "./shake.js";
import MouseLook from "./MouseLook.js";

// ---------------------------------------------------------------------------
// Camera modes. Chase and orbit are smoothed "external" views; cockpit rides
// the vehicle rigidly (so attitude is felt, not observed); pad is a fixed
// ground camera at the landing site; nadir looks straight down as a landing
// aid. All views are prevented from clipping through the terrain.
// ---------------------------------------------------------------------------

export const CAMERA_MODES = ["chase", "orbit", "cockpit", "pad", "nadir"];

export const CAMERA_LABELS = {
  chase: "Chase",
  orbit: "Orbit",
  cockpit: "Cockpit",
  pad: "Pad Cam",
  nadir: "Nadir",
};

const FOV = { chase: 55, orbit: 52, cockpit: 68, pad: 38, nadir: 58 };

export default class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = "chase";
    this.modeIndex = 0;

    this.distance = 26;
    this.orbitYaw = 0.6;
    this.orbitPitch = 0.32;

    // Mouse camera control. Views that orbit the vehicle swing the camera;
    // the cockpit and the fixed pad camera pan their view instead.
    this.mouse = new MouseLook();

    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._smoothLook = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._toLander = new THREE.Vector3();
    this._toPad = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._lookEuler = new THREE.Euler();
    this._lookQuat = new THREE.Quaternion();

    this.shakeAmount = 0;
    this.impulse = 0;
    this.initialised = false;
  }

  setMode(mode) {
    if (!CAMERA_MODES.includes(mode)) return;
    this.mode = mode;
    this.modeIndex = CAMERA_MODES.indexOf(mode);
    this.initialised = false;
    // Each view has its own framing, so carrying a swing across a mode change
    // would drop the player somewhere arbitrary.
    this.mouse.reset();
    this.camera.fov = FOV[mode];
    this.camera.updateProjectionMatrix();
  }

  /** Feeds a mouse drag to the active view. */
  drag(dx, dy) {
    this.mouse.applyDrag(dx, dy);
  }

  /** True where the mouse swings the camera rather than panning the view. */
  get orbits() {
    return this.mode !== "cockpit" && this.mode !== "pad";
  }

  cycleMode(dir = 1) {
    const next = (this.modeIndex + dir + CAMERA_MODES.length) % CAMERA_MODES.length;
    this.setMode(CAMERA_MODES[next]);
    return this.mode;
  }

  zoom(delta) {
    this.distance = THREE.MathUtils.clamp(this.distance + delta, 8, 160);
  }


  /** Adds a one-shot shake impulse (touchdown, crash, stage events). */
  kick(amount) {
    this.impulse = Math.min(3, this.impulse + amount);
  }

  /**
   * @param {number} dt
   * @param {Lander} lander
   * @param {Terrain} terrain
   * @param {number} elapsed
   */
  update(dt, lander, terrain, elapsed) {
    const s = lander.state;
    const focus = this._target.copy(s.position);

    // Nadir rotates the camera's up vector to keep "forward" up-screen. Every
    // other view needs it back at world up, or the horizon stays rolled over
    // after switching away from nadir.
    if (this.mode !== "nadir") this.camera.up.set(0, 1, 0);

    // Vehicle heading (yaw only) so external cameras don't roll with the
    // vehicle — that would be unusable while manoeuvring.
    this._tmp.set(0, 0, 1).applyQuaternion(s.quaternion);
    const heading = Math.atan2(this._tmp.x, this._tmp.z);

    switch (this.mode) {
      case "cockpit":
        this._updateCockpit(lander);
        break;
      case "pad":
        this._updatePad(lander, terrain, focus);
        break;
      case "nadir":
        this._updateNadir(focus, heading);
        break;
      case "orbit":
        this._updateOrbit(focus);
        break;
      default:
        this._updateChase(focus, heading, s, terrain);
        break;
    }

    // --- Mouse camera control ---------------------------------------------
    // Applied to the *desired* position, before smoothing and before the
    // terrain clamp, so a swing eases in like any other framing change and
    // still cannot be driven underground.
    if (this.orbits) {
      this.mouse.orbit(this._desired, this._lookAt);
    } else if (this.mode === "pad") {
      this.mouse.freeLook(this._lookAt, this._desired);
    }

    // --- Terrain clearance ------------------------------------------------
    if (terrain && this.mode !== "cockpit") {
      const ground = terrain.heightAt(this._desired.x, this._desired.z);
      const minY = ground + 2.2;
      if (this._desired.y < minY) this._desired.y = minY;
    }

    // --- Smoothing --------------------------------------------------------
    if (!this.initialised) {
      this._pos.copy(this._desired);
      this._smoothLook.copy(this._lookAt);
      this.initialised = true;
    } else if (this.mode === "cockpit") {
      // Rigidly attached: no smoothing, or the view lags the vehicle.
      this._pos.copy(this._desired);
      this._smoothLook.copy(this._lookAt);
    } else {
      const posLambda = this.mode === "pad" ? 6 : 4.2;
      const lookLambda = 7;
      this._pos.lerp(this._desired, 1 - Math.exp(-posLambda * dt));
      this._smoothLook.lerp(this._lookAt, 1 - Math.exp(-lookLambda * dt));
    }

    // --- Shake ------------------------------------------------------------
    // Engine vibration is structure-borne: the crew felt the DPS even though
    // they could not hear it through vacuum — so it is felt in the cockpit
    // and barely at all by an external camera. Touchdown and crash jolts are
    // the only strong shakes. See core/shake.js for why it is rotational and
    // low-frequency.
    this.impulse = Math.max(0, this.impulse - dt * 2.6);
    const engine = s.engineOn ? s.throttle : 0;
    const amount = this.impulse * 0.55 + engine * (this.mode === "cockpit" ? 0.12 : 0.03);

    this.camera.position.copy(this._pos);

    if (this.mode === "cockpit") {
      this.camera.quaternion.copy(this._cockpitQuat);
      // Look around the cabin: yaw about the head's own vertical, pitch about
      // its own lateral axis, both relative to the vehicle's attitude.
      if (this.mouse.touched) {
        this._lookEuler.set(this.mouse.pitch, this.mouse.yaw, 0, "YXZ");
        this._lookQuat.setFromEuler(this._lookEuler);
        this.camera.quaternion.multiply(this._lookQuat);
      }
    } else {
      this.camera.lookAt(this._smoothLook);
    }
    applyShake(this.camera, elapsed, amount);
  }

  _updateChase(focus, heading, s, terrain) {
    // Sits behind and above, pulling back and rising slightly with speed so
    // fast descents stay readable.
    const speed = s.velocity.length();
    const dist = this.distance * (1 + Math.min(speed / 70, 0.5));
    const height = this.distance * 0.42 + Math.min(speed * 0.35, 14);

    this._desired.set(
      focus.x - Math.sin(heading) * dist,
      focus.y + height,
      focus.z - Math.cos(heading) * dist
    );
    // Lead the look-at point downward so the landing site stays in frame.
    this._lookAt.copy(focus).addScaledVector(s.velocity, 0.35);
    this._lookAt.y -= 3;

    // Frame the pad as well as the vehicle. From behind and above, a pad that
    // is ahead and far below sits at the very bottom of the frame — under the
    // instrument cluster — exactly when the pilot most needs to see it. Aim
    // part-way toward it, but never so far that the lander leaves the frame.
    if (terrain?.padCenter) this._framePad(terrain.padCenter);
  }

  _framePad(pad) {
    const toLander = this._toLander.subVectors(this._lookAt, this._desired);
    const range = toLander.length();
    if (range < 1e-3) return;
    toLander.divideScalar(range);
    const toPad = this._toPad.subVectors(pad, this._desired);
    const padRange = toPad.length();
    if (padRange < 1e-3) return;
    toPad.divideScalar(padRange);

    // Only when the pad is in front of the camera and within approach range.
    // Both conditions fade in and out smoothly: a hard cut-off here made the
    // view whip round the moment the pad crossed the threshold.
    const ahead = toLander.dot(toPad);
    const facing = THREE.MathUtils.smoothstep(ahead, 0.15, 0.5);
    const nearness = (1 - THREE.MathUtils.smoothstep(padRange, 350, 700)) * facing;
    if (nearness <= 0) return;

    // Split the difference, capped so the lander stays inside ~40% of the
    // half-field of view from centre.
    const separation = Math.acos(THREE.MathUtils.clamp(ahead, -1, 1));
    const halfFov = THREE.MathUtils.degToRad(FOV.chase) / 2;
    const maxShift = halfFov * 0.62;
    const blend = separation > 1e-4 ? Math.min(0.5, maxShift / separation) * nearness : 0;

    toLander.lerp(toPad, blend).normalize();
    this._lookAt.copy(this._desired).addScaledVector(toLander, range);
  }

  _updateOrbit(focus) {
    const cp = Math.cos(this.orbitPitch);
    this._desired.set(
      focus.x + Math.sin(this.orbitYaw) * cp * this.distance,
      focus.y + Math.sin(this.orbitPitch) * this.distance,
      focus.z + Math.cos(this.orbitYaw) * cp * this.distance
    );
    this._lookAt.copy(focus);
  }

  _updateCockpit(lander) {
    const s = lander.state;
    // Eye point at the left-hand commander's window, looking forward and
    // down through the canted pane.
    this._tmp.set(-0.5, 1.5, 1.5).applyQuaternion(s.quaternion);
    this._desired.copy(s.position).add(this._tmp);

    this._cockpitQuat = this._cockpitQuat ?? new THREE.Quaternion();
    const pitchDown = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      THREE.MathUtils.degToRad(-22)
    );
    const faceForward = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI
    );
    this._cockpitQuat.copy(s.quaternion).multiply(faceForward).multiply(pitchDown);
    this._lookAt.copy(s.position);
  }

  _updatePad(lander, terrain, focus) {
    const pad = terrain.padCenter;
    // Stand off from the pad, on the sunlit side, framing the descent.
    const offset = new THREE.Vector3(-34, 9, 30);
    this._desired.set(pad.x + offset.x, pad.y + offset.y, pad.z + offset.z);
    // Track the vehicle, but keep the pad in frame once it is close.
    const alt = Math.max(0, lander.state.position.y - pad.y);
    const blend = THREE.MathUtils.clamp(1 - alt / 140, 0, 1);
    this._lookAt.copy(focus).lerp(pad, blend * 0.45);
  }

  _updateNadir(focus, heading) {
    this._desired.set(focus.x, focus.y + this.distance * 1.5, focus.z + 0.001);
    this._lookAt.copy(focus);
    // Keep "forward" up-screen so the view is orientable.
    this.camera.up.set(Math.sin(heading), 0, Math.cos(heading));
  }

  reset() {
    this.initialised = false;
    this.impulse = 0;
    this.mouse.reset();
    this.camera.up.set(0, 1, 0);
  }
}
