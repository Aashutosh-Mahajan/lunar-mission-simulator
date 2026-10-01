import * as THREE from "three";
import { makeRng, makeSimplex2, fbm, clamp } from "../materials/noise.js";
import { buildEarthMaps } from "../materials/textures.js";
import { createSun } from "../materials/sun.js";
import EarthGlobe from "./EarthGlobe.js";
import { createLunarProbe } from "../materials/environmentMaps.js";
import {
  SUN_COLOR,
  SUN_INTENSITY,
  AMBIENT_SKY_COLOR,
  AMBIENT_GROUND_COLOR,
  AMBIENT_INTENSITY,
  LUNAR_EXPOSURE,
  REGOLITH_ALBEDO,
} from "../constants.js";

// ---------------------------------------------------------------------------
// The lunar sky: stars, the Milky Way, Earth, and the sun.
//
// Everything here lives in a group that is re-centred on the camera each
// frame, so it behaves as if at infinity. There is no atmosphere, so there is
// no sky glow, no haze and no aerial perspective — the sky is black right
// down to the horizon line and shadows are almost unlit. Sun elevation is
// deliberately low (~13 degrees), the lighting condition Apollo landings were
// planned for because long shadows are the only depth cue on a surface with
// no trees, buildings or atmosphere.
// ---------------------------------------------------------------------------

const SKY_RADIUS = 9000;
const STAR_COUNT = 9000;

const starVertexShader = /* glsl */ `
  attribute float size;
  attribute vec3 starColor;
  varying vec3 vColor;
  void main() {
    vColor = starColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // Stars are effectively at infinity: no distance attenuation.
    gl_PointSize = size;
  }
`;

