import * as THREE from "three";
import { ASCENT_MISSION } from "../levels/ascentConfig.js";
import { buildSaturnV, buildSaturnMaterials } from "./saturnV.js";

// ---------------------------------------------------------------------------
// Saturn V, modelled at real scale: 110.6 m tall, 10.1 m core diameter.
//
// Built from primitives like the lunar module, with the features that make the
// vehicle recognisable — the black/white roll pattern, the corrugated S-IC
// skin, the interstage fairings, the fin flare at the base, the five F-1 bells
// and the escape tower.
//
// The model's origin sits at the base of whichever stage is currently burning,
// so the physics only has to track one point.
// ---------------------------------------------------------------------------


// How far the gimballed bells can swing. The real F-1 actuators had about
// 6 degrees of travel in each axis.
const MAX_GIMBAL = THREE.MathUtils.degToRad(6);

export default class Rocket {
  constructor(scene, assets, mission = ASCENT_MISSION) {
    this.scene = scene;
    this.assets = assets;
    this.mission = mission;

    this.group = new THREE.Group();
    this.group.name = "saturnV";
    scene.add(this.group);

    this._buildMaterials();
    this._buildStages();
    this._buildPlumes();

    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    this.huskGroups = [];
    this.separatedAt = -1;
  }

  _buildMaterials() {
    this.materials = buildSaturnMaterials(this.assets);
  }

  /**
   * Builds the stack from saturnV.js — real dimensions, a livery texture per
   * stage, F-1s under their fairings with fins, J-2s in the interstages, and
   * the full payload stack up to the escape tower's canards.
   */
  _buildStages() {
    const built = buildSaturnV(this.mission, this.materials);
    this.stageGroups = built.stages;
    for (const s of this.stageGroups) this.group.add(s.group);
    this.f1Bells = built.bells;
    // The four outboard F-1s gimballed to steer; the centre engine was fixed.
    this.gimballedBells = built.gimballed;
    this.escapeTower = built.escape;
    this.totalHeight = built.totalHeight;
  }

  /**
   * Exhaust plumes. In dense air the plume is a short, brilliant, tightly
   * collimated column; as ambient pressure drops the flow becomes badly
   * under-expanded and blooms into the huge translucent bell that makes
   * high-altitude Saturn V footage so recognisable.
   */
  _buildPlumes() {
    // Starts at the width of the engine cluster rather than at a point, and
    // widens downstream. Open-ended, so the shader must fade to nothing before
    // the far rim or that rim shows as a hard edge.
    const geo = new THREE.CylinderGeometry(0.55, 1, 1, 32, 14, true);
    geo.translate(0, -0.5, 0);

    this.plumeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        throttle: { value: 0 },
        time: { value: 0 },
        expansion: { value: 0 }, // 0 = sea level, 1 = vacuum
        luminosity: { value: 1 }, // kerosene flame 1, hydrogen far less
        coreColor: { value: new THREE.Color(0xfff0d0) },
        midColor: { value: new THREE.Color(0xff9540) },
        edgeColor: { value: new THREE.Color(0xff5a20) },
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
        uniform float expansion;
        uniform float luminosity;
        uniform vec3 coreColor;
        uniform vec3 midColor;
        uniform vec3 edgeColor;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vView;

        float hash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          // 0 at the nozzle exit, 1 at the far (open) end. CylinderGeometry
          // puts v = 1 at the top, which is the nozzle end here. (This was
          // previously inverted, so the plume was brightest at its open far
          // end and drew a hollow glowing ring trailing below the vehicle.)
          float along = 1.0 - vUv.y;
          float near = 1.0 - along;
          // Sea level: dense and bright at the nozzle, fading fast.
          // Vacuum: thin, wide, and translucent a long way downstream.
          float density = mix(pow(near, 2.4), pow(near, 0.9), expansion);
          // Always reach zero before the open end: no rim.
          density *= smoothstep(1.0, 0.72, along);

          // Optically thin gas glows in proportion to the path length through
          // it, which is longest through the centre and shortest at the
          // silhouette — so brighter in the middle, softer at the edges.
          // Falls all the way to zero at the silhouette, so the plume has a
          // soft boundary instead of the hard edge of the mesh behind it.
          float thickness = abs(dot(vNormal, vView));
          float body = pow(thickness, 0.9);

          // Mach diamonds: standing shocks, visible only in the atmosphere.
          // Standing — they do not travel down the plume.
          float diamonds = 0.78 + 0.22 * sin(vUv.y * 46.0);
          diamonds = mix(diamonds, 1.0, expansion);

          float flicker = 0.9 + 0.1 * hash(vec2(floor(time * 60.0), floor(vUv.y * 12.0)));

          // Overall level is kept well under 1: this is drawn additively over
          // a large part of the frame, and a fully opaque plume turns the
          // whole scene orange.
          float alpha = density * body * diamonds * flicker;
          alpha *= throttle * mix(0.55, 0.3, expansion) * luminosity;

          vec3 col = mix(edgeColor, midColor, density);
          col = mix(col, coreColor, pow(density, 2.0));
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.plume = new THREE.Mesh(geo, this.plumeMaterial);
    this.plume.frustumCulled = false;
    this.plume.visible = false;
    this.group.add(this.plume);

    // The engines throw enough light to matter at night and during staging.
    this.engineLight = new THREE.PointLight(0xffa040, 0, 900, 2);
    this.group.add(this.engineLight);
  }

