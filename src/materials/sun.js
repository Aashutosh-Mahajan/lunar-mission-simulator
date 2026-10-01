import * as THREE from "three";

// ---------------------------------------------------------------------------
// The sun, as a camera sees it.
//
// Above the atmosphere the sun is not orange and not soft: it is a white disc
// half a degree across, so bright that every photograph of it shows the
// optics' response rather than the sun — a neutral glare that falls off
// roughly as 1/r², and the diffraction spikes of the aperture. The previous
// sprite was a warm gradient that read as an orange ball.
//
// The disc is drawn in HDR (far above the bloom threshold), so the bloom pass
// produces the wide glow and anything that occludes the disc kills the glare
// with it — which a painted halo cannot do.
// ---------------------------------------------------------------------------

const SUN_ANGULAR_DIAMETER = THREE.MathUtils.degToRad(0.53);

function discTexture(size = 128) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  const radius = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c) / radius;
      // Limb darkening: the solar disc is ~40% dimmer at its edge than its
      // centre (standard u = 0.6 linear law).
      const mu = Math.sqrt(Math.max(0, 1 - Math.min(r, 1) ** 2));
      const limb = 1 - 0.6 * (1 - mu);
      const edge = THREE.MathUtils.clamp((1 - r) * radius * 0.7, 0, 1);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * limb * edge);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glareTexture(size = 256, spikes = 6) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / c;
      const dy = (y + 0.5 - c) / c;
      const r = Math.hypot(dx, dy);
      // Veiling glare: a scattered-light core with a 1/r^2 tail, faded to
      // zero at the sprite edge so it never shows a boundary.
      const fade = Math.max(0, 1 - r) ** 2;
      let a = (0.012 / (r * r + 0.012)) * fade;
      // Diffraction spikes from a six-bladed aperture: thin, long, faint.
      const ang = Math.atan2(dy, dx);
      const spoke = Math.abs(Math.cos((ang * spikes) / 2));
      a += Math.pow(spoke, 900) * 0.5 * Math.max(0, 1 - r) ** 1.5 * (0.04 / (r + 0.04));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * Math.min(1, a));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Builds a sun for a sky placed at `distance` from the camera.
 * @param {number} distance render units from the camera to the sun's sprites
 * @param {object} [options]
 * @param {number} [options.discRadiance] linear HDR radiance of the disc
 * @param {number} [options.glare] strength of the veiling glare
 * @param {number} [options.glareSize] glare sprite width as a fraction of
 *   distance
 * @param {boolean} [options.depthTest] whether terrain and vehicles occlude it
 */
export function createSun(distance, options = {}) {
  const {
    discRadiance = 60,
    glare = 2.2,
    glareSize = 0.5,
    depthTest = true,
    color = 0xfffaf2,
  } = options;

  const group = new THREE.Group();
  group.name = "sun";

  const discMap = discTexture();
  const glareMap = glareTexture();

  // The disc fills 80% of its sprite (see discTexture).
  const discWorld = (2 * Math.tan(SUN_ANGULAR_DIAMETER / 2) * distance) / 0.8;
  const discMaterial = new THREE.SpriteMaterial({
    map: discMap,
    color: new THREE.Color(color).multiplyScalar(discRadiance),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest,
    transparent: true,
    fog: false,
  });
  const disc = new THREE.Sprite(discMaterial);
  // Slightly oversized: at a few pixels across the disc would alias, and the
  // bloom pass needs some area to latch onto.
  disc.scale.setScalar(discWorld * 1.6);
  group.add(disc);

  const glareMaterial = new THREE.SpriteMaterial({
    map: glareMap,
    color: new THREE.Color(color).multiplyScalar(glare),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest,
    transparent: true,
    fog: false,
  });
  const glareSprite = new THREE.Sprite(glareMaterial);
  glareSprite.scale.setScalar(distance * glareSize);
  group.add(glareSprite);

  return {
    group,
    disc,
    glare: glareSprite,
    /** 0..1 — for fading the glare, e.g. by atmospheric extinction. */
    setStrength(k, tint = null) {
      discMaterial.color.set(color).multiplyScalar(discRadiance * k);
      glareMaterial.color.set(color).multiplyScalar(glare * k);
      if (tint) {
        discMaterial.color.multiply(tint);
        glareMaterial.color.multiply(tint);
      }
    },
    dispose() {
      discMap.dispose();
      glareMap.dispose();
      discMaterial.dispose();
      glareMaterial.dispose();
    },
  };
}
