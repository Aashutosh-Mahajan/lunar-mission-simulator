import * as THREE from "three";
import { buildServiceModuleLivery } from "../materials/textures.js";
import Lander from "./Lander.js";

// ---------------------------------------------------------------------------
// Phase 3 — the docked stack that crosses to the Moon.
//
// After transposition and docking the vehicle flew as Command/Service Module
// nose-to-nose with the Lunar Module, still attached to the spent S-IVB until
// the LM was extracted. That is what is modelled here: a CSM built from
// primitives, with the existing Lander mesh docked to its nose (display only —
// no collision body).
// ---------------------------------------------------------------------------

const SM_RADIUS = 1.95;
// The service module's drum. The oft-quoted 7.5 m includes the SPS engine
// bell; the cylinder itself is about 4.6 m.
const SM_LENGTH = 4.6;
const CM_HEIGHT = 3.5;

export default class Spacecraft {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;

    this.group = new THREE.Group();
    this.group.name = "csm";
    scene.add(this.group);

    this._buildCsm();
    this._buildLunarModule();
    this._buildEngine();

    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  _buildCsm() {
    const a = this.assets;

    // Service Module: bare aluminium with the white-painted radiator panels
    // that rejected the fuel cells' heat (see textures.js).
    const smMat = new THREE.MeshStandardMaterial({
      map: buildServiceModuleLivery(SM_LENGTH, SM_RADIUS),
      metalness: 0.5,
      roughness: 0.4,
    });
    this._smMaterial = smMat;

    const sm = new THREE.Mesh(
      new THREE.CylinderGeometry(SM_RADIUS, SM_RADIUS, SM_LENGTH, 32, 1),
      smMat
    );
    sm.position.y = SM_LENGTH / 2;
    this.group.add(sm);

    // Radiator panels and the sector seams that break up the drum.
    const seamMat = new THREE.MeshStandardMaterial({
      color: 0x6c7278,
      metalness: 0.7,
      roughness: 0.45,
    });
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const seam = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, SM_LENGTH * 0.96, 0.5),
        seamMat
      );
      seam.position.set(
        Math.cos(ang) * (SM_RADIUS + 0.02),
        SM_LENGTH / 2,
        Math.sin(ang) * (SM_RADIUS + 0.02)
      );
      seam.rotation.y = -ang;
      this.group.add(seam);
    }

    // RCS quads around the SM.
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const quad = new THREE.Group();
      quad.position.set(
        Math.cos(ang) * (SM_RADIUS + 0.1),
        SM_LENGTH * 0.78,
        Math.sin(ang) * (SM_RADIUS + 0.1)
      );
      quad.rotation.y = -ang;
      const mount = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), a.metalMaterial);
      quad.add(mount);
      for (const dir of [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 0, 1),
      ]) {
        const nozzle = new THREE.Mesh(
          new THREE.ConeGeometry(0.09, 0.22, 10, 1, true),
          a.engineMaterial
        );
        nozzle.material.side = THREE.DoubleSide;
        nozzle.position.copy(dir).multiplyScalar(0.33);
        nozzle.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
        quad.add(nozzle);
      }
      this.group.add(quad);
    }

    // High-gain antenna on its boom, aft.
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.0, 8), a.metalMaterial);
    boom.position.set(SM_RADIUS + 0.9, 1.1, 0);
    boom.rotation.z = Math.PI / 2.4;
    this.group.add(boom);
    const dishGroup = new THREE.Group();
    dishGroup.position.set(SM_RADIUS + 2.0, 0.5, 0);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const dish = new THREE.Mesh(
        new THREE.SphereGeometry(0.46, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.6),
        a.dishMaterial
      );
      dish.material.side = THREE.DoubleSide;
      dish.position.set(Math.cos(ang) * 0.48, 0, Math.sin(ang) * 0.48);
      dish.rotation.x = Math.PI;
      dishGroup.add(dish);
    }
    this.group.add(dishGroup);
    // Kept so the antenna can be steered at Earth during the coast.
    this.highGainAntenna = dishGroup;

    // Command Module: the conical crew capsule, ablative heat shield aft.
    const cm = new THREE.Mesh(
      new THREE.ConeGeometry(SM_RADIUS, CM_HEIGHT, 32),
      new THREE.MeshStandardMaterial({
        color: 0xd6d8da,
        metalness: 0.68,
        roughness: 0.3,
        map: a.panel.map,
        normalMap: a.panel.normalMap,
      })
    );
    cm.position.y = SM_LENGTH + CM_HEIGHT / 2;
    this.group.add(cm);

    // Docking probe and tunnel at the apex.
    const tunnel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.5, 0.7, 20),
      a.metalMaterial
    );
    tunnel.position.y = SM_LENGTH + CM_HEIGHT + 0.35;
    this.group.add(tunnel);

    this.dockY = SM_LENGTH + CM_HEIGHT + 0.7;
  }

  /**
   * The Lunar Module, docked nose-to-nose on top of the Command Module. It is
   * the same model flown in Phase 1 — display only, so it carries no
   * collision body.
   */
  _buildLunarModule() {
    this.lander = new Lander(this.scene, null, this.assets);
    // Re-parent the LM's mesh into this stack.
    this.scene.remove(this.lander.group);
    this.group.add(this.lander.group);

    // Docked inverted, its own docking tunnel mating with the CM's.
    this.lander.group.rotation.z = Math.PI;
    this.lander.group.position.y = this.dockY + 2.9;
    this.lander.group.scale.setScalar(0.98);
    // Gear stays folded for the whole coast.
    this.lander.setGearStowed(true);
  }

  _buildEngine() {
    // Service Propulsion System bell, aft.
    const points = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      points.push(new THREE.Vector2(0.35 + Math.pow(t, 0.6) * 0.7, -t * 2.6));
    }
    const bell = new THREE.Mesh(
      new THREE.LatheGeometry(points, 24),
      this.assets.engineMaterial
    );
    bell.material.side = THREE.DoubleSide;
    this.group.add(bell);
    this.engineExitY = -2.6;

    // Additive plume for the SPS burns (TLI and lunar orbit insertion).
    const geo = new THREE.ConeGeometry(1, 1, 24, 5, true);
    geo.translate(0, -0.5, 0);
    this.plumeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        throttle: { value: 0 },
        time: { value: 0 },
        coreColor: { value: new THREE.Color(0xdfe9ff) },
        edgeColor: { value: new THREE.Color(0x7fa8ff) },
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
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
          float along = 1.0 - vUv.y;
          // Hypergolic exhaust in vacuum: pale, translucent, hugely expanded.
          float density = pow(along, 1.1);
          float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 1.3);
          float flicker = 0.9 + 0.1 * hash(vec2(floor(time * 50.0), floor(vUv.y * 9.0)));
          float a = density * rim * flicker * throttle * 0.34;
          gl_FragColor = vec4(mix(edgeColor, coreColor, density), a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.plume = new THREE.Mesh(geo, this.plumeMaterial);
    this.plume.visible = false;
    this.plume.frustumCulled = false;
    this.group.add(this.plume);

    this.engineLight = new THREE.PointLight(0x9fc4ff, 0, 220, 2);
    this.engineLight.position.y = this.engineExitY - 3;
    this.group.add(this.engineLight);
  }

  /** @param {number} throttle 0..1 */
  setEngine(throttle, elapsed) {
    const on = throttle > 0.02;
    this.plume.visible = on;
    this.engineLight.intensity = on ? throttle * 2600 : 0;
    if (!on) return;

    const length = 14 + throttle * 20;
    const radius = 1.6 + throttle * 2.4;
    this.plume.position.set(0, this.engineExitY - 0.2, 0);
    this.plume.scale.set(radius, length, radius);
    this.plumeMaterial.uniforms.throttle.value = throttle;
    this.plumeMaterial.uniforms.time.value = elapsed;
  }

  /**
   * Keeps the high-gain antenna pointed back at Earth. The real crews had to
   * re-aim it constantly through the coast, and a dish that slowly tracks
   * while the stack rolls is a quiet, believable piece of motion.
   */
  aimAntenna(earthWorldPosition, dt) {
    if (!this.highGainAntenna) return;
    this._aimTarget = this._aimTarget ?? new THREE.Vector3();
    // Convert Earth's position into the antenna's parent frame, then ease the
    // dish around to face it.
    this._aimTarget.copy(earthWorldPosition);
    this.group.worldToLocal(this._aimTarget);

    this._aimQuat = this._aimQuat ?? new THREE.Quaternion();
    this._aimMatrix = this._aimMatrix ?? new THREE.Matrix4();
    this._aimMatrix.lookAt(
      this.highGainAntenna.position,
      this._aimTarget,
      new THREE.Vector3(0, 1, 0)
    );
    this._aimQuat.setFromRotationMatrix(this._aimMatrix);
    this.highGainAntenna.quaternion.slerp(this._aimQuat, 1 - Math.exp(-1.6 * dt));
  }

  /** Total stack height, used to frame cameras. */
  get height() {
    return this.dockY + 9;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.plumeMaterial.dispose();
    // The LM may have been undocked into the scene, outside this group.
    this.lander.dispose();
    this._smMaterial?.map?.dispose();
    this._smMaterial?.dispose();
  }
}
