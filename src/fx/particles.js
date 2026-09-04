import * as THREE from "three";
import { LUNAR_GRAVITY } from "../constants.js";

// ---------------------------------------------------------------------------
// Particle effects, written for vacuum.
//
// The single most recognisable thing about the Apollo landing films is how
// dust behaves with no air: lofted regolith leaves the engine in flat, ruler
// straight sheets at high speed and simply falls back on a ballistic arc.
// It never billows, curls, hangs or forms clouds, because there is no
// atmosphere to suspend it. Every dust particle here is therefore launched
// nearly horizontally and integrated under gravity alone, with zero drag.
//
// The descent engine plume itself is almost invisible in vacuum (the
// exhaust is transparent and hugely over-expanded), so it is rendered as a
// very faint, wide cone rather than a rocket-flame — the readable feedback
// comes from the nozzle glow and the dust sheet instead.
// ---------------------------------------------------------------------------

/** Fixed-capacity particle pool backed by typed arrays. */
class Pool {
  constructor(scene, capacity, material, { renderOrder = 0 } = {}) {
    this.capacity = capacity;
    this.count = 0;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(capacity * 3);
    this.alphas = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("alpha", new THREE.BufferAttribute(this.alphas, 1));
    geometry.setAttribute("psize", new THREE.BufferAttribute(this.sizes, 1));
    geometry.setDrawRange(0, 0);

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    scene.add(this.points);
    this.geometry = geometry;
    this.scene = scene;
  }

  spawn(x, y, z, vx, vy, vz, life, size) {
    let i;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      // Recycle the oldest slot (index 0 after the compaction in update()).
      i = 0;
    }
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.seed[i] = Math.random();
  }

  /** Removes a slot by swapping the last live particle into it. */
  _remove(i) {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.life[i] = this.life[last];
      this.maxLife[i] = this.maxLife[last];
      this.size[i] = this.size[last];
      this.seed[i] = this.seed[last];
    }
  }

  flush() {
    const pos = this.positions;
    const alphas = this.alphas;
    const sizes = this.sizes;
    for (let i = 0; i < this.count; i++) {
      pos[i * 3] = this.px[i];
      pos[i * 3 + 1] = this.py[i];
      pos[i * 3 + 2] = this.pz[i];
      alphas[i] = Math.max(0, this.life[i] / this.maxLife[i]);
      sizes[i] = this.size[i];
    }
    this.geometry.setDrawRange(0, this.count);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
    this.geometry.attributes.psize.needsUpdate = true;
    if (this.count > 0) this.geometry.computeBoundingSphere();
  }

  clear() {
    this.count = 0;
    this.flush();
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
  }
}

const particleVertex = /* glsl */ `
  attribute float alpha;
  attribute float psize;
  varying float vAlpha;
  void main() {
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Perspective size attenuation, clamped so near particles stay sane.
    gl_PointSize = clamp(psize * 620.0 / max(-mv.z, 1.0), 1.0, 260.0);
  }
`;

const particleFragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 tint;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    float a = tex.a * vAlpha * opacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(tint * tex.rgb, a);
  }
