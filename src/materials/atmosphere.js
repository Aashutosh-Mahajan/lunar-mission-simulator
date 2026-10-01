import * as THREE from "three";

// ---------------------------------------------------------------------------
// Earth's atmosphere: single scattering over a spherical planet.
//
// The sky is not a gradient painted by altitude. It is sunlight scattered by
// air molecules (Rayleigh: strongly blue, symmetric) and aerosols (Mie:
// grey-white, strongly forward, the glare round the sun), each falling off
// exponentially with height, and dimmed on the way in and out by the same
// air. Ozone adds a little absorption in the red and green that deepens the
// blue of the high sky. Integrating that along each view ray gives, from the
// same few constants:
//
// - the pale horizon and deep zenith at the pad,
// - the indigo stratosphere and the black sky of orbit,
// - the thin bright limb along a curved horizon,
// - the haze that swallows distant ground (aerial perspective),
// - and the colour of the sunlight that reaches the vehicle.
//
// Coefficients are the standard Earth values (Bruneton 2017, Hillaire 2020),
// in km⁻¹. Everything here works in kilometres: at the planet's radius a
// float32 holds about half a metre, and heights are formed so the 6371 km
// never has to be subtracted from itself.
//
// The GLSL is used by the sky dome and the image-based-lighting probe; the JS
// twin below is used for the sun's colour and the ground's haze, so the
// lighting, the sky and the terrain all come from one model.
// ---------------------------------------------------------------------------

export const R_GROUND = 6371; // km
export const ATMOSPHERE_THICKNESS = 100; // km
export const R_TOP = R_GROUND + ATMOSPHERE_THICKNESS;
export const RAYLEIGH_SCATTERING = [5.802e-3, 13.558e-3, 33.1e-3]; // km⁻¹
export const RAYLEIGH_HEIGHT = 8; // km
export const MIE_SCATTERING = 3.996e-3;
export const MIE_EXTINCTION = 4.44e-3;
export const MIE_HEIGHT = 1.2;
export const MIE_G = 0.8;
export const OZONE_ABSORPTION = [0.65e-3, 1.881e-3, 0.085e-3];
// Isotropic multiple-scattering terms added to each phase function (see
// atmInScatter). 1/(4π) ≈ 0.08 would be a fully isotropic doubling.
const MS_RAYLEIGH = 0.04;
const MS_MIE = 0.02;
const OZONE_CENTRE = 25; // km
const OZONE_WIDTH = 15;

const f = (x) => x.toFixed(6);
const v3 = (a) => `vec3(${a.map(f).join(", ")})`;

