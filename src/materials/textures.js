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
  // Spacecraft skin is flat sheet with seams and faint handling marks. The
  // random pits this used to carry read as hammered metal on every vehicle.
  void rng;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      let h = fbm(noise, u * 20, v * 20, 3) * 0.03;
      // Seams are narrow grooves.
      let seam = 0;
      for (const sx of seamsX) seam = Math.max(seam, Math.exp(-Math.pow((u - sx) * size / 1.4, 2)));
      for (const sy of seamsY) seam = Math.max(seam, Math.exp(-Math.pow((v - sy) * size / 1.4, 2)));
      h -= seam * 0.75;

      height[y * size + x] = h;

      const scuff = fbm(noiseB, u * 8, v * 8, 4) * 0.5 + 0.5;
      const shade = 0.76 + scuff * 0.07 - seam * 0.3;
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

/**
 * Pad concrete: pale grey slab with expansion joints, aggregate speckle and
 * weathering stains. LC-39's hardstand was bright, almost white concrete;
 * the old material reused the lunar regolith maps, which put craters on it.
 */
export function buildConcreteMaps(seed = 3900, size = 256) {
  const noise = makeSimplex2(seed);
  const noiseB = makeSimplex2(seed + 17);
  const rng = makeRng(seed + 3);
  const height = new Float32Array(size * size);
  const canvas = makeCanvas(size);
  const img = canvas.getContext("2d").createImageData(size, size);

  // Four slabs a side per tile; joints are narrow sawn grooves.
  const slabs = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const ju = Math.abs((u * slabs) % 1 - 0.5) * 2; // 1 at a joint
      const jv = Math.abs((v * slabs) % 1 - 0.5) * 2;
      const joint = Math.max(smoothstep(0.975, 1, ju), smoothstep(0.975, 1, jv));

      const stain = fbm(noise, u * 3, v * 3, 4) * 0.5 + 0.5;
      const grain = fbm(noiseB, u * 60, v * 60, 2) * 0.5 + 0.5;
      const speck = rng() < 0.02 ? -0.08 : 0;
      // Each slab weathered slightly differently.
      const slab = fbm(noiseB, Math.floor(u * slabs) * 3.1, Math.floor(v * slabs) * 2.7, 1) * 0.04;

      const shade = clamp(0.8 - stain * 0.12 + grain * 0.05 + slab + speck - joint * 0.35, 0, 1);
      const i = (y * size + x) * 4;
      img.data[i] = shade * 255;
      img.data[i + 1] = shade * 252;
      img.data[i + 2] = shade * 244;
      img.data[i + 3] = 255;
      height[y * size + x] = grain * 0.08 - joint * 0.6;
    }
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
  return {
    map: (() => { const t = finishTexture(canvas, { srgb: true, aniso: 16 }); return t; })(),
    normalMap: finishTexture(heightToNormalMap(height, size, 2.2), { aniso: 16 }),
  };
}

/**
 * Ground map for the land around the pad, as seen from the pad and from the
 * early climb: Florida scrub and marsh, sand, the Atlantic to the east with
 * surf along the beach, and the crawlerway running west from the pad.
 * One texture spans `extent` metres, centred on the pad.
 */
export function buildCapeGroundMap(seed = 1969, size = 1024, extent = 26000) {
  const noise = makeSimplex2(seed);
  const noiseB = makeSimplex2(seed + 91);
  const canvas = makeCanvas(size);
  const img = canvas.getContext("2d").createImageData(size, size);
  const half = extent / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // World metres, x east, z south (matching the scene).
      const x = (px / size) * extent - half;
      const z = (py / size) * extent - half;

      // Coastline: roughly north-south about a kilometre east of the pad,
      // wandering with the dunes.
      const coast = 1100 + Math.sin(z * 0.00035) * 650 + fbm(noise, z * 0.0004, 3.3, 3) * 380;
      const sea = x - coast;
      let r, g, b;
      if (sea > 0) {
        // Atlantic: shallows green-blue, deepening offshore, with surf lines.
        const depth = clamp(sea / 4500, 0, 1);
        r = 0.05 + (1 - depth) * 0.06;
        g = 0.16 + (1 - depth) * 0.1;
        b = 0.24 + (1 - depth) * 0.05;
        const surf = sea < 90 ? smoothstep(90, 0, sea) * (0.5 + 0.5 * Math.sin(sea * 0.25 + z * 0.01)) : 0;
        r += surf * 0.5;
        g += surf * 0.5;
        b += surf * 0.45;
      } else if (sea > -140) {
        // Beach and dunes.
        const dune = fbm(noiseB, x * 0.01, z * 0.004, 3) * 0.5 + 0.5;
        r = 0.68 + dune * 0.08;
        g = 0.63 + dune * 0.07;
        b = 0.52 + dune * 0.05;
      } else {
        // Scrub, palmetto and marsh: patchy olive, dry tan and dark water.
        const veg = fbm(noise, x * 0.0016, z * 0.0016, 5) * 0.5 + 0.5;
        const fine = fbm(noiseB, x * 0.012, z * 0.012, 3) * 0.5 + 0.5;
        const marsh = smoothstep(0.62, 0.7, fbm(noiseB, x * 0.0005 + 7, z * 0.0005, 4) * 0.5 + 0.5);
        r = 0.16 + veg * 0.12 + fine * 0.05;
        g = 0.2 + veg * 0.11 + fine * 0.05;
        b = 0.1 + veg * 0.05;
        // Dry sandy clearings.
        const dry = smoothstep(0.66, 0.8, fine * 0.4 + veg * 0.6);
        r += dry * 0.22; g += dry * 0.18; b += dry * 0.13;
        // Marsh water: the lagoons behind the barrier island.
        r = r * (1 - marsh) + 0.06 * marsh;
        g = g * (1 - marsh) + 0.12 * marsh;
        b = b * (1 - marsh) + 0.14 * marsh;
      }

      // Crawlerway: two parallel gravel lanes running west from the pad.
      if (x < -300 && Math.abs(z) < 60) {
        const lane = Math.abs(Math.abs(z) - 22) < 14;
        if (lane) { r = 0.62; g = 0.6; b = 0.55; }
      }

      const i = (py * size + px) * 4;
      img.data[i] = clamp(r, 0, 1) * 255;
      img.data[i + 1] = clamp(g, 0, 1) * 255;
      img.data[i + 2] = clamp(b, 0, 1) * 255;
      img.data[i + 3] = 255;
    }
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
  const tex = finishTexture(canvas, { srgb: true, aniso: 16 });
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Saturn V livery. Each stage's skin is one cylinder, so its paint scheme is a
// single texture: u runs round the stage, v up it (canvas top = stage top).
// Drawn at the stage's real proportions so markings keep their shape.
// ---------------------------------------------------------------------------

