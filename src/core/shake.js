import * as THREE from "three";

// ---------------------------------------------------------------------------
// Camera shake, shared by every camera rig.
//
// Three rules, each fixing a way the old shake made the picture unwatchable:
//
//  1. Low frequency only. The old shake summed sines at 10-35 Hz. A 60 fps
//     display can only show motion below 30 Hz; anything faster aliases into
//     random frame-to-frame twitching instead of reading as vibration. Real
//     camera shake — a tripod in a rocket's acoustic field, an airframe in
//     buffet — is dominated by a few hertz.
//  2. Rotational, not positional. A camera rattling on its mount turns; it
//     does not jump metres sideways. Rotating also leaves the framing where
//     the rig put it, so the subject stays in shot.
//  3. Measured in screen space. The shake is specified as a fraction of the
//     field of view, so a telephoto tracker at 2 degrees does not shake
//     twenty-five times harder on screen than a wide chase view.
// ---------------------------------------------------------------------------

// Incommensurate frequencies (Hz) so the motion never visibly repeats. All
// well under the 30 Hz a 60 fps display can show.
const FREQ = [
  [1.7, 3.9, 6.1],
  [2.3, 4.7, 7.3],
  [1.1, 3.1, 5.3],
];
const WEIGHT = [0.55, 0.3, 0.15];

const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _quat = new THREE.Quaternion();

/**
 * Smooth pseudo-random value in roughly [-1, 1] for one axis.
 * @param {number} t seconds
 * @param {number} axis 0..2
 */
function wobble(t, axis) {
  const f = FREQ[axis];
  const phase = axis * 1.917;
  let v = 0;
  for (let i = 0; i < 3; i++) {
    v += Math.sin((t * f[i] + phase + i * 0.37) * Math.PI * 2) * WEIGHT[i];
  }
  return v;
}

/**
 * Applies shake to a camera that has already been aimed.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {number} time seconds (a steady clock, not frame count)
 * @param {number} amount 0..1+, where 1 is a hard jolt
 * @param {object} [opts]
 * @param {number} [opts.maxFraction] peak shake as a fraction of the vertical
 *   field of view at amount = 1 (default 0.012, about 0.66 deg at 55 deg)
 * @param {number} [opts.roll] how much of that goes into roll (default 0.5)
 */
export function applyShake(camera, time, amount, { maxFraction = 0.012, roll = 0.5 } = {}) {
  if (!(amount > 0.0005)) return;
  const peak = THREE.MathUtils.degToRad(camera.fov) * maxFraction * Math.min(amount, 1.5);
  _euler.set(wobble(time, 0) * peak, wobble(time, 1) * peak, wobble(time, 2) * peak * roll);
  _quat.setFromEuler(_euler);
  camera.quaternion.multiply(_quat);
}
