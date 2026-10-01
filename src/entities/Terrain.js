import * as THREE from "three";
import * as CANNON from "cannon-es";
import { makeSimplex2, makeRng, fbm, ridged, clamp, smoothstep, lerp } from "../materials/noise.js";
import { applyLunarPhotometry } from "../materials/photometry.js";
import { applyRegolithDetail, setRegolithDetail } from "../materials/regolithShader.js";

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

    // Regolith materials this terrain created, for quality changes.
    this._detailMaterials = [];

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
    const shades = new Float32Array(pos.count);
    let shadeSum = 0;
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
      shades[i] = shade;
      shadeSum += shade;
    }

    // Normalise to a mean of 1: the material carries the calibrated albedo
    // (see assets.js), the vertex colours only the variation around it.
    const shadeNorm = pos.count / shadeSum;
    for (let i = 0; i < pos.count; i++) {
      const ix = i % n;
      const iz = Math.floor(i / n);
      const shade = shades[i] * shadeNorm;
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
    // Same 12 m texel density as the playable field. RingGeometry's own UVs
    // stretch one tile across the whole 7 km plate, which made the ground
    // visibly change character at the edge of the play area.
    this._worldUvs(geometry, 12);

    const material = new THREE.MeshStandardMaterial({
      color: this.assets.regolithTint.clone().multiplyScalar(0.92),
      roughness: 1,
      metalness: 0,
      map: this.assets.regolith.map,
      normalMap: this.assets.regolith.normalMap,
    });
    applyLunarPhotometry(material);
    applyRegolithDetail(material, { ...this.assets.regolithDetail, microStrength: 0 });
    this._detailMaterials.push(material);
    this.farField = new THREE.Mesh(geometry, material);
    this.farField.receiveShadow = false;
    this.group.add(this.farField);

    // Distant mountain ring: an old basin rim breaking the skyline.
    //
    // Built as one continuous band rather than a ring of instanced cones. The
    // cones were flat-shaded five-sided pyramids, and at a 10-degree sun their
    // sunward facets lit up as bright uniform triangles against a dark
    // foreground — the least lunar thing on screen. A single displaced mesh
    // with smooth normals gives a real silhouette, and lets the low sun rake
    // across its slopes the way it does across the near terrain.
    this.horizonRidge = this._buildHorizonMassif(size);
    this.group.add(this.horizonRidge);
  }

  /**
   * A ring-shaped massif: angular resolution follows the skyline, radial
   * resolution follows the cross-section (foothills, main crest, back slope).
   * Heights come from ridged noise sampled on the ring itself, so the
   * silhouette is seamless all the way round.
   */
  _buildHorizonMassif(fieldSize) {
    const inner = fieldSize * 0.3;
    const outer = fieldSize * 0.5;
    const segA = 540; // around the ring
    const segR = 30; // across it
    const positions = new Float32Array((segA + 1) * (segR + 1) * 3);
    const uvs = new Float32Array((segA + 1) * (segR + 1) * 2);
    const indices = [];

    // Skyline height and crest position vary slowly round the ring.
    //
    // Lunar mountains are rounded, not jagged. With no wind, water or ice,
    // the only erosion is billions of years of micrometeorite gardening,
    // which softens every peak into a broad dome — Apollo 15's Hadley Delta
    // and Mount Hadley look like smooth heaps, not alpine spires. So the
    // skyline is smooth fbm with only a little ridged character, and few
    // octaves: no fine sharp detail survives at this scale.
    const skyline = (a) => {
      const nx = Math.cos(a) * 3.2;
      const nz = Math.sin(a) * 3.2;
      const dome = fbm(this.noiseB, nx * 0.8, nz * 0.8, 3) * 0.5 + 0.5;
      const ridge = ridged(this.noiseB, nx, nz, 2);
      const broad = fbm(this.noise, nx * 0.45 + 11, nz * 0.45 - 7, 2);
      return {
        height: 80 + dome * dome * 380 + ridge * 60 + broad * 60,
        crest: 0.48 + fbm(this.noise, nx * 0.6 - 3, nz * 0.6 + 5, 2) * 0.16,
      };
    };

    let v = 0;
    for (let i = 0; i <= segA; i++) {
      const a = (i / segA) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const { height, crest } = skyline(a);
      for (let j = 0; j <= segR; j++) {
        const u = j / segR;
        const r = inner + (outer - inner) * u;
        const x = ca * r;
        const z = sa * r;
        // Asymmetric cross-section: a long foothill apron facing the site,
        // a steeper crest, then the back slope falling away.
        const d = u - crest;
        const profile = d < 0 ? Math.exp(-(d * d) / 0.045) : Math.exp(-(d * d) / 0.02);
        const apron = 0.28 * Math.exp(-((u - crest + 0.26) ** 2) / 0.02);
        // Ridged detail so the slopes carry gullies and spurs, not a smooth hump.
        // Gentle undulation only — sharp gullies would read as terrestrial.
        const detail = fbm(this.noise, x * 0.0022, z * 0.0022, 3);
        const y = -70 + height * (profile + apron) * (0.92 + detail * 0.16);
        positions[v * 3] = x;
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = z;
        uvs[v * 2] = (i / segA) * 90;
        uvs[v * 2 + 1] = u * 6;
        v++;
      }
    }
    for (let i = 0; i < segA; i++) {
      for (let j = 0; j < segR; j++) {
        const a = i * (segR + 1) + j;
        const b = a + segR + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      // Highland massifs are anorthositic and brighter than mare soil.
      color: this.assets.regolithTint.clone().multiplyScalar(1.15),
      roughness: 1,
      metalness: 0,
      map: this.assets.regolith.map,
    });
    applyLunarPhotometry(material);
    applyRegolithDetail(material, { ...this.assets.regolithDetail, microStrength: 0 });
    this._detailMaterials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    return mesh;
  }

  /**
   * Replaces a horizontal mesh's UVs with world-space ones at `tileMetres`
   * per texture repeat, in the same phase as the terrain's own UVs.
   * @param {THREE.BufferGeometry} geometry positions in the mesh's local frame
   * @param {number} tileMetres
   * @param {THREE.Vector3} [origin] the mesh's world position, if offset
   */
  _worldUvs(geometry, tileMetres, origin = null) {
    const pos = geometry.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    const ox = origin?.x ?? 0;
    const oz = origin?.z ?? 0;
    for (let i = 0; i < pos.count; i++) {
      // Terrain UVs run 0..1 west to east and south to north (PlaneGeometry
      // rotated flat), scaled by size / tile.
      uv[i * 2] = (pos.getX(i) + ox + this.half) / tileMetres;
      uv[i * 2 + 1] = (this.half - (pos.getZ(i) + oz)) / tileMetres;
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
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

    // Prepared deck: swept, compacted regolith — the same material as the
    // ground around it, just flatter and a shade brighter, as compacted
    // regolith is (the astronauts' footpaths show this in every photograph).
    //
    // The site is marked the way a surveyed pad on the Moon plausibly would
    // be: flat, low-contrast survey panels and small strobes. It used to be
    // painted like a heliport — saturated yellow rings with a glow, and
    // constantly lit orbs on posts — which read as science fiction.
    const deckGeo = new THREE.CircleGeometry(this.padRadius, 72);
    deckGeo.rotateX(-Math.PI / 2);
    // Texel density and phase matched to the terrain underneath, so the deck
    // reads as the same soil, swept — not as a disc of oversized craters.
    this._worldUvs(deckGeo, 12, this.padCenter);
    const deckMaterial = new THREE.MeshStandardMaterial({
      color: this.assets.regolithTint.clone().multiplyScalar(1.12),
      roughness: 1,
      metalness: 0,
      map: this.assets.regolith.map,
      normalMap: this.assets.regolith.normalMap,
      // Compacted: the micro-relief is pressed flat.
      normalScale: new THREE.Vector2(0.45, 0.45),
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    applyLunarPhotometry(deckMaterial);
    applyRegolithDetail(deckMaterial, this.assets.regolithDetail);
    this._detailMaterials.push(deckMaterial);
    const deck = new THREE.Mesh(deckGeo, deckMaterial);
    deck.position.y = 0.04;
    deck.receiveShadow = true;
    group.add(deck);

    // Survey panels: pale beta-cloth, dusted with regolith (the map mottles
    // them) and unlit — they read in sunlight by contrast alone, which on a
    // grey surface is plenty from altitude. Two rings of segmented panels and
    // a centre cross, rather than continuous painted lines.
    // Albedo ~0.3: pale cloth under a film of dust, against ~0.12 soil.
    const panelMat = new THREE.MeshStandardMaterial({
      color: this.assets.regolithTint.clone().multiplyScalar(2.4),
      roughness: 0.92,
      metalness: 0,
      map: this.assets.regolith.map,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    applyLunarPhotometry(panelMat, 0.45);
    for (const [ringFraction, count] of [[0.55, 16], [0.95, 28]]) {
      const radius = this.padRadius * ringFraction;
      const arc = (Math.PI * 2) / count;
      const geo = new THREE.RingGeometry(radius - 0.6, radius + 0.6, 4, 1, 0, arc * 0.62);
      geo.rotateX(-Math.PI / 2);
      for (let k = 0; k < count; k++) {
        const panel = new THREE.Mesh(geo, panelMat);
        panel.rotation.y = k * arc;
        panel.position.y = 0.07;
        group.add(panel);
      }
    }
    for (let i = 0; i < 4; i++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(this.padRadius * 0.3, 0.03, 0.7), panelMat);
      const a = (i * Math.PI) / 2;
      strip.position.set(Math.cos(a) * this.padRadius * 0.2, 0.07, Math.sin(a) * this.padRadius * 0.2);
      strip.rotation.y = -a;
      group.add(strip);
    }

    // Perimeter strobes on low tripod masts: dark until they flash, like an
    // obstruction strobe, rather than glowing orbs.
    this.beacons = [];
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x8e8f8c, roughness: 0.55, metalness: 0.6 });
    const lampGeo = new THREE.SphereGeometry(0.16, 10, 8);
    const beaconCount = 6;
    for (let i = 0; i < beaconCount; i++) {
      const a = (i / beaconCount) * Math.PI * 2;
      const bx = Math.cos(a) * (this.padRadius + 2.5);
      const bz = Math.sin(a) * (this.padRadius + 2.5);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.6, 6), mastMat);
      mast.position.set(bx, 0.8, bz);
      mast.castShadow = true;
      group.add(mast);

      const lampMat = new THREE.MeshStandardMaterial({
        color: 0xd8dde0,
        emissive: 0xfff4e0,
        emissiveIntensity: 0,
        roughness: 0.3,
      });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(bx, 1.66, bz);
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
    // Safety yellow is plausible on a machine; a self-lit glow is not.
    const chevronMat = new THREE.MeshStandardMaterial({
      color: 0xc9a43a,
      roughness: 0.75,
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
      new THREE.MeshStandardMaterial({ color: 0xcfc9bb, roughness: 0.85 })
    );
    target.position.y = 0.58;
    group.add(target);

    // Deck-mounted approach lights, so the moving pad is as findable from
    // altitude as a fixed one.
    const lampGeo = new THREE.SphereGeometry(0.16, 10, 8);
    const deckBeacons = 5;
    for (let i = 0; i < deckBeacons; i++) {
      const a = (i / deckBeacons) * Math.PI * 2;
      const mat = new THREE.MeshStandardMaterial({
        color: 0xd8dde0,
        emissive: 0xfff4e0,
        emissiveIntensity: 0,
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

  /** Applies a regolith detail level (see regolithShader.js). */
  setDetailLevel(level) {
    for (const m of this._detailMaterials) setRegolithDetail(m, level);
  }

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
    // Strobes flash in a chase around the perimeter so the pad is findable
    // from a distance: a sharp flash every 1.6 s, dark in between.
    for (const b of this.beacons ?? []) {
      const cycle = (this.elapsed / 1.6 + b.phase / (Math.PI * 2)) % 1;
      b.material.emissiveIntensity = cycle < 0.06 ? 14 * (1 - cycle / 0.06) : 0;
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
