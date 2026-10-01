import * as THREE from "three";

// ---------------------------------------------------------------------------
// The blowing-dust sheet.
//
// What every Apollo commander described below about 30 m — and what the 16 mm
// landing films show — is not a cloud but a *veil*: a thin, fast, translucent
// sheet of regolith streaming radially away from under the engine, so dense
// by the last few metres that the surface texture is lost behind it. Grains
// leave at hundreds of metres per second only a few degrees above the
// surface, so they travel in straight radial streaks, never curling.
//
// Individual particles cannot carry that: thousands of sprites still read as
// glitter. This is a disc of geometry laid over the terrain under the
// vehicle, shaded with radial streaks scrolling outward. The particle system
// keeps the near-field grains that fly off the edge of it.
// ---------------------------------------------------------------------------

const RINGS = 18;
const SPOKES = 72;

const vertex = /* glsl */ `
  attribute vec2 polar;          // (radius 0..1, angle 0..1)
  varying vec2 vPolar;
  varying float vFade;
  void main() {
    vPolar = polar;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Fade where the sheet is seen edge-on, so it never shows as a hard line.
    vec3 n = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
    vFade = smoothstep(0.02, 0.25, abs(dot(n, normalize(-mv.xyz))));
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  uniform float time;
  uniform float intensity;
  uniform float scour;           // radius (0..1) of the swept-bare core
  uniform vec3 color;
  varying vec2 vPolar;
  varying float vFade;

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
    float r = vPolar.x;
    float a = vPolar.y;

    // Streaks: noise that is fine across the angle and stretched along the
    // radius, scrolling outward. Radius enters as log(r) so the streaks
    // widen with distance at the same angular width, like real ejecta rays.
    float lr = log(r + 0.04);
    float s1 = noise(vec2(a * 260.0, lr * 3.0 - time * 5.5));
    float s2 = noise(vec2(a * 90.0 + 17.0, lr * 1.6 - time * 3.1));
    float s3 = noise(vec2(a * 640.0 + 3.0, lr * 6.0 - time * 9.0));
    float streak = s1 * 0.5 + s2 * 0.32 + s3 * 0.18;
    streak = smoothstep(0.22, 0.9, streak);

    // Densest just outside the scoured core, thinning with distance as the
    // sheet spreads over a growing circumference.
    float core = smoothstep(scour * 0.6, scour, r);
    float falloff = pow(1.0 - smoothstep(0.0, 1.0, r), 1.4);
    float alpha = intensity * core * falloff * mix(0.35, 1.0, streak) * vFade;
    if (alpha < 0.003) discard;

    // Lofted fines are lit by the full sun and backscatter like the soil,
    // so the sheet reads a little brighter than the ground it hides.
    vec3 col = color * mix(0.85, 1.12, streak);
    gl_FragColor = vec4(col, min(alpha, 0.92));
  }
`;

export default class DustSheet {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [options]
   * @param {number} [options.radius] metres
   */
  constructor(scene, { radius = 42 } = {}) {
    this.scene = scene;
    this.radius = radius;
    this.intensity = 0;
    this._target = 0;
    this._centre = new THREE.Vector3();
    this._lastRebuild = new THREE.Vector3(Infinity, 0, Infinity);

    // Polar grid: a centre vertex plus RINGS rings of SPOKES+1 vertices (the
    // seam is duplicated so the angle coordinate can run 0..1 without a
    // wrap-around discontinuity).
    const count = 1 + RINGS * (SPOKES + 1);
    this.positions = new Float32Array(count * 3);
    const polar = new Float32Array(count * 2);
    this.offsets = new Float32Array(count * 2); // local x/z per vertex
    let v = 1;
    for (let ring = 1; ring <= RINGS; ring++) {
      // Rings bunch up near the centre, where the height field varies most
      // under the sheet's own scale.
      const t = Math.pow(ring / RINGS, 1.6);
      for (let s = 0; s <= SPOKES; s++) {
        const ang = (s / SPOKES) * Math.PI * 2;
        this.offsets[v * 2] = Math.cos(ang) * t * radius;
        this.offsets[v * 2 + 1] = Math.sin(ang) * t * radius;
        polar[v * 2] = t;
        polar[v * 2 + 1] = s / SPOKES;
        v++;
      }
    }

    const index = [];
    for (let s = 0; s < SPOKES; s++) index.push(0, 1 + s + 1, 1 + s);
    for (let ring = 0; ring < RINGS - 1; ring++) {
      const a0 = 1 + ring * (SPOKES + 1);
      const b0 = a0 + SPOKES + 1;
      for (let s = 0; s < SPOKES; s++) {
        index.push(a0 + s, a0 + s + 1, b0 + s, b0 + s, a0 + s + 1, b0 + s + 1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("polar", new THREE.BufferAttribute(polar, 2));
    geometry.setIndex(index);
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        intensity: { value: 0 },
        scour: { value: 0.06 },
        color: { value: new THREE.Color(0.2, 0.19, 0.175) },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Lifted over the ground in depth rather than in space, so it hugs the
      // terrain without z-fighting.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  /** Sunlit dust colour (linear radiance), set by the scene's lighting. */
  setColor(color) {
    this.material.uniforms.color.value.copy(color);
  }

  /**
   * Feeds the sheet for this frame. Call every frame the plume reaches the
   * ground; when the calls stop, the sheet decays.
   * @param {THREE.Vector3} centre plume impingement point
   * @param {number} strength 0..1
   * @param {object} terrain anything with heightAt(x, z)
   */
  feed(centre, strength, terrain) {
    this._target = Math.max(this._target, strength);
    this._centre.copy(centre);
    this._terrain = terrain;
  }

  update(dt) {
    // Fast rise as the plume reaches the ground, quick decay at cut-off —
    // with no air, the sheet stops the instant its source does.
    const k = 1 - Math.exp(-(this._target > this.intensity ? 6 : 4) * dt);
    this.intensity += (this._target - this.intensity) * k;
    this._target = 0;

    const visible = this.intensity > 0.01 && this._terrain;
    this.mesh.visible = !!visible;
    if (!visible) return;

    this.material.uniforms.intensity.value = this.intensity;
    this.material.uniforms.time.value += dt;
    // The bare core grows as the vehicle descends and the jet tightens.
    this.material.uniforms.scour.value = 0.04 + this.intensity * 0.05;

    // Re-drape over the terrain only when the vehicle has moved; heights are
    // sampled per vertex, so the sheet follows craters and slopes.
    if (this._centre.distanceToSquared(this._lastRebuild) > 0.25) {
      this._lastRebuild.copy(this._centre);
      const p = this.positions;
      const o = this.offsets;
      const cx = this._centre.x;
      const cz = this._centre.z;
      const n = p.length / 3;
      for (let i = 0; i < n; i++) {
        const x = cx + o[i * 2];
        const z = cz + o[i * 2 + 1];
        p[i * 3] = x;
        p[i * 3 + 1] = this._terrain.heightAt(x, z) + 0.12;
        p[i * 3 + 2] = z;
      }
      this.geometry.attributes.position.needsUpdate = true;
    }
  }

  reset() {
    this.intensity = 0;
    this._target = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