// Stars are subject to the same exposure as everything else. Apollo surface
// photographs show a black sky: an exposure short enough for sunlit regolith
// is far too short to register stars. `threshold` removes stars fainter than
// the exposure can record, and `gain` dims the survivors; the sky exposure is
// only opened up when there is no sunlit ground in view (the menu backdrop).
const starFragmentShader = /* glsl */ `
  uniform float threshold;
  uniform float gain;
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    // Soft airy-disc-ish falloff; a hard dot reads as aliasing.
    float a = smoothstep(0.5, 0.06, d);
    a *= a;
    float lum = max(vColor.r, max(vColor.g, vColor.b));
    float recorded = smoothstep(threshold, threshold + 0.18, lum) * gain;
    a *= recorded;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

// Sky exposure: menu backdrop (no sunlit ground) versus on the surface.
const SKY_EXPOSURE = {
  open: { threshold: 0.0, gain: 1.0, milkyWay: 1.0 },
  // Only the handful of brightest stars (and planets) survive an exposure
  // set for sunlit ground; at 0.98 several hundred did.
  surface: { threshold: 1.1, gain: 0.45, milkyWay: 0.0 },
};

export default class Environment {
  /**
   * @param {THREE.Scene} scene
   * @param {object} options { sunAzimuthDeg, sunElevationDeg, earthAzimuthDeg, earthElevationDeg, earthPhase }
   */
  constructor(scene, options = {}, assets = null) {
    this.scene = scene;
    this.assets = assets;
    this.options = {
      sunAzimuthDeg: 118,
      sunElevationDeg: 13,
      earthAzimuthDeg: -55,
      earthElevationDeg: 34,
      ...options,
    };

    this.group = new THREE.Group();
    this.group.name = "sky";
    scene.add(this.group);

    this.sunDirection = new THREE.Vector3();
    this._computeSunDirection();

    this._buildStars();
    this._buildMilkyWay();
    this._buildSun();
    this._buildEarth();
    this._buildLights();

    // Image-based lighting: the sunlit ground below and Earth above, baked
    // into a pre-filtered environment for every PBR material in the scene.
    // Rebaked per site in configure(), since the sun moves.
    this.probe = assets?.renderer ? createLunarProbe(assets.renderer) : null;
    this.envTexture = null;
    this._bakeEnvironment();

    /** Photographic exposure for a sunlit lunar scene (see constants.js). */
    this.exposure = LUNAR_EXPOSURE;

    scene.background = new THREE.Color(0x000000);
  }

  _bakeEnvironment() {
    if (!this.probe) return;
    const u = this.probe.uniforms;
    u.sunDirection.value.copy(this.sunDirection);
    u.sunIrradiance.value = SUN_INTENSITY;
    u.groundAlbedo.value.setRGB(REGOLITH_ALBEDO, REGOLITH_ALBEDO * 0.96, REGOLITH_ALBEDO * 0.9);
    // The lower the sun, the more of the ground in view sits in shadow —
    // above ~25 degrees almost every surface is lit.
    const el = this.options.sunElevationDeg;
    u.shadowFraction.value = THREE.MathUtils.clamp(0.75 - el * 0.022, 0.15, 0.7);
    u.earthDirection.value.copy(this.earthGroup.position).normalize();
    this.envTexture = this.probe.bake();
    if (this.group.visible) this.scene.environment = this.envTexture;
  }

  _computeSunDirection() {
    const az = THREE.MathUtils.degToRad(this.options.sunAzimuthDeg);
    const el = THREE.MathUtils.degToRad(this.options.sunElevationDeg);
    this.sunDirection
      .set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
      .normalize();
  }

  _buildStars() {
    const rng = makeRng(90210);
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);
    const colors = new Float32Array(STAR_COUNT * 3);
    const color = new THREE.Color();

    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform on a sphere.
      const u = rng() * 2 - 1;
      const theta = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dir = new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta));

      // Concentrate a third of the stars into a galactic band.
      if (i % 3 === 0) {
        const bandNormal = new THREE.Vector3(0.42, 0.82, -0.39).normalize();
        const along = dir.dot(bandNormal);
        dir.addScaledVector(bandNormal, -along * (0.82 + rng() * 0.14)).normalize();
      }

      dir.multiplyScalar(SKY_RADIUS * 0.98);
      positions[i * 3] = dir.x;
      positions[i * 3 + 1] = dir.y;
      positions[i * 3 + 2] = dir.z;

      // Magnitude distribution: overwhelmingly faint stars, a few bright ones.
      const mag = Math.pow(rng(), 3.6);
      sizes[i] = 0.7 + mag * 5.4;

      // Stellar colour by temperature class — mostly white/blue-white with a
      // scattering of orange and red giants.
      const t = rng();
      if (t > 0.93) color.setRGB(1.0, 0.72, 0.52);
      else if (t > 0.84) color.setRGB(1.0, 0.86, 0.72);
      else if (t > 0.4) color.setRGB(1.0, 0.98, 0.95);
      else color.setRGB(0.82, 0.89, 1.0);

      const bright = 0.35 + mag * 0.85;
      colors[i * 3] = color.r * bright;
      colors[i * 3 + 1] = color.g * bright;
      colors[i * 3 + 2] = color.b * bright;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("starColor", new THREE.BufferAttribute(colors, 3));

    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: {
        threshold: { value: SKY_EXPOSURE.open.threshold },
        gain: { value: SKY_EXPOSURE.open.gain },
      },
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.stars = new THREE.Points(geometry, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -100;
    this.group.add(this.stars);
  }

  /** Faint diffuse band of unresolved galactic starlight. */
  _buildMilkyWay() {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    const noise = makeSimplex2(4711);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        // A band across the middle of the texture, broken up by dust lanes.
        const band = Math.exp(-Math.pow((v - 0.5) / 0.13, 2));
        const clumps = fbm(noise, u * 6, v * 12, 5) * 0.5 + 0.5;
        const dust = clamp(fbm(noise, u * 9 + 4, v * 20, 4) * 0.5 + 0.5, 0, 1);
        const a = clamp(band * clumps * (1 - dust * 0.55), 0, 1);
        const i = (y * size + x) * 4;
        img.data[i] = 214;
        img.data[i + 1] = 220;
        img.data[i + 2] = 240;
        img.data[i + 3] = Math.pow(a, 1.7) * 78;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;

    const geometry = new THREE.SphereGeometry(SKY_RADIUS * 0.985, 48, 32);
    const material = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.milkyWay = new THREE.Mesh(geometry, material);
    // Tilt the galactic plane away from the local horizon.
    this.milkyWay.rotation.set(THREE.MathUtils.degToRad(58), 0.9, THREE.MathUtils.degToRad(22));
    this.milkyWay.renderOrder = -101;
    this.group.add(this.milkyWay);
  }

  _buildSun() {
    const dist = SKY_RADIUS * 0.9;
    this.sunGroup = new THREE.Group();
    this.sunGroup.position.copy(this.sunDirection).multiplyScalar(dist);
    this.group.add(this.sunGroup);

    // Depth-tested: terrain, and the vehicle itself, must be able to eclipse
    // the sun rather than the sprite drawing over everything.
    this.sun = createSun(dist, { depthTest: true });
    this.sunGroup.add(this.sun.group);
  }

  _buildEarth() {
    // Shared with the cislunar scene; baked once during the loading screen.
    const { map, clouds } = this.assets?.earth ?? buildEarthMaps();
    const dist = SKY_RADIUS * 0.82;
    // Earth is ~2 degrees across from the Moon. Rendered slightly larger than
    // life (about 3.5 degrees) so it reads as a recognisable planet.
    const radius = dist * 0.031;

    const az = THREE.MathUtils.degToRad(this.options.earthAzimuthDeg);
    const el = THREE.MathUtils.degToRad(this.options.earthElevationDeg);
    const dir = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az)
    );

    this.earthGroup = new THREE.Group();
    this.earthGroup.position.copy(dir).multiplyScalar(dist);
    this.group.add(this.earthGroup);

    // The same physically based globe the player left from (see
    // entities/EarthGlobe.js), at ~3.5 degrees across.
    this.earthGlobe = new EarthGlobe({ map, clouds }, this.sunDirection, { segments: 64, spin: 0.0016 });
    this.earthGlobe.mesh.scale.setScalar(radius);
    this.earthGlobe.mesh.rotation.y = THREE.MathUtils.degToRad(-30);
    this.earthGroup.add(this.earthGlobe.mesh);
  }

  _buildLights() {
    this.sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 900;
    // The shadow map only handles dynamic casters (vehicle, boulders) —
    // terrain self-shadowing is baked into vertex colours in Terrain.js — so
    // the bias can stay small and shadows stay attached to their casters.
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.4;
    const extent = 190;
    this.sunLight.shadow.camera.left = -extent;
    this.sunLight.shadow.camera.right = extent;
    this.sunLight.shadow.camera.top = extent;
    this.sunLight.shadow.camera.bottom = -extent;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // With no atmosphere there is no sky fill; what little light reaches the
    // shadows is bounced off the regolith, so the "ground" half of this
    // hemisphere light is warm and the "sky" half is nearly black.
    this.ambient = new THREE.HemisphereLight(
      AMBIENT_SKY_COLOR,
      AMBIENT_GROUND_COLOR,
      AMBIENT_INTENSITY
    );
    this.scene.add(this.ambient);
  }

  /**
   * Re-aims the sun and Earth for a new landing site. Textures and geometry
   * are reused; only the directions change, so switching sites is instant.
   */
  configure({ sun, earth, lighting }) {
    // Sites where the sun barely clears the horizon get more fill light. At
    // the poles that is physically reasonable — Earth sits near the horizon
    // and Earthshine is the dominant illumination in the permanent shadow —
    // and it keeps the approach flyable rather than pitch black.
    this.ambient.intensity = AMBIENT_INTENSITY * (lighting?.ambientScale ?? 1);

    if (sun) {
      this.options.sunAzimuthDeg = sun.azimuthDeg;
      this.options.sunElevationDeg = sun.elevationDeg;
      this._computeSunDirection();
      this.sunGroup.position.copy(this.sunDirection).multiplyScalar(SKY_RADIUS * 0.9);
      this.earthGlobe.setSunDirection(this.sunDirection);

      // A very low sun means very long shadows, which need a deeper shadow
      // frustum to avoid being clipped short.
      const el = Math.max(1.5, sun.elevationDeg);
      const reach = THREE.MathUtils.clamp(220 / Math.tan(THREE.MathUtils.degToRad(el)), 300, 2600);
      this.sunLight.shadow.camera.far = reach;
      this.sunLight.shadow.camera.updateProjectionMatrix();
    }

    if (earth) {
      this.options.earthAzimuthDeg = earth.azimuthDeg;
      this.options.earthElevationDeg = earth.elevationDeg;
      const az = THREE.MathUtils.degToRad(earth.azimuthDeg);
      const el = THREE.MathUtils.degToRad(earth.elevationDeg);
      this.earthGroup.position
        .set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
        .multiplyScalar(SKY_RADIUS * 0.82);
    }

    this._bakeEnvironment();
  }

  /**
   * Keeps the sky centred on the camera and slides the shadow frustum along
   * with the vehicle so a tight, high-resolution shadow map can cover a large
   * world.
   */
  update(camera, focus, dt) {
    this.group.position.copy(camera.position);

    // Ease the sky exposure between the open menu sky and the sunlit surface
    // rather than popping the stars on and off.
    const want = focus ? SKY_EXPOSURE.surface : SKY_EXPOSURE.open;
    const k = 1 - Math.exp(-3 * Math.min(dt, 0.1));
    const u = this.starMaterial.uniforms;
    u.threshold.value += (want.threshold - u.threshold.value) * k;
    u.gain.value += (want.gain - u.gain.value) * k;
    if (this.milkyWay) {
      const m = this.milkyWay.material;
      m.opacity += (want.milkyWay - m.opacity) * k;
      this.milkyWay.visible = m.opacity > 0.01;
    }

    const target = focus ?? camera.position;
    this.sunLight.target.position.copy(target);
    this.sunLight.position.copy(target).addScaledVector(this.sunDirection, 400);

    // Slow cloud drift and spin; Earth's rotation is ~15 deg/hour, far too
    // slow to see, so this is a deliberate, gentle exaggeration.
    this.earthGlobe.update(dt);
  }

  /**
   * Turns the lunar sky and its lighting on or off. Phase 2 replaces both
   * with the Earth scene, so they have to stand down rather than double up.
   */
  setEnabled(enabled) {
    this.group.visible = enabled;
    this.sunLight.visible = enabled;
    this.ambient.visible = enabled;
    // A disabled light still costs a shadow pass unless it stops casting.
    this.sunLight.castShadow = enabled && this._castShadow !== false;
    // Phase 2 tints the background for the Earth sky; take it back on return.
    if (enabled) this.scene.background = new THREE.Color(0x000000);
    // The other phases bring their own image-based lighting.
    if (enabled) this.scene.environment = this.envTexture;
    else if (this.scene.environment === this.envTexture) this.scene.environment = null;
  }

  setQuality(quality) {
    // The frustum spans roughly ±190 m, so 2048 texels is ~0.19 m each —
    // already finer than anything on screen resolves. 4096 quadrupled the
    // shadow pass (about 6 ms a frame on integrated graphics) for no visible
    // gain.
    const size = quality === "low" ? 1024 : quality === "high" ? 2048 : 1536;
    if (this.sunLight.shadow.mapSize.x !== size) {
      this.sunLight.shadow.mapSize.set(size, size);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
    this._castShadow = quality !== "low";
    this.sunLight.castShadow = this._castShadow && this.sunLight.visible;
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.ambient);
    if (this.scene.environment === this.envTexture) this.scene.environment = null;
    this.probe?.dispose();
    this.sun.dispose();
    this.earthGlobe.dispose();
  }
}
