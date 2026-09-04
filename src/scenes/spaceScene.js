import * as THREE from "three";
import { makeRng } from "../materials/noise.js";
import { buildSunSprite, buildRegolithMaps } from "../materials/textures.js";

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

// Directions the two bodies sit in, relative to the coasting stack.
const EARTH_DIR = new THREE.Vector3(-0.16, -0.42, -0.89).normalize();
const MOON_DIR = new THREE.Vector3(0.08, 0.16, 0.98).normalize();

const planetVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const earthFragment = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D cloudMap;
  uniform vec3 sunDirection;
  uniform float cloudOffset;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 base = texture2D(dayMap, vUv).rgb;
    vec4 cloud = texture2D(cloudMap, vec2(vUv.x + cloudOffset, vUv.y));
    base = mix(base, vec3(0.95, 0.96, 0.98), cloud.a * 0.85);

    // Terminator. In vacuum it is sharp, softened only by the atmosphere.
    float lit = dot(n, normalize(sunDirection));
    float day = smoothstep(-0.12, 0.22, lit);
    vec3 night = base * 0.035 + vec3(0.012, 0.014, 0.028);
    vec3 col = mix(night, base, day);

    // Atmospheric limb: a blue rim that brightens toward the terminator.
    float rim = pow(1.0 - abs(dot(n, normalize(vView))), 2.4);
    col += vec3(0.32, 0.55, 0.95) * rim * day * 0.85;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const moonFragment = /* glsl */ `
  uniform sampler2D surfaceMap;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash2(vec2 p) {
    return vec2(hash(p), hash(p + 19.7));
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0, norm = 0.0;
    for (int i = 0; i < 5; i++) {
      s += a * noise(p);
      norm += a;
      a *= 0.5;
      p *= 2.03;
    }
    return s / norm;
  }

  // A crater field: one impact per grid cell, with a dark floor, a bright
  // rim and a faint ejecta halo. Two scales are layered so the disc has both
  // the big named basins and a dusting of smaller craters.
  float craters(vec2 p, float scale, out float rim) {
    p *= scale;
    vec2 cell = floor(p);
    float floorDark = 0.0;
    rim = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 c = cell + vec2(float(x), float(y));
        vec2 centre = c + 0.15 + 0.7 * hash2(c);
        // Power-law sizes: many small craters, few large ones, as on the
        // real surface. A uniform distribution reads as a golf ball.
        float sizeRoll = hash(c + 3.1);
        float radius = 0.05 + 0.34 * sizeRoll * sizeRoll;
        // Most cells are empty; craters should punctuate, not tile.
        if (hash(c + 7.7) > 0.42) continue;
        float d = length(p - centre) / radius;
        floorDark += (1.0 - smoothstep(0.0, 0.85, d)) * 0.8;
        rim += exp(-pow((d - 0.95) / 0.22, 2.0)) * 0.9;
      }
    }
    return clamp(floorDark, 0.0, 1.0);
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 tex = texture2D(surfaceMap, vUv * 6.0).rgb;

    // Mare basins: large, dark, roughly circular floods of basalt covering
    // about a third of the near side. Centred so the threshold actually bites.
    float basinField = fbm(vUv * vec2(4.0, 2.2) + 11.0);
    float mare = smoothstep(0.40, 0.56, basinField);

    // Real lunar albedo is only about 0.12 — the Moon looks bright because
    // the sun is unfiltered, not because the surface is. Painting it pale
    // grey is the single easiest way to make it read as fake.
    vec3 highland = vec3(0.215, 0.211, 0.200);
    vec3 basalt = vec3(0.105, 0.104, 0.108);
    vec3 albedo = mix(highland, basalt, mare);

    // Craters, coarser in the highlands than over the young mare.
    float rimBig, rimSmall;
    float bigFloor = craters(vUv, 14.0, rimBig);
    float smallFloor = craters(vUv + 4.3, 34.0, rimSmall);
    float floorDark = max(bigFloor * 0.55, smallFloor * 0.35);
    float rim = max(rimBig, rimSmall * 0.7);

    albedo *= 1.0 - floorDark * 0.30;
    albedo += vec3(0.055) * rim * (1.0 - mare * 0.6);

    // Fine grain from the shared regolith map.
    albedo *= 0.86 + tex.r * 0.28;

    // No atmosphere: a hard terminator and essentially no fill in shadow.
    float lit = clamp(dot(n, normalize(sunDirection)), 0.0, 1.0);
    // Regolith backscatters strongly, so a full disc looks flat and bright
    // rather than shaded like a billiard ball.
    float scatter = pow(lit, 0.6);
    // Sharpen the last few degrees into the terminator — in vacuum the shadow
    // line is a hard edge, not a gradient.
    scatter *= smoothstep(0.0, 0.10, lit);
    vec3 col = albedo * scatter * 1.95 + albedo * 0.010;

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

    // The sun sits almost side-on. Earth is astern and the Moon ahead, so a
    // sun along either of those axes would leave one of them fully backlit;
    // keeping it broadside gives both a strong terminator instead.
    this.sunDirection = new THREE.Vector3(0.93, 0.30, 0.21).normalize();

    this._buildStars();
    this._buildSun();
    this._buildEarth();
    this._buildMoon();
    this._buildLights();

    this.journey = 0;
    scene.background = new THREE.Color(0x000000);
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
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float a = smoothstep(0.5, 0.06, length(uv));
          a *= a;
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
    const sprite = buildSunSprite();
    const dist = SKY_RADIUS * 0.92;
    this.sunSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sprite,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      })
    );
    this.sunSprite.scale.setScalar(dist * 0.02);
    this.sunSprite.position.copy(this.sunDirection).multiplyScalar(dist);
    this.group.add(this.sunSprite);
  }

  _buildEarth() {
    const { map, clouds } = this.assets.earth;
    this.earthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: map },
        cloudMap: { value: clouds },
        sunDirection: { value: this.sunDirection.clone() },
        cloudOffset: { value: 0 },
      },
      vertexShader: planetVertex,
      fragmentShader: earthFragment,
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), this.earthMaterial);
    this.earth.renderOrder = -200;
    this.group.add(this.earth);
  }

  _buildMoon() {
    const maps = buildRegolithMaps(5150, 256);
    this.moonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        surfaceMap: { value: maps.map },
        sunDirection: { value: this.sunDirection.clone() },
      },
      vertexShader: planetVertex,
      fragmentShader: moonFragment,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), this.moonMaterial);
    this.moon.renderOrder = -199;
    this.group.add(this.moon);
  }

  _buildLights() {
    this.sunLight = new THREE.DirectionalLight(0xfff6e8, 3.4);
    this.sunLight.castShadow = false; // nothing casts onto anything out here
    this.scene.add(this.sunLight);

    // Only starlight and planetshine fill the shadows.
    this.ambient = new THREE.HemisphereLight(0x0a1424, 0x120f0c, 0.25);
    this.scene.add(this.ambient);
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

    this.moon.scale.setScalar(moonRadius);
    this.moon.position.copy(MOON_DIR).multiplyScalar(moonDist);

    this.earthMaterial.uniforms.cloudOffset.value += dt * 0.0025;
    this.earth.rotation.y += dt * 0.012;
    this.moon.rotation.y += dt * 0.004;

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
    this.scene.remove(this.ambient);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.starMaterial.dispose();
    this.earthMaterial.dispose();
    this.moonMaterial.dispose();
  }
}
