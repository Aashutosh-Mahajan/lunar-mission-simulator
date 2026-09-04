import * as THREE from "three";
import * as CANNON from "cannon-es";
import { makeSimplex2, makeRng, fbm, ridged, clamp, smoothstep, lerp } from "../materials/noise.js";

// ---------------------------------------------------------------------------
// Lunar terrain: a real 3D height field, generated from the level config and
// fed to both the render mesh and a CANNON.Heightfield collider.
//
// Crater morphology follows the observed shape of fresh lunar impact craters:
// a roughly parabolic bowl with a depth:diameter ratio near 1:5, a rim raised
// about 4% of the diameter, and an ejecta blanket that decays over roughly one
// crater radius beyond the rim.
// ---------------------------------------------------------------------------

const FAR_FIELD_SCALE = 7; // how far the (non-colliding) horizon plate extends

export default class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {CANNON.World} world
   * @param {object} config level config entry
   * @param {object} assets shared procedural materials/textures
   */
  constructor(scene, world, config, assets) {
    this.scene = scene;
    this.world = world;
    this.config = config;
    this.assets = assets;

    const t = config.terrain;
    this.size = t.size;
    this.divisions = t.divisions;
    this.step = this.size / this.divisions;
    this.half = this.size / 2;

    this.rng = makeRng(config.seed);
    this.noise = makeSimplex2(config.seed);
    this.noiseB = makeSimplex2(config.seed + 5171);
    this.noiseC = makeSimplex2(config.seed + 92821);

    this.group = new THREE.Group();
    this.group.name = "terrain";
    scene.add(this.group);

    this.padCenter = new THREE.Vector3(config.pad.x, 0, config.pad.z);
    this.padRadius = config.pad.radius;
    this.bodies = [];
    this.boulders = [];
    this.elapsed = 0;

    // Sun geometry, needed to bake terrain self-shadowing.
    const sunAz = THREE.MathUtils.degToRad(config.sun?.azimuthDeg ?? 120);
    const sunEl = THREE.MathUtils.degToRad(Math.max(1.5, config.sun?.elevationDeg ?? 14));
    this.sunHoriz = new THREE.Vector2(Math.cos(sunAz), Math.sin(sunAz)).normalize();
    this.sunTanElevation = Math.tan(sunEl);

    this._planCraters();
    this._planRille();
    this._bakeHeightField();
    this._bakeSunShadow();
    this._buildTerrainMesh();
    this._buildFarField();
    this._buildHeightFieldBody();
    this._buildPadDressing();
    this._buildBoulders();
    this._buildMovingPad();

    // Pad surface height is sampled once the field is baked.
    this.padCenter.y = this.heightAt(this.padCenter.x, this.padCenter.z);
  }

  // -------------------------------------------------------------------------
  // Feature planning
  // -------------------------------------------------------------------------

  _planCraters() {
    const t = this.config.terrain;
    this.craters = [];
    const padKeepOut = this.padRadius + (this.config.pad.clearance ?? 30);
    let guard = 0;

    while (this.craters.length < t.craterCount && guard < t.craterCount * 40) {
      guard++;
      // Small craters vastly outnumber large ones (a power-law size
      // distribution, as on the real surface).
      const r = this.rng();
      const diameter = lerp(t.craterMin, t.craterMax, Math.pow(r, 2.2));
      const x = (this.rng() * 2 - 1) * (this.half - diameter);
      const z = (this.rng() * 2 - 1) * (this.half - diameter);

      // Keep the approach corridor and pad clear of craters.
      const dPad = Math.hypot(x - this.padCenter.x, z - this.padCenter.z);
      if (dPad < padKeepOut + diameter * 0.6) continue;

      const overlaps = this.craters.some(
        (c) => Math.hypot(c.x - x, c.z - z) < (c.diameter + diameter) * 0.42
      );
      if (overlaps) continue;

      this.craters.push({
        x,
        z,
        diameter,
        radius: diameter / 2,
        // Fresh craters are ~1/5 as deep as they are wide; older ones have
        // slumped and infilled, so freshness scales depth and rim height.
        freshness: 0.35 + this.rng() * 0.65,
      });
    }

    // Sort large-first so ejecta from big craters underlies small ones.
    this.craters.sort((a, b) => b.diameter - a.diameter);
  }

  _planRille() {
    const cfg = this.config.terrain.rille;
    if (!cfg) {
      this.rille = null;
      return;
    }
    // A sinuous collapsed lava channel: a noise-perturbed centre line running
    // across the map, sampled as a polyline for cheap distance queries.
    const points = [];
    const steps = 90;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const along = lerp(-this.half * 1.1, this.half * 1.1, t);
      const wander =
        fbm(this.noiseC, t * 2.4, 0.5, 3) * cfg.sinuosity +
        Math.sin(t * Math.PI * 1.7) * cfg.sinuosity * 0.6;
      points.push(new THREE.Vector2(along, cfg.offset + wander));
    }
    this.rille = { cfg, points };
  }

  /** Shortest distance from (x,z) to the rille centre line. */
  _rilleDistance(x, z) {
    const pts = this.rille.points;
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const abx = b.x - a.x;
      const abz = b.y - a.y;
      const t = clamp(((x - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz), 0, 1);
      const px = a.x + abx * t;
      const pz = a.y + abz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) best = d;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Height field
  // -------------------------------------------------------------------------

  /** Raw generated height at a world position, before pad flattening. */
  _rawHeight(x, z) {
    const t = this.config.terrain;
    const s = 1 / t.baseScale;
    let h = 0;

    // Broad mare undulation — long-wavelength swells of the basalt plain.
    h += fbm(this.noise, x * s, z * s, 5) * t.baseRoughness;
    // Blocky highland texture at medium scale.
    h += ridged(this.noiseB, x * s * 3.1, z * s * 3.1, 4) * t.ridgeRoughness;
    // Metre-scale regolith churn (kept small; the normal map sells this scale).
    h += fbm(this.noiseC, x * 0.06, z * 0.06, 3) * t.microRoughness;

    // --- Craters --------------------------------------------------------
    for (const c of this.craters) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > c.radius * 2.6) continue;
      const depth = c.diameter * 0.2 * c.freshness; // 1:5 depth:diameter
      const rimH = c.diameter * 0.04 * c.freshness;
      const u = d / c.radius;

      if (u < 1) {
        // Parabolic bowl, flattening slightly at the floor where regolith
        // and slumped wall material pond.
        const bowl = 1 - u * u;
        h -= depth * Math.pow(bowl, 0.85);
        // Terraced walls on the larger, fresher craters.
        if (c.diameter > 60) {
          h += Math.sin(u * Math.PI * 3) * depth * 0.03 * c.freshness;
        }
      }
      // Raised rim, peaking just outside the bowl edge.
      h += rimH * Math.exp(-Math.pow((u - 1.02) / 0.16, 2));
      // Ejecta blanket decaying outward.
      if (u > 1) {
        h += rimH * 0.55 * Math.exp(-(u - 1) * 1.9);
      }
    }

    // --- Rille ----------------------------------------------------------
    if (this.rille) {
      const { cfg } = this.rille;
      const d = this._rilleDistance(x, z);
      const halfW = cfg.width / 2;
      if (d < halfW * 1.5) {
        // Flat-floored channel with steep, slumped shoulders.
        const inner = smoothstep(halfW, halfW * 0.55, d);
        h -= cfg.depth * inner;
        const shoulder = Math.exp(-Math.pow((d - halfW * 1.05) / (halfW * 0.28), 2));
        h += cfg.depth * 0.06 * shoulder;
      }
    }

    return h;
  }

  /** Final height including the flattened (and possibly raised) landing pad. */
  _finalHeight(x, z) {
    const pad = this.config.pad;
    const d = Math.hypot(x - this.padCenter.x, z - this.padCenter.z);
    const plateau = pad.plateau;
    const flatR = this.padRadius + (pad.flatMargin ?? 6);
    const blendR = flatR + (pad.blend ?? 26);

    if (d > blendR) return this._rawHeight(x, z);

    // Target height of the prepared surface: the natural height at the pad
    // centre, optionally lifted into a mesa for "narrow platform" levels.
    const target = this._padBaseHeight + (plateau ? plateau.height : 0);
    if (d <= flatR) return target;

    // Smooth apron from the prepared surface out to natural terrain. A mesa
    // gets a steeper, scarp-like falloff.
    const t = smoothstep(flatR, blendR, d);
    const shaped = plateau ? Math.pow(t, plateau.scarp ?? 2.2) : t;
    return lerp(target, this._rawHeight(x, z), shaped);
  }

  _bakeHeightField() {
    const n = this.divisions + 1;
    // Pad base must be sampled from raw terrain before flattening is applied.
    this._padBaseHeight = this._rawHeight(this.padCenter.x, this.padCenter.z);

    this.heights = new Float32Array(n * n);
    this.gridSize = n;
    let min = Infinity;
    let max = -Infinity;

    for (let iz = 0; iz < n; iz++) {
      const z = -this.half + iz * this.step;
      for (let ix = 0; ix < n; ix++) {
        const x = -this.half + ix * this.step;
        const h = this._finalHeight(x, z);
        this.heights[iz * n + ix] = h;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    this.minHeight = min;
    this.maxHeight = max;
  }

  /**
   * Pre-computes terrain self-shadowing by ray-marching the height field
   * toward the sun from every grid point, and stores it as a per-vertex light
   * factor.
   *
   * This replaces shadow-mapped self-shadowing, which is pathological here:
   * with the sun only ~10 degrees above the horizon, almost every surface sits
   * near the grazing angle where depth-buffer shadows produce severe acne, and
   * the bias needed to suppress it is large enough to detach shadows from
   * their casters. Because both the terrain and the sun are static for the
   * duration of a level, marching the height field once gives geometrically
   * exact, completely alias-free shadows for free at runtime — the standard
   * approach for static terrain. Dynamic casters (the vehicle, boulders) still
   * use the shadow map.
   */
  _bakeSunShadow() {
    const n = this.gridSize;
    this.sunLightFactor = new Float32Array(n * n);
    const relief = Math.max(4, this.maxHeight - this.minHeight);
    // A ridge of height h casts a shadow h/tan(elevation) long. Cap the march
    // so a near-horizon sun doesn't make this unboundedly expensive.
    const maxDist = Math.min(520, relief / this.sunTanElevation + 40);
    const dirX = this.sunHoriz.x;
    const dirZ = this.sunHoriz.y;

    // How dark shadowed ground goes. With the sun high, shadows cover little
    // area and can be near-black. Near the poles the sun grazes the surface
    // and most of the site is shadowed, so the same attenuation would leave
    // the whole scene unreadable — and physically, Earthshine and scattered
    // light off sunlit relief fill those shadows in.
    const sunElevationDeg = THREE.MathUtils.radToDeg(Math.atan(this.sunTanElevation));
    const shadowStrength = THREE.MathUtils.lerp(
      0.52,
      0.86,
      smoothstep(3, 15, sunElevationDeg)
    );

    for (let iz = 0; iz < n; iz++) {
      const z = -this.half + iz * this.step;
      for (let ix = 0; ix < n; ix++) {
        const x = -this.half + ix * this.step;
        const h = this.heights[iz * n + ix];

        let penetration = -Infinity;
        // Adaptive step: fine close in (where the shadow edge matters), coarse
        // far out (where only tall relief can still occlude).
        let d = this.step;
        while (d <= maxDist) {
          const sx = x + dirX * d;
          const sz = z + dirZ * d;
          if (Math.abs(sx) > this.half || Math.abs(sz) > this.half) break;
          // Height of the ray to the sun at this distance.
          const rayH = h + d * this.sunTanElevation;
          const terrainH = this.heightAt(sx, sz);
          const pen = terrainH - rayH;
          if (pen > penetration) penetration = pen;
          // Nothing further out can occlude once the ray clears all relief.
          if (rayH > this.maxHeight) break;
          d += Math.max(this.step, d * 0.07);
        }

        // Soft transition over the first metre of penetration gives the
        // shadow edge a plausible penumbra instead of a hard stair-step.
        const shadow = smoothstep(0, 1.4, penetration);
        this.sunLightFactor[iz * n + ix] = 1 - shadow * shadowStrength;
      }
    }
  }

  /** Bilinear height lookup in world space. Clamps outside the field. */
  heightAt(x, z) {
    const n = this.gridSize;
    const fx = clamp((x + this.half) / this.step, 0, n - 1.0001);
    const fz = clamp((z + this.half) / this.step, 0, n - 1.0001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.heights;
    const h00 = h[iz * n + ix];
    const h10 = h[iz * n + ix + 1];
    const h01 = h[(iz + 1) * n + ix];
    const h11 = h[(iz + 1) * n + ix + 1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /** Local surface slope in degrees — drives the landing-safety readout. */
  slopeAt(x, z) {
    const d = this.step;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    const grad = Math.hypot(hx / (2 * d), hz / (2 * d));
    return THREE.MathUtils.radToDeg(Math.atan(grad));
  }

  surfaceNormalAt(x, z) {
    const d = this.step;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return new THREE.Vector3(-hx / (2 * d), 1, -hz / (2 * d)).normalize();
  }

  // -------------------------------------------------------------------------
  // Render meshes
  // -------------------------------------------------------------------------

  _buildTerrainMesh() {
    const n = this.gridSize;
    const geometry = new THREE.PlaneGeometry(this.size, this.size, this.divisions, this.divisions);
    geometry.rotateX(-Math.PI / 2); // plane is XY by default; lay it flat

    const pos = geometry.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const color = new THREE.Color();

    // Macro albedo variation: mare basalt is darker than highland breccia,
    // fresh ejecta is brighter, and crater floors collect dark dust.
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // PlaneGeometry vertex order maps directly onto our grid.
      const ix = i % n;
      const iz = Math.floor(i / n);
      const h = this.heights[iz * n + ix];
      pos.setY(i, h);

      let shade = 0.5 + fbm(this.noiseB, x * 0.0016, z * 0.0016, 3) * 0.22;

      // Brighten fresh ejecta rings around large craters.
      for (const c of this.craters) {
        if (c.diameter < 45) continue;
        const d = Math.hypot(x - c.x, z - c.z);
        const u = d / c.radius;
        if (u > 0.95 && u < 2.4) {
          shade += 0.16 * c.freshness * Math.exp(-(u - 1) * 1.5);
        } else if (u < 0.9) {
          shade -= 0.06 * c.freshness; // ponded dark floor dust
        }
      }

      // Slope-dependent tone: steep walls shed dust and expose brighter rock.
      const slope = clamp(this.slopeAt(x, z) / 35, 0, 1);
      shade += slope * 0.12;

      shade = clamp(shade, 0.28, 1.0);

      // Baked terrain self-shadowing. Shadowed regolith also reads slightly
      // cooler, since its only illumination is starlight and bounce.
      const lit = this.sunLightFactor[iz * n + ix];
      const r = shade * lit;
      const g = shade * 0.985 * lit;
      const b = shade * 0.95 * (lit + (1 - lit) * 0.28);
      color.setRGB(r, g, b);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    // Second UV channel scaled for detail tiling.
    const uv = geometry.attributes.uv;
    const detailRepeat = this.size / 12; // one texture tile per 12 m
    const uv2 = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      uv2[i * 2] = uv.getX(i) * detailRepeat;
      uv2[i * 2 + 1] = uv.getY(i) * detailRepeat;
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv2, 2));

    this.mesh = new THREE.Mesh(geometry, this.assets.regolithMaterial);
    // Receives shadows from dynamic casters (the vehicle, boulders) but does
    // not cast into the shadow map: its own self-shadowing is baked into the
    // vertex colours above, which avoids grazing-angle shadow acne entirely.
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = "regolith";
    this.group.add(this.mesh);
  }

  /**
   * Non-colliding horizon plate plus a distant crater-rim ridge, so the world
   * reads as a continuous surface out to the (surprisingly close) lunar
   * horizon rather than ending at the playable area.
   */
  _buildFarField() {
    const size = this.size * FAR_FIELD_SCALE;
    const geometry = new THREE.RingGeometry(this.half * 0.98, size / 2, 96, 24);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z);
      const t = smoothstep(this.half, this.half * 2.2, r);
      // Blend from the playable field's edge height into coarse far terrain,
      // then dip below the horizon at the outer rim.
      const coarse = fbm(this.noise, x * 0.0006, z * 0.0006, 4) * 40;
      const edge = this.heightAt(
        clamp(x, -this.half + 1, this.half - 1),
        clamp(z, -this.half + 1, this.half - 1)
      );
      pos.setY(i, lerp(edge, coarse - 14, t));
    }
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0x6d675f,
      roughness: 1,
      metalness: 0,
      map: this.assets.regolith.map,
      normalMap: this.assets.regolith.normalMap,
    });
    this.farField = new THREE.Mesh(geometry, material);
    this.farField.receiveShadow = false;
    this.group.add(this.farField);

    // Distant mountain ring (an old basin rim) to break the flat skyline.
    const ridge = new THREE.Group();
    const peakCount = 46;
    const ringR = size * 0.42;
    const peakGeo = new THREE.ConeGeometry(1, 1, 5, 1);
    const peakMat = new THREE.MeshStandardMaterial({
      color: 0x555049,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    });
    const peaks = new THREE.InstancedMesh(peakGeo, peakMat, peakCount);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const posv = new THREE.Vector3();
    for (let i = 0; i < peakCount; i++) {
      const a = (i / peakCount) * Math.PI * 2 + this.rng() * 0.08;
      const rr = ringR * (0.86 + this.rng() * 0.3);
      // Kept low and broad: the lunar horizon is close, so distant relief
      // should read as a subtle massif on the skyline, not a ring of peaks.
      const height = 150 + this.rng() * 330;
      const width = height * (2.2 + this.rng() * 1.8);
      posv.set(Math.cos(a) * rr, height * 0.42 - 60, Math.sin(a) * rr);
      scale.set(width, height, width);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * Math.PI);
      m.compose(posv, q, scale);
      peaks.setMatrixAt(i, m);
    }
    peaks.instanceMatrix.needsUpdate = true;
    ridge.add(peaks);
    this.group.add(ridge);
    this.horizonRidge = ridge;
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------

  _buildHeightFieldBody() {
    const n = this.gridSize;
    // CANNON.Heightfield indexes data[i][j] along its local X and Y, with
    // height along local Z. Rotating the body -90 degrees about X maps local
    // (x,y,z) to world (x, z, -y): local Z becomes world "up", and local +Y
    // runs toward world -Z. So grid row j corresponds to world
    // z = +half - j*step, i.e. our own row index (divisions - j).
    const data = [];
    for (let i = 0; i < n; i++) {
      const column = new Array(n);
      for (let j = 0; j < n; j++) {
        column[j] = this.heights[(this.divisions - j) * n + i];
      }
      data.push(column);
    }

    const shape = new CANNON.Heightfield(data, {
      elementSize: this.step,
      minValue: this.minHeight - 1,
      maxValue: this.maxHeight + 1,
    });

    this.groundBody = new CANNON.Body({ mass: 0, material: this.assets.groundPhysMaterial });
    this.groundBody.addShape(shape);
    this.groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    // Shape origin sits at data[0][0]; shift so the field is centred on origin.
    this.groundBody.position.set(-this.half, 0, this.half);
    this.groundBody.userData = { kind: "terrain" };
    this.world.addBody(this.groundBody);
    this.bodies.push(this.groundBody);
  }

  // -------------------------------------------------------------------------
  // Landing pad dressing
  // -------------------------------------------------------------------------

  _buildPadDressing() {
    const pad = this.config.pad;
    // Sites with a rail-mounted deck carry their markings and lights on the
    // deck itself (see _buildMovingPad); painting a second static target on
    // the ground beside it would be two landing sites, not one.
    if (pad.moving) {
      this.beacons = [];
      return;
    }
    const y = this._padBaseHeight + (pad.plateau ? pad.plateau.height : 0);
    const group = new THREE.Group();
    group.position.set(this.padCenter.x, y, this.padCenter.z);
    this.padGroup = group;

    // Prepared deck: swept-clear regolith with a slightly brighter, compacted
    // surface. Sits a few centimetres proud of the flattened field.
    const deckGeo = new THREE.CircleGeometry(this.padRadius, 72);
    deckGeo.rotateX(-Math.PI / 2);
    const deck = new THREE.Mesh(
      deckGeo,
      new THREE.MeshStandardMaterial({
        color: 0x8d8880,
        roughness: 0.95,
        metalness: 0,
        map: this.assets.regolith.map,
        normalMap: this.assets.regolith.normalMap,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      })
    );
    deck.position.y = 0.04;
    deck.receiveShadow = true;
    group.add(deck);

    // Concentric target rings — high-contrast so they read from altitude.
    for (let i = 0; i < 3; i++) {
      const rOuter = this.padRadius * (0.34 + i * 0.3);
      const ringGeo = new THREE.RingGeometry(rOuter * 0.92, rOuter, 64);
      ringGeo.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshStandardMaterial({
          color: i === 0 ? 0xf0d24a : 0xe8e4dc,
          roughness: 0.7,
          metalness: 0,
          emissive: i === 0 ? 0x2a2208 : 0x1a1a18,
          polygonOffset: true,
          polygonOffsetFactor: -4,
        })
      );
      ring.position.y = 0.07;
      group.add(ring);
    }

    // Cross-hair bars through the centre.
    const barMat = new THREE.MeshStandardMaterial({
      color: 0xf0d24a,
      roughness: 0.7,
      emissive: 0x2a2208,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    for (let i = 0; i < 2; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(this.padRadius * 1.5, 0.05, 0.9), barMat);
      bar.rotation.y = (i * Math.PI) / 2;
      bar.position.y = 0.08;
      group.add(bar);
    }

    // Beacon masts around the perimeter with pulsing lamps.
    this.beacons = [];
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x9a9a98, roughness: 0.5, metalness: 0.7 });
    const lampGeo = new THREE.SphereGeometry(0.42, 12, 10);
    const beaconCount = 6;
    for (let i = 0; i < beaconCount; i++) {
      const a = (i / beaconCount) * Math.PI * 2;
      const bx = Math.cos(a) * (this.padRadius + 2.5);
      const bz = Math.sin(a) * (this.padRadius + 2.5);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 3.4, 8), mastMat);
      mast.position.set(bx, 1.7, bz);
      mast.castShadow = true;
      group.add(mast);

      const lampMat = new THREE.MeshStandardMaterial({
        color: 0xfff0c0,
        emissive: 0xffc94a,
        emissiveIntensity: 4,
        roughness: 0.3,
      });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(bx, 3.6, bz);
      group.add(lamp);
      this.beacons.push({ material: lampMat, phase: (i / beaconCount) * Math.PI * 2 });
    }

    this.group.add(group);
  }

  _buildBoulders() {
    const t = this.config.terrain;
    if (!t.boulderCount) return;

    const geo = new THREE.DodecahedronGeometry(1, 1);
    // Rough the primitive up so instances don't read as identical crystals.
    const p = geo.attributes.position;
    const nz = makeSimplex2(this.config.seed + 4001);
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const d = 1 + fbm(nz, v.x * 1.6, v.z * 1.6 + v.y, 3) * 0.34;
      v.multiplyScalar(d);
      p.setXYZ(i, v.x, v.y * 0.78, v.z); // squat, partially buried look
    }
    geo.computeVertexNormals();

    const mesh = new THREE.InstancedMesh(geo, this.assets.boulderMaterial, t.boulderCount);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    const posv = new THREE.Vector3();
    let placed = 0;
    let guard = 0;

    while (placed < t.boulderCount && guard < t.boulderCount * 30) {
      guard++;
      const x = (this.rng() * 2 - 1) * this.half * 0.97;
      const z = (this.rng() * 2 - 1) * this.half * 0.97;
      const dPad = Math.hypot(x - this.padCenter.x, z - this.padCenter.z);
      // Never inside the pad; sparser just outside it so the approach is fair.
      if (dPad < this.padRadius + 8) continue;
      if (dPad < this.padRadius + 26 && this.rng() > 0.25) continue;

      // Boulders concentrate on crater rims, where impacts excavate bedrock.
      let rimBoost = 0;
      for (const c of this.craters) {
        const u = Math.hypot(x - c.x, z - c.z) / c.radius;
        if (u > 0.85 && u < 1.7) rimBoost = Math.max(rimBoost, c.freshness);
      }
      if (this.rng() > 0.25 + rimBoost * 0.7) continue;

      const r = lerp(t.boulderMin, t.boulderMax, Math.pow(this.rng(), 2.4));
      const y = this.heightAt(x, z) - r * 0.28; // sunk into the regolith
      posv.set(x, y, z);
      euler.set(this.rng() * 0.5, this.rng() * Math.PI * 2, this.rng() * 0.5);
      q.setFromEuler(euler);
      scale.set(r * (0.8 + this.rng() * 0.4), r * (0.6 + this.rng() * 0.5), r * (0.8 + this.rng() * 0.4));
      m.compose(posv, q, scale);
      mesh.setMatrixAt(placed, m);

      // Boulders big enough to wreck a leg are real hazards, so they get
      // collision bodies. Apollo 11 had to fly past exactly this problem.
      if (r >= t.boulderHazardSize) {
        const body = new CANNON.Body({ mass: 0, material: this.assets.groundPhysMaterial });
        body.addShape(new CANNON.Sphere(r * 0.82));
        body.position.set(x, y + r * 0.2, z);
        body.userData = { kind: "boulder" };
        this.world.addBody(body);
        this.bodies.push(body);
      }

      this.boulders.push({ x, z, r });
      placed++;
    }

    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    this.boulderMesh = mesh;
    this.group.add(mesh);
  }

  /**
   * Rail-mounted mobile pad for the moving-platform level: a steel deck that
   * traverses a track, rather than an implausibly hovering platform.
   */
  _buildMovingPad() {
    const cfg = this.config.pad.moving;
    if (!cfg) {
      this.movingPad = null;
      return;
    }

    const y = this._padBaseHeight;
    const deckR = this.padRadius;
    const group = new THREE.Group();

    const steel = new THREE.MeshStandardMaterial({
      color: 0x7c8288,
      roughness: 0.44,
      metalness: 0.85,
      map: this.assets.panel.map,
      normalMap: this.assets.panel.normalMap,
      roughnessMap: this.assets.panel.roughnessMap,
    });

    const deck = new THREE.Mesh(new THREE.CylinderGeometry(deckR, deckR * 0.94, 1.1, 40), steel);
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    // Hazard chevrons around the deck edge.
    const chevronMat = new THREE.MeshStandardMaterial({
      color: 0xf2c22c,
      emissive: 0x241a02,
      roughness: 0.6,
      metalness: 0.2,
    });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const chev = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.16, 0.62), chevronMat);
      chev.position.set(Math.cos(a) * (deckR - 1.1), 0.58, Math.sin(a) * (deckR - 1.1));
      chev.rotation.y = -a;
      group.add(chev);
    }

    const targetGeo = new THREE.RingGeometry(deckR * 0.34, deckR * 0.44, 48);
    targetGeo.rotateX(-Math.PI / 2);
    const target = new THREE.Mesh(
      targetGeo,
      new THREE.MeshStandardMaterial({ color: 0xf0d24a, emissive: 0x2a2208, roughness: 0.7 })
    );
    target.position.y = 0.58;
    group.add(target);

    // Deck-mounted approach lights, so the moving pad is as findable from
    // altitude as a fixed one.
    const lampGeo = new THREE.SphereGeometry(0.36, 12, 10);
    const deckBeacons = 5;
    for (let i = 0; i < deckBeacons; i++) {
      const a = (i / deckBeacons) * Math.PI * 2;
      const mat = new THREE.MeshStandardMaterial({
        color: 0xfff0c0,
        emissive: 0xffc94a,
        emissiveIntensity: 4,
        roughness: 0.3,
      });
      const lamp = new THREE.Mesh(lampGeo, mat);
      lamp.position.set(Math.cos(a) * (deckR - 0.9), 0.95, Math.sin(a) * (deckR - 0.9));
      group.add(lamp);
      this.beacons.push({ material: mat, phase: (i / deckBeacons) * Math.PI * 2 });
    }

    // Bogies and the rail they ride on.
    const bogieMat = new THREE.MeshStandardMaterial({ color: 0x4d5257, roughness: 0.5, metalness: 0.8 });
    for (const sx of [-1, 1]) {
      const bogie = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, deckR * 1.5), bogieMat);
      bogie.position.set(sx * deckR * 0.55, -0.9, 0);
      bogie.castShadow = true;
      group.add(bogie);
    }

    this.movingPadGroup = group;
    this.group.add(group);

    // Rail bed spanning the traverse.
    const railMat = new THREE.MeshStandardMaterial({ color: 0x53585c, roughness: 0.55, metalness: 0.7 });
    const axis = cfg.axis === "z" ? "z" : "x";
    const span = cfg.amplitude * 2 + deckR * 3;
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(axis === "x" ? span : 0.5, 0.34, axis === "x" ? 0.5 : span),
        railMat
      );
      const off = side * deckR * 0.55;
      rail.position.set(
        this.padCenter.x + (axis === "x" ? 0 : off),
        y - 1.5,
        this.padCenter.z + (axis === "x" ? off : 0)
      );
      rail.receiveShadow = true;
      this.group.add(rail);
    }

    // Collision deck. A static body we reposition each frame; the lander body
    // is DYNAMIC so the pair is still narrowphase-tested (a KINEMATIC/STATIC
    // pair would be skipped by cannon-es).
    const body = new CANNON.Body({ mass: 0, material: this.assets.groundPhysMaterial });
    body.addShape(new CANNON.Cylinder(deckR, deckR, 1.1, 20));
    body.userData = { kind: "movingPad" };
    this.world.addBody(body);
    this.bodies.push(body);
    this.movingPad = { cfg, body, axis, baseY: y, deckTop: y + 0.55 };

    this._updateMovingPad(0);
  }

  _updateMovingPad(dt) {
    const mp = this.movingPad;
    if (!mp) return;
    const { cfg, axis } = mp;
    const offset = Math.sin(this.elapsed * cfg.speed) * cfg.amplitude;
    const vel = Math.cos(this.elapsed * cfg.speed) * cfg.amplitude * cfg.speed;

    const x = this.config.pad.x + (axis === "x" ? offset : 0);
    const z = this.config.pad.z + (axis === "z" ? offset : 0);

    this.movingPadGroup.position.set(x, mp.baseY, z);
    mp.body.position.set(x, mp.baseY, z);
    // A static body never runs integrate(), so its cached AABB would go stale
    // after a manual move — mark it for refresh explicitly.
    mp.body.aabbNeedsUpdate = true;

    this.padCenter.set(x, mp.deckTop, z);
    this.padVelocity = axis === "x"
      ? new THREE.Vector3(vel, 0, 0)
      : new THREE.Vector3(0, 0, vel);
    void dt;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Horizontal distance from a world position to the pad centre. */
  distanceToPad(x, z) {
    return Math.hypot(x - this.padCenter.x, z - this.padCenter.z);
  }

  isOnPad(x, z) {
    return this.distanceToPad(x, z) <= this.padRadius;
  }

  /** Height of the landable surface (pad deck or terrain) under a position. */
  surfaceHeightAt(x, z) {
    if (this.movingPad && this.distanceToPad(x, z) <= this.padRadius) {
      return this.movingPad.deckTop;
    }
    return this.heightAt(x, z);
  }

  update(dt) {
    this.elapsed += dt;
    this._updateMovingPad(dt);
    // Beacons pulse in sequence so the pad is findable from a distance.
    for (const b of this.beacons ?? []) {
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 3.4 - b.phase);
      b.material.emissiveIntensity = 1.2 + pulse * 6;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const body of this.bodies) this.world.removeBody(body);
    this.bodies.length = 0;
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      // Shared procedural materials are owned by the asset cache, so only
      // dispose the ones created locally for this terrain.
      if (obj.material && obj.material !== this.assets.regolithMaterial &&
          obj.material !== this.assets.boulderMaterial) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  }
}
