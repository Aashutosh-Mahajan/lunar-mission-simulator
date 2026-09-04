import * as THREE from "three";
import { ASCENT_MISSION } from "../levels/ascentConfig.js";

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

const CORE_RADIUS = 10.1 / 2;
const SIVB_RADIUS = 6.6 / 2;

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
    const a = this.assets;

    // Saturn V's insulation was painted white with black roll-pattern
    // markings so range cameras could measure roll rate.
    this.white = new THREE.MeshStandardMaterial({
      color: 0xe9e9e6,
      metalness: 0.18,
      roughness: 0.62,
      map: a.panel.map,
      normalMap: a.panel.normalMap,
      roughnessMap: a.panel.roughnessMap,
    });
    this.black = new THREE.MeshStandardMaterial({
      color: 0x24262a,
      metalness: 0.2,
      roughness: 0.66,
      map: a.panel.map,
      normalMap: a.panel.normalMap,
    });
    this.metal = new THREE.MeshStandardMaterial({
      color: 0xa8adb2,
      metalness: 0.72,
      roughness: 0.42,
    });
    this.engineMat = new THREE.MeshStandardMaterial({
      color: 0x3a342e,
      metalness: 0.7,
      roughness: 0.5,
      side: THREE.DoubleSide,
    });
    this.sootMat = new THREE.MeshStandardMaterial({
      color: 0x1c1a18,
      metalness: 0.4,
      roughness: 0.85,
    });
  }

  _buildStages() {
    const [sic, sii, sivb] = this.mission.stages;

    // Each stage is its own group so separation can simply reparent it.
    this.stageGroups = [];

    // ---- S-IC (first stage) --------------------------------------------
    const g1 = new THREE.Group();
    const h1 = sic.length;
    const body1 = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_RADIUS, CORE_RADIUS, h1, 40, 1),
      this.white
    );
    body1.position.y = h1 / 2;
    g1.add(body1);

    // Black roll-pattern bands.
    for (const [yFrac, hFrac] of [[0.06, 0.1], [0.52, 0.06], [0.92, 0.07]]) {
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(CORE_RADIUS + 0.03, CORE_RADIUS + 0.03, h1 * hFrac, 40, 1),
        this.black
      );
      band.position.y = h1 * yFrac;
      g1.add(band);
    }

    // Four fins and their conical fairings at the base.
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.4, 5.4), this.black);
      fin.position.set(Math.cos(ang) * (CORE_RADIUS + 2.0), 3.4, Math.sin(ang) * (CORE_RADIUS + 2.0));
      fin.rotation.y = -ang;
      g1.add(fin);

      const fairing = new THREE.Mesh(new THREE.ConeGeometry(1.5, 7.5, 12), this.white);
      fairing.position.set(Math.cos(ang) * (CORE_RADIUS - 0.4), 6.0, Math.sin(ang) * (CORE_RADIUS - 0.4));
      g1.add(fairing);
    }

    // Five F-1 engines: four on a ring that gimballed, one fixed in the centre.
    this.f1Bells = [];
    const bellPositions = [[0, 0]];
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      bellPositions.push([Math.cos(ang) * 3.7, Math.sin(ang) * 3.7]);
    }
    for (const [bx, bz] of bellPositions) {
      const bell = this._makeBell(1.2, 1.9, 4.2, this.engineMat);
      bell.position.set(bx, -2.2, bz);
      g1.add(bell);
      this.f1Bells.push(bell);
    }
    // The four outboard F-1s gimballed to steer; the centre engine was fixed.
    this.gimballedBells = this.f1Bells.slice(1);

    // Engine skirt / heat shield.
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_RADIUS, CORE_RADIUS * 0.96, 1.2, 40, 1, true),
      this.sootMat
    );
    skirt.position.y = -0.5;
    skirt.material.side = THREE.DoubleSide;
    g1.add(skirt);

    this.group.add(g1);
    this.stageGroups.push({ group: g1, height: h1, config: sic });

    // ---- S-II (second stage) -------------------------------------------
    const g2 = new THREE.Group();
    g2.position.y = h1;
    const h2 = sii.length;
    const body2 = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_RADIUS, CORE_RADIUS, h2, 40, 1),
      this.white
    );
    body2.position.y = h2 / 2;
    g2.add(body2);

    // Interstage skirt, jettisoned in reality but kept as a visual band.
    const inter = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_RADIUS + 0.04, CORE_RADIUS + 0.04, 5.5, 40),
      this.black
    );
    inter.position.y = 2.6;
    g2.add(inter);

    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const bell = this._makeBell(0.5, 1.0, 2.6, this.engineMat);
      const r = i === 0 ? 0 : 2.2;
      bell.position.set(Math.cos(ang) * r, -1.5, Math.sin(ang) * r);
      g2.add(bell);
    }

    this.group.add(g2);
    this.stageGroups.push({ group: g2, height: h2, config: sii });

    // ---- S-IVB (third stage) + payload ---------------------------------
    const g3 = new THREE.Group();
    g3.position.y = h1 + h2;
    const h3 = sivb.length;

    // Tapered adapter from the 10.1 m core to the 6.6 m third stage.
    const taper = new THREE.Mesh(
      new THREE.CylinderGeometry(SIVB_RADIUS, CORE_RADIUS, 3.6, 40, 1),
      this.white
    );
    taper.position.y = 1.8;
    g3.add(taper);

    const body3 = new THREE.Mesh(
      new THREE.CylinderGeometry(SIVB_RADIUS, SIVB_RADIUS, h3 - 3.6, 32, 1),
      this.white
    );
    body3.position.y = 3.6 + (h3 - 3.6) / 2;
    g3.add(body3);

    const band3 = new THREE.Mesh(
      new THREE.CylinderGeometry(SIVB_RADIUS + 0.03, SIVB_RADIUS + 0.03, 1.6, 32),
      this.black
    );
    band3.position.y = 5.2;
    g3.add(band3);

    const j2 = this._makeBell(0.45, 0.9, 2.4, this.engineMat);
    j2.position.y = -1.2;
    g3.add(j2);

    // Instrument unit ring.
    const iu = new THREE.Mesh(
      new THREE.CylinderGeometry(SIVB_RADIUS + 0.02, SIVB_RADIUS + 0.02, 0.9, 32),
      this.metal
    );
    iu.position.y = h3 + 0.45;
    g3.add(iu);

    // Spacecraft adapter housing the lunar module.
    const slaHeight = 8.5;
    const sla = new THREE.Mesh(
      new THREE.CylinderGeometry(1.95, SIVB_RADIUS, slaHeight, 32, 1),
      this.white
    );
    sla.position.y = h3 + 0.9 + slaHeight / 2;
    g3.add(sla);

    // Service module.
    const smHeight = 7.5;
    const sm = new THREE.Mesh(
      new THREE.CylinderGeometry(1.95, 1.95, smHeight, 32),
      this.metal
    );
    sm.position.y = h3 + 0.9 + slaHeight + smHeight / 2;
    g3.add(sm);

    // Service Propulsion System bell.
    const sps = this._makeBell(0.4, 0.8, 2.2, this.engineMat);
    sps.position.y = h3 + 0.9 + slaHeight - 1.0;
    sps.rotation.x = Math.PI; // points aft, tucked under the SM
    g3.add(sps);

    // Command module cone.
    const cmY = h3 + 0.9 + slaHeight + smHeight;
    const cm = new THREE.Mesh(new THREE.ConeGeometry(1.95, 3.5, 32), this.metal);
    cm.position.y = cmY + 1.75;
    g3.add(cm);

    // Launch escape system: tower and solid motor.
    const towerY = cmY + 3.5;
    const escTower = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.2, 6), this.metal);
      leg.position.set(Math.cos(ang) * 0.55, towerY + 1.6, Math.sin(ang) * 0.55);
      leg.rotation.z = Math.cos(ang) * 0.12;
      leg.rotation.x = -Math.sin(ang) * 0.12;
      escTower.add(leg);
    }
    const escMotor = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 4.6, 20), this.white);
    escMotor.position.y = towerY + 5.5;
    escTower.add(escMotor);
    const escNose = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2.4, 20), this.black);
    escNose.position.y = towerY + 9.0;
    escTower.add(escNose);
    g3.add(escTower);
    this.escapeTower = escTower;

    this.group.add(g3);
    this.stageGroups.push({ group: g3, height: h3, config: sivb });

    // Overall stack height from the base of the S-IC to the tip of the escape
    // tower — the real vehicle stood 110.6 m.
    this.totalHeight = h1 + h2 + cmY + 3.5 + 10.2;
  }

  /** A lathed bell nozzle with a proper expanding contour. */
  _makeBell(throatRadius, exitRadius, length, material) {
    const points = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = throatRadius + Math.pow(t, 0.6) * (exitRadius - throatRadius);
      points.push(new THREE.Vector2(r, -t * length));
    }
    const geo = new THREE.LatheGeometry(points, 20);
    const mesh = new THREE.Mesh(geo, material);
    mesh.material.side = THREE.DoubleSide;
    return mesh;
  }

  /**
   * Exhaust plumes. In dense air the plume is a short, brilliant, tightly
   * collimated column; as ambient pressure drops the flow becomes badly
   * under-expanded and blooms into the huge translucent bell that makes
   * high-altitude Saturn V footage so recognisable.
   */
  _buildPlumes() {
    const geo = new THREE.ConeGeometry(1, 1, 26, 6, true);
    geo.translate(0, -0.5, 0);

    this.plumeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        throttle: { value: 0 },
        time: { value: 0 },
        expansion: { value: 0 }, // 0 = sea level, 1 = vacuum
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
          float along = 1.0 - vUv.y;
          // Sea level: dense and bright near the nozzle, fading fast.
          // Vacuum: thin, wide, and translucent all the way down.
          float density = mix(pow(along, 3.2), pow(along, 0.85), expansion);

          float rim = 1.0 - abs(dot(vNormal, vView));
          rim = pow(clamp(rim, 0.0, 1.0), mix(0.6, 1.5, expansion));

          // Mach diamonds: standing shocks visible only in the atmosphere.
          float diamonds = 0.75 + 0.25 * sin(vUv.y * 46.0 - time * 30.0);
          diamonds = mix(diamonds, 1.0, expansion);

          float flicker = 0.88 + 0.12 * hash(vec2(floor(time * 60.0), floor(vUv.y * 12.0)));

          // Overall level is kept well under 1: this is drawn additively over
          // a large part of the frame, and a fully opaque plume turns the
          // whole scene orange.
          float alpha = density * mix(1.0, rim, expansion * 0.85) * diamonds * flicker;
          alpha *= throttle * mix(0.5, 0.42, expansion);

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
    // Retire husks once they are far behind and no longer worth drawing.
    this.huskGroups = this.huskGroups.filter((h) => {
      if (h.age > 26) {
        this.scene.remove(h.object);
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
    this.engineLight.intensity = visible ? throttle * 7000 : 0;
    if (!visible) return;

    const expansion = 1 - pressureRatio;
    const stage = this.mission.stages[stageIndex];

    // Sea-level plumes are roughly a vehicle-diameter wide and a few
    // diameters long; in vacuum they bloom to many times that.
    const baseRadius = stage.diameter * 0.5;
    const radius = baseRadius * (0.85 + expansion * 2.6);
    // Long enough to read as a vacuum plume, short enough that the chase
    // camera doesn't end up inside it.
    const length = stage.diameter * (2.2 + expansion * 4.5) * (0.5 + throttle * 0.7);

    // Position the plume at the base of the currently burning stage.
    let offset = 0;
    for (let i = 0; i < stageIndex; i++) offset += this.stageGroups[i].height;
    this.plume.position.set(0, offset - 3.2, 0);
    this.plume.scale.set(radius, length, radius);

    this.engineLight.position.set(0, offset - 6, 0);
    this.engineLight.distance = 200 + length * 6;

    this.plumeMaterial.uniforms.throttle.value = throttle;
    this.plumeMaterial.uniforms.time.value = elapsed;
    this.plumeMaterial.uniforms.expansion.value = expansion;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const h of this.huskGroups) this.scene.remove(h.object);
    this.huskGroups.length = 0;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.plumeMaterial.dispose();
  }
}
