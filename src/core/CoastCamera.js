import * as THREE from "three";
import MouseLook from "./MouseLook.js";

// ---------------------------------------------------------------------------
// Phase 3 cameras. The stack is effectively stationary against a moving
// backdrop, so these are all framing choices rather than tracking problems.
//
//   stack    three-quarter view of the CSM/LM, the default
//   earth    over the stack's shoulder, looking back at Earth
//   moon     past the stack toward the destination
//   engine   behind the SPS bell, for the burns
// ---------------------------------------------------------------------------

export const COAST_CAMERA_MODES = ["stack", "earth", "moon", "engine"];

export const COAST_CAMERA_LABELS = {
  stack: "Stack",
  earth: "Earth",
  moon: "Moon",
  engine: "Engine",
};

const FOV = { stack: 46, earth: 52, moon: 40, engine: 58 };

export default class CoastCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = "stack";
    this.modeIndex = 0;
    this.distance = 34;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._centre = new THREE.Vector3();
    this.initialised = false;
    this.orbitAngle = 0.6;

    // Everything out here is a free camera around a stationary stack, so all
    // four views orbit.
    this.mouse = new MouseLook();
  }

  /** Feeds a mouse drag to the active view. */
  drag(dx, dy) {
    this.mouse.applyDrag(dx, dy);
  }

  setMode(mode) {
    if (!COAST_CAMERA_MODES.includes(mode)) return;
    this.mode = mode;
    this.modeIndex = COAST_CAMERA_MODES.indexOf(mode);
    this.initialised = false;
    this.mouse.reset();
    this.camera.fov = FOV[mode];
    this.camera.updateProjectionMatrix();
  }

  cycleMode(dir = 1) {
    const next = (this.modeIndex + dir + COAST_CAMERA_MODES.length) % COAST_CAMERA_MODES.length;
    this.setMode(COAST_CAMERA_MODES[next]);
    return this.mode;
  }

  zoom(delta) {
    this.distance = THREE.MathUtils.clamp(this.distance + delta * 2, 14, 160);
  }

  /**
   * @param {number} dt
   * @param {Spacecraft} craft
   * @param {SpaceScene} space
   * @param {number} elapsed
   * @param {THREE.Vector3|null} [focus] during the arrival sequence, the LM:
   *   every view then follows it, framed against the Moon below
   */
  update(dt, craft, space, elapsed, focus = null, focusDistance = 30) {
    if (focus) {
      this._updateFollow(dt, focus, space, focusDistance);
      return;
    }
    // Middle of the stack, in the spacecraft's own frame. The craft is built
    // along its local +Y but flown lying along world +Z, so adding a world-Y
    // offset (as this used to) aimed every view at empty space beside the
    // vehicle and left it jammed into a corner of the frame.
    craft.group.updateMatrixWorld();
    const centre = craft.group.localToWorld(this._centre.set(0, craft.height * 0.45, 0));

    // A very slow drift keeps the shot alive during the long quiet stretches,
    // but it hands over the moment the player takes the camera themselves —
    // otherwise the automatic swing fights the mouse.
    if (!this.mouse.touched) this.orbitAngle += dt * 0.035;
    const a = this.orbitAngle;

    switch (this.mode) {
      case "earth": {
        const earth = space.earthPosition;
        // Put the stack between the camera and Earth.
        this._desired.copy(centre).addScaledVector(
          earth.clone().sub(centre).normalize(),
          -this.distance
        );
        this._desired.y += this.distance * 0.22;
        this._look.copy(centre).lerp(earth, 0.55);
        break;
      }
      case "moon": {
        const moon = space.moonPosition;
        this._desired.copy(centre).addScaledVector(
          moon.clone().sub(centre).normalize(),
          -this.distance
        );
        this._desired.y += this.distance * 0.18;
        this._look.copy(centre).lerp(moon, 0.6);
        break;
      }
      case "engine": {
        // Behind and below the bell, looking forward along the stack.
        this._desired.set(
          Math.cos(a) * this.distance * 0.35,
          -this.distance * 0.85,
          Math.sin(a) * this.distance * 0.35
        ).add(craft.group.position);
        this._look.copy(centre);
        break;
      }
      default: {
        this._desired.set(
          Math.cos(a) * this.distance,
          this.distance * 0.28,
          Math.sin(a) * this.distance
        ).add(centre);
        this._look.copy(centre);
        break;
      }
    }

    // Mouse orbit, before smoothing so the swing eases in. The pivot is the
    // spacecraft itself, never the look target — the Earth and Moon views aim
    // at a point thousands of units away, and orbiting about *that* would
    // fling the camera across the system.
    this.mouse.orbit(this._desired, centre);

    if (!this.initialised) {
      this._pos.copy(this._desired);
      this.initialised = true;
    } else {
      this._pos.lerp(this._desired, 1 - Math.exp(-3.2 * dt));
    }

    this.camera.position.copy(this._pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._look);
    void elapsed;
  }

  /**
   * The arrival sequence: above and beside the LM, looking past it and down
   * at the lunar surface, so the separation and the descent burn play out
   * against the Moon.
   */
  _updateFollow(dt, focus, space, distance) {
    const toMoon = this._tmp.copy(space.moonPosition).sub(focus).normalize();
    const side = this._side ?? (this._side = new THREE.Vector3());
    side.crossVectors(toMoon, this._worldUp ?? (this._worldUp = new THREE.Vector3(0, 0, 1)));
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    // Stand on the sunlit side: from the other one both vehicles are
    // silhouettes against black space.
    if (space.sunDirection && side.dot(space.sunDirection) < 0) side.negate();
    // Eased, so the pull-in from the wide separation shot is smooth.
    this._followDistance = THREE.MathUtils.lerp(this._followDistance ?? distance, distance, 1 - Math.exp(-1.5 * dt));
    const d = this._followDistance;
    this._desired.copy(focus).addScaledVector(toMoon, -d * 0.3).addScaledVector(side, d * 0.9);
    this.mouse.orbit(this._desired, focus);
    // Look just below the subject: it sits a little above centre, with the
    // lunar surface filling the frame beneath it.
    this._look.copy(focus).addScaledVector(toMoon, d * 0.12);

    if (!this._following) {
      // Ease over from wherever the stack view was.
      this._following = true;
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
    }
    if (!this.initialised) {
      this._pos.copy(this._desired);
      this.initialised = true;
    } else {
      this._pos.lerp(this._desired, 1 - Math.exp(-2.4 * dt));
    }
    this.camera.position.copy(this._pos);
    // "Up" away from the Moon, so its surface reads as below.
    this.camera.up.copy(toMoon).negate();
    this.camera.lookAt(this._look);
  }

  reset() {
    this._following = false;
    this.initialised = false;
    this.distance = 34;
    this.orbitAngle = 0.6;
    this.mouse.reset();
    this.setMode("stack");
  }
}
