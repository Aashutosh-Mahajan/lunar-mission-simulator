import * as THREE from "three";
import { makeRng } from "../materials/noise.js";
import { buildSunSprite } from "../materials/textures.js";
import { ASCENT_MISSION, airDensity } from "../levels/ascentConfig.js";

// ---------------------------------------------------------------------------
// The sky above Cape Canaveral, from the pad to orbit.
//
// The hard part of an ascent scene is scale: the vehicle climbs 185 km, and a
// literal Earth of radius 6371 km will not fit in a depth buffer alongside a
// 110 m rocket. The trick used here is that the *horizon dip angle* only
// depends on the ratio h/R — so the Earth is drawn at 1/2000 scale with the
// camera's altitude scaled by the same factor. The curvature and the horizon
// position are then geometrically exact at every altitude, while everything
// stays inside a small far plane.
//
// The globe is drawn behind everything (no depth write, low render order), so
// the real-scale launch complex and terrain simply overlay it near the ground.
// ---------------------------------------------------------------------------

const GLOBE_SCALE = 1 / 2000;
const EARTH_RADIUS = 6371000; // m
const GLOBE_RADIUS = EARTH_RADIUS * GLOBE_SCALE; // ≈ 3185 render units
const SKY_RADIUS = 9000;
const STAR_COUNT = 6000;

// Sky colour as a function of altitude. Real values: a deep blue zenith at sea
// level, indigo through the stratosphere, black above roughly 60 km.
const SKY_STOPS = [
  { alt: 0, zenith: 0x2f6ab8, horizon: 0xbcd6ee },
  { alt: 6000, zenith: 0x1c4a92, horizon: 0x93b8dc },
  { alt: 14000, zenith: 0x0d2a63, horizon: 0x5b86bb },
  { alt: 26000, zenith: 0x04123a, horizon: 0x27508c },
  { alt: 45000, zenith: 0x010720, horizon: 0x0d2450 },
  { alt: 70000, zenith: 0x000208, horizon: 0x030e22 },
  { alt: 110000, zenith: 0x000000, horizon: 0x000306 },
];

function lerpStops(altitude) {
  if (altitude <= SKY_STOPS[0].alt) return SKY_STOPS[0];
  const last = SKY_STOPS[SKY_STOPS.length - 1];
  if (altitude >= last.alt) return last;
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const a = SKY_STOPS[i];
    const b = SKY_STOPS[i + 1];
    if (altitude >= a.alt && altitude <= b.alt) {
      const t = (altitude - a.alt) / (b.alt - a.alt);
      return {
        zenith: new THREE.Color(a.zenith).lerp(new THREE.Color(b.zenith), t),
        horizon: new THREE.Color(a.horizon).lerp(new THREE.Color(b.horizon), t),
      };
    }
  }
  return last;
}

const skyVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragment = /* glsl */ `
  uniform vec3 zenithColor;
  uniform vec3 horizonColor;
  uniform vec3 sunDirection;
  uniform float sunGlow;
  varying vec3 vWorld;

  void main() {
    // Gradient is biased toward the horizon, as real atmospheric scattering is.
    float t = pow(clamp(vWorld.y, 0.0, 1.0), 0.42);
    vec3 col = mix(horizonColor, zenithColor, t);

    // Forward-scattering halo around the sun, only while there is air.
    float sunDot = max(dot(normalize(vWorld), normalize(sunDirection)), 0.0);
    col += horizonColor * pow(sunDot, 8.0) * sunGlow * 1.4;
    col += vec3(1.0, 0.86, 0.66) * pow(sunDot, 220.0) * sunGlow;

    // Below the horizon fades to nothing so the ground can take over.
    float below = smoothstep(-0.06, 0.02, vWorld.y);
    gl_FragColor = vec4(col, below);
  }
`;

const globeVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vWorldPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const globeFragment = /* glsl */ `
  uniform vec3 landColor;
  uniform vec3 oceanColor;
  uniform vec3 hazeColor;
  uniform float opacity;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec3 n = normalize(vNormal);
    // Coarse continents; at the scale this is seen (a limb far below) only
    // the large-scale land/sea contrast reads.
    float c = noise(n.xz * 5.0 + 2.0) * 0.6 + noise(n.xy * 9.0) * 0.4;
    vec3 base = mix(oceanColor, landColor, smoothstep(0.52, 0.62, c));

    // Cloud decks.
    float cloud = smoothstep(0.55, 0.78, noise(n.xz * 13.0 + 7.0) * 0.6 + noise(n.zy * 21.0) * 0.4);
    base = mix(base, vec3(0.92, 0.94, 0.97), cloud * 0.75);

    // Day/night terminator.
    float lit = clamp(dot(n, normalize(sunDirection)) * 1.6 + 0.35, 0.03, 1.0);
    base *= lit;

    // Atmospheric haze thickens toward the limb.
    float limb = 1.0 - abs(dot(n, normalize(-vWorldPos)));
    base = mix(base, hazeColor, pow(clamp(limb, 0.0, 1.0), 2.2) * 0.85);

    gl_FragColor = vec4(base, opacity);
  }
`;

