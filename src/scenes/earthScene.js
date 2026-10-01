import * as THREE from "three";
import { makeRng } from "../materials/noise.js";
import { createSun } from "../materials/sun.js";
import { EnvironmentProbe } from "../materials/environmentMaps.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { ATMOSPHERE_GLSL, R_GROUND, sunTransmittance, skyRadiance } from "../materials/atmosphere.js";
import { ASCENT_MISSION } from "../levels/ascentConfig.js";
import { SUN_COLOR, SUN_INTENSITY } from "../constants.js";

// ---------------------------------------------------------------------------
// The sky above Cape Canaveral, from the pad to orbit.
//
// Everything beyond the launch complex — the air, the cloud deck, the curved
// Earth below — is one shader on a sky sphere, ray-marched through a
// physically based atmosphere (materials/atmosphere.js) against a true-scale
// spherical planet.
//
// That replaces an older trick of drawing a 1/2000-scale globe with the
// camera's altitude scaled to match. The trick got the horizon dip right but
// nothing else: the sky was a gradient keyed on altitude, the haze a painted
// rim. Done analytically in the shader there is no depth-buffer problem at
// all (the sphere is background, so its size never meets the depth range),
// and the horizon dip, the limb, the aerial perspective and the darkening of
// the sky with height all fall out of the same few constants.
//
// The same model is baked into an environment probe for image-based
// lighting, and evaluated on the CPU for the sun's colour and the ground's
// haze, so the vehicle is lit by the sky the player can see.
// ---------------------------------------------------------------------------

const SKY_RADIUS = 9000;
const STAR_COUNT = 6000;
const CAPE_EXTENT_KM = 26; // the baked Cape map (see textures.js)
const CLOUD_BASE_KM = 1.6; // fair-weather cumulus over Florida
const CLOUD_TOP_KM = 2.6;

// Planet surface, in km about the pad (x east, z south). The Cape map covers
// the first 13 km; beyond it, Florida's Atlantic coast runs north-south a
// kilometre east of the pad, with scrub and lagoons inland and ocean
// offshore — which is the view down the launch azimuth.
const surfaceGLSL = /* glsl */ `
  uniform sampler2D capeMap;
  uniform sampler2D noiseTex;   // tileable fbm, four fields (textures.js)
  uniform float time;
  uniform float cloudCover;

  // One mipmapped fetch per field instead of evaluating fbm per pixel. The
  // texture's base octave has four cells per tile, so p * 0.25 samples it
  // at one cell per unit of p.
  vec4 esNoise(vec2 p) {
    return texture2D(noiseTex, p * 0.25);
  }

  // Linear albedo of the surface at pad-relative (east, south) km.
  vec3 surfaceAlbedo(vec2 xz, out float water) {
    float coast = 1.1 + 0.65 * sin(xz.y * 0.35) + (esNoise(vec2(xz.y * 0.4, 3.3)).r - 0.5) * 0.76;
    // Far from the pad the coast is the large-scale shape of the peninsula:
    // it bends gently west going south.
    coast -= max(xz.y, 0.0) * 0.08;
    float sea = xz.x - coast;
    water = smoothstep(-0.05, 0.05, sea);
    float depth = clamp(sea / 30.0, 0.0, 1.0);
    // Shallows over the shelf are greener; deep Atlantic is ink blue.
    vec3 ocean = mix(vec3(0.018, 0.05, 0.06), vec3(0.008, 0.022, 0.05), depth);

    float veg = esNoise(xz * 0.9).r;
    float marsh = smoothstep(0.58, 0.66, esNoise(xz * 0.25 + 7.0).g);
    vec3 land = mix(vec3(0.045, 0.06, 0.03), vec3(0.09, 0.085, 0.05), veg);
    land = mix(land, vec3(0.02, 0.04, 0.045), marsh);
    vec3 col = mix(land, ocean, water);

    // Inside the baked map, use it: it is what the launch complex's own
    // ground plane shows, so the two meet without a seam.
    vec2 uv = vec2(xz.x / ${CAPE_EXTENT_KM.toFixed(1)} + 0.5, 0.5 - xz.y / ${CAPE_EXTENT_KM.toFixed(1)});
    vec2 edge = abs(uv - 0.5);
    float inside = 1.0 - smoothstep(0.42, 0.5, max(edge.x, edge.y));
    if (inside > 0.0) {
      vec3 cape = texture2D(capeMap, uv).rgb;
      col = mix(col, cape, inside);
      // The map's water is the only blue-dominant surface on it.
      float capeWater = smoothstep(1.1, 1.5, cape.b / max(cape.r, 1e-3));
      water = mix(water, capeWater, inside);
    }
    return col;
  }

  // Fair-weather cumulus coverage at pad-relative km, 0..1. 'footprint' is
  // the size of a pixel on the deck, in km.
  float cloudDensity(vec2 xz, float footprint) {
    // Weather: cumulus forms in fields and streets tens of kilometres
    // across, with clear lanes between — not as uniform confetti.
    float weather = esNoise(xz * 0.018 + vec2(3.0, 11.0)).b;
    float cover = clamp(cloudCover * smoothstep(0.3, 0.62, weather) * 1.7, 0.0, 0.85);
    if (cover < 0.005) return 0.0;
    // Individual cells, a few kilometres across, drifting on the trades.
    vec2 p = xz * 0.21 + vec2(time * 0.004, time * 0.0015);
    float cells = esNoise(p).a;
    float c = smoothstep(1.0 - cover, 1.0 - cover + 0.22, cells);
    // Where a cell is smaller than a pixel, thresholded noise only aliases
    // into glitter; use the mean coverage the field would average to.
    float far = smoothstep(0.6, 3.0, footprint);
    return mix(c, cover * 0.55, far);
  }
`;

