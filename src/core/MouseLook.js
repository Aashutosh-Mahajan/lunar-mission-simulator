import * as THREE from "three";

// ---------------------------------------------------------------------------
// Shared mouse camera control.
//
// Two behaviours, which are the same operation with the roles swapped:
//
//   orbit    drag swings the camera around what it is looking at — used by
//            the free/chase views, where the subject stays centred
//   freeLook drag swings what the camera is looking at around the camera —
//            used by fixed and rigidly-mounted views (pad cameras, cockpit),
//            where the camera cannot sensibly move but panning is natural
//
// Both are implemented by rotating one point around another in spherical
// coordinates, which makes the pole clamp trivial and cannot gimbal-flip.
// ---------------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export default class MouseLook {
  /**
   * @param {object} opts
   * @param {number} opts.sensitivity radians of swing per unit of drag
   * @param {number} opts.minPhi closest approach to straight-up, radians
   * @param {number} opts.maxPhi closest approach to straight-down, radians
   */
  // Input reports drag in units of 0.005 per pixel, so this scales to roughly
  // 0.13 degrees per pixel — a full swing around the vehicle takes about a
  // screen and a half of travel, which is the rate that reads as controlled
  // rather than twitchy.
  constructor({ sensitivity = 0.45, minPhi = 0.12, maxPhi = Math.PI - 0.12 } = {}) {
    this.sensitivity = sensitivity;
    this.minPhi = minPhi;
    this.maxPhi = maxPhi;
    this.yaw = 0;
    this.pitch = 0;
    this.touched = false;

    this._spherical = new THREE.Spherical();
    this._offset = new THREE.Vector3();
  }

  /** Accumulates a drag. dx/dy come from Input in normalised units. */
  applyDrag(dx, dy) {
    if (dx === 0 && dy === 0) return;
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    // Keep the accumulated pitch inside a half-turn so the clamp below is the
    // only thing limiting it.
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI * 0.49, Math.PI * 0.49);
    this.touched = true;
  }

  reset() {
    this.yaw = 0;
    this.pitch = 0;
    this.touched = false;
  }

  /** True once the player has actually moved the camera. */
  get isActive() {
    return this.touched && (this.yaw !== 0 || this.pitch !== 0);
  }

  /**
   * Rotates `point` around `pivot` by the accumulated yaw/pitch, in place.
   * @param {THREE.Vector3} point mutated
   * @param {THREE.Vector3} pivot
   */
  rotateAround(point, pivot) {
    if (!this.touched) return point;

    this._offset.subVectors(point, pivot);
    const length = this._offset.length();
    if (length < 1e-5) return point;

    this._spherical.setFromVector3(this._offset);
    this._spherical.theta += this.yaw;
    // phi is measured from +Y, so dragging up (positive pitch) must decrease it.
    this._spherical.phi = THREE.MathUtils.clamp(
      this._spherical.phi - this.pitch,
      this.minPhi,
      this.maxPhi
    );
    this._spherical.radius = length;
    this._offset.setFromSpherical(this._spherical);

    return point.copy(pivot).add(this._offset);
  }

  /** Convenience: swing the camera around its subject. */
  orbit(cameraPos, lookTarget) {
    return this.rotateAround(cameraPos, lookTarget);
  }

  /** Convenience: pan the view without moving the camera. */
  freeLook(lookTarget, cameraPos) {
    return this.rotateAround(lookTarget, cameraPos);
  }
}

export { WORLD_UP };
