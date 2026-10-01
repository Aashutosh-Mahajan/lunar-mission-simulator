import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// ---------------------------------------------------------------------------
// The Moon's albedo and relief, baked on the GPU at load.
//
// Seen on arrival the Moon fills the view, so it has to read as *the* Moon:
//
// - Maria: dark basalt (albedo ~0.07) flooding a few huge, irregular basins,
//   against bright anorthositic highlands (~0.16).
// - Craters at every scale with a power-law size distribution: parabolic
//   bowls about a fifth as deep as they are wide, raised rims, an ejecta
//   apron, and central peaks in the big ones. The maria are younger, so
//   they carry far fewer craters.
// - A few young craters with bright ray systems, like Tycho and Copernicus.
//
// Height is baked first; albedo and a tangent-space normal map are then
// derived from it, so the low sun at the terminator rakes across real relief
// instead of a painted texture.
//
// Texel (u, v) maps to the same point on the sphere as three's
// SphereGeometry, so the normal map's tangent frame (east = +u, north = +v)
// can be rebuilt in the shader from the object-space normal.
// ---------------------------------------------------------------------------

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const common = /* glsl */ `
  uniform vec3 seed;
  // Loop bounds come from uniforms so the shader compiler cannot unroll
  // them. Unrolled, the 27-cell crater search at four scales took ANGLE's
  // HLSL compiler over a second on the loading screen.
  uniform int one;           // always 1
  uniform int maxOctaves;    // always 8
  const float PI = 3.14159265359;

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  vec3 hash33(vec3 p) {
    return vec3(hash3(p), hash3(p + 19.19), hash3(p + 47.77));
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
  const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  float fbm3(vec3 p, int octaves) {
    float s = 0.0, a = 0.5, n = 0.0;
    for (int i = 0; i < maxOctaves; i++) {
      if (i >= octaves) break;
      s += a * noise3(p);
      n += a;
      a *= 0.5;
      p = ROT * p * 2.03;
    }
    return s / n;
  }

  // three's SphereGeometry parameterisation.
  vec3 spherePoint(vec2 uv) {
    float phi = uv.x * 2.0 * PI;
    float theta = (1.0 - uv.y) * PI;
    return vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  }

  // Mare coverage, 0..1: a few great basins, centred on the near side.
  float mare(vec3 p) {
    vec3 q = p * 1.3 + seed;
    vec3 w = vec3(fbm3(q + 2.0, 3), fbm3(q + 6.0, 3), fbm3(q + 9.0, 3)) - 0.5;
    float f = fbm3(q + w * 0.9, 6);
    // The near side (facing -x here) is where the maria are.
    float nearSide = smoothstep(-0.2, 0.7, -p.x);
    // About a third of the near side and almost none of the far side, as on
    // the real Moon; shorelines soft, since lava flooded up to the highland
    // margins rather than ending at a wall.
    return smoothstep(0.515, 0.565, f + nearSide * 0.085 - 0.06);
  }

  // One octave of craters: a jittered 3D cell lattice, at most one crater
  // per cell. Returns height; 'fresh' accumulates bright ejecta/rays.
  float craterOctave(vec3 p, float cells, float density, float depthScale, inout float fresh) {
    vec3 q = p * cells;
    vec3 base = floor(q);
    float h = 0.0;
    for (int z = -one; z <= one; z++)
    for (int y = -one; y <= one; y++)
    for (int x = -one; x <= one; x++) {
      vec3 cell = base + vec3(float(x), float(y), float(z));
      vec3 rnd = hash33(cell + seed);
      if (rnd.x > density) continue;
      vec3 centre = cell + 0.2 + 0.6 * hash33(cell * 1.7 + 3.1);
      // Power law: many small, few large.
      float size = 0.12 + 0.38 * pow(hash3(cell + 7.3), 2.6);
      float d = length(q - centre) / size;
      if (d > 3.5) continue;
      // Age: fresh craters are sharp; old ones slumped and shallow.
      float age = hash3(cell + 11.1);
      float sharp = mix(1.0, 0.35, age);
      float bowl = d < 1.0 ? -(1.0 - d * d) : 0.0;
      float rim = exp(-pow((d - 1.0) / 0.18, 2.0)) * 0.22;
      float ejecta = d > 1.0 ? 0.12 * pow(1.0 / d, 3.0) : 0.0;
      float peak = size > 0.32 ? exp(-pow(d / 0.16, 2.0)) * 0.35 : 0.0;
      h += (bowl + rim + ejecta + peak) * size * depthScale * sharp;
      // Fresh material is bright: the floor and ejecta of young craters.
      fresh += (1.0 - age) * (1.0 - age) * smoothstep(2.4, 0.9, d) * 0.6;
    }
    return h;
  }

  // Ray systems from a few young craters: many thin, bright streaks of
  // ejecta thrown out radially for hundreds of kilometres, patchy along
  // their length, fading with distance.
  float rays(vec3 p) {
    float sum = 0.0;
    for (int i = 0; i < maxOctaves; i++) {
      if (i >= 4) break;
      vec3 c = normalize(hash33(seed + float(i) * 13.7) - 0.5);
      float cosAng = dot(p, c);
      if (cosAng < 0.6) continue;
      float ang = acos(clamp(cosAng, -1.0, 1.0));
      // Direction round the crater, in its tangent plane.
      vec3 t1 = normalize(cross(c, vec3(0.0, 1.0, 0.07)));
      vec3 t2 = cross(c, t1);
      vec3 d = p - c * cosAng;
      float around = atan(dot(d, t2), dot(d, t1)) + PI;
      // Two families of streaks, broken up along the ray.
      float fine = noise3(vec3(around * 46.0, float(i) * 7.0, 0.0));
      float coarse = noise3(vec3(around * 13.0, float(i) * 3.0, 5.0));
      float streak = pow(fine, 7.0) * 1.6 + pow(coarse, 6.0) * 0.8;
      streak *= 0.4 + 0.6 * noise3(vec3(around * 20.0, ang * 30.0, float(i)));
      float reach = 0.25 + 0.3 * hash3(c * 9.0);
      float radial = smoothstep(0.015, 0.03, ang) * pow(max(1.0 - ang / reach, 0.0), 1.6);
      // The bright halo of ejecta right round the rim.
      float halo = smoothstep(0.035, 0.012, ang);
      sum += streak * radial + halo * 0.7;
    }
    return sum;
  }

  float heightAt(vec3 p, out float fresh, out float m) {
    fresh = 0.0;
    m = mare(p);
    float h = 0.0;
    // Maria are younger lava plains: fewer craters, and the basins are low.
    float density = mix(1.0, 0.25, m);
    h += craterOctave(p, 5.0, 0.55 * density + 0.2, 0.9, fresh);
    h += craterOctave(p, 13.0, 0.6 * density, 0.5, fresh);
    h += craterOctave(p, 34.0, 0.65 * density, 0.25, fresh);
    h += craterOctave(p, 90.0, 0.7 * density, 0.12, fresh);
    h += (fbm3(p * 8.0 + seed, 5) - 0.5) * 0.25 * (1.0 - m * 0.7);
    // Maria lie a little low, in basins, without a cliff at the shore.
    h -= m * 0.04;
    return h;
  }
`;