// ---------------------------------------------------------------------------
// Sky-view LUT (after Hillaire, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique", 2020).
//
// Marching the atmosphere for every pixel cost ~9 ms a frame on integrated
// graphics with the sky filling the screen. But the in-scattered light only
// depends on the view's zenith angle and its azimuth from the sun, and it
// varies smoothly in both — so it is marched once per frame into a small
// texture and looked up per pixel. Rows are spaced so most of them sit near
// the horizon, where the sky changes fastest and the planet's edge must stay
// sharp. Clouds and the surface, which carry real detail, stay per pixel.
// ---------------------------------------------------------------------------

const LUT_WIDTH = 192;
const LUT_HEIGHT = 128;

const lutMappingGLSL = /* glsl */ `
  uniform float horizonAngle;   // zenith angle of the geometric horizon, rad

  vec2 skyLutUv(vec3 dir, vec3 sunDir) {
    float theta = acos(clamp(dir.y, -1.0, 1.0));
    float v;
    if (theta < horizonAngle) {
      float c = theta / horizonAngle;
      v = (1.0 - sqrt(max(1.0 - c, 0.0))) * 0.5;
    } else {
      float c = (theta - horizonAngle) / (ATM_PI - horizonAngle);
      v = 0.5 + 0.5 * sqrt(max(c, 0.0));
    }
    vec2 hd = dir.xz;
    float lh = length(hd);
    vec2 hs = normalize(sunDir.xz + vec2(1e-6, 0.0));
    float cosPhi = lh > 1e-5 ? dot(hd / lh, hs) : 1.0;
    float u = acos(clamp(cosPhi, -1.0, 1.0)) / ATM_PI;
    return vec2(u, v);
  }
`;

const lutVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const lutFragment = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  uniform float camHeight;
  uniform float sunElevation;
  uniform float horizonAngle;
  uniform int lutMode;          // 0 in-scatter, 1 transmittance
  varying vec2 vUv;
  void main() {
    // Inverse of skyLutUv.
    float theta;
    if (vUv.y < 0.5) {
      float c2 = 1.0 - vUv.y * 2.0;
      theta = (1.0 - c2 * c2) * horizonAngle;
    } else {
      float c = vUv.y * 2.0 - 1.0;
      theta = horizonAngle + c * c * (ATM_PI - horizonAngle);
    }
    float phi = vUv.x * ATM_PI;
    vec3 dir = vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
    vec3 sunDir = vec3(cos(sunElevation), sin(sunElevation), 0.0);
    float h0 = max(camHeight, 0.002);
    vec2 ground = atmShell(h0, dir.y, 0.0);
    float tEnd = ground.x > 0.0 ? ground.x : 1e9;
    vec3 T;
    vec3 L = atmInScatter(h0, dir, sunDir, tEnd, 24, T);
    gl_FragColor = lutMode == 0 ? vec4(L, 1.0) : vec4(T, 1.0);
  }
