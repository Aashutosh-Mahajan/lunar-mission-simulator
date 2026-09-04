import * as THREE from "three";
import { makeSimplex2, makeRng, fbm, ridged, clamp, smoothstep, lerp } from "./noise.js";

// All textures are baked procedurally at load time — the project ships no
// binary image assets, so everything (regolith, thermal foil, Earth) is
// generated from the noise primitives in noise.js.

function makeCanvas(size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function finishTexture(canvas, { repeat = 1, srgb = false, aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Converts a height field into a tangent-space normal map via central
 * differences (Sobel-lite). `strength` scales the slope.
 */
function heightToNormalMap(height, size, strength) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normal of the height field: (-dh/dx, -dh/dy, 1), normalised.
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Regolith surface maps. Lunar soil is a very dark, spectrally flat powder
 * (albedo ~0.11-0.14 for mare) that looks bright only because the sun is
 * unfiltered; the albedo map is therefore dark grey with subtle warm/cool
 * mottling, and micro-craters + rock fragments are baked into the height map.
 */
export function buildRegolithMaps(seed = 1337, size = 512) {
  const noise = makeSimplex2(seed);
  const noiseB = makeSimplex2(seed + 991);
  const rng = makeRng(seed + 7);

  const height = new Float32Array(size * size);
  const albedoCanvas = makeCanvas(size);
  const roughCanvas = makeCanvas(size);
  const aCtx = albedoCanvas.getContext("2d");
  const rCtx = roughCanvas.getContext("2d");
  const aImg = aCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);

  // Micro-crater field baked into the detail height map. Small craters are far
  // too numerous to model as geometry, so they live in the normal map instead.
  const craterCount = 260;
  const craters = [];
  for (let i = 0; i < craterCount; i++) {
    craters.push({
      x: rng() * size,
      y: rng() * size,
      r: 2 + rng() * rng() * 26,
      depth: 0.35 + rng() * 0.65,
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // Base powdery undulation plus a fractured, ridged component.
      let h = fbm(noise, u * 7, v * 7, 5) * 0.5;
      h += ridged(noiseB, u * 13, v * 13, 4) * 0.28;
      // Fine grain — the "sandpaper" frequency.
      h += fbm(noiseB, u * 48, v * 48, 3) * 0.12;

      // Stamp micro-craters, with the raised rim real impacts leave.
      for (const c of craters) {
        let dx = x - c.x;
        let dy = y - c.y;
        // Wrap so the tile stays seamless.
        if (dx > size / 2) dx -= size;
        if (dx < -size / 2) dx += size;
        if (dy > size / 2) dy -= size;
        if (dy < -size / 2) dy += size;
        const d = Math.hypot(dx, dy);
        if (d < c.r * 1.5) {
          const t = d / c.r;
          if (t < 1) {
            // Parabolic bowl.
            h -= c.depth * (1 - t * t) * 0.75;
          }
          // Raised rim just outside the bowl.
          const rim = Math.exp(-((t - 1.05) * (t - 1.05)) / 0.06);
          h += c.depth * rim * 0.3;
        }
      }

      height[y * size + x] = h;

      // --- Albedo -----------------------------------------------------
      // Dark basaltic grey; slight warm tint where the soil is churned and
      // cooler where fresher material is exposed.
      const mottle = fbm(noise, u * 4 + 11, v * 4 + 3, 4);
      const fresh = smoothstep(0.35, 0.85, ridged(noiseB, u * 9, v * 9, 3));
      let base = 0.115 + mottle * 0.035 + fresh * 0.05;
      // Slope-driven darkening approximation: pits read darker.
      base += clamp(h, -1, 1) * 0.02;
      base = clamp(base, 0.06, 0.26);

      // Convert linear reflectance to an 8-bit sRGB-ish value.
      const srgb = Math.pow(base, 1 / 2.2) * 255;
      const warm = 1 + mottle * 0.05;
      const i = (y * size + x) * 4;
      aImg.data[i] = clamp(srgb * warm, 0, 255);
      aImg.data[i + 1] = clamp(srgb * (1 + mottle * 0.02), 0, 255);
      aImg.data[i + 2] = clamp(srgb * (1 - mottle * 0.03), 0, 255);
      aImg.data[i + 3] = 255;

      // --- Roughness --------------------------------------------------
      // Powder is almost perfectly diffuse; glassy agglutinates and impact
      // melt give a few slightly smoother speckles.
      const glass = smoothstep(0.72, 0.95, fbm(noiseB, u * 34, v * 34, 3) * 0.5 + 0.5);
      const rough = clamp(0.97 - glass * 0.35, 0, 1) * 255;
      rImg.data[i] = rough;
      rImg.data[i + 1] = rough;
      rImg.data[i + 2] = rough;
      rImg.data[i + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);
  const normalCanvas = heightToNormalMap(height, size, 2.6);

  return {
    map: finishTexture(albedoCanvas, { repeat: 1, srgb: true }),
    normalMap: finishTexture(normalCanvas, { repeat: 1 }),
    roughnessMap: finishTexture(roughCanvas, { repeat: 1 }),
  };
}

/**
 * Crumpled multi-layer insulation (the gold/amber foil that wrapped the LM
 * descent stage). Wrinkles are ridged noise; the sheen comes from a low
 * roughness with strong normal detail.
 */
export function buildFoilMaps(seed = 4242, size = 256, tint = [1.0, 0.72, 0.26]) {
  const noise = makeSimplex2(seed);
  const noiseB = makeSimplex2(seed + 17);
  const height = new Float32Array(size * size);
  const albedoCanvas = makeCanvas(size);
  const roughCanvas = makeCanvas(size);
  const aImg = albedoCanvas.getContext("2d").createImageData(size, size);
  const rImg = roughCanvas.getContext("2d").createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Sharp creases at a few scales — foil folds rather than undulates.
      let h = ridged(noise, u * 6, v * 6, 3, 2.3, 0.55) * 0.7;
      h += ridged(noiseB, u * 18, v * 18, 2) * 0.3;
      h += fbm(noise, u * 40, v * 40, 2) * 0.08;
      height[y * size + x] = h;

      const shade = 0.62 + h * 0.5;
      const i = (y * size + x) * 4;
      aImg.data[i] = clamp(255 * tint[0] * shade, 0, 255);
      aImg.data[i + 1] = clamp(255 * tint[1] * shade, 0, 255);
      aImg.data[i + 2] = clamp(255 * tint[2] * shade, 0, 255);
      aImg.data[i + 3] = 255;

      // Creases catch light: crest = glossier, valley = duller.
      const r = clamp(0.42 - h * 0.22, 0.08, 0.9) * 255;
      rImg.data[i] = r;
      rImg.data[i + 1] = r;
      rImg.data[i + 2] = r;
      rImg.data[i + 3] = 255;
    }
  }

  albedoCanvas.getContext("2d").putImageData(aImg, 0, 0);
  roughCanvas.getContext("2d").putImageData(rImg, 0, 0);

  return {
    map: finishTexture(albedoCanvas, { srgb: true }),
    normalMap: finishTexture(heightToNormalMap(height, size, 3.4), {}),
    roughnessMap: finishTexture(roughCanvas, {}),
  };
}

/**
 * Painted/anodised spacecraft panel with faint panel lines, scuffing and
 * micrometeorite pitting. Used for the ascent stage and structural members.
 */
export function buildPanelMaps(seed = 909, size = 256) {
  const noise = makeSimplex2(seed);
  const noiseB = makeSimplex2(seed + 313);
  const rng = makeRng(seed + 5);
  const height = new Float32Array(size * size);
  const albedoCanvas = makeCanvas(size);
  const roughCanvas = makeCanvas(size);
  const aImg = albedoCanvas.getContext("2d").createImageData(size, size);
  const rImg = roughCanvas.getContext("2d").createImageData(size, size);

  // Panel seam grid positions.
  const seamsX = [0.18, 0.5, 0.77];
  const seamsY = [0.31, 0.66];
  const pits = [];
  for (let i = 0; i < 90; i++) pits.push({ x: rng() * size, y: rng() * size, r: 0.6 + rng() * 2.4 });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      let h = fbm(noise, u * 20, v * 20, 3) * 0.12;
      // Seams are narrow grooves.
      let seam = 0;
      for (const sx of seamsX) seam = Math.max(seam, Math.exp(-Math.pow((u - sx) * size / 1.4, 2)));
      for (const sy of seamsY) seam = Math.max(seam, Math.exp(-Math.pow((v - sy) * size / 1.4, 2)));
      h -= seam * 0.75;

      for (const p of pits) {
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < p.r) h -= (1 - d / p.r) * 0.5;
      }
      height[y * size + x] = h;

      const scuff = fbm(noiseB, u * 8, v * 8, 4) * 0.5 + 0.5;
      const shade = 0.70 + scuff * 0.16 - seam * 0.35;
      const i = (y * size + x) * 4;
      aImg.data[i] = clamp(255 * shade * 0.98, 0, 255);
      aImg.data[i + 1] = clamp(255 * shade * 0.99, 0, 255);
      aImg.data[i + 2] = clamp(255 * shade, 0, 255);
      aImg.data[i + 3] = 255;

      const r = clamp(0.5 + scuff * 0.3 + seam * 0.2, 0, 1) * 255;
      rImg.data[i] = r;
      rImg.data[i + 1] = r;
      rImg.data[i + 2] = r;
      rImg.data[i + 3] = 255;
    }
  }

  albedoCanvas.getContext("2d").putImageData(aImg, 0, 0);
  roughCanvas.getContext("2d").putImageData(rImg, 0, 0);

  return {
    map: finishTexture(albedoCanvas, { srgb: true }),
    normalMap: finishTexture(heightToNormalMap(height, size, 2.2), {}),
    roughnessMap: finishTexture(roughCanvas, {}),
  };
}

