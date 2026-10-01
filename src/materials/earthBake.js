import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// ---------------------------------------------------------------------------
// Earth's surface and cloud maps, baked on the GPU at load.
//
// The CPU version sampled 2D noise with the sphere's coordinates folded
// together, which streaked the clouds along the meridians, and at 1024 px it
// took most of a second. Here every texel of an equirectangular map is turned
// back into a point on the unit sphere and evaluated with genuinely 3D,
// domain-warped noise — no seam, no pole pinch, no streaks — at 2048 px in a
// few milliseconds.
//
// The planet is procedural (it is not our continents), but it is built on
// Earth's actual climate structure, which is what makes a globe read as
// Earth rather than as "a blue planet":
//
// - about 29% land, with continental shelves showing as paler water;
// - deserts in the subtropical high-pressure belts near ±25°, forest in the
//   wet equatorial band and the mid-latitudes, tundra and ice at the poles;
// - clouds organised the same way: the convective band of the ITCZ near the
//   equator, clear subtropics, and swirling frontal systems in the storm
//   tracks around ±50°.
//
// Albedos are linear and real: ocean ~0.06, forest ~0.1, desert ~0.3, ice
// ~0.8. The day map's alpha channel carries the water mask.
// ---------------------------------------------------------------------------

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const noiseGLSL = /* glsl */ `
  uniform vec3 seed;
  // A uniform loop bound, so ANGLE's HLSL compiler cannot unroll fbm (slow
  // to compile, and nothing gained for a one-off bake).
  uniform int maxOctaves;

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
          mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
          mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  // Each octave is rotated so the lattice never lines up between octaves —
  // axis-aligned value noise otherwise shows its grid.
  const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  float fbm3(vec3 p, int octaves) {
    float s = 0.0, a = 0.5, n = 0.0;
    for (int i = 0; i < maxOctaves; i++) {
      if (i >= octaves) break;
      s += a * noise3(p);
      n += a;
      a *= 0.5;
      p = ROT * p * 2.02;
    }
    return s / n;
  }

  vec3 spherePoint(vec2 uv) {
    // Matches the CPU maps: longitude 0..2pi across, latitude +90 at the top.
    float lon = uv.x * 6.28318530718;
    float lat = (uv.y - 0.5) * 3.14159265359;
    return vec3(cos(lon) * cos(lat), sin(lat), sin(lon) * cos(lat));
  }
`;

const surfaceFragment = /* glsl */ `
  ${noiseGLSL}
  varying vec2 vUv;
  void main() {
    vec3 p = spherePoint(vUv);
    float lat = asin(clamp(p.y, -1.0, 1.0));
    float absLat = abs(lat) * 57.2958;

    // Continents: warped fbm, thresholded so ~29% is land.
    vec3 q = p * 1.5 + seed;
    vec3 warp = vec3(fbm3(q * 1.2 + 1.7, 4), fbm3(q * 1.2 + 9.2, 4), fbm3(q * 1.2 + 4.4, 4)) - 0.5;
    float c = fbm3(q + warp * 1.1, 8);
    const float SEA = 0.535;
    float land = smoothstep(SEA - 0.002, SEA + 0.002, c);
    float elevation = clamp((c - SEA) / 0.12, 0.0, 1.0);
    float shelf = smoothstep(SEA - 0.035, SEA, c) * (1.0 - land);

    // Moisture: wet at the equator and mid-latitudes, dry in the subtropical
    // belts, with regional variation and drier continental interiors.
    float regional = fbm3(p * 3.0 + seed * 1.7, 5);
    float wet = 0.55 + 0.45 * cos(radians(absLat) * 6.0) ;
    wet = clamp(wet * 0.8 + (regional - 0.5) * 0.9 - elevation * 0.25, 0.0, 1.0);

    vec3 forest = vec3(0.028, 0.055, 0.022);
    vec3 grass = vec3(0.075, 0.09, 0.04);
    vec3 desert = vec3(0.33, 0.24, 0.15);
    vec3 tundra = vec3(0.10, 0.10, 0.085);
    vec3 rock = vec3(0.13, 0.115, 0.10);
    vec3 ground = mix(desert, grass, smoothstep(0.25, 0.5, wet));
    ground = mix(ground, forest, smoothstep(0.55, 0.8, wet));
    ground = mix(ground, tundra, smoothstep(52.0, 64.0, absLat + (regional - 0.5) * 12.0));
    ground = mix(ground, rock, smoothstep(0.55, 0.9, elevation));
    // Fine variation — field, scrub, dune and valley — so land is never flat.
    ground *= 0.8 + 0.4 * fbm3(p * 24.0 + seed, 4);

    vec3 deep = vec3(0.010, 0.022, 0.055);
    vec3 shallow = vec3(0.020, 0.065, 0.075);
    vec3 water = mix(deep, shallow, shelf);

    vec3 col = mix(water, ground, land);

    // Polar ice, ragged at the edge; sea ice extends a little further.
    float iceLine = 72.0 + (fbm3(p * 5.0 + 3.0, 4) - 0.5) * 14.0 - land * 4.0;
    float ice = smoothstep(iceLine - 1.5, iceLine + 1.5, absLat);
    col = mix(col, vec3(0.78, 0.8, 0.84), ice);

    gl_FragColor = vec4(col, (1.0 - land) * (1.0 - ice));
  }
`;

