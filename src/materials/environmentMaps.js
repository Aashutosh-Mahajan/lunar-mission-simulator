import * as THREE from "three";

// ---------------------------------------------------------------------------
// Image-based lighting, baked procedurally.
//
// A metal has no colour of its own in a renderer — what you see on a metallic
// surface is the world it reflects. With no environment map every metallic
// material in the game (the LM's foil, the engine bells, the Saturn V's skirts)
// had nothing to reflect but black, which is why the lander read as a dark
// silhouette however strongly it was lit.
//
// Each phase therefore bakes a radiance environment from a tiny shader-only
// scene: one sphere whose fragment shader returns the radiance arriving from
// each direction. Three's PMREM generator pre-filters it for every roughness,
// so diffuse fill and glossy reflections both come from the same, physically
// consistent picture of the surroundings. The sun itself is left out on
// purpose: it is already a DirectionalLight, and putting it in the map as well
// would count it twice.
// ---------------------------------------------------------------------------

const probeVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * A procedural radiance probe. Owns a one-mesh scene and the PMREM target
 * baked from it; call `bake()` whenever the uniforms change.
 */
export class EnvironmentProbe {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {string} fragmentShader returns linear radiance for direction vDir
   * @param {object} uniforms
   * @param {number} [size] cube face size; 128 is ample for the roughness
   *   range used by the game's materials and keeps a re-bake around a
   *   millisecond on integrated graphics.
   */
  constructor(renderer, fragmentShader, uniforms, size = 128) {
    this.renderer = renderer;
    this.size = size;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene = new THREE.Scene();
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: probeVertex,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), this.material);
    this.scene.add(this.mesh);
    this.target = null;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** Re-renders the probe and returns the new pre-filtered texture. */
  bake() {
    const next = this.pmrem.fromScene(this.scene, 0, 0.1, 100, { size: this.size });
    // Dispose only after the new one exists: materials hold the old texture
    // until the caller swaps `scene.environment` over.
    const previous = this.target;
    this.target = next;
    previous?.dispose();
    return next.texture;
  }

  get texture() {
    return this.target?.texture ?? null;
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.pmrem.dispose();
  }
}

// ---------------------------------------------------------------------------
// The lunar surface: black sky, Earth, and a floor of sunlit regolith.
//
// The bright half of this environment is *below* the horizon. On the Moon the
// dominant fill light is sunlight bounced off the ground, which is why the
// shadowed side of an Apollo LM is never black in surface photography and
// why its underside glows gold. The ground radiance follows the same
// Lommel-Seeliger law the terrain shader uses, with the opposition surge that
// makes regolith markedly brighter looking down-sun than up-sun.
// ---------------------------------------------------------------------------

const lunarFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform float sunIrradiance;   // DirectionalLight intensity
  uniform vec3 groundAlbedo;     // linear, effective regolith albedo
  uniform float shadowFraction;  // share of visible ground in shadow up-sun
  uniform vec3 earthDirection;
  uniform vec3 earthRadiance;
  varying vec3 vDir;

  const float PI = 3.14159265;

  void main() {
    vec3 d = normalize(vDir);
    vec3 col = vec3(0.0);

    // Earth: ~2 degrees across and genuinely bright (albedo ~0.3, fully
    // sunlit from most landing sites). Widened a little so a 128-texel probe
    // can resolve it; energy is scaled down to match.
    float e = dot(d, normalize(earthDirection));
    col += earthRadiance * smoothstep(0.9965, 0.9985, e);

    // Faint glow of unresolved starlight and zodiacal light — present, but
    // orders of magnitude below anything sunlit.
    col += vec3(0.0006, 0.0008, 0.0012) * max(d.y, 0.0);

    if (d.y < 0.02) {
      float mu0 = max(sunDirection.y, 0.0);       // cos(incidence), flat ground
      float mu = max(-d.y, 0.05);                 // cos(emission)
      // Lommel-Seeliger, normalised to Lambert at normal incidence/emission.
      float ls = 2.0 * mu0 / (mu0 + mu);
      // Phase angle between the sun and the line back to the viewer: regolith
      // backscatters, and brightens sharply near zero phase (opposition).
      // Same law as the terrain shader (materials/photometry.js).
      float cosPhase = dot(sunDirection, -d);
      float phaseLaw = 1.0 + 0.62 * cosPhase + 0.35 * pow(max(cosPhase, 0.0), 48.0);
      // Looking up-sun you see the shadowed back slopes of every crater and
      // pebble; looking down-sun, only their lit faces.
      float hDot = dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(sunDirection.x, 0.0, sunDirection.z) + 1e-5));
      float lit = mix(1.0 - shadowFraction, 1.0, hDot * 0.5 + 0.5);
      // Radiance = albedo * irradiance * photometric law / pi; ls already
      // carries the cos(incidence) dependence.
      vec3 ground = groundAlbedo * sunIrradiance * ls * phaseLaw * lit / PI;
      // Soft horizon: the terrain edge, not a knife cut across the probe.
      col = mix(col, ground, smoothstep(0.02, -0.03, d.y));
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * @param {THREE.WebGLRenderer} renderer
 * @returns {EnvironmentProbe}
 */
export function createLunarProbe(renderer) {
  return new EnvironmentProbe(renderer, lunarFragment, {
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunIrradiance: { value: 2 },
    groundAlbedo: { value: new THREE.Color(0.11, 0.105, 0.098) },
    shadowFraction: { value: 0.4 },
    earthDirection: { value: new THREE.Vector3(0, 1, 0) },
    earthRadiance: { value: new THREE.Color(0.06, 0.08, 0.12) },
  });
}

// ---------------------------------------------------------------------------
// Deep space: black, with the sunlit Earth and Moon as the only fill.
// ---------------------------------------------------------------------------

const spaceFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform vec3 earthDirection;
  uniform float earthCos;        // cos of Earth's angular radius
  uniform vec3 earthRadiance;
  uniform vec3 moonDirection;
  uniform float moonCos;
  uniform vec3 moonRadiance;
  varying vec3 vDir;

  // A sunlit sphere seen from outside: the fraction of its visible disc that
  // is lit, approximated per direction from the local surface normal.
  vec3 body(vec3 d, vec3 centre, float cosR, vec3 radiance) {
    float c = dot(d, centre);
    if (c < cosR) return vec3(0.0);
    // Reconstruct the surface normal of the point hit along d.
    float sinR = sqrt(max(1.0 - cosR * cosR, 0.0));
    float t = clamp((1.0 - c) / max(1.0 - cosR, 1e-4), 0.0, 1.0);
    vec3 side = normalize(d - centre * c + 1e-5);
    vec3 n = normalize(-centre * sqrt(1.0 - t) + side * sqrt(t));
    float lit = max(dot(n, sunDirection), 0.0);
    return radiance * lit;
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 col = vec3(0.0004, 0.0005, 0.0008);
    col += body(d, normalize(earthDirection), earthCos, earthRadiance);
    col += body(d, normalize(moonDirection), moonCos, moonRadiance);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createSpaceProbe(renderer) {
  return new EnvironmentProbe(renderer, spaceFragment, {
    sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    earthDirection: { value: new THREE.Vector3(0, -1, 0) },
    earthCos: { value: 0.5 },
    earthRadiance: { value: new THREE.Color(0.32, 0.4, 0.55) },
    moonDirection: { value: new THREE.Vector3(0, 0, 1) },
    moonCos: { value: 0.999 },
    moonRadiance: { value: new THREE.Color(0.09, 0.088, 0.084) },
  }, 64);
}
