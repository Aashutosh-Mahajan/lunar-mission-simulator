import * as THREE from "three";
import { ATMOSPHERE_GLSL, ATMOSPHERE_THICKNESS, R_GROUND } from "../materials/atmosphere.js";
import { SUN_INTENSITY } from "../constants.js";

// ---------------------------------------------------------------------------
// Earth seen from outside: from parking orbit, from cislunar space and from
// the lunar surface. One physically based globe for all three, so the planet
// the player leaves is the one they later see hanging over the landing site.
// ---------------------------------------------------------------------------

// World-space normal and position. These planets used to shade with a
// view-space normal against a world-space sun direction, so the terminator
// swung round the globe as the camera moved — from parking orbit most of the
// Earth in view came out on the night side.
const planetVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Earth from outside, with the same atmosphere as the launch (see
// materials/atmosphere.js), evaluated analytically: the air between a
// surface point and the camera is one Chapman air-mass column, and the light
// it scatters toward the camera is the in-scatter of a uniformly lit slab of
// that optical depth.
const earthFragment = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  uniform sampler2D dayMap;
  uniform sampler2D cloudMap;
  uniform vec3 sunDirection;
  uniform float sunIrradiance;
  uniform float cloudOffset;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  // In-scatter and transmittance of a column of air of the given air masses
  // (Rayleigh, Mie), lit by sunlight of transmittance sunT.
  vec3 atmColumn(float massR, float massM, float nu, vec3 sunT, out vec3 T) {
    vec3 tauR = ATM_RAYLEIGH * ATM_HR * massR;
    float tauM = ATM_MIE_E * ATM_HM * massM;
    vec3 tau = tauR + tauM;
    T = exp(-tau);
    vec3 scatter = ATM_RAYLEIGH * ATM_HR * massR * (atmPhaseRayleigh(nu) + ATM_MS_RAYLEIGH) +
                   ATM_MIE_S * ATM_HM * massM * (atmPhaseMie(nu) + ATM_MS_MIE);
    return sunT * scatter / max(tau, vec3(1e-4)) * (1.0 - T);
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorldPos);
    float mu = max(dot(n, v), 0.0);
    float mu0 = dot(n, sunDirection);
    float nu = dot(-v, sunDirection);

    // Real linear albedos, with the water mask in alpha (materials/earthBake.js).
    vec4 day = texture2D(dayMap, vUv);
    vec3 albedo = day.rgb;
    float water = day.a;
    vec4 cloud = texture2D(cloudMap, vec2(vUv.x + cloudOffset, vUv.y));
    albedo = mix(albedo, vec3(0.78), cloud.a * 0.9);
    water *= 1.0 - cloud.a;

    vec3 sunT = atmSunTransmittance(0.0, mu0);
    vec3 surface = albedo * sunIrradiance * sunT * max(mu0, 0.0) / ATM_PI;
    // Sun glint: the bright smear on the ocean, sharp because water is
    // smooth, widened a little by waves.
    vec3 h = normalize(sunDirection + v);
    float glint = pow(max(dot(n, h), 0.0), 220.0) * 0.6;
    surface += water * glint * sunT * sunIrradiance * max(mu0, 0.0);
    // City lights on the night side, faint.
    float night = smoothstep(0.05, -0.15, mu0) * (1.0 - water) * (1.0 - cloud.a);
    surface += vec3(1.0, 0.75, 0.45) * night * 0.004 * smoothstep(0.2, 0.5, albedo.g);

    // Air between the surface and the camera.
    float massR = atmChapman(ATM_R / ATM_HR, 0.0, mu);
    float massM = atmChapman(ATM_R / ATM_HM, 0.0, mu);
    // Light reaching that air: the sun's transmittance a few km up.
    vec3 airSunT = atmSunTransmittance(3.0, mu0);
    vec3 T;
    vec3 inscatter = atmColumn(massR, massM, nu, airSunT, T) * sunIrradiance;

    gl_FragColor = vec4(surface * T + inscatter, 1.0);
  }