`;

// The shared sky function. 'SKY_FULL' adds the cloud deck and surface
// textures; the lighting probe uses the plain version.
const skyGLSL = /* glsl */ `
  uniform float camHeight;      // km
  uniform vec3 sunDirection;
  uniform float sunIrradiance;
  uniform float downrange;      // km east of the pad
  uniform sampler2D skyInScatter;
  uniform sampler2D skyTransmittance;
  ${lutMappingGLSL}

  // Planet-local direction to pad-relative surface coordinates (km).
  vec2 surfaceCoords(vec3 p) {
    // p is relative to the planet centre in the observer's frame; the
    // observer is 'downrange' km east of the pad.
    float east = atan(p.x, p.y) * ATM_R + downrange;
    float south = atan(p.z, p.y) * ATM_R;
    return vec2(east, south);
  }

  vec3 skyRadiance(vec3 dir) {
    float h0 = max(camHeight, 0.002);
    float mu = dir.y;
    vec3 obs = vec3(0.0, ATM_R + h0, 0.0);

    vec2 ground = atmShell(h0, mu, 0.0);
    bool hitsGround = ground.x > 0.0;
    float tEnd = hitsGround ? ground.x : 1e9;

    vec2 lutUv = skyLutUv(dir, sunDirection);
    vec3 L = texture2D(skyInScatter, lutUv).rgb * sunIrradiance;
    vec3 T = texture2D(skyTransmittance, lutUv).rgb;

    vec3 surface = vec3(0.0);
    float water = 0.0;
    if (hitsGround) {
      vec3 p = obs + dir * tEnd;
      vec3 n = normalize(p);
      float cosSun = dot(n, sunDirection);
      vec3 sunT = atmSunTransmittance(0.0, cosSun);
      #ifdef SKY_FULL
        vec3 albedo = surfaceAlbedo(surfaceCoords(p), water);
      #else
        vec3 albedo = vec3(0.03, 0.045, 0.055);
        water = 0.6;
      #endif
      // Direct sun plus skylight (roughly a fifth of the direct at this
      // elevation, and blue).
      vec3 irradiance = sunIrradiance * (sunT * max(cosSun, 0.0) +
        vec3(0.06, 0.09, 0.14) * smoothstep(-0.1, 0.3, cosSun));
      surface = albedo * irradiance / ATM_PI;
      // Sun glint off the ocean: the bright smear seen from orbit.
      vec3 refl = reflect(-sunDirection, n);
      float glint = pow(max(dot(refl, -dir), 0.0), 180.0);
      surface += water * glint * sunT * sunIrradiance * 0.35 * max(cosSun, 0.0);
    }

    vec3 result = L + T * surface;

    #ifdef SKY_FULL
      // Cumulus deck. The LUT cannot split the in-scatter at the cloud, so
      // it is apportioned by distance through the (mostly low) air.
      vec2 shell = atmShell(h0, mu, ${CLOUD_BASE_KM.toFixed(2)});
      float tCloud = h0 > ${CLOUD_BASE_KM.toFixed(2)} ? shell.x : shell.y;
      // Derivatives must be taken outside the branch.
      vec3 pc = obs + dir * max(tCloud, 0.0);
      vec2 cxz = surfaceCoords(pc);
      float footprint = length(fwidth(cxz));
      if (tCloud > 0.0 && tCloud < tEnd) {
        float density = cloudDensity(cxz, footprint);
        // Seen nearly edge-on the deck closes up into a solid layer.
        float slant = clamp(abs(mu) * 6.0 + 0.15, 0.0, 1.0);
        float alpha = clamp(density * (1.6 - slant * 0.6), 0.0, 1.0);
        if (alpha > 0.002) {
          vec3 nc = normalize(pc);
          float cosSun = dot(nc, sunDirection);
          vec3 sunT = atmSunTransmittance(${CLOUD_BASE_KM.toFixed(2)}, cosSun);
          // Lit tops from above; grey, self-shadowed bases from below.
          float fromAbove = step(${CLOUD_BASE_KM.toFixed(2)}, h0);
          float lit = mix(0.42, 0.95, fromAbove) * (0.8 + 0.2 * density);
          // A cloud is thousands of scattering events deep: it whitens the
          // light that reaches it, rather than passing on the sun's tint.
          vec3 sunCol = mix(sunT, vec3(dot(sunT, vec3(0.2126, 0.7152, 0.0722))), 0.6);
          vec3 cloud = sunIrradiance * (sunCol * max(cosSun, 0.0) * lit + vec3(0.05, 0.065, 0.09)) * 0.8 / ATM_PI;
          float frac = clamp(1.0 - exp(-tCloud / 9.0), 0.0, 1.0);
          vec3 front = L * frac;
          vec3 Tc = mix(vec3(1.0), T, frac);
          result = mix(result, front + Tc * cloud, alpha);
        }
      }
    #endif

    return result;
  }