export const ATMOSPHERE_GLSL = /* glsl */ `
  #define ATM_PI 3.14159265
  const float ATM_R = ${f(R_GROUND)};
  const float ATM_TOP = ${f(ATMOSPHERE_THICKNESS)};
  const vec3 ATM_RAYLEIGH = ${v3(RAYLEIGH_SCATTERING)};
  const float ATM_HR = ${f(RAYLEIGH_HEIGHT)};
  const float ATM_MIE_S = ${f(MIE_SCATTERING)};
  const float ATM_MIE_E = ${f(MIE_EXTINCTION)};
  const float ATM_HM = ${f(MIE_HEIGHT)};
  const float ATM_G = ${f(MIE_G)};
  const vec3 ATM_OZONE = ${v3(OZONE_ABSORPTION)};
  const float ATM_MS_RAYLEIGH = ${f(MS_RAYLEIGH)};
  const float ATM_MS_MIE = ${f(MS_MIE)};

  // Ray from a point at height h0 (km) above the surface, with mu = cosine
  // of the ray's zenith angle, against a sphere of radius ATM_R + shellH.
  // Returns the two distances along the ray; y < 0 means a miss. The
  // constant term is formed as a difference of heights, never of radii.
  vec2 atmShell(float h0, float mu, float shellH) {
    float r0 = ATM_R + h0;
    float b = r0 * mu;
    float c = (h0 - shellH) * (2.0 * ATM_R + h0 + shellH);
    float d = b * b - c;
    if (d < 0.0) return vec2(-1.0);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  // Height above the surface after travelling t along that ray.
  float atmHeightAt(float h0, float mu, float t) {
    float r0 = ATM_R + h0;
    float rt = sqrt(r0 * r0 + t * (t + 2.0 * r0 * mu));
    return (t * (t + 2.0 * r0 * mu) + h0 * (2.0 * ATM_R + h0)) / (rt + ATM_R);
  }

  // Chapman function (Schüler's approximation): the air mass along a ray
  // through an exponential atmosphere, relative to the vertical, including
  // the curvature that keeps it finite at the horizon. X = R/H, x = h/H.
  float atmChapman(float X, float x, float cosZ) {
    float c = sqrt(X + x);
    if (cosZ >= 0.0) {
      return c / (c * cosZ + 1.0) * exp(-x);
    }
    float x0 = sqrt(max(1.0 - cosZ * cosZ, 0.0)) * (X + x);
    float c0 = sqrt(x0);
    return 2.0 * c0 * exp(X - x0) - c / (1.0 - c * cosZ) * exp(-x);
  }

  // Transmittance of sunlight reaching height h with the sun at cosZ from
  // the local zenith. Zero once the planet itself is in the way.
  vec3 atmSunTransmittance(float h, float cosZ) {
    float sinHorizon = ATM_R / (ATM_R + h);
    float cosHorizon = -sqrt(max(1.0 - sinHorizon * sinHorizon, 0.0));
    // A sun just below the geometric horizon is still partly up (it is half
    // a degree across); fade rather than cut.
    float visible = smoothstep(cosHorizon - 0.004, cosHorizon + 0.004, cosZ);
    if (visible <= 0.0) return vec3(0.0);
    float tauR = ATM_HR * atmChapman(ATM_R / ATM_HR, h / ATM_HR, cosZ);
    float tauM = ATM_HM * atmChapman(ATM_R / ATM_HM, h / ATM_HM, cosZ);
    // Ozone: a thin layer around 25 km. Approximated by the Rayleigh air
    // mass scaled to the layer's column — exact enough for its small effect.
    // (smoothstep with reversed edges is undefined in GLSL, hence 1 - ...)
    float ozoneColumn = ${f(OZONE_WIDTH)} * (1.0 - smoothstep(${f(OZONE_CENTRE - OZONE_WIDTH)}, ${f(OZONE_CENTRE + OZONE_WIDTH)}, h));
    float airmass = tauR / (ATM_HR * exp(-h / ATM_HR) + 1e-6);
    vec3 tau = ATM_RAYLEIGH * tauR + ATM_MIE_E * tauM + ATM_OZONE * ozoneColumn * min(airmass, 40.0);
    return exp(-tau) * visible;
  }

  float atmPhaseRayleigh(float mu) {
    return 3.0 / (16.0 * ATM_PI) * (1.0 + mu * mu);
  }
  float atmPhaseMie(float mu) {
    float g2 = ATM_G * ATM_G;
    return 3.0 / (8.0 * ATM_PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
           ((2.0 + g2) * pow(1.0 + g2 - 2.0 * ATM_G * mu, 1.5));
  }

  vec3 atmExtinction(float h) {
    float ozone = max(0.0, 1.0 - abs(h - ${f(OZONE_CENTRE)}) / ${f(OZONE_WIDTH)});
    return ATM_RAYLEIGH * exp(-h / ATM_HR) + ATM_MIE_E * exp(-h / ATM_HM) + ATM_OZONE * ozone;
  }

  // In-scattered radiance (per unit solar irradiance) along a view ray from
  // height h0 in direction dir, up to tMax (or the top of the atmosphere).
  // The planet-local frame has +y up at the observer. Returns the radiance;
  // 'transmittance' is the attenuation of whatever lies at the far end.
  vec3 atmInScatter(float h0, vec3 dir, vec3 sunDir, float tMax, const int steps, out vec3 transmittance) {
    transmittance = vec3(1.0);
    float mu = dir.y;
    vec2 top = atmShell(h0, mu, ATM_TOP);
    if (top.y <= 0.0) return vec3(0.0);
    float t0 = max(top.x, 0.0);
    float t1 = min(top.y, tMax);
    if (t1 <= t0) return vec3(0.0);

    float nu = dot(dir, sunDir);
    float pR = atmPhaseRayleigh(nu);
    float pM = atmPhaseMie(nu);
    float r0 = ATM_R + h0;

    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);
    vec3 tau = vec3(0.0);
    float prevT = t0;
    for (int i = 0; i < 24; i++) {
      if (i >= steps) break;
      // Quadratic spacing: most of the air, and most of the change, is near
      // the observer.
      float s = (float(i) + 0.5) / float(steps);
      float t = t0 + (t1 - t0) * s * s;
      float sNext = (float(i) + 1.0) / float(steps);
      float sPrev = float(i) / float(steps);
      float dt = (t1 - t0) * (sNext * sNext - sPrev * sPrev);

      float h = max(atmHeightAt(h0, mu, t), 0.0);
      vec3 ext = atmExtinction(h);
      vec3 tauMid = tau + ext * dt * 0.5;
      // Local zenith at the sample: the observer's up rotated by the angle
      // subtended at the planet's centre.
      vec3 p = vec3(0.0, r0, 0.0) + dir * t;
      float cosSun = dot(p, sunDir) / (ATM_R + h);
      vec3 sunT = atmSunTransmittance(h, cosSun);
      vec3 w = exp(-tauMid) * sunT * dt;
      sumR += w * exp(-h / ATM_HR);
      sumM += w * exp(-h / ATM_HM);
      tau += ext * dt;
    }
    transmittance = exp(-tau);
    // Multiple scattering, approximated: light scattered more than once
    // arrives from every direction, so it adds a near-isotropic term that
    // single scattering misses — about half again at the zenith. Without it
    // the high sky is too dark and the shadowed side of the sky too empty.
    return sumR * ATM_RAYLEIGH * (pR + ATM_MS_RAYLEIGH) + sumM * ATM_MIE_S * (pM + ATM_MS_MIE);
  }
`;