const heightFragment = /* glsl */ `
  ${common}
  varying vec2 vUv;
  void main() {
    vec3 p = spherePoint(vUv);
    float fresh, m;
    float h = heightAt(p, fresh, m);
    gl_FragColor = vec4(h, fresh, m, 1.0);
  }
`;

const shadeFragment = /* glsl */ `
  ${common}
  uniform sampler2D heightMap;
  uniform vec2 texel;
  uniform float reliefScale;
  uniform int output_;     // 0 albedo, 1 normal
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(heightMap, vUv);
    vec3 p = spherePoint(vUv);
    if (output_ == 0) {
      float fresh = s.g;
      float m = s.b;
      vec3 highland = vec3(0.165, 0.158, 0.148);
      vec3 basalt = vec3(0.068, 0.067, 0.07);
      vec3 col = mix(highland, basalt, m);
      // Ilmenite-rich mare is a touch blue; highland soils a touch warm.
      col *= mix(vec3(1.02, 1.0, 0.97), vec3(0.97, 0.99, 1.04), m);
      col *= 0.85 + 0.3 * fbm3(p * 20.0 + seed, 4);
      col += vec3(0.09) * clamp(fresh, 0.0, 1.2);
      col += vec3(0.05) * rays(p);
      gl_FragColor = vec4(col, 1.0);
    } else {
      // Height differences to tangent-space slopes. Neighbours wrap in u.
      float hE = texture2D(heightMap, vUv + vec2(texel.x, 0.0)).r;
      float hW = texture2D(heightMap, vUv - vec2(texel.x, 0.0)).r;
      float hN = texture2D(heightMap, vUv + vec2(0.0, texel.y)).r;
      float hS = texture2D(heightMap, vUv - vec2(0.0, texel.y)).r;
      // Texel spacing on the unit sphere: east shrinks with latitude.
      float sinTheta = max(sin((1.0 - vUv.y) * PI), 0.02);
      float dx = 2.0 * texel.x * 2.0 * PI * sinTheta;
      float dy = 2.0 * texel.y * PI;
      vec3 n = normalize(vec3(-(hE - hW) / dx * reliefScale, -(hN - hS) / dy * reliefScale, 1.0));
      gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
    }
  }
`;

