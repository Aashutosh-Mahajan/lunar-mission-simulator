import * as THREE from "three";
import { makeRng } from "../materials/noise.js";
import { buildRegolithMaps } from "../materials/textures.js";
import { createSun } from "../materials/sun.js";
import { createSpaceProbe } from "../materials/environmentMaps.js";
import EarthGlobe from "../entities/EarthGlobe.js";
import { PHASE_SLOPE } from "../materials/photometry.js";
import { SUN_COLOR, SUN_INTENSITY, REGOLITH_ALBEDO } from "../constants.js";

// ---------------------------------------------------------------------------
// Phase 3 — cislunar space, between Earth orbit and the Moon.
//
// Driven by a single `journey` parameter from 0 (parking orbit) to 1 (lunar
// orbit). Earth shrinks from filling the view to a blue marble; the Moon grows
// from a point to a landscape. Both are drawn at a compressed scale rather
// than at true distance — 384,400 km will not fit in a depth buffer, and the
// point of this scene is the *sense* of the crossing, not its metric truth.
//
// There is no atmosphere anywhere in here, so lighting is the same harsh,
// single-source setup as the lunar surface: one sun, near-black shadows, and
// a lot of stars.
// ---------------------------------------------------------------------------

const SKY_RADIUS = 9000;
const STAR_COUNT = 11000;

// Apparent radii, in render units, at each end of the journey, together with
// the distance each body is held at. Distance is tracked explicitly rather
// than derived, because what matters visually is the *angular* size —
// asin(radius / distance) — and because a sphere placed closer than its own
// radius swallows the camera.
const EARTH_NEAR = { radius: 900, distance: 1710 }; // ~63° across, from parking orbit
const EARTH_FAR = { radius: 46, distance: 2760 }; // ~2° — a blue marble
const MOON_FAR = { radius: 30, distance: 6200 }; // a bright point
const MOON_NEAR = { radius: 2300, distance: 4025 }; // ~70° across, filling the view

// A 1x1 "straight up" normal map, for when the Moon's maps were not baked.
const FLAT_NORMAL = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
FLAT_NORMAL.needsUpdate = true;

// Where the Moon sits once the stack is in lunar orbit: below, a little ahead.
const ORBIT_MOON_DIR = new THREE.Vector3(0.05, -0.93, 0.36).normalize();

const SUN_DEPARTURE = new THREE.Vector3(0.93, 0.3, 0.21).normalize();
const SUN_ARRIVAL = new THREE.Vector3(0.74, 0.26, -0.62).normalize();

// Directions the two bodies sit in, relative to the coasting stack.
const EARTH_DIR = new THREE.Vector3(-0.16, -0.42, -0.89).normalize();
const MOON_DIR = new THREE.Vector3(0.08, 0.16, 0.98).normalize();