// ---------------------------------------------------------------------------
// JS twin — the same model, evaluated a handful of times per frame.
// ---------------------------------------------------------------------------

function chapman(X, x, cosZ) {
  const c = Math.sqrt(X + x);
  if (cosZ >= 0) return (c / (c * cosZ + 1)) * Math.exp(-x);
  const x0 = Math.sqrt(Math.max(1 - cosZ * cosZ, 0)) * (X + x);
  const c0 = Math.sqrt(x0);
  return 2 * c0 * Math.exp(X - x0) - (c / (1 - c * cosZ)) * Math.exp(-x);
}

/**
 * Transmittance of sunlight to height `hKm` with the sun at `cosZ` from the
 * local zenith. Writes into `out` (THREE.Color).
 */
export function sunTransmittance(hKm, cosZ, out = new THREE.Color()) {
  const sinH = R_GROUND / (R_GROUND + hKm);
  const cosH = -Math.sqrt(Math.max(1 - sinH * sinH, 0));
  const visible = THREE.MathUtils.smoothstep(cosZ, cosH - 0.004, cosH + 0.004);
  if (visible <= 0) return out.setRGB(0, 0, 0);
  const tauR = RAYLEIGH_HEIGHT * chapman(R_GROUND / RAYLEIGH_HEIGHT, hKm / RAYLEIGH_HEIGHT, cosZ);
  const tauM = MIE_HEIGHT * chapman(R_GROUND / MIE_HEIGHT, hKm / MIE_HEIGHT, cosZ);
  const column =
    OZONE_WIDTH * (1 - THREE.MathUtils.smoothstep(hKm, OZONE_CENTRE - OZONE_WIDTH, OZONE_CENTRE + OZONE_WIDTH));
  const airmass = Math.min(tauR / (RAYLEIGH_HEIGHT * Math.exp(-hKm / RAYLEIGH_HEIGHT) + 1e-6), 40);
  const ch = (i) =>
    Math.exp(-(RAYLEIGH_SCATTERING[i] * tauR + MIE_EXTINCTION * tauM + OZONE_ABSORPTION[i] * column * airmass)) *
    visible;
  return out.setRGB(ch(0), ch(1), ch(2));
}