  /**
   * Positions the vehicle. The physics tracks the base of the burning stage,
   * so the model is offset down by the stages already dropped.
   */
  setTransform(position, pitchDeg, stageIndex) {
    // Model origin is the base of stage 0; shift it so the current stage's
    // base lands on the physics position.
    let offset = 0;
    for (let i = 0; i < stageIndex; i++) offset += this.stageGroups[i].height;

    // Pitch is measured from the horizon and the vehicle flies in the x-y
    // plane, so a 90 degree pitch means the nose points along +Y.
    const roll = THREE.MathUtils.degToRad(pitchDeg - 90);
    this.group.rotation.set(0, 0, roll);

    const up = new THREE.Vector3(0, 1, 0).applyEuler(this.group.rotation);
    this.group.position.copy(position).addScaledVector(up, -offset);
  }

  /** Drops a stage: reparents it to the scene so it can tumble away. */
  jettison(stageIndex) {
    const entry = this.stageGroups[stageIndex];
    if (!entry || entry.jettisoned) return null;
    entry.jettisoned = true;

    const husk = entry.group;
    husk.updateWorldMatrix(true, false);
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    husk.matrixWorld.decompose(worldPos, worldQuat, new THREE.Vector3());

    this.group.remove(husk);
    this.scene.add(husk);
    husk.position.copy(worldPos);
    husk.quaternion.copy(worldQuat);

    const record = {
      object: husk,
      velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.5
      ),
      age: 0,
    };
    this.huskGroups.push(record);
    return record;
  }

  /**
   * Swings the gimballed engine bells to match the steering command. On a
   * real launcher this is the *only* way the vehicle turns — there are no
   * aerodynamic controls worth the name — so seeing the bells move is what
   * makes the steering read as physical rather than as the model being
   * rotated by an invisible hand.
   *
   * @param {number} demand -1..1 pitch command
   * @param {number} dt
   */
  updateGimbal(demand, dt) {
    const target = THREE.MathUtils.clamp(demand, -1, 1) * MAX_GIMBAL;
    // Actuators are fast but not instant.
    this._gimbal = THREE.MathUtils.lerp(
      this._gimbal ?? 0,
      target,
      1 - Math.exp(-7 * dt)
    );
    for (const bell of this.gimballedBells ?? []) {
      bell.rotation.x = this._gimbal;
    }
    // The plume follows the bells.
    if (this.plume) this.plume.rotation.x = this._gimbal;
  }

  /**
   * Jettisons the launch escape tower — a real event, moments after S-II
   * ignition. Its own solid motor pulls it up and away from the stack, so it
   * is thrown clear rather than simply switched off.
   */
  jettisonEscapeTower() {
    if (!this.escapeTower || this.escapeTowerGone) return;
    this.escapeTowerGone = true;

    const tower = this.escapeTower;
    tower.updateWorldMatrix(true, false);
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    tower.matrixWorld.decompose(worldPos, worldQuat, new THREE.Vector3());

    tower.parent.remove(tower);
    this.scene.add(tower);
    tower.position.copy(worldPos);
    tower.quaternion.copy(worldQuat);

    // Pulled up and off to one side by its escape motor.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.group.quaternion);
    this.huskGroups.push({
      object: tower,
      velocity: up.multiplyScalar(48).add(new THREE.Vector3(14, 0, 6)),
      spin: new THREE.Vector3(0.6, 0.3, 0.5),
      age: 0,
    });
  }

  /** Advances jettisoned hardware so it visibly falls away and tumbles. */
  updateHusks(dt, gravity) {
    for (const h of this.huskGroups) {
      h.age += dt;
      h.velocity.y -= gravity * dt;
      h.object.position.addScaledVector(h.velocity, dt);
      h.object.rotation.x += h.spin.x * dt;
      h.object.rotation.y += h.spin.y * dt;
      h.object.rotation.z += h.spin.z * dt;
    }
    // Retire husks once they are far behind and no longer worth drawing,
    // freeing their geometry (it was previously left on the GPU).
    this.huskGroups = this.huskGroups.filter((h) => {
      if (h.age > 26) {
        this.scene.remove(h.object);
        h.object.traverse((o) => o.geometry?.dispose());
        return false;
      }
      return true;
    });
  }

  /**
   * @param {number} throttle 0..1
   * @param {number} pressureRatio 1 at sea level, 0 in vacuum
   * @param {number} stageIndex
   */
  updatePlume(throttle, pressureRatio, stageIndex, elapsed) {
    const visible = throttle > 0.02;
    this.plume.visible = visible;
    // Enough to warm the pad structure and the exhaust cloud without
    // flooding the whole frame.
    const stage = this.mission.stages[stageIndex];
    // A hydrogen flame throws a fraction of the light a kerosene one does.
    const glow = stage?.fuel === "hydrolox" ? 0.15 : 1;
    this.engineLight.intensity = visible ? throttle * 7000 * glow : 0;
    if (!visible) return;

    const expansion = 1 - pressureRatio;

    // Sea-level plumes are roughly a vehicle-diameter wide and a few
    // diameters long; in vacuum they bloom to many times that.
    const baseRadius = stage.diameter * 0.5;
    const radius = baseRadius * (0.85 + expansion * 2.6);
    // Long enough to read as a vacuum plume, short enough that the chase
    // camera doesn't end up inside it.
    const length = stage.diameter * (3.4 + expansion * 4.5) * (0.5 + throttle * 0.7);

    // Position the plume at the base of the currently burning stage.
    // Starts at the burning stage's nozzle exit plane.
    let offset = 0;
    for (let i = 0; i < stageIndex; i++) offset += this.stageGroups[i].height;
    this.plume.position.set(0, offset + (this.stageGroups[stageIndex]?.nozzleExit ?? -3.2), 0);
    this.plume.scale.set(radius, length, radius);

    this.engineLight.position.set(0, offset - 6, 0);
    this.engineLight.distance = 200 + length * 6;

    this.plumeMaterial.uniforms.throttle.value = throttle;
    this.plumeMaterial.uniforms.time.value = elapsed;
    this.plumeMaterial.uniforms.expansion.value = expansion;
    this._setPlumeFuel(stage.fuel);
  }

  /**
   * Kerosene and hydrogen burn very differently to the eye. The S-IC's RP-1
   * flame is full of glowing soot and is the brilliant orange plume everyone
   * pictures; the J-2s on the S-II and S-IVB burned hydrogen, whose exhaust is
   * nearly transparent — a faint blue-violet shimmer. Rendering the upper
   * stages with the first stage's flame made the vacuum plume a solid white
   * tube filling the screen.
   */
  _setPlumeFuel(fuel) {
    if (fuel === this._plumeFuel) return;
    this._plumeFuel = fuel;
    const u = this.plumeMaterial.uniforms;
    if (fuel === "hydrolox") {
      u.luminosity.value = 0.16;
      u.coreColor.value.set(0xe4ecff);
      u.midColor.value.set(0x9fb6ff);
      u.edgeColor.value.set(0x6a70d8);
      this.engineLight.color.set(0xb8c6ff);
    } else {
      u.luminosity.value = 1;
      u.coreColor.value.set(0xfff0d0);
      u.midColor.value.set(0xff9540);
      u.edgeColor.value.set(0xff5a20);
      this.engineLight.color.set(0xffa860);
    }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const h of this.huskGroups) {
      this.scene.remove(h.object);
      h.object.traverse((o) => o.geometry?.dispose());
    }
    this.huskGroups.length = 0;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.plumeMaterial.dispose();

    // Materials and the textures baked for this vehicle. The panel and foil
    // normal maps some of them borrow belong to the shared asset cache.
    const m = this.materials;
    const own = [m.livery.sic.map, m.livery.sii.map, m.livery.sivb.map, m.serviceModule.map, m.bell.normalMap];
    for (const tex of own) tex?.dispose();
    for (const mat of [...Object.values(m.livery), ...Object.values(m).filter((x) => x?.isMaterial)]) {
      mat.dispose();
    }
  }
}