const cloudFragment = /* glsl */ `
  ${noiseGLSL}
  varying vec2 vUv;
  void main() {
    vec3 p = spherePoint(vUv);
    float absLat = abs(asin(clamp(p.y, -1.0, 1.0))) * 57.2958;

    // General circulation: the ITCZ's convective band near the equator,
    // the clear subtropical highs, and the mid-latitude storm tracks.
    float itcz = exp(-pow((absLat - 6.0) / 9.0, 2.0)) * 0.55;
    float subtropic = exp(-pow((absLat - 25.0) / 9.0, 2.0));
    float storms = exp(-pow((absLat - 52.0) / 14.0, 2.0)) * 0.75;
    float base = 0.38 + itcz + storms - subtropic * 0.32;

    // Swirl: frontal systems wound up by a strongly warped field.
    vec3 q = p * 2.4 + seed * 2.3;
    vec3 w1 = vec3(fbm3(q + 3.1, 4), fbm3(q + 7.7, 4), fbm3(q + 1.3, 4)) - 0.5;
    vec3 w2 = vec3(fbm3(q * 2.0 + w1 * 2.0 + 5.0, 4), fbm3(q * 2.0 + w1 * 2.0 + 2.0, 4), fbm3(q * 2.0 + w1 * 2.0 + 8.0, 4)) - 0.5;
    float field = fbm3(q * 1.6 + w2 * 2.4, 7);
    // Small convective cells on top, everywhere.
    float cells = fbm3(p * 40.0 + seed, 4);

    float cover = smoothstep(0.62 - base * 0.3, 0.86 - base * 0.3, field + (cells - 0.5) * 0.18);
    cover *= 0.94;
    gl_FragColor = vec4(1.0, 1.0, 1.0, cover);
  }
`;

function bakeTarget(renderer, fragmentShader, seed, width, height) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    colorSpace: THREE.SRGBColorSpace,
    anisotropy: 8,
  });
  const material = new THREE.ShaderMaterial({
    uniforms: { seed: { value: seed }, maxOctaves: { value: 9 } },
    vertexShader: vertex,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(material);
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  quad.render(renderer);
  renderer.setRenderTarget(previous);
  quad.dispose();
  material.dispose();
  return target;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} [options]
 * @returns {{ map: THREE.Texture, clouds: THREE.Texture, dispose(): void }}
 */
export function bakeEarthMaps(renderer, { width = 2048, seed = 20240 } = {}) {
  const height = width / 2;
  const s = new THREE.Vector3((seed % 97) * 0.37, (seed % 89) * 0.21, (seed % 83) * 0.53);
  const surface = bakeTarget(renderer, surfaceFragment, s, width, height);
  const clouds = bakeTarget(renderer, cloudFragment, s.clone().multiplyScalar(1.7), width, height);
  return {
    map: surface.texture,
    clouds: clouds.texture,
    dispose() {
      surface.dispose();
      clouds.dispose();
    },
  };
}