`;

// The limb: rays that miss the planet but cross its atmosphere. Drawn on a
// shell just outside the surface, additively, and only where the line of
// sight clears the solid globe (inside it, the Earth shader already carries
// the air).
const limbFragment = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  uniform vec3 sunDirection;
  uniform float sunIrradiance;
  uniform vec3 planetCentre;
  uniform float planetRadius;   // render units
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    vec3 rd = normalize(vWorldPos - cameraPosition);
    vec3 oc = cameraPosition - planetCentre;
    float b = dot(oc, rd);
    // Closest approach of the line of sight to the planet's centre.
    vec3 closest = oc - rd * b;
    float dClosest = length(closest);
    if (dClosest < planetRadius) discard;
    float kmPerUnit = ATM_R / planetRadius;
    float hTangent = (dClosest - planetRadius) * kmPerUnit;
    if (hTangent > ATM_TOP) discard;

    // Air mass along the whole grazing path: twice the horizontal Chapman
    // column from the tangent point.
    float massR = 2.0 * atmChapman(ATM_R / ATM_HR, hTangent / ATM_HR, 0.0);
    float massM = 2.0 * atmChapman(ATM_R / ATM_HM, hTangent / ATM_HM, 0.0);
    vec3 up = closest / dClosest;
    float cosSun = dot(up, sunDirection);
    vec3 sunT = atmSunTransmittance(hTangent, cosSun);
    float nu = dot(rd, sunDirection);

    vec3 tauR = ATM_RAYLEIGH * ATM_HR * massR;
    float tauM = ATM_MIE_E * ATM_HM * massM;
    vec3 tau = tauR + tauM;
    vec3 scatter = ATM_RAYLEIGH * ATM_HR * massR * (atmPhaseRayleigh(nu) + ATM_MS_RAYLEIGH) +
                   ATM_MIE_S * ATM_HM * massM * (atmPhaseMie(nu) + ATM_MS_MIE);
    vec3 L = sunT * scatter / max(tau, vec3(1e-4)) * (1.0 - exp(-tau)) * sunIrradiance;
    gl_FragColor = vec4(L, 1.0);
  }
`;

export default class EarthGlobe {
  /**
   * @param {{ map: THREE.Texture, clouds: THREE.Texture }} maps baked Earth
   *   maps (materials/earthBake.js); the day map's alpha is the water mask
   * @param {THREE.Vector3} sunDirection world-space, toward the sun
   */
  /**
   * @param {object} [options]
   * @param {number} [options.segments] sphere tessellation
   * @param {number} [options.spin] rotation rate, rad/s — exaggerated, since
   *   the real 15 degrees an hour would never be seen
   */
  constructor(maps, sunDirection, { segments = 128, spin = 0.012 } = {}) {
    this.spin = spin;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: maps.map },
        cloudMap: { value: maps.clouds },
        sunDirection: { value: sunDirection.clone() },
        sunIrradiance: { value: SUN_INTENSITY },
        cloudOffset: { value: 0 },
      },
      vertexShader: planetVertex,
      fragmentShader: earthFragment,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, Math.round(segments * 0.75)), this.material);

    // Atmosphere shell, 100 km deep at the globe's scale.
    this.limbMaterial = new THREE.ShaderMaterial({
      uniforms: {
        sunDirection: { value: sunDirection.clone() },
        sunIrradiance: { value: SUN_INTENSITY },
        planetCentre: { value: new THREE.Vector3() },
        planetRadius: { value: 1 },
      },
      vertexShader: planetVertex,
      fragmentShader: limbFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.limb = new THREE.Mesh(
      new THREE.SphereGeometry(1 + ATMOSPHERE_THICKNESS / R_GROUND, segments, Math.round(segments * 0.5)),
      this.limbMaterial
    );
    this.mesh.add(this.limb);
  }

  setSunDirection(dir) {
    this.material.uniforms.sunDirection.value.copy(dir);
    this.limbMaterial.uniforms.sunDirection.value.copy(dir);
  }

  /** Call after the globe has been positioned and scaled for the frame. */
  update(dt) {
    this.material.uniforms.cloudOffset.value += dt * 0.0025;
    this.mesh.rotation.y += dt * this.spin;
    // The limb shader needs the globe in world units.
    this.mesh.updateWorldMatrix(true, false);
    const u = this.limbMaterial.uniforms;
    u.planetCentre.value.setFromMatrixPosition(this.mesh.matrixWorld);
    u.planetRadius.value = this.mesh.getWorldScale(_scale).x;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.limb.geometry.dispose();
    this.material.dispose();
    this.limbMaterial.dispose();
  }
}

const _scale = new THREE.Vector3();