`;

function makeParticleMaterial(map, tint, { additive = false, opacity = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      tint: { value: new THREE.Color(tint) },
      opacity: { value: opacity },
    },
    vertexShader: particleVertex,
    fragmentShader: particleFragment,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export default class ParticleSystem {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.gravity = LUNAR_GRAVITY;
    this.terrain = null;
    this.quality = 1;

    // Regolith is dark grey but is being lit by unfiltered sunlight, so the
    // lofted sheet reads as a pale, dusty grey-brown.
    // Many small grains rather than a few big puffs: the ejecta sheet should
    // read as a fast, fine-grained spray, not as cotton wool.
    this.dust = new Pool(scene, 4200, makeParticleMaterial(assets.dustSprite, 0xb3a794, { opacity: 0.5 }));
    this.plume = new Pool(scene, 500, makeParticleMaterial(assets.glowSprite, 0xffb070, { additive: true, opacity: 0.32 }));
    this.sparks = new Pool(scene, 700, makeParticleMaterial(assets.glowSprite, 0xffd9a0, { additive: true, opacity: 0.9 }));
    this.debris = new Pool(scene, 400, makeParticleMaterial(assets.dustSprite, 0x8a8580, { opacity: 0.95 }));

    this.pools = [this.dust, this.plume, this.sparks, this.debris];

    this._buildPlumeCone();

    this._acc = { dust: 0, plume: 0 };
  }

  setTerrain(terrain) {
    this.terrain = terrain;
  }

  setQuality(scale) {
    this.quality = scale;
  }

  /**
   * The visible engine plume. In vacuum the exhaust expands to an enormous
   * cone and is nearly transparent, so this is deliberately very faint and
   * very wide, unlike an atmospheric rocket flame.
   */
  _buildPlumeCone() {
    const geometry = new THREE.ConeGeometry(1, 1, 28, 6, true);
    geometry.translate(0, -0.5, 0); // origin at the nozzle exit
    this.plumeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        throttle: { value: 0 },
        time: { value: 0 },
        coreColor: { value: new THREE.Color(0xffc79a) },
        edgeColor: { value: new THREE.Color(0x7fb4ff) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float throttle;
        uniform float time;
        uniform vec3 coreColor;
        uniform vec3 edgeColor;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vView;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
        }

        void main() {
          // Fades out along the plume as it expands and rarefies.
          float along = 1.0 - vUv.y;
          float density = pow(along, 1.7);
          // Rim-lit: we see more gas looking through the cone edge-on.
          float rim = 1.0 - abs(dot(vNormal, vView));
          rim = pow(clamp(rim, 0.0, 1.0), 1.4);
          // Shock structure ripples travelling down the plume.
          float ripple = 0.75 + 0.25 * sin(vUv.y * 34.0 - time * 26.0);
          float flicker = 0.86 + 0.14 * hash(vec2(floor(time * 45.0), floor(vUv.y * 8.0)));

          float a = density * rim * ripple * flicker * throttle * 0.34;
          vec3 col = mix(edgeColor, coreColor, density);
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.plumeCone = new THREE.Mesh(geometry, this.plumeMaterial);
    this.plumeCone.frustumCulled = false;
    this.plumeCone.visible = false;
    this.scene.add(this.plumeCone);
  }

  /**
   * Positions and scales the plume cone. Called every frame with the current
   * nozzle transform.
   */
  updatePlume(origin, direction, throttle, altitude, elapsed) {
    const visible = throttle > 0.02;
    this.plumeCone.visible = visible;
    if (!visible) return;

    // Plume length grows with throttle; near the ground it is "cut off" by
    // the surface, which is why Apollo's plume looked short on final descent.
    const freeLength = 6 + throttle * 22;
    const length = Math.min(freeLength, Math.max(1.2, altitude * 0.95));
    const radius = 1.1 + throttle * 2.6 + length * 0.16;

    this.plumeCone.position.copy(origin);
    // The cone's apex sits at its local origin and it opens along local -Y
    // (see _buildPlumeCone), so -Y is the axis that must align with the
    // exhaust direction.
    this.plumeCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), direction);
    this.plumeCone.scale.set(radius, length, radius);
    this.plumeMaterial.uniforms.throttle.value = throttle;
    this.plumeMaterial.uniforms.time.value = elapsed;

    // A few glow particles streaming down the plume axis.
    const rate = 34 * throttle * this.quality;
    this._acc.plume += rate * (1 / 60);
    while (this._acc.plume >= 1) {
      this._acc.plume -= 1;
      const spread = 0.5 + Math.random() * radius * 0.4;
      const a = Math.random() * Math.PI * 2;
      const speed = 18 + Math.random() * 26;
      const perp1 = new THREE.Vector3(1, 0, 0).cross(direction).normalize();
      const perp2 = new THREE.Vector3().crossVectors(direction, perp1);
      const off = perp1
        .clone()
        .multiplyScalar(Math.cos(a) * spread)
        .addScaledVector(perp2, Math.sin(a) * spread);
      this.plume.spawn(
        origin.x + off.x,
        origin.y + off.y,
        origin.z + off.z,
        direction.x * speed + off.x * 1.4,
        direction.y * speed + off.y * 1.4,
        direction.z * speed + off.z * 1.4,
        0.16 + Math.random() * 0.16,
        0.3 + Math.random() * 0.4
      );
    }
  }

  /**
   * Regolith blown outward by the exhaust once the plume reaches the ground.
   * Grains leave almost horizontally at high speed and fly on pure ballistic
   * arcs — the flat, fast, non-billowing sheet seen in the landing films.
   */
  emitGroundDust(contactPoint, throttle, altitude, dt) {
    if (!this.terrain || throttle <= 0.05) return;
    // The sheet only forms once the plume actually impinges on the surface.
    // Apollo crews first saw dust around 30 m and were flying in a blinding
    // sheet by 10 m, so the onset is gradual and the ramp is steep.
    const proximity = THREE.MathUtils.clamp(1 - altitude / 32, 0, 1);
    if (proximity <= 0) return;

    const intensity = proximity * proximity * throttle;
    const rate = 2200 * intensity * this.quality;
    this._acc.dust += rate * dt;

    while (this._acc.dust >= 1) {
      this._acc.dust -= 1;
      const a = Math.random() * Math.PI * 2;
      // Ejection angle hugs the surface: a few degrees above horizontal.
      const elevation = THREE.MathUtils.degToRad(2 + Math.random() * 12);
      const speed = 9 + Math.random() * 34 * intensity;
      const cosE = Math.cos(elevation);
      const jitter = 0.4 + Math.random() * 1.4;

      this.dust.spawn(
        contactPoint.x + Math.cos(a) * jitter,
        contactPoint.y + 0.15 + Math.random() * 0.35,
        contactPoint.z + Math.sin(a) * jitter,
        Math.cos(a) * speed * cosE,
        Math.sin(elevation) * speed,
        Math.sin(a) * speed * cosE,
        1.6 + Math.random() * 2.6,
        0.28 + Math.random() * 0.7
      );
    }
  }

  /** Dust kicked up by footpads at touchdown. */
  emitTouchdownDust(point, energy = 1) {
    const n = Math.floor(80 * energy * this.quality);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const elevation = THREE.MathUtils.degToRad(4 + Math.random() * 22);
      const speed = (3 + Math.random() * 12) * energy;
      const cosE = Math.cos(elevation);
      this.dust.spawn(
        point.x,
        point.y + 0.1,
        point.z,
        Math.cos(a) * speed * cosE,
        Math.sin(elevation) * speed,
        Math.sin(a) * speed * cosE,
        1.2 + Math.random() * 1.8,
        0.24 + Math.random() * 0.55
      );
    }
  }

  /** Structural failure: debris, sparks and a dust sheet. */
  emitCrash(point, energy = 1) {
    const debrisCount = Math.floor(90 * this.quality);
    for (let i = 0; i < debrisCount; i++) {
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 1.1,
        Math.random() * 2 - 1
      ).normalize();
      const speed = (6 + Math.random() * 26) * energy;
      this.debris.spawn(
        point.x,
        point.y + 0.5,
        point.z,
        dir.x * speed,
        dir.y * speed,
        dir.z * speed,
        2.5 + Math.random() * 3.5,
        0.2 + Math.random() * 0.45
      );
    }

    const sparkCount = Math.floor(220 * this.quality);
    for (let i = 0; i < sparkCount; i++) {
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 1.4,
        Math.random() * 2 - 1
      ).normalize();
      const speed = (10 + Math.random() * 46) * energy;
      this.sparks.spawn(
        point.x,
        point.y + 0.6,
        point.z,
        dir.x * speed,
        dir.y * speed,
        dir.z * speed,
        0.25 + Math.random() * 0.7,
        0.16 + Math.random() * 0.38
      );
    }

    this.emitTouchdownDust(point, 2.6 * energy);
  }

  /** Gas geyser for outgassing vents. */
  emitVent(x, y, z, strength, dt) {
    const rate = 55 * strength * this.quality;
    if (Math.random() > rate * dt) return;
    const count = 1 + Math.floor(rate * dt);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spread = Math.random() * 2.2;
      const speed = 14 + Math.random() * 26;
      this.dust.spawn(
        x + Math.cos(a) * spread,
        y + 0.4,
        z + Math.sin(a) * spread,
        Math.cos(a) * 4,
        speed,
        Math.sin(a) * 4,
        1.8 + Math.random() * 2.2,
        0.3 + Math.random() * 0.7
      );
    }
  }

  update(dt) {
    const g = this.gravity;
    const terrain = this.terrain;

    for (const pool of this.pools) {
      const isSpark = pool === this.sparks;
      const isPlume = pool === this.plume;
      for (let i = pool.count - 1; i >= 0; i--) {
        pool.life[i] -= dt;
        if (pool.life[i] <= 0) {
          pool._remove(i);
          continue;
        }

        // No atmosphere: no drag term at all. Plume gas is the exception —
        // it rarefies and disperses rather than falling.
        if (!isPlume) pool.vy[i] -= g * dt;

        pool.px[i] += pool.vx[i] * dt;
        pool.py[i] += pool.vy[i] * dt;
        pool.pz[i] += pool.vz[i] * dt;

        if (terrain && !isPlume) {
          const ground = terrain.heightAt(pool.px[i], pool.pz[i]);
          if (pool.py[i] <= ground + 0.05) {
            if (isSpark) {
              pool._remove(i);
              continue;
            }
            // Grains land and stay put; a shallow impact kills most of the
            // velocity rather than bouncing (regolith is not elastic).
            pool.py[i] = ground + 0.05;
            pool.vy[i] = 0;
            pool.vx[i] *= 0.18;
            pool.vz[i] *= 0.18;
            pool.life[i] = Math.min(pool.life[i], 0.55);
          }
        }
      }
      pool.flush();
    }
  }

  reset() {
    for (const pool of this.pools) pool.clear();
    this._acc.dust = 0;
    this._acc.plume = 0;
    this.plumeCone.visible = false;
  }

  dispose() {
    for (const pool of this.pools) pool.dispose();
    this.scene.remove(this.plumeCone);
    this.plumeCone.geometry.dispose();
    this.plumeMaterial.dispose();
  }
}
