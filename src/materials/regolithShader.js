import * as THREE from "three";

// ---------------------------------------------------------------------------
// Regolith surface detail: breaking the tile, and resolving the close-up.
//
// The terrain's detail maps are one 512-texel tile repeated every 12 m. Seen
// from the approach that repetition is obvious — the same micro-craters in
// the same arrangement, marching to the horizon like a golf ball. Two fixes,
// both in the fragment shader so they cost no geometry:
//
// 1. Anti-tiling. Each sample is taken twice, at two pseudo-random offsets
//    chosen by a low-frequency noise, and cross-faded (the technique Inigo
//    Quilez describes as "texture repetition, technique 3"). Offsets are
//    translations only, so tangent-space normals stay valid, and the same
//    offsets drive albedo, normals and roughness so the layers stay aligned.
//
// 2. A micro layer. The same maps at ~4x the frequency, faded in only within
//    a few tens of metres. On final approach the pilot is looking at a patch
//    of ground a few metres across; without it, a 12 m tile spends ~40 texels
//    per metre and the surface turns to mush exactly when it matters.
//
// The same maps are reused at every scale, so this adds texture fetches but
// no texture memory.
// ---------------------------------------------------------------------------

const header = /* glsl */ `
  uniform float rgMicroScale;
  uniform float rgMicroNear;
  uniform float rgMicroFar;
  uniform float rgMicroStrength;
  uniform float rgMapMean;
  uniform float rgTiling;        // 0 disables the anti-tiling cross-fade

  vec2 rgOffA, rgOffB, rgDx, rgDy;
  float rgW, rgMicro;

  float rgHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float rgNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(rgHash(i), rgHash(i + vec2(1.0, 0.0)), f.x),
               mix(rgHash(i + vec2(0.0, 1.0)), rgHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  // Chooses the two offsets and the blend for this fragment. Called once,
  // before any map is read.
  void rgSetup(vec2 uv, float viewDistance) {
    rgDx = dFdx(uv);
    rgDy = dFdy(uv);
    float k = rgNoise(uv * 0.37) * 6.0;
    float i = floor(k);
    rgW = smoothstep(0.25, 0.75, fract(k)) * rgTiling;
    rgOffA = sin(vec2(3.0, 7.0) * i);
    rgOffB = sin(vec2(3.0, 7.0) * (i + 1.0));
    rgMicro = (1.0 - smoothstep(rgMicroNear, rgMicroFar, viewDistance)) * rgMicroStrength;
  }

  // Explicit gradients: the offsets jump between cells, and implicit
  // derivatives would see that as a discontinuity and drop to the smallest
  // mip along every seam.
  //
  // The cross-fade only spans the middle of each noise cell; everywhere else
  // one sample is enough, which halves the fetches over most of the ground.
  // The branch is coherent — cells are tens of metres across.
  vec4 rgSample(sampler2D s, vec2 uv) {
    if (rgW < 0.002) return textureGrad(s, uv + rgOffA, rgDx, rgDy);
    if (rgW > 0.998) return textureGrad(s, uv + rgOffB, rgDx, rgDy);
    vec4 a = textureGrad(s, uv + rgOffA, rgDx, rgDy);
    vec4 b = textureGrad(s, uv + rgOffB, rgDx, rgDy);
    return mix(a, b, rgW);
  }
  vec4 rgSampleMicro(sampler2D s, vec2 uv) {
    vec2 m = uv * rgMicroScale + vec2(0.31, 0.67);
    return textureGrad(s, m, rgDx * rgMicroScale, rgDy * rgMicroScale);
  }
`;

const mapChunk = /* glsl */ `
#ifdef USE_MAP
  rgSetup(vMapUv, length(vViewPosition));
  vec4 sampledDiffuseColor = rgSample(map, vMapUv);
  if (rgMicro > 0.001) {
    // Albedo detail relative to the tile's own mean, so it only adds
    // contrast — pebbles and clods — and never shifts the overall tone.
    float micro = dot(rgSampleMicro(map, vMapUv).rgb, vec3(0.2126, 0.7152, 0.0722));
    sampledDiffuseColor.rgb *= mix(1.0, micro / rgMapMean, rgMicro * 0.7);
  }
  diffuseColor *= sampledDiffuseColor;
#endif
`;

const roughnessChunk = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  roughnessFactor *= rgSample(roughnessMap, vRoughnessMapUv).g;
#endif
`;

const NORMAL_LINE = "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;";
const normalLine = /* glsl */ `
  vec3 mapN = rgSample(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
  if (rgMicro > 0.001) {
    // Whiteout blend: the detail normal tilts the base one rather than
    // averaging it flat.
    vec3 microN = rgSampleMicro(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
    mapN = normalize(vec3(mapN.xy + microN.xy * rgMicro, mapN.z * mix(1.0, microN.z, rgMicro)));
  }
`;

/**
 * Adds anti-tiling and close-range micro detail to a regolith material.
 * Chains onto any existing onBeforeCompile (e.g. the lunar photometry patch).
 *
 * @param {THREE.MeshStandardMaterial} material
 * @param {object} [options]
 * @param {number} [options.microScale] frequency of the micro layer
 *   relative to the base tile
 * @param {number} [options.microNear] metres at which micro detail is full
 * @param {number} [options.microFar] metres beyond which it is gone
 * @param {number} [options.microStrength] 0 disables the micro layer
 * @param {number} [options.mapMean] mean linear luminance of the albedo map
 * @param {boolean} [options.environment] false strips image-based lighting
 *   from this material. For open ground it is worth nothing — an upward
 *   facing surface sees black sky, and the ground bounce it would add is
 *   already in the hemisphere term — but the two cube-UV lookups it costs per
 *   pixel were ~15% of the frame on integrated graphics, on the material that
 *   covers most of the screen.
 */
export function applyRegolithDetail(material, options = {}) {
  const {
    microScale = 4.3,
    microNear = 12,
    microFar = 70,
    microStrength = 1,
    mapMean = 0.14,
    environment = true,
  } = options;

  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey?.bind(material);

  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.rgMicroScale = { value: microScale };
    shader.uniforms.rgMicroNear = { value: microNear };
    shader.uniforms.rgMicroFar = { value: microFar };
    shader.uniforms.rgMicroStrength = { value: microStrength };
    shader.uniforms.rgMapMean = { value: mapMean };
    shader.uniforms.rgTiling = { value: 1 };
    // Kept so the detail can be tuned (or switched off by quality) live.
    material.userData.regolithUniforms = shader.uniforms;

    let fs = shader.fragmentShader;
    fs = fs.replace("#include <common>", `#include <common>\n${header}`);
    fs = fs.replace("#include <map_fragment>", mapChunk);
    fs = fs.replace("#include <roughnessmap_fragment>", roughnessChunk);
    // Expand the include so the sampling line inside it can be swapped.
    fs = fs.replace(
      "#include <normal_fragment_maps>",
      THREE.ShaderChunk.normal_fragment_maps.replace(NORMAL_LINE, normalLine)
    );
    // The renderer's #defines are prepended after this hook runs, so an
    // #undef at the top of the body overrides them.
    if (!environment) fs = `#undef USE_ENVMAP
${fs}`;
    shader.fragmentShader = fs;
  };

  material.customProgramCacheKey = () =>
    `${previousKey ? previousKey() : ""}|regolith-detail-${microStrength > 0 ? 1 : 0}-${environment ? 1 : 0}`;
  material.needsUpdate = true;
  return material;
}