const PAINT_WHITE = "#f1f0eb";
const PAINT_BLACK = "#1c1d20";

/** Alternating black/white panels in a band — the roll pattern range cameras read. */
function rollPattern(ctx, W, yTop, yBottom, segments, phase = 0) {
  const w = W / segments;
  ctx.fillStyle = PAINT_BLACK;
  for (let k = 0; k < segments; k += 2) {
    const x = ((k / segments + phase) % 1) * W;
    ctx.fillRect(x, yTop, w, yBottom - yTop);
    if (x + w > W) ctx.fillRect(x - W, yTop, w, yBottom - yTop); // wrap the seam
  }
}

/** Faint stringer lines over a band, for the corrugated skin sections. */
function stringers(ctx, W, yTop, yBottom, count, alpha) {
  ctx.fillStyle = `rgba(90, 92, 96, ${alpha})`;
  for (let k = 0; k < count; k++) ctx.fillRect((k / count) * W, yTop, 1, yBottom - yTop);
}

function seam(ctx, W, y, alpha = 0.35) {
  ctx.fillStyle = `rgba(80, 82, 86, ${alpha})`;
  ctx.fillRect(0, y - 1, W, 2);
}

/**
 * Vertical lettering, drawn with the canvas stretched to cancel the texture's
 * non-square texel aspect so the letters are the right shape on the stage.
 */
