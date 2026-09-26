import * as THREE from "three";
import { makeRng, makeSimplex2, fbm, clamp } from "../materials/noise.js";
import { buildEarthMaps, buildSunSprite } from "../materials/textures.js";
import {
  SUN_COLOR,
  SUN_INTENSITY,
  AMBIENT_SKY_COLOR,
  AMBIENT_GROUND_COLOR,
  AMBIENT_INTENSITY,
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

const starFragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    // Soft airy-disc-ish falloff; a hard dot reads as aliasing.
    float a = smoothstep(0.5, 0.06, d);
    a *= a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const atmosphereVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const atmosphereFragmentShader = /* glsl */ `
  uniform vec3 glowColor;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    // Rim brightens toward the limb (Rayleigh-ish forward scattering shell).
    float rim = 1.0 - abs(dot(vNormal, vViewDir));
    rim = pow(clamp(rim, 0.0, 1.0), 2.6);
    // Only the sunlit limb glows.
    float lit = clamp(dot(vNormal, normalize(sunDirection)) * 0.5 + 0.5, 0.0, 1.0);
    float a = rim * pow(lit, 1.6);
    gl_FragColor = vec4(glowColor, a * 0.9);
  }
`;

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

    scene.background = new THREE.Color(0x000000);
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

    const sprite = buildSunSprite();
    // The sun subtends only about half a degree. The glare is deliberately a
    // little larger than that (the sprite's soft halo plus the bloom pass do
    // the work), but not so large that it washes the frame out.
    const discSize = dist * 0.019;
    const material = new THREE.SpriteMaterial({
      map: sprite,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Depth-tested: terrain, and the vehicle itself, must be able to
      // eclipse the sun rather than the sprite drawing over everything.
      depthTest: true,
      transparent: true,
    });
    this.sunSprite = new THREE.Sprite(material);
    this.sunSprite.scale.setScalar(discSize);
    this.sunGroup.add(this.sunSprite);

    // Small bright core to give the bloom pass something to latch onto.
    const coreMat = new THREE.SpriteMaterial({
      map: sprite,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this.sunCore = new THREE.Sprite(coreMat);
    this.sunCore.scale.setScalar(discSize * 0.32);
    this.sunGroup.add(this.sunCore);
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

    const surface = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 64, 48),
      new THREE.MeshStandardMaterial({
        map,
        roughness: 0.82,
        metalness: 0,
        // Cities on the night side, very faint.
        emissive: 0x0a0f1a,
        emissiveIntensity: 1,
      })
    );
    surface.rotation.y = THREE.MathUtils.degToRad(-30);
    this.earthGroup.add(surface);
    this.earthSurface = surface;

    const cloudLayer = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.012, 64, 48),
      new THREE.MeshStandardMaterial({
        map: clouds,
        transparent: true,
        roughness: 1,
        metalness: 0,
        depthWrite: false,
      })
    );
    this.earthGroup.add(cloudLayer);
    this.earthClouds = cloudLayer;

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.09, 48, 32),
      new THREE.ShaderMaterial({
        vertexShader: atmosphereVertexShader,
        fragmentShader: atmosphereFragmentShader,
        uniforms: {
          glowColor: { value: new THREE.Color(0x5fa8ff) },
          sunDirection: { value: this.sunDirection.clone() },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    this.earthGroup.add(atmosphere);
    this.earthAtmosphere = atmosphere;
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
      this.earthAtmosphere.material.uniforms.sunDirection.value.copy(this.sunDirection);

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
  }

  /**
   * Keeps the sky centred on the camera and slides the shadow frustum along
   * with the vehicle so a tight, high-resolution shadow map can cover a large
   * world.
   */
  update(camera, focus, dt) {
    this.group.position.copy(camera.position);

    const target = focus ?? camera.position;
    this.sunLight.target.position.copy(target);
    this.sunLight.position.copy(target).addScaledVector(this.sunDirection, 400);

    if (this.earthClouds) {
      // Slow cloud drift; Earth's rotation is ~15 deg/hour, far too slow to
      // see, so this is a deliberate, gentle exaggeration.
      this.earthClouds.rotation.y += dt * 0.004;
      this.earthSurface.rotation.y += dt * 0.0016;
    }
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
  }
}