const limbFragment = /* glsl */ `
  uniform vec3 glowColor;
  uniform float opacity;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 n = normalize(vNormal);
    float rim = 1.0 - abs(dot(n, normalize(-vWorldPos)));
    rim = pow(clamp(rim, 0.0, 1.0), 3.0);
    float lit = clamp(dot(n, normalize(sunDirection)) * 0.6 + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(glowColor, rim * lit * opacity);
  }
`;

export default class EarthScene {
  constructor(scene, mission = ASCENT_MISSION) {
    this.scene = scene;
    this.mission = mission;

    this.group = new THREE.Group();
    this.group.name = "earthSky";
    scene.add(this.group);

    // Sun placed for a morning launch: low and roughly downrange, which puts
    // the vehicle in strong side light through the whole first stage.
    const az = THREE.MathUtils.degToRad(78);
    const el = THREE.MathUtils.degToRad(26);
    this.sunDirection = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az)
    ).normalize();

    this._buildSkyDome();
    this._buildStars();
    this._buildSun();
    this._buildGlobe();
    this._buildLights();

    scene.background = new THREE.Color(0x0b1c33);

    /** Photographic exposure: a sunlit white vehicle under a blue sky. */
    this.exposure = 1.0;
  }

  _buildSkyDome() {
    const geo = new THREE.SphereGeometry(SKY_RADIUS * 0.96, 40, 28);
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        zenithColor: { value: new THREE.Color(SKY_STOPS[0].zenith) },
        horizonColor: { value: new THREE.Color(SKY_STOPS[0].horizon) },
        sunDirection: { value: this.sunDirection.clone() },
        sunGlow: { value: 1 },
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      transparent: true,
    });
    this.sky = new THREE.Mesh(geo, this.skyMaterial);
    this.sky.renderOrder = -200;
    this.group.add(this.sky);
  }

  _buildStars() {
    const rng = makeRng(72841);
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);
    const colors = new Float32Array(STAR_COUNT * 3);
    const color = new THREE.Color();

    for (let i = 0; i < STAR_COUNT; i++) {
      const u = rng() * 2 - 1;
      const theta = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dir = new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta));
      dir.multiplyScalar(SKY_RADIUS * 0.94);
      positions[i * 3] = dir.x;
      positions[i * 3 + 1] = dir.y;
      positions[i * 3 + 2] = dir.z;

      const mag = Math.pow(rng(), 3.4);
      sizes[i] = 0.7 + mag * 4.6;
      const t = rng();
      if (t > 0.9) color.setRGB(1.0, 0.78, 0.6);
      else if (t > 0.45) color.setRGB(1.0, 0.98, 0.94);
      else color.setRGB(0.84, 0.9, 1.0);
      const bright = 0.4 + mag * 0.8;
      colors[i * 3] = color.r * bright;
      colors[i * 3 + 1] = color.g * bright;
      colors[i * 3 + 2] = color.b * bright;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("starColor", new THREE.BufferAttribute(colors, 3));

    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 } },
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
      fragmentShader: /* glsl */ `
        uniform float opacity;
        varying vec3 vColor;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float a = smoothstep(0.5, 0.06, length(uv));
          a *= a * opacity;
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
    this.stars.renderOrder = -190;
    this.group.add(this.stars);
  }

  _buildSun() {
    const sprite = buildSunSprite();
    const dist = SKY_RADIUS * 0.9;
    this.sunSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sprite,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        transparent: true,
      })
    );
    this.sunSprite.scale.setScalar(dist * 0.03);
    this.sunSprite.position.copy(this.sunDirection).multiplyScalar(dist);
    this.sunSprite.renderOrder = -150;
    this.group.add(this.sunSprite);
  }

  /**
   * The scaled Earth. Fades in as the local terrain loses meaning, and is
   * always drawn behind everything else.
   */
  _buildGlobe() {
    this.globeGroup = new THREE.Group();
    this.group.add(this.globeGroup);

    this.globeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        landColor: { value: new THREE.Color(0x4a5c3a) },
        oceanColor: { value: new THREE.Color(0x14355e) },
        hazeColor: { value: new THREE.Color(0x86b4e8) },
        sunDirection: { value: this.sunDirection.clone() },
        opacity: { value: 0 },
      },
      vertexShader: globeVertex,
      fragmentShader: globeFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    this.globe = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS, 96, 64),
      this.globeMaterial
    );
    this.globe.renderOrder = -180;
    this.globeGroup.add(this.globe);

    // Atmospheric limb: the bright blue arc along the edge of the planet.
    this.limbMaterial = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x6cb4ff) },
        sunDirection: { value: this.sunDirection.clone() },
        opacity: { value: 0 },
      },
      vertexShader: globeVertex,
      fragmentShader: limbFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    // Atmosphere is ~100 km deep; at globe scale that is a thin shell.
    this.limb = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS * 1.016, 96, 64),
      this.limbMaterial
    );
    this.limb.renderOrder = -179;
    this.globeGroup.add(this.limb);
  }

  _buildLights() {
    this.sunLight = new THREE.DirectionalLight(0xfff4e2, 3.0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 1200;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.5;
    const extent = 220;
    this.sunLight.shadow.camera.left = -extent;
    this.sunLight.shadow.camera.right = extent;
    this.sunLight.shadow.camera.top = extent;
    this.sunLight.shadow.camera.bottom = -extent;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // On Earth the sky itself is a huge blue fill light — quite unlike the
    // Moon, where shadows are nearly black.
    this.ambient = new THREE.HemisphereLight(0x94bde8, 0x54514a, 1.5);
    this.scene.add(this.ambient);
  }

  /**
   * @param {THREE.Camera} camera
   * @param {number} altitude metres above the pad
   * @param {THREE.Vector3} focus what the shadow frustum should follow
   */
  update(camera, altitude, focus, dt) {
    this.group.position.copy(camera.position);

    // --- Sky colour and sun halo -----------------------------------------
    const stops = lerpStops(altitude);
    this.skyMaterial.uniforms.zenithColor.value.copy(
      stops.zenith instanceof THREE.Color ? stops.zenith : new THREE.Color(stops.zenith)
    );
    this.skyMaterial.uniforms.horizonColor.value.copy(
      stops.horizon instanceof THREE.Color ? stops.horizon : new THREE.Color(stops.horizon)
    );
    // The halo is scattering, so it fades with the air that causes it.
    const densityRatio = airDensity(altitude) / this.mission.atmosphere.seaLevelDensity;
    this.skyMaterial.uniforms.sunGlow.value = densityRatio;

    // --- Stars appear as the sky darkens ---------------------------------
    this.starMaterial.uniforms.opacity.value = THREE.MathUtils.clamp(
      (altitude - 18000) / 34000,
      0,
      1
    );

    // --- Scaled globe ------------------------------------------------------
    // Placing the sphere centre one scaled planet-radius plus one scaled
    // altitude below the camera reproduces the true horizon dip exactly.
    const scaledAltitude = altitude * GLOBE_SCALE;
    this.globeGroup.position.set(0, -(GLOBE_RADIUS + scaledAltitude), 0);

    const globeFade = THREE.MathUtils.clamp((altitude - 4000) / 22000, 0, 1);
    this.globeMaterial.uniforms.opacity.value = globeFade;
    this.limbMaterial.uniforms.opacity.value = globeFade;
    this.globeGroup.visible = globeFade > 0.005;

    // Slowly rotate so the surface below is not static during a long climb.
    this.globe.rotation.y += dt * 0.0009;

    // --- Lighting ----------------------------------------------------------
    const target = focus ?? camera.position;
    this.sunLight.target.position.copy(target);
    this.sunLight.position.copy(target).addScaledVector(this.sunDirection, 500);

    // Above the atmosphere the blue sky fill disappears and lighting becomes
    // as harsh as it is on the Moon.
    this.ambient.intensity = 0.28 + densityRatio * 1.3;
  }

  setQuality(quality) {
    const size = quality === "low" ? 1024 : quality === "high" ? 2048 : 2048;
    if (this.sunLight.shadow.mapSize.x !== size) {
      this.sunLight.shadow.mapSize.set(size, size);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
    this.sunLight.castShadow = quality !== "low";
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.ambient);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.skyMaterial.dispose();
    this.starMaterial.dispose();
    this.globeMaterial.dispose();
    this.limbMaterial.dispose();
    // Both of these were left on the GPU after every launch: the sun sprite's
    // texture is baked per scene, and a light's shadow map is a render target
    // that removing the light from the scene does not release.
    this.sunSprite.material.map?.dispose();
    this.sunSprite.material.dispose();
    this.sunLight.shadow.map?.dispose();
    this.sunLight.shadow.map = null;
  }
}