function verticalText(ctx, text, cx, yTop, letterPx, spacingPx, aspect) {
  ctx.save();
  ctx.fillStyle = PAINT_BLACK;
  ctx.font = `bold ${letterPx}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let y = yTop;
  for (const ch of text) {
    if (ch !== " ") {
      ctx.setTransform(1 / aspect, 0, 0, 1, cx, y);
      ctx.fillText(ch, 0, 0);
    }
    y += spacingPx;
  }
  ctx.restore();
}

/** US flag, `w` by `h` pixels in world proportion, top-left at (x, y). */
function flag(ctx, x, y, w, h) {
  const stripe = h / 13;
  for (let i = 0; i < 13; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#b22234" : "#f5f5f0";
    ctx.fillRect(x, y + i * stripe, w, Math.ceil(stripe));
  }
  ctx.fillStyle = "#3c3b6e";
  ctx.fillRect(x, y, w * 0.4, stripe * 7);
}

function liveryTexture(canvas) {
  const tex = finishTexture(canvas, { srgb: true, aniso: 16 });
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * @param {'sic'|'sii'|'sivb'} stage
 * @param {number} length stage skin length, m
 * @param {number} radius m
 */
export function buildSaturnLivery(stage, length, radius) {
  const circumference = Math.PI * 2 * radius;
  const W = 1024;
  const H = stage === "sic" ? 2048 : 1024;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAINT_WHITE;
  ctx.fillRect(0, 0, W, H);

  // Height above the stage base (m) to canvas y, and metres to pixels.
  const Y = (h) => (1 - h / length) * H;
  const pxPerMu = W / circumference; // round the stage
  const pxPerMv = H / length; // up the stage
  const aspect = pxPerMu / pxPerMv;

  if (stage === "sic") {
    // Corrugated skin on the thrust structure, intertank and forward skirt.
    stringers(ctx, W, Y(5.8), Y(0), 216, 0.18);
    stringers(ctx, W, Y(23.7), Y(19.5), 216, 0.18);
    stringers(ctx, W, Y(42.1), Y(38.5), 216, 0.18);
    rollPattern(ctx, W, Y(5.8), Y(0), 8, 1 / 16);
    rollPattern(ctx, W, Y(23.7), Y(19.5), 8, 1 / 16);
    rollPattern(ctx, W, Y(42.1), Y(38.5), 8, 1 / 16);
    for (const h of [5.8, 19.5, 23.7, 38.5]) seam(ctx, W, Y(h));
    // Tank weld lines.
    for (const h of [9.5, 13.5, 17.0, 27.5, 31.5, 35.0]) seam(ctx, W, Y(h), 0.12);

    // "UNITED STATES" down two opposite sides, the flag above each.
    const letter = 1.45 * pxPerMv;
    for (const u of [0.25, 0.75]) {
      const cx = u * W;
      flag(ctx, cx - 1.5 * pxPerMu, Y(37.2), 3.0 * pxPerMu, 1.95 * pxPerMv);
      verticalText(ctx, "UNITED STATES", cx, Y(34.4), letter, 1.72 * pxPerMv, aspect);
    }
  } else if (stage === "sii") {
    // Interstage skirt at the bottom, the stage's forward skirt at the top.
    stringers(ctx, W, Y(5.6), Y(0), 216, 0.16);
    stringers(ctx, W, Y(length), Y(length - 2.6), 216, 0.16);
    rollPattern(ctx, W, Y(length), Y(length - 2.6), 8, 1 / 16);
    ctx.fillStyle = PAINT_BLACK;
    ctx.fillRect(0, Y(5.75), W, Math.max(2, 0.3 * pxPerMv));
    for (const h of [5.6, length - 2.6]) seam(ctx, W, Y(h));
    for (const h of [9.5, 14.0, 18.5]) seam(ctx, W, Y(h), 0.1);
  } else {
    // S-IVB: aft skirt roll pattern; a thin forward band.
    stringers(ctx, W, Y(3.0), Y(0), 144, 0.16);
    stringers(ctx, W, Y(length), Y(length - 1.4), 144, 0.16);
    rollPattern(ctx, W, Y(3.0), Y(0), 8, 1 / 16);
    ctx.fillStyle = PAINT_BLACK;
    ctx.fillRect(0, Y(length - 0.6), W, 0.35 * pxPerMv);
    for (const h of [3.0, length - 1.4]) seam(ctx, W, Y(h));
  }

  return liveryTexture(canvas);
}

/**
 * Service module skin: bare aluminium with the white-painted radiator panels
 * that rejected the fuel cells' heat, and an "UNITED STATES" legend.
 */
export function buildServiceModuleLivery(length = 3.9, radius = 1.96) {
  const W = 1024;
  const H = 512;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#b9bcbf";
  ctx.fillRect(0, 0, W, H);
  // Radiator panels: two large white fields with fine tube lines.
  for (const [u0, u1] of [[0.05, 0.3], [0.55, 0.8]]) {
    ctx.fillStyle = "#e9e9e4";
    ctx.fillRect(u0 * W, H * 0.12, (u1 - u0) * W, H * 0.76);
    ctx.fillStyle = "rgba(120,120,120,0.25)";
    for (let x = u0 * W; x < u1 * W; x += 6) ctx.fillRect(x, H * 0.12, 1, H * 0.76);
  }
  // Panel seams.
  ctx.fillStyle = "rgba(60,62,66,0.5)";
  for (let k = 0; k < 6; k++) ctx.fillRect((k / 6) * W, 0, 2, H);
  ctx.fillRect(0, H * 0.1, W, 2);
  ctx.fillRect(0, H * 0.9, W, 2);
  // Legend across one of the bare panels.
  const pxPerMu = W / (Math.PI * 2 * radius);
  const pxPerMv = H / length;
  ctx.save();
  ctx.fillStyle = PAINT_BLACK;
  ctx.font = `bold ${Math.round(0.28 * pxPerMv)}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.setTransform(pxPerMu / pxPerMv, 0, 0, 1, 0.425 * W, H * 0.5);
  ctx.fillText("UNITED STATES", 0, 0);
  ctx.restore();
  return liveryTexture(canvas);
}

/**
 * Normal map for a regeneratively cooled nozzle: the F-1's chamber and bell
 * were brazed from 178 coolant tubes, which is why real bells look ribbed.
 */
export function buildTubeWallNormal(tubes = 178) {
  const W = 2048;
  const H = 4;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  for (let x = 0; x < W; x++) {
    // Slope of a row of round tubes: the derivative of |sin|.
    const phase = (x / W) * tubes * Math.PI;
    const slope = Math.cos(phase) * Math.sign(Math.sin(phase)) * 0.7;
    const len = Math.hypot(slope, 1);
    const nx = -slope / len;
    const nz = 1 / len;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = 128;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finishTexture(canvas, { aniso: 16 });
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