// The Moon: baked albedo and relief (materials/moonBake.js). The normal
// map's tangent frame is rebuilt from the object-space normal using the
// SphereGeometry parameterisation it was baked for (east = +u, north = +v).
const moonVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vEast;
  varying vec3 vNorth;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vec3 no = normalize(normal);
    float sinT = length(no.xz);
    vec3 east = sinT > 1e-4 ? vec3(no.z, 0.0, -no.x) / sinT : vec3(1.0, 0.0, 0.0);
    vec3 north = cross(no, east);
    mat3 m = mat3(modelMatrix);
    vNormal = normalize(m * no);
    vEast = normalize(m * east);
    vNorth = normalize(m * north);
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const moonFragment = /* glsl */ `
  uniform sampler2D albedoMap;
  uniform sampler2D normalMap;
  uniform vec3 sunDirection;
  uniform float sunIrradiance;
  varying vec3 vNormal;
  varying vec3 vEast;
  varying vec3 vNorth;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    vec3 albedo = texture2D(albedoMap, vUv).rgb;
    vec3 tn = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
    vec3 n = normalize(vEast * tn.x + vNorth * tn.y + normalize(vNormal) * tn.z);

    // The same photometry as the landing sites (materials/photometry.js):
    // Lommel-Seeliger, which is why a full Moon is evenly bright to its limb
    // rather than shaded like a billiard ball, with the backscatter phase law
    // that makes a crescent so much dimmer than its area suggests.
    vec3 v = normalize(cameraPosition - vWorldPos);
    float mu0 = max(dot(n, sunDirection), 0.0);
    float mu = max(dot(n, v), 0.05);
    float ls = 2.0 * mu0 / (mu0 + mu);
    float cosPhase = dot(sunDirection, v);
    float phaseLaw = 1.0 + ${PHASE_SLOPE.toFixed(3)} * cosPhase + 0.35 * pow(max(cosPhase, 0.0), 48.0);
    // Relief only casts self-shadow where the smooth sphere is lit: in vacuum
    // the terminator is a hard line, broken only by peaks catching the sun.
    float geoLit = smoothstep(-0.02, 0.04, dot(normalize(vNormal), sunDirection));
    vec3 col = albedo * sunIrradiance * mix(mu0, ls, 0.75) * phaseLaw * geoLit / 3.14159265;
    // Earthshine: the night side is not black, but it is close.
    col += albedo * 0.0015;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export default class SpaceScene {
  /**
   * @param {THREE.Scene} scene
   * @param {object} assets shared procedural textures (Earth is baked there)
   */
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = "cislunar";
    scene.add(this.group);

    // The sun sits roughly side-on. This scene's frame is the stack's —
    // Earth astern, the Moon ahead — and that frame turns as the trans-lunar
    // trajectory bends through the crossing, so the sun's apparent direction
    // swings with it: early on it lights the Earth falling away behind, and
    // by arrival the face of the Moon ahead. (Fixed broadside, with correct
    // shading, the Moon arrived as a black disc with a sliver of limb.)
    this.sunDirection = SUN_DEPARTURE.clone();

    this._buildStars();
    this._buildSun();
    this._buildEarth();
    this._buildMoon();
    this._buildLights();

    this.journey = 0;
    /** 0..1: settling into lunar orbit, then the LM's descent (see update). */
    this.orbit = 0;
    this.approach = 0;
    this._moonDir = MOON_DIR.clone();
    scene.background = new THREE.Color(0x000000);

    /** Photographic exposure: sunlit hardware against black space. */
    this.exposure = 1.0;
  }

  _buildStars() {
    const rng = makeRng(31415);
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);
    const colors = new Float32Array(STAR_COUNT * 3);
    const c = new THREE.Color();

    for (let i = 0; i < STAR_COUNT; i++) {
      const u = rng() * 2 - 1;
      const theta = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dir = new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta));
      if (i % 3 === 0) {
        // Galactic band.
        const bandNormal = new THREE.Vector3(0.3, 0.86, -0.41).normalize();
        dir.addScaledVector(bandNormal, -dir.dot(bandNormal) * (0.84 + rng() * 0.13)).normalize();
      }
      dir.multiplyScalar(SKY_RADIUS * 0.97);
      positions[i * 3] = dir.x;
      positions[i * 3 + 1] = dir.y;
      positions[i * 3 + 2] = dir.z;

      const mag = Math.pow(rng(), 3.5);
      sizes[i] = 0.7 + mag * 5.0;
      const t = rng();
      if (t > 0.92) c.setRGB(1.0, 0.74, 0.55);
      else if (t > 0.82) c.setRGB(1.0, 0.87, 0.74);
      else if (t > 0.42) c.setRGB(1.0, 0.98, 0.96);
      else c.setRGB(0.83, 0.89, 1.0);
      const b = 0.4 + mag * 0.85;
      colors[i * 3] = c.r * b;
      colors[i * 3 + 1] = c.g * b;
      colors[i * 3 + 2] = c.b * b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("starColor", new THREE.BufferAttribute(colors, 3));

    this.starMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec3 starColor;
        varying vec3 vColor;
        void main() {
          vColor = starColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
        }
      `,
      uniforms: { gain: { value: 0.75 } },
      fragmentShader: /* glsl */ `
        uniform float gain;
        varying vec3 vColor;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float a = smoothstep(0.5, 0.06, length(uv));
          a *= a * gain;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.stars = new THREE.Points(geo, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -300;
    this.group.add(this.stars);
  }

  _buildSun() {
    const dist = SKY_RADIUS * 0.92;
    // Not depth-tested against the planets here (they are drawn as
    // background), but the spacecraft still occludes it.
    this.sun = createSun(dist, { depthTest: true });
    this.sun.group.position.copy(this.sunDirection).multiplyScalar(dist);
    this.group.add(this.sun.group);
  }

  _buildEarth() {
    this.earthGlobe = new EarthGlobe(this.assets.earth, this.sunDirection);
    this.earth = this.earthGlobe.mesh;
    this.earth.renderOrder = -200;
    this.earthGlobe.limb.renderOrder = -199;
    this.group.add(this.earth);
  }

  _buildMoon() {
    // Baked once at load and shared (see assets.js); a plain grey fallback
    // keeps the scene working without a GPU bake.
    const maps = this.assets.moon ?? {
      map: buildRegolithMaps(5150, 256).map,
      normalMap: null,
    };
    this.moonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        albedoMap: { value: maps.map },
        normalMap: { value: maps.normalMap ?? FLAT_NORMAL },
        sunDirection: { value: this.sunDirection.clone() },
        sunIrradiance: { value: SUN_INTENSITY },
      },
      vertexShader: moonVertex,
      fragmentShader: moonFragment,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), this.moonMaterial);
    // Tidally locked: the maria-rich near side (object -x in the bake) faces
    // Earth, and so faces the spacecraft coming from it.
    this.moon.rotation.y = -Math.PI / 2;
    this.moon.renderOrder = -199;
    this.group.add(this.moon);
  }

  _buildLights() {
    // The same unfiltered sun as on the lunar surface.
    this.sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sunLight.castShadow = false; // nothing casts onto anything out here
    this.scene.add(this.sunLight);

    // Fill comes from the sunlit Earth and Moon, through the probe.
    this.probe = this.assets.renderer ? createSpaceProbe(this.assets.renderer) : null;
    this._probeJourney = -1;
  }

  /** Re-bakes the lighting probe as Earth and the Moon change size. */
  _bakeProbe(earthRadius, earthDist, moonRadius, moonDist) {
    if (!this.probe) return;
    const u = this.probe.uniforms;
    u.sunDirection.value.copy(this.sunDirection);
    u.earthDirection.value.copy(EARTH_DIR);
    u.earthCos.value = Math.cos(Math.asin(Math.min(earthRadius / earthDist, 0.999)));
    u.moonDirection.value.copy(this._moonDir);
    u.moonCos.value = Math.cos(Math.asin(Math.min(moonRadius / moonDist, 0.999)));
    // Mean radiance of each sunlit disc: albedo x irradiance / pi.
    const k = SUN_INTENSITY / Math.PI;
    u.earthRadiance.value.setRGB(0.28 * k, 0.32 * k, 0.4 * k);
    u.moonRadiance.value.setRGB(REGOLITH_ALBEDO * k, REGOLITH_ALBEDO * 0.97 * k, REGOLITH_ALBEDO * 0.92 * k);
    this.scene.environment = this.probe.bake();
  }

  /**
   * @param {THREE.Camera} camera
   * @param {number} journey 0 at TLI, 1 at lunar arrival
   * @param {number} dt
   */
  update(camera, journey, dt) {
    this.journey = journey;
    this.group.position.copy(camera.position);

    // Apparent size follows an inverse-distance feel rather than a linear
    // ramp: Earth falls away quickly at first, and the Moon stays small until
    // the last stretch — which is how the crossing actually looked.
    const eT = Math.pow(THREE.MathUtils.clamp(journey, 0, 1), 0.42);
    const mT = Math.pow(THREE.MathUtils.clamp(journey, 0, 1), 3.1);

    const earthRadius = THREE.MathUtils.lerp(EARTH_NEAR.radius, EARTH_FAR.radius, eT);
    const earthDist = THREE.MathUtils.lerp(EARTH_NEAR.distance, EARTH_FAR.distance, eT);
    const moonRadius = THREE.MathUtils.lerp(MOON_FAR.radius, MOON_NEAR.radius, mT);
    const moonDist = THREE.MathUtils.lerp(MOON_FAR.distance, MOON_NEAR.distance, mT);

    // Earth astern, Moon ahead, each held on its own bearing at a distance
    // comfortably greater than its radius so the camera is always outside it.
    this.earth.scale.setScalar(earthRadius);
    this.earth.position.copy(EARTH_DIR).multiplyScalar(earthDist);

    // Arrival: in lunar orbit the Moon swings round beneath the stack and
    // closes to orbital height (`orbit`), then rises to meet the LM as it
    // descends (`approach`). Both are driven by the coast runtime.
    const orbit = this.orbit;
    const approach = this.approach;
    this._moonDir.copy(MOON_DIR).lerp(ORBIT_MOON_DIR, orbit).normalize();
    const orbitDist = moonRadius * (1 + THREE.MathUtils.lerp(0.17, 0.012, approach));
    const placedDist = THREE.MathUtils.lerp(moonDist, orbitDist, orbit);

    this.moon.scale.setScalar(moonRadius);
    this.moon.position.copy(this._moonDir).multiplyScalar(placedDist);
    // The surface slides past below as the orbit carries the stack round —
    // faster and faster in apparent terms as it gets closer.
    this.moon.rotation.x += dt * (0.006 + approach * 0.02) * orbit;

    // Sun direction for this point in the crossing (see the constructor).
    const turn = THREE.MathUtils.smoothstep(journey, 0.25, 0.95);
    this.sunDirection.copy(SUN_DEPARTURE).lerp(SUN_ARRIVAL, turn).normalize();
    this.earthGlobe.setSunDirection(this.sunDirection);
    this.moonMaterial.uniforms.sunDirection.value.copy(this.sunDirection);
    this.sun.group.position.copy(this.sunDirection).multiplyScalar(SKY_RADIUS * 0.92);

    this.earthGlobe.update(dt);

    const probeKey = journey + orbit * 2 + approach * 4;
    if (Math.abs(probeKey - this._probeJourney) > 0.01) {
      this._probeJourney = probeKey;
      this._bakeProbe(earthRadius, earthDist, moonRadius, placedDist);
    }

    this.sunLight.position.copy(camera.position).addScaledVector(this.sunDirection, 1000);
    this.sunLight.target.position.copy(camera.position);
    this.sunLight.target.updateMatrixWorld();
  }

  /** World position of the Moon, so cameras can frame the destination. */
  get moonPosition() {
    return this.moon.getWorldPosition(new THREE.Vector3());
  }

  get earthPosition() {
    return this.earth.getWorldPosition(new THREE.Vector3());
  }

  setQuality() {
    /* nothing here scales with quality — no shadows, no postfx of its own */
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.sunLight);
    if (this.probe && this.scene.environment === this.probe.texture) this.scene.environment = null;
    this.probe?.dispose();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.starMaterial.dispose();
    this.earthGlobe.dispose();
    this.moonMaterial.dispose();
    this.sun.dispose();
  }
}