/**
 * Earth as seen from the Moon: oceans, noise-derived landmasses, ice caps and
 * a separate cloud layer. Not cartographically accurate — a plausible
 * water-world, which is all that is legible at this apparent size (~2°).
 */
export function buildEarthMaps(seed = 20240, size = 512) {
  const cont = makeSimplex2(seed);
  const detail = makeSimplex2(seed + 41);
  const cloudN = makeSimplex2(seed + 777);

  const dayCanvas = makeCanvas(size);
  const cloudCanvas = makeCanvas(size);
  const dImg = dayCanvas.getContext("2d").createImageData(size, size);
  const cImg = cloudCanvas.getContext("2d").createImageData(size, size);

  for (let y = 0; y < size; y++) {
    // Equirectangular: latitude from +90 at top to -90 at bottom.
    const lat = (0.5 - y / size) * Math.PI;
    const cosLat = Math.cos(lat);
    for (let x = 0; x < size; x++) {
      const lon = (x / size) * Math.PI * 2;
      // Sample on the sphere so the map wraps without a seam.
      const sx = Math.cos(lon) * cosLat;
      const sy = Math.sin(lat);
      const sz = Math.sin(lon) * cosLat;

      const landRaw =
        fbm(cont, sx * 1.6 + 3, sz * 1.6 + sy * 1.2, 5) +
        fbm(detail, sx * 4.5, sz * 4.5 + sy * 2.0, 4) * 0.35;
      const land = landRaw > 0.06;
      const i = (y * size + x) * 4;

      let r;
      let g;
      let b;
      if (land) {
        const elev = smoothstep(0.06, 0.55, landRaw);
        const arid = fbm(detail, sx * 7 + 9, sz * 7, 3) * 0.5 + 0.5;
        // Vegetation green → arid tan → high-elevation grey.
        r = lerp(lerp(56, 150, arid), 128, elev);
        g = lerp(lerp(92, 128, arid), 122, elev);
        b = lerp(lerp(48, 84, arid), 112, elev);
      } else {
        // Shallow shelf → deep ocean.
        const depth = smoothstep(-0.5, 0.06, landRaw);
        r = lerp(6, 26, depth);
        g = lerp(24, 74, depth);
        b = lerp(62, 122, depth);
      }

      // Polar ice.
      const ice = smoothstep(0.78, 0.94, Math.abs(Math.sin(lat)));
      r = lerp(r, 238, ice);
      g = lerp(g, 244, ice);
      b = lerp(b, 250, ice);

      dImg.data[i] = r;
      dImg.data[i + 1] = g;
      dImg.data[i + 2] = b;
      dImg.data[i + 3] = 255;

      // --- Clouds: banded by latitude like real circulation cells --------
      const band = Math.abs(Math.sin(lat * 3.1)) * 0.45 + 0.55;
      let c = fbm(cloudN, sx * 3.2, sz * 3.2 + sy * 1.6, 5) * 0.5 + 0.5;
      c = smoothstep(0.46, 0.78, c * band);
      cImg.data[i] = 255;
      cImg.data[i + 1] = 255;
      cImg.data[i + 2] = 255;
      cImg.data[i + 3] = c * 235;
    }
  }

  dayCanvas.getContext("2d").putImageData(dImg, 0, 0);
  cloudCanvas.getContext("2d").putImageData(cImg, 0, 0);

  const map = finishTexture(dayCanvas, { srgb: true });
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  const clouds = finishTexture(cloudCanvas, { srgb: true });
  clouds.wrapS = THREE.RepeatWrapping;
  clouds.wrapT = THREE.ClampToEdgeWrapping;

  return { map, clouds };
}

/** Soft radial sprite used for dust, plume and glow particles. */
export function buildGlowSprite(size = 128, hardness = 0.35) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(hardness, "rgba(255,255,255,0.55)");
  g.addColorStop(0.72, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Irregular grain sprite for lofted regolith particles. */
export function buildDustSprite(size = 64, seed = 5) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const noise = makeSimplex2(seed);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      const wob = fbm(noise, x / size * 5, y / size * 5, 3) * 0.35;
      const a = clamp(1 - (d + wob) * 1.15, 0, 1);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 250;
      img.data[i + 2] = 242;
      img.data[i + 3] = Math.pow(a, 1.6) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Star field cube-face style texture is overkill; instead we build a starlight
 * gradient sprite for the sun disc with a subtle chromatic edge.
 */
export function buildSunSprite(size = 256) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.13, "rgba(255,253,245,1)");
  g.addColorStop(0.2, "rgba(255,240,214,0.75)");
  g.addColorStop(0.42, "rgba(255,214,160,0.22)");
  g.addColorStop(0.7, "rgba(255,190,130,0.06)");
  g.addColorStop(1, "rgba(255,180,120,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