/** Local air density relative to sea level (Rayleigh and Mie). */
export function airDensityRatios(hKm) {
  return {
    rayleigh: Math.exp(-hKm / RAYLEIGH_HEIGHT),
    mie: Math.exp(-hKm / MIE_HEIGHT),
  };
}

/**
 * Sky radiance (per unit solar irradiance) seen from height `hKm` looking
 * along `dir` (planet-local frame, +y up), integrated to the top of the
 * atmosphere or the ground. A coarse 16-step version of the shader's march,
 * for colours the CPU needs (horizon haze, ground fill).
 */
export function skyRadiance(hKm, dir, sunDir, out = new THREE.Color()) {
  const steps = 16;
  const r0 = R_GROUND + hKm;
  const mu = dir.y;
  const shell = (shellH) => {
    const b = r0 * mu;
    const c = (hKm - shellH) * (2 * R_GROUND + hKm + shellH);
    const d = b * b - c;
    if (d < 0) return null;
    const s = Math.sqrt(d);
    return [-b - s, -b + s];
  };
  const top = shell(ATMOSPHERE_THICKNESS);
  if (!top || top[1] <= 0) return out.setRGB(0, 0, 0);
  let t0 = Math.max(top[0], 0);
  let t1 = top[1];
  const ground = shell(0);
  if (ground && ground[0] > 0) t1 = Math.min(t1, ground[0]);

  const nu = dir.x * sunDir.x + dir.y * sunDir.y + dir.z * sunDir.z;
  const pR = (3 / (16 * Math.PI)) * (1 + nu * nu);
  const g2 = MIE_G * MIE_G;
  const pM =
    ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + nu * nu))) /
    ((2 + g2) * Math.pow(1 + g2 - 2 * MIE_G * nu, 1.5));

  const sum = [0, 0, 0];
  const tau = [0, 0, 0];
  const sunT = new THREE.Color();
  for (let i = 0; i < steps; i++) {
    const s0 = i / steps;
    const s1 = (i + 1) / steps;
    const sm = (i + 0.5) / steps;
    const t = t0 + (t1 - t0) * sm * sm;
    const dt = (t1 - t0) * (s1 * s1 - s0 * s0);
    const rt = Math.sqrt(r0 * r0 + t * (t + 2 * r0 * mu));
    const h = Math.max((t * (t + 2 * r0 * mu) + hKm * (2 * R_GROUND + hKm)) / (rt + R_GROUND), 0);
    const dR = Math.exp(-h / RAYLEIGH_HEIGHT);
    const dM = Math.exp(-h / MIE_HEIGHT);
    const oz = Math.max(0, 1 - Math.abs(h - OZONE_CENTRE) / OZONE_WIDTH);
    const px = dir.x * t;
    const py = r0 + dir.y * t;
    const pz = dir.z * t;
    const cosSun = (px * sunDir.x + py * sunDir.y + pz * sunDir.z) / (R_GROUND + h);
    sunTransmittance(h, cosSun, sunT);
    const st = [sunT.r, sunT.g, sunT.b];
    for (let c = 0; c < 3; c++) {
      const ext = RAYLEIGH_SCATTERING[c] * dR + MIE_EXTINCTION * dM + OZONE_ABSORPTION[c] * oz;
      const w = Math.exp(-(tau[c] + ext * dt * 0.5)) * st[c] * dt;
      sum[c] += w * (dR * RAYLEIGH_SCATTERING[c] * (pR + MS_RAYLEIGH) + dM * MIE_SCATTERING * (pM + MS_MIE));
      tau[c] += ext * dt;
    }
  }
  return out.setRGB(sum[0], sum[1], sum[2]);
}