`;

// Drawn at the far plane (z = w): the dome is at infinity, so it is depth-
// tested against everything opaque and only shades the pixels nothing else
// covers.
const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w;
  }
`;

const skyFragment = /* glsl */ `
  #define SKY_FULL
  ${ATMOSPHERE_GLSL}
  ${surfaceGLSL}
  ${skyGLSL}
  varying vec3 vDir;
  void main() {
    gl_FragColor = vec4(skyRadiance(normalize(vDir)), 1.0);
  }
`;

const probeFragment = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  ${skyGLSL}
  varying vec3 vDir;
  void main() {
    gl_FragColor = vec4(skyRadiance(normalize(vDir)), 1.0);
  }
`;

// Distance (km of altitude) the camera must move before the lighting probe is
// re-baked. Small low down, where the sky changes fastest.
function probeStep(hKm) {
  return Math.max(0.25, hKm * 0.08);
}

export default class EarthScene {
  constructor(scene, mission = ASCENT_MISSION, assets = null) {
    this.scene = scene;
    this.mission = mission;
    this.assets = assets;

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

    this.cameraAltitude = 0;
    this.downrangeKm = 0;
    /** The launch complex, which takes its haze and light from this sky. */
    this.ground = null;
    this._sunT = new THREE.Color();
    this.hazeColor = new THREE.Color();
    /** Camera white balance for this light (see RenderPipeline). */
    this.whiteBalance = new THREE.Color(1, 1, 1);
    this.groundLight = new THREE.Color();

    this._buildSkyLut();
    this._buildSkyDome();
    this._buildStars();
    this._buildSun();
    this._buildLights();
    this._buildProbe();

    scene.background = new THREE.Color(0x000000);

    // Exposure for a sunlit white vehicle under a blue sky. The sun is the
    // same top-of-atmosphere irradiance as on the Moon; the air takes a
    // little off it and the sky adds a lot of fill, so slightly less gain.
    this.exposure = 1.25;
    this.update(null, 0, null, 0);
  }

  /** The two sky-view LUTs and the full-screen pass that fills them. */
  _buildSkyLut() {
    const opts = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
    };
    this.lutInScatter = new THREE.WebGLRenderTarget(LUT_WIDTH, LUT_HEIGHT, opts);
    this.lutTransmittance = new THREE.WebGLRenderTarget(LUT_WIDTH, LUT_HEIGHT, opts);
    this.lutMaterial = new THREE.ShaderMaterial({
      uniforms: {
        camHeight: { value: 0 },
        sunElevation: { value: Math.asin(this.sunDirection.y) },
        horizonAngle: { value: Math.PI / 2 },
        lutMode: { value: 0 },
      },
      vertexShader: lutVertex,
      fragmentShader: lutFragment,
      depthTest: false,
      depthWrite: false,
    });
    this.lutQuad = new FullScreenQuad(this.lutMaterial);
    this._lutHeight = -1;
  }

  /** Re-marches the atmosphere into the LUTs for the camera's height. */
  _renderSkyLut(hKm) {
    const renderer = this.assets?.renderer;
    if (!renderer) return;
    // Nothing to redo while the camera holds its height (on the pad, in a
    // paused frame); below a metre the change is invisible.
    if (Math.abs(hKm - this._lutHeight) < 0.001) return;
    this._lutHeight = hKm;

    const u = this.lutMaterial.uniforms;
    u.camHeight.value = hKm;
    u.horizonAngle.value = this.horizonAngle;
    const previous = renderer.getRenderTarget();
    u.lutMode.value = 0;
    renderer.setRenderTarget(this.lutInScatter);
    this.lutQuad.render(renderer);
    u.lutMode.value = 1;
    renderer.setRenderTarget(this.lutTransmittance);
    this.lutQuad.render(renderer);
    renderer.setRenderTarget(previous);
  }

  _buildSkyDome() {
    const geo = new THREE.SphereGeometry(SKY_RADIUS * 0.96, 64, 40);
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        camHeight: { value: 0 },
        sunDirection: { value: this.sunDirection.clone() },
        sunIrradiance: { value: SUN_INTENSITY },
        downrange: { value: 0 },
        horizonAngle: { value: Math.PI / 2 },
        skyInScatter: { value: this.lutInScatter.texture },
        skyTransmittance: { value: this.lutTransmittance.texture },
        capeMap: { value: this.assets?.capeGround ?? null },
        noiseTex: { value: this.assets?.noise ?? null },
        time: { value: 0 },
        cloudCover: { value: 0.36 },
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(geo, this.skyMaterial);
    // After the rest of the opaque pass, so its pixels are already covered
    // wherever the vehicle and the pad are (see skyVertex).
    this.sky.renderOrder = 1000;
    this.sky.frustumCulled = false;
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
    const dist = SKY_RADIUS * 0.9;
    this.sun = createSun(dist, { depthTest: true });
    this.sun.group.position.copy(this.sunDirection).multiplyScalar(dist);
    this.sun.group.renderOrder = -150;
    this.group.add(this.sun.group);
  }

  _buildLights() {
    this.sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
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
  }

  /** Image-based lighting from the same atmosphere the player sees. */
  _buildProbe() {
    this.probe = null;
    const renderer = this.assets?.renderer;
    if (!renderer) return;
    this.probe = new EnvironmentProbe(
      renderer,
      probeFragment,
      {
        camHeight: { value: 0 },
        sunDirection: { value: this.sunDirection.clone() },
        sunIrradiance: { value: SUN_INTENSITY },
        downrange: { value: 0 },
        horizonAngle: { value: Math.PI / 2 },
        skyInScatter: { value: this.lutInScatter.texture },
        skyTransmittance: { value: this.lutTransmittance.texture },
      },
      64
    );
    this._probeAltitude = -Infinity;
  }

  _bakeProbe(hKm) {
    if (!this.probe) return;
    this.probe.uniforms.camHeight.value = hKm;
    this.scene.environment = this.probe.bake();
    this._probeAltitude = hKm;
  }

  /**
   * @param {THREE.Camera|null} camera
   * @param {number} altitude vehicle altitude, metres (kept for callers;
   *   the sky itself is computed from the camera's height)
   * @param {THREE.Vector3|null} focus what the shadow frustum should follow;
   *   its x is the vehicle's downrange distance
   */
  update(camera, altitude, focus, dt) {
    if (camera) this.group.position.copy(camera.position);
    const camY = camera ? camera.position.y : Math.max(altitude, 2);
    const hKm = Math.max(camY, 2) / 1000;
    this.cameraAltitude = camY;
    const downrangeKm = (camera ? camera.position.x : focus?.x ?? 0) / 1000;
    this.downrangeKm = downrangeKm;

    // Zenith angle of the geometric horizon: 90 degrees plus the dip.
    this.horizonAngle = Math.PI / 2 + Math.acos(R_GROUND / (R_GROUND + Math.max(hKm, 0.002)));
    this._renderSkyLut(Math.max(hKm, 0.002));

    const u = this.skyMaterial.uniforms;
    u.camHeight.value = hKm;
    u.downrange.value = downrangeKm;
    u.horizonAngle.value = this.horizonAngle;
    u.time.value += dt;
    if (this.probe) {
      this.probe.uniforms.downrange.value = downrangeKm;
      this.probe.uniforms.horizonAngle.value = this.horizonAngle;
    }

    // --- Sun: what survives the air above the camera ----------------------
    const sunT = sunTransmittance(hKm, this.sunDirection.y, this._sunT);
    this.sunLight.color.set(SUN_COLOR).multiply(sunT);
    this.sunLight.intensity = SUN_INTENSITY;
    // The disc reddens and dims with the same transmittance.
    this.sun.setStrength(1, sunT);
    // White-balance for that light, mostly: a camera set for daylight still
    // leaves a little warmth in low sun, and none above the air.
    const lum = 0.2126 * sunT.r + 0.7152 * sunT.g + 0.0722 * sunT.b;
    const balance = (c) => THREE.MathUtils.lerp(1, lum / Math.max(c, 1e-3), 0.85);
    this.whiteBalance.setRGB(balance(sunT.r), balance(sunT.g), balance(sunT.b));

    // --- Haze and ground light for the launch complex ---------------------
    // Horizon radiance, averaged across and away from the sun, is what
    // distant ground fades into.
    const h = this._horizonDirs ?? (this._horizonDirs = [0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a), 0.02, Math.sin(a)).normalize();
    }));
    const tmp = this._tmpColor ?? (this._tmpColor = new THREE.Color());
    this.hazeColor.setRGB(0, 0, 0);
    for (const d of h) this.hazeColor.add(skyRadiance(hKm, d, this.sunDirection, tmp));
    this.hazeColor.multiplyScalar(SUN_INTENSITY / h.length);
    // Irradiance on flat ground: direct sun plus skylight (see the shader).
    const cosSun = Math.max(this.sunDirection.y, 0);
    const groundSunT = sunTransmittance(0, this.sunDirection.y, tmp);
    this.groundLight
      .setRGB(0.06, 0.09, 0.14)
      .add(groundSunT.clone().multiplyScalar(cosSun))
      .multiplyScalar(SUN_INTENSITY);

    this.ground?.setView(camY, this.hazeColor, this.groundLight);

    // --- Stars appear as the sky darkens ----------------------------------
    // Only when there is no bright air in view: the camera is exposed for a
    // sunlit vehicle, so this is a gentle nod rather than a full sky.
    this.starMaterial.uniforms.opacity.value = THREE.MathUtils.clamp((hKm - 45) / 60, 0, 1) * 0.55;

    // --- Lighting probe ---------------------------------------------------
    if (Math.abs(hKm - this._probeAltitude) > probeStep(hKm)) this._bakeProbe(hKm);

    // --- Shadow frustum ---------------------------------------------------
    const target = focus ?? camera?.position;
    if (target) {
      this.sunLight.target.position.copy(target);
      this.sunLight.position.copy(target).addScaledVector(this.sunDirection, 500);
    }
  }

  setQuality(quality) {
    const size = quality === "low" ? 1024 : 2048;
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
    if (this.probe && this.scene.environment === this.probe.texture) this.scene.environment = null;
    this.probe?.dispose();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.skyMaterial.dispose();
    this.lutMaterial.dispose();
    this.lutQuad.dispose();
    this.lutInScatter.dispose();
    this.lutTransmittance.dispose();
    this.starMaterial.dispose();
    this.sun.dispose();
    // A light's shadow map is a render target that removing the light from
    // the scene does not release.
    this.sunLight.shadow.map?.dispose();
    this.sunLight.shadow.map = null;
  }
}