function target(width, height, { type = THREE.UnsignedByteType, colorSpace = THREE.NoColorSpace, mipmaps = true } = {}) {
  return new THREE.WebGLRenderTarget(width, height, {
    type,
    depthBuffer: false,
    generateMipmaps: mipmaps,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    colorSpace,
    anisotropy: 8,
  });
}

function draw(renderer, quad, rt) {
  renderer.setRenderTarget(rt);
  quad.render(renderer);
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{ map: THREE.Texture, normalMap: THREE.Texture, dispose(): void }}
 */
export function bakeMoonMaps(renderer, { width = 2048, seed = 1969 } = {}) {
  const height = width / 2;
  const s = new THREE.Vector3((seed % 61) * 0.41, (seed % 59) * 0.29, (seed % 53) * 0.37);
  const previous = renderer.getRenderTarget();

  const heightRT = target(width, height, { type: THREE.HalfFloatType, mipmaps: false });
  const loops = { one: { value: 1 }, maxOctaves: { value: 8 } };
  const heightMat = new THREE.ShaderMaterial({
    uniforms: { seed: { value: s }, ...loops },
    vertexShader: vertex,
    fragmentShader: heightFragment,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(heightMat);
  draw(renderer, quad, heightRT);

  const shadeMat = new THREE.ShaderMaterial({
    uniforms: {
      seed: { value: s },
      ...loops,
      heightMap: { value: heightRT.texture },
      texel: { value: new THREE.Vector2(1 / width, 1 / height) },
      reliefScale: { value: 0.11 },
      output_: { value: 0 },
    },
    vertexShader: vertex,
    fragmentShader: shadeFragment,
    depthTest: false,
    depthWrite: false,
  });
  quad.material = shadeMat;
  const albedoRT = target(width, height, { colorSpace: THREE.SRGBColorSpace });
  draw(renderer, quad, albedoRT);
  shadeMat.uniforms.output_.value = 1;
  const normalRT = target(width, height);
  draw(renderer, quad, normalRT);

  renderer.setRenderTarget(previous);
  quad.dispose();
  heightMat.dispose();
  shadeMat.dispose();
  heightRT.dispose();

  return {
    map: albedoRT.texture,
    normalMap: normalRT.texture,
    dispose() {
      albedoRT.dispose();
      normalRT.dispose();
    },
  };
}
