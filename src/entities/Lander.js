import * as THREE from "three";
import * as CANNON from "cannon-es";
import { LANDER_DRY_MASS } from "../constants.js";

// ---------------------------------------------------------------------------
// The lander: an Apollo Lunar Module built from primitives at real scale
// (9.4 m landing-gear span, 7 m overall height, 4.2 m octagonal descent
// stage), plus the collision body used by cannon-es.
//
// Collision uses one sphere per footpad plus a body sphere, so touchdown can
// be evaluated per-leg — the same information the real LM's contact probes
// gave the crew.
// ---------------------------------------------------------------------------

const GEAR_SPAN = 9.4;
const GEAR_RADIUS = GEAR_SPAN / 2;
const FOOTPAD_RADIUS = 0.47;
const DESCENT_RADIUS = 2.1;
const DESCENT_HEIGHT = 1.68;
const LEG_ATTACH_Y = 0.35;
// Footpads sit ~3.25 m below the descent-stage deck, matching the real LM's
// stance. The engine bell's exit plane ends just *above* this line — on the
// real vehicle the bell nearly touched the surface at touchdown (it did on
// Apollo 15), but the pads always took the load.
const FOOTPAD_Y = -2.9;
// Distance from the vehicle's origin down to the footpad contact plane —
// this is what the radar altimeter reads against, so it is measured from the
// origin, not from the leg attachment point.
const GEAR_HEIGHT = -FOOTPAD_Y;
const BODY_SPHERE_RADIUS = 1.8;
const FOOT_COLLIDER_RADIUS = FOOTPAD_RADIUS * 0.9;

// Leg azimuths: the LM's gear sat at 45 degrees to the vehicle axes, with the
// forward leg (carrying the ladder) toward +Z in our body frame.
const LEG_ANGLES = [45, 135, 225, 315];

export default class Lander {
  /**
   * @param {THREE.Scene} scene
   * @param {CANNON.World|null} world — pass null for a display-only vehicle
   *   (Phase 3 shows the LM docked to the CSM, where nothing collides).
   * @param {object} assets
   */
  constructor(scene, world, assets) {
    this.scene = scene;
    this.world = world;
    this.assets = assets;

    this.state = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      // Body-frame angular velocity, rad/s (x = pitch, y = yaw, z = roll).
      angularVelocity: new THREE.Vector3(),
      throttle: 0,
      commandedThrottle: 0,
      fuel: 0,
      fuelCapacity: 0,
      rcsFuel: 0,
      mass: LANDER_DRY_MASS,
      engineOn: false,
      rcsFiring: new THREE.Vector3(),
      stabiliser: true,
      contactProbe: false,
      legsDown: [false, false, false, false],
      landed: false,
      crashed: false,
    };

    this._up = new THREE.Vector3();
    this._buildModel();
    if (world) this._buildBody();
  }

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------

  _buildModel() {
    const a = this.assets;
    this.group = new THREE.Group();
    this.group.name = "lander";

    this.descentStage = new THREE.Group();
    this.ascentStage = new THREE.Group();
    this.group.add(this.descentStage, this.ascentStage);

    this._buildDescentStage();
    this._buildLandingGear();
    this._buildAscentStage();
    this._buildThrusterVisuals();

    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    void a;
    this.scene.add(this.group);
  }

  _buildDescentStage() {
    const a = this.assets;
    const g = this.descentStage;

    // Octagonal core wrapped in amber multi-layer insulation.
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(DESCENT_RADIUS, DESCENT_RADIUS, DESCENT_HEIGHT, 8, 1),
      a.foilMaterial
    );
    core.position.y = -DESCENT_HEIGHT / 2 + LEG_ATTACH_Y;
    g.add(core);

    // The four propellant/oxidiser bays that fill the octagon's corners are
    // blanketed in darker, sootier insulation than the main body.
    for (let i = 0; i < 4; i++) {
      const ang = THREE.MathUtils.degToRad(45 + i * 90);
      const bay = new THREE.Mesh(
        new THREE.BoxGeometry(1.62, DESCENT_HEIGHT * 0.94, 1.62),
        a.foilDarkMaterial
      );
      bay.position.set(
        Math.cos(ang) * 1.28,
        -DESCENT_HEIGHT / 2 + LEG_ATTACH_Y,
        Math.sin(ang) * 1.28
      );
      bay.rotation.y = -ang;
      g.add(bay);
    }

    // Upper and lower deck rings (structural, bare metal).
    for (const y of [LEG_ATTACH_Y + 0.02, LEG_ATTACH_Y - DESCENT_HEIGHT - 0.02]) {
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(DESCENT_RADIUS * 1.02, DESCENT_RADIUS * 1.02, 0.12, 8),
        a.metalMaterial
      );
      ring.position.y = y;
      g.add(ring);
    }

    // --- Descent engine ------------------------------------------------
    const engineGroup = new THREE.Group();
    engineGroup.position.y = LEG_ATTACH_Y - DESCENT_HEIGHT;
    g.add(engineGroup);

    // Throat/combustion chamber housing.
    const chamber = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.34, 0.5, 20),
      a.engineMaterial
    );
    chamber.position.y = -0.2;
    engineGroup.add(chamber);

    // Bell nozzle — a real bell contour, widening with a slight curve.
    const bellProfile = [];
    const bellSteps = 14;
    const bellLength = 0.95;
    for (let i = 0; i <= bellSteps; i++) {
      const t = i / bellSteps;
      // Radius follows a bell curve from throat 0.34 m to exit 0.83 m.
      const r = 0.34 + Math.pow(t, 0.62) * 0.49;
      bellProfile.push(new THREE.Vector2(r, -t * bellLength));
    }
    const bellGeo = new THREE.LatheGeometry(bellProfile, 28);
    const bell = new THREE.Mesh(bellGeo, a.engineMaterial);
    bell.position.y = -0.45;
    bell.material.side = THREE.DoubleSide;
    engineGroup.add(bell);
    this.engineBell = bell;
    this.engineExitY = LEG_ATTACH_Y - DESCENT_HEIGHT - 0.45 - bellLength;

    // Inner nozzle wall glows when the engine is running.
    const glowGeo = new THREE.LatheGeometry(
      bellProfile.map((p) => new THREE.Vector2(p.x * 0.94, p.y)),
      24
    );
    this.engineGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff7a2a,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(glowGeo, this.engineGlowMaterial);
    glow.position.y = -0.45;
    engineGroup.add(glow);

    // The descent engine was gimballed to keep thrust through the centre of
    // mass as propellant drained. Swinging it with the attitude command makes
    // the vehicle look like it is steering itself rather than being turned.
    this.engineGimbal = engineGroup;

    // Point light so the plume actually lights the ground on final approach.
    this.engineLight = new THREE.PointLight(0xffa451, 0, 90, 2);
    this.engineLight.position.set(0, this.engineExitY - 0.5, 0);
    this.group.add(this.engineLight);
  }

  _buildLandingGear() {
    const a = this.assets;
    this.legs = [];

    for (let i = 0; i < 4; i++) {
      const ang = THREE.MathUtils.degToRad(LEG_ANGLES[i]);
      const dirX = Math.cos(ang);
      const dirZ = Math.sin(ang);

      const legGroup = new THREE.Group();
      legGroup.name = `leg${i}`;
      this.group.add(legGroup);

      const attach = new THREE.Vector3(dirX * DESCENT_RADIUS * 0.82, LEG_ATTACH_Y, dirZ * DESCENT_RADIUS * 0.82);
      const foot = new THREE.Vector3(dirX * GEAR_RADIUS, FOOTPAD_Y, dirZ * GEAR_RADIUS);

      // Primary strut (the shock-absorbing cylinder). On the real LM these
      // were wrapped in the same gold Kapton as the descent stage.
      const primary = this._strut(attach, foot, 0.115, a.foilMaterial);
      legGroup.add(primary);

      // Secondary struts brace the primary back to the descent stage.
      const braceTop = new THREE.Vector3(dirX * DESCENT_RADIUS * 0.55, LEG_ATTACH_Y - DESCENT_HEIGHT * 0.86, dirZ * DESCENT_RADIUS * 0.55);
      const braceMid = foot.clone().lerp(attach, 0.34);
      legGroup.add(this._strut(braceTop, braceMid, 0.062, a.metalMaterial));

      // Deployment truss (the diagonal down-lock strut).
      const trussTop = new THREE.Vector3(dirX * DESCENT_RADIUS * 0.95, LEG_ATTACH_Y - 0.12, dirZ * DESCENT_RADIUS * 0.95);
      legGroup.add(this._strut(trussTop, braceMid, 0.05, a.metalMaterial));

      // Footpad — a shallow dish, wide to spread load on soft regolith.
      const padGroup = new THREE.Group();
      padGroup.position.copy(foot);
      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(FOOTPAD_RADIUS, FOOTPAD_RADIUS * 0.72, 0.17, 20),
        a.footpadMaterial
      );
      padGroup.add(pad);
      const dish = new THREE.Mesh(
        new THREE.SphereGeometry(FOOTPAD_RADIUS * 0.98, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        a.footpadMaterial
      );
      dish.rotation.x = Math.PI;
      dish.position.y = 0.08;
      dish.scale.y = 0.42;
      padGroup.add(dish);
      legGroup.add(padGroup);

      // Lunar surface sensing probe: a 1.7 m wire that tripped the CONTACT
      // light, telling the crew to shut the engine down.
      let probe = null;
      if (i !== 0) {
        // The forward leg had its probe removed after Apollo 11 (crew feared
        // it would foul the ladder), so leg 0 goes without.
        probe = new THREE.Mesh(
          new THREE.CylinderGeometry(0.028, 0.028, 1.7, 6),
          a.probeMaterial
        );
        probe.position.copy(foot).add(new THREE.Vector3(dirX * 0.1, -0.85, dirZ * 0.1));
        legGroup.add(probe);
      }

      this.legs.push({ group: legGroup, foot: foot.clone(), padGroup, probe, dir: new THREE.Vector3(dirX, 0, dirZ) });
    }

    // Egress ladder on the forward leg.
    const ladder = new THREE.Group();
    const legDir = this.legs[0].dir;
    const railMat = this.assets.metalMaterial;
    for (const side of [-0.18, 0.18]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 2.0, 6), railMat);
      rail.position.set(legDir.x * 3.5 + -legDir.z * side, -0.85, legDir.z * 3.5 + legDir.x * side);
      rail.rotation.z = 0.12;
      ladder.add(rail);
    }
    for (let r = 0; r < 8; r++) {
      const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.36, 6), railMat);
      rung.rotation.x = Math.PI / 2;
      rung.rotation.y = Math.atan2(legDir.x, legDir.z);
      rung.position.set(legDir.x * 3.5, -1.75 + r * 0.25, legDir.z * 3.5);
      ladder.add(rung);
    }
    this.group.add(ladder);
  }

  /** Builds a cylinder spanning two points (used for every strut). */
  _strut(from, to, radius, material) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), material);
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  }

  _buildAscentStage() {
    const a = this.assets;
    const g = this.ascentStage;
    g.position.y = LEG_ATTACH_Y + 0.06;

    // Crew compartment: a squat cylinder with the LM's characteristic canted
    // front face carrying the two triangular windows.
    // Faceted, not round: the ascent stage was built from flat skin panels,
    // and smooth-shaded it read as a turned metal can.
    const cabinGeo = new THREE.CylinderGeometry(1.47, 1.47, 1.68, 10).toNonIndexed();
    cabinGeo.computeVertexNormals();
    const cabin = new THREE.Mesh(cabinGeo, a.panelMaterial);
    cabin.position.y = 0.84;
    g.add(cabin);

    // Aft equipment bay — boxier, wrapped in blanket.
    const aft = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.5, 1.9), a.foilDarkMaterial);
    aft.position.set(0, 0.9, -1.5);
    g.add(aft);

    // Canted forward face.
    const face = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.25, 0.14), a.panelMaterial);
    face.position.set(0, 1.05, 1.32);
    face.rotation.x = THREE.MathUtils.degToRad(-16);
    g.add(face);

    // Two forward-and-down canted triangular windows.
    const winShape = new THREE.Shape();
    winShape.moveTo(-0.34, -0.22);
    winShape.lineTo(0.34, -0.3);
    winShape.lineTo(0.26, 0.26);
    winShape.closePath();
    const winGeo = new THREE.ShapeGeometry(winShape);
    for (const side of [-1, 1]) {
      const win = new THREE.Mesh(winGeo, a.glassMaterial);
      win.position.set(side * 0.52, 1.12, 1.42);
      win.rotation.x = THREE.MathUtils.degToRad(-16);
      win.scale.x = side;
      g.add(win);
    }

    // Forward hatch (square, below the windows).
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.82, 0.1), a.metalMaterial);
    hatch.position.set(0, 0.42, 1.44);
    g.add(hatch);

    // Docking tunnel and drogue on top.
    const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.72, 20), a.metalMaterial);
    tunnel.position.y = 2.0;
    g.add(tunnel);
    const drogue = new THREE.Mesh(new THREE.ConeGeometry(0.48, 0.34, 20, 1, true), a.engineMaterial);
    drogue.position.y = 2.4;
    drogue.material.side = THREE.DoubleSide;
    g.add(drogue);

    // Ascent engine cover (the "dog house" over the ascent motor).
    const cover = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 14), a.foilMaterial);
    cover.position.set(0, 0.3, -0.2);
    g.add(cover);

    // --- RCS thruster quads -------------------------------------------
    this.rcsQuads = [];
    for (let i = 0; i < 4; i++) {
      const ang = THREE.MathUtils.degToRad(45 + i * 90);
      const quad = new THREE.Group();
      quad.position.set(Math.cos(ang) * 1.98, 1.42, Math.sin(ang) * 1.98);
      quad.rotation.y = -ang;

      const mount = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), a.metalMaterial);
      quad.add(mount);

      // Each quad carries four nozzles pointing along different axes.
      const nozzleDirs = [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(1, 0, 0.35),
        new THREE.Vector3(-0.2, 0, 1),
      ];
      for (const dir of nozzleDirs) {
        const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.088, 0.2, 10, 1, true), a.engineMaterial);
        nozzle.material.side = THREE.DoubleSide;
        nozzle.position.copy(dir).multiplyScalar(0.3);
        nozzle.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
        quad.add(nozzle);
      }
      g.add(quad);
      this.rcsQuads.push(quad);
    }

    // Steerable S-band antenna.
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6), a.metalMaterial);
    boom.position.set(1.5, 2.05, -0.5);
    boom.rotation.z = THREE.MathUtils.degToRad(-42);
    g.add(boom);
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(0.46, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.4),
      a.dishMaterial
    );
    dish.position.set(2.0, 2.42, -0.5);
    dish.rotation.set(THREE.MathUtils.degToRad(140), 0, THREE.MathUtils.degToRad(28));
    dish.material.side = THREE.DoubleSide;
    g.add(dish);

    // Rendezvous radar antenna.
    const radar = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.2),
      a.dishMaterial
    );
    radar.position.set(0, 2.32, 0.66);
    radar.rotation.x = THREE.MathUtils.degToRad(-150);
    radar.material.side = THREE.DoubleSide;
    g.add(radar);

    // VHF whip antennas.
    for (const side of [-1, 1]) {
      const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.012, 1.3, 5), a.metalMaterial);
      whip.position.set(side * 1.1, 2.45, -0.9);
      whip.rotation.z = side * THREE.MathUtils.degToRad(22);
      g.add(whip);
    }

    // Handrails around the cabin.
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const rail = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 6, 10, Math.PI), a.metalMaterial);
      rail.position.set(Math.cos(ang) * 1.5, 1.7, Math.sin(ang) * 1.5);
      rail.rotation.set(Math.PI / 2, 0, -ang);
      g.add(rail);
    }

    // Docking/tracking light so the vehicle reads against black sky. Kept
    // dim: with bloom enabled a bright emissive at this scale swamps the
    // whole vehicle.
    const beaconMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x66ccff,
      emissiveIntensity: 1.2,
      roughness: 0.4,
    });
    this.trackingLight = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), beaconMat);
    this.trackingLight.position.set(0, 2.5, 1.0);
    this.trackingLightMaterial = beaconMat;
    g.add(this.trackingLight);
  }

  /** Additive cones that flash when a given RCS axis is commanded. */
  _buildThrusterVisuals() {
    this.rcsJets = [];
    const jetMat = new THREE.MeshBasicMaterial({
      color: 0xbfe4ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    for (let i = 0; i < 4; i++) {
      const ang = THREE.MathUtils.degToRad(45 + i * 90);
      // One representative up-jet and down-jet per quad.
      for (const sign of [1, -1]) {
        const mat = jetMat.clone();
        const jet = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.85, 10, 1, true), mat);
        jet.material.side = THREE.DoubleSide;
        jet.position.set(
          Math.cos(ang) * 1.98,
          LEG_ATTACH_Y + 1.48 + sign * 0.62,
          Math.sin(ang) * 1.98
        );
        jet.rotation.x = sign > 0 ? Math.PI : 0;
        this.group.add(jet);
        this.rcsJets.push({ mesh: jet, material: mat, quad: i, sign });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Collision body
  // -------------------------------------------------------------------------

  _buildBody() {
    // DYNAMIC with mass 0: cannon-es skips narrowphase contact generation
    // (and therefore 'collide' events) for KINEMATIC-vs-STATIC pairs, so the
    // lander must be DYNAMIC. Mass 0 gives it infinite inertia, so the solver
    // can never move it — position and attitude come solely from our own
    // integration in physics/landerPhysics.js.
    this.body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.DYNAMIC,
      material: this.assets.landerPhysMaterial,
    });
    this.body.allowSleep = false;

    this.footShapes = [];
    for (const leg of this.legs) {
      const shape = new CANNON.Sphere(FOOT_COLLIDER_RADIUS);
      // Sphere centre is lifted by its own radius so the sphere's *bottom*
      // sits on the footpad's contact plane. Without this the vehicle comes
      // to rest floating one radius above the surface.
      this.body.addShape(
        shape,
        new CANNON.Vec3(leg.foot.x, leg.foot.y + FOOT_COLLIDER_RADIUS, leg.foot.z)
      );
      this.footShapes.push(shape);
    }
    // Hull sphere: catches the descent stage striking terrain or a boulder.
    // Kept well above the footpad plane so a normal landing never trips it.
    this.hullShape = new CANNON.Sphere(BODY_SPHERE_RADIUS);
    this.body.addShape(this.hullShape, new CANNON.Vec3(0, LEG_ATTACH_Y - 0.15, 0));

    this.body.userData = { kind: "lander" };
    this.body.addEventListener("collide", (event) => this._onCollide(event));
    this.world.addBody(this.body);
  }

  _onCollide(event) {
    if (!this.onCollide) return;
    // Work out which of our shapes was involved so callers can tell a
    // footpad touchdown from the hull striking rock.
    const contact = event.contact;
    const mine = contact.bi === this.body ? contact.si : contact.sj;
    const legIndex = this.footShapes.indexOf(mine);
    this.onCollide({
      other: event.body,
      legIndex,
      isHull: mine === this.hullShape,
      contact,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  reset(config, terrain) {
    const s = this.state;
    const start = config.start;
    const groundY = terrain.heightAt(start.x, start.z);

    s.position.set(start.x, groundY + start.altitude, start.z);
    s.velocity.set(start.vx ?? 0, start.vy ?? 0, start.vz ?? 0);
    s.quaternion.identity();
    if (start.headingDeg) {
      s.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(start.headingDeg)
      );
    }
    if (start.pitchDeg) {
      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        THREE.MathUtils.degToRad(start.pitchDeg)
      );
      s.quaternion.multiply(q);
    }
    s.angularVelocity.set(0, 0, 0);
    s.throttle = 0;
    s.commandedThrottle = 0;
    s.fuel = config.fuel.descent;
    s.fuelCapacity = config.fuel.descent;
    s.rcsFuel = config.fuel.rcs;
    s.rcsFuelCapacity = config.fuel.rcs;
    s.mass = LANDER_DRY_MASS + s.fuel;
    s.engineOn = false;
    s.rcsFiring.set(0, 0, 0);
    s.stabiliser = true;
    s.contactProbe = false;
    s.legsDown = [false, false, false, false];
    s.landed = false;
    s.crashed = false;

    this.legCompression = [0, 0, 0, 0];
    this._wreck = null;
    this.syncTransform();
  }

  /** Pushes physics state onto the render model and the collision body. */
  syncTransform() {
    const s = this.state;
    this.group.position.copy(s.position);
    this.group.quaternion.copy(s.quaternion);

    if (!this.body) return; // display-only vehicle (Phase 3)
    this.body.position.set(s.position.x, s.position.y, s.position.z);
    this.body.quaternion.set(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w);
    this.body.velocity.set(s.velocity.x, s.velocity.y, s.velocity.z);
  }

  /** World-space direction the engine thrusts along (the vehicle's +Y). */
  upVector(target = this._up) {
    return target.set(0, 1, 0).applyQuaternion(this.state.quaternion);
  }

  /** Tilt away from local vertical, in degrees. */
  tiltDegrees() {
    const up = this.upVector();
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(up.y, -1, 1)));
  }

  /** World position of the engine nozzle exit — where the plume originates. */
  enginePosition(target = new THREE.Vector3()) {
    return target
      .set(0, this.engineExitY, 0)
      .applyQuaternion(this.state.quaternion)
      .add(this.state.position);
  }

  /**
   * Starts the post-crash topple. A wrecked vehicle should not stand
   * politely upright on its gear — it pitches over onto the surface and
   * stops there.
   */
  startWreck(impactDirection) {
    // Topple about a horizontal axis perpendicular to the impact direction.
    const axis = new THREE.Vector3(
      -(impactDirection?.z ?? 0) + (Math.random() - 0.5) * 0.6,
      0,
      (impactDirection?.x ?? 0) + (Math.random() - 0.5) * 0.6
    );
    if (axis.lengthSq() < 1e-4) axis.set(1, 0, Math.random() - 0.5);
    axis.normalize();

    this._wreck = {
      axis,
      rate: THREE.MathUtils.degToRad(55 + Math.random() * 65),
      // Settles somewhere past the point where the gear could recover.
      limit: THREE.MathUtils.degToRad(62 + Math.random() * 34),
      turned: 0,
      sinkRate: 0.35,
    };
  }

  /** Advances the topple; returns true while the wreck is still moving. */
  updateWreck(dt, terrain) {
    const w = this._wreck;
    if (!w) return false;

    const step = Math.min(w.rate * dt, w.limit - w.turned);
    if (step <= 0.0001) {
      this._wreck = null;
      return false;
    }
    w.turned += step;
    // Rotation decelerates as the structure digs into the regolith.
    w.rate *= Math.exp(-1.6 * dt);

    const q = new THREE.Quaternion().setFromAxisAngle(w.axis, step);
    this.state.quaternion.premultiply(q).normalize();

    // Settle the hull down as the gear collapses under it.
    if (terrain) {
      const ground = terrain.surfaceHeightAt(this.state.position.x, this.state.position.z);
      const target = ground + 1.1;
      if (this.state.position.y > target) {
        this.state.position.y = Math.max(target, this.state.position.y - w.sinkRate * dt * 3);
      }
    }

    this.syncTransform();
    return true;
  }

  /** World position of a given footpad. */
  footPosition(index, target = new THREE.Vector3()) {
    return target
      .copy(this.legs[index].foot)
      .applyQuaternion(this.state.quaternion)
      .add(this.state.position);
  }

  /**
   * Per-frame visual response to the current control state: nozzle glow,
   * engine light, RCS jet flashes and landing-gear compression.
   */
  updateVisuals(dt, elapsed) {
    const s = this.state;

    // Engine bell glow and light scale with throttle, with a little flicker
    // from combustion roughness.
    const flicker = 0.9 + Math.sin(elapsed * 51) * 0.06 + Math.sin(elapsed * 113) * 0.04;
    const t = s.engineOn ? s.throttle * flicker : 0;
    this.engineGlowMaterial.opacity = THREE.MathUtils.lerp(
      this.engineGlowMaterial.opacity,
      t * 0.95,
      1 - Math.exp(-14 * dt)
    );
    this.engineLight.intensity = THREE.MathUtils.lerp(
      this.engineLight.intensity,
      t * 1400,
      1 - Math.exp(-12 * dt)
    );
    this.engineLight.distance = 60 + t * 70;

    // RCS jets flash on the side that produces the commanded torque.
    for (const jet of this.rcsJets) {
      const cmd = s.rcsFiring;
      // Quad layout: 0:+x+z, 1:-x+z, 2:-x-z, 3:+x-z (45 deg offsets).
      const ang = THREE.MathUtils.degToRad(45 + jet.quad * 90);
      const qx = Math.cos(ang);
      const qz = Math.sin(ang);
      // Pitch torque (about x) needs opposite vertical jets fore and aft;
      // roll (about z) needs them left and right; yaw uses lateral nozzles.
      let demand = 0;
      demand += -cmd.x * qz * jet.sign;
      demand += cmd.z * qx * jet.sign;
      demand += Math.abs(cmd.y) * 0.35;
      demand = THREE.MathUtils.clamp(demand, 0, 1);
      const target = demand * (0.55 + Math.random() * 0.45);
      jet.material.opacity = THREE.MathUtils.lerp(jet.material.opacity, target, 1 - Math.exp(-22 * dt));
      jet.mesh.scale.setScalar(0.7 + jet.material.opacity * 0.6);
    }

    // Descent engine gimbal, following the attitude command. Small travel —
    // the real one had about 6 degrees — but enough to read as deliberate.
    const gimbalTarget = THREE.MathUtils.degToRad(6);
    this._gimbalX = THREE.MathUtils.lerp(
      this._gimbalX ?? 0,
      THREE.MathUtils.clamp(s.rcsFiring.x, -1, 1) * gimbalTarget,
      1 - Math.exp(-8 * dt)
    );
    this._gimbalZ = THREE.MathUtils.lerp(
      this._gimbalZ ?? 0,
      THREE.MathUtils.clamp(s.rcsFiring.z, -1, 1) * gimbalTarget,
      1 - Math.exp(-8 * dt)
    );
    if (this.engineGimbal) {
      this.engineGimbal.rotation.x = this._gimbalX;
      this.engineGimbal.rotation.z = this._gimbalZ;
    }

    // Tracking light strobes.
    this.trackingLightMaterial.emissiveIntensity = (elapsed % 1.2) < 0.12 ? 3.2 : 0.5;

    // Landing gear compresses as each footpad takes load.
    for (let i = 0; i < 4; i++) {
      const target = s.legsDown[i] ? 1 : 0;
      this.legCompression[i] = THREE.MathUtils.lerp(
        this.legCompression[i],
        target,
        1 - Math.exp(-9 * dt)
      );
      // Primary struts stroke ~0.8 m; show a fraction of that.
      this.legs[i].padGroup.position.y = this.legs[i].foot.y + this.legCompression[i] * 0.16;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    if (this.body) this.world.removeBody(this.body);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
}

export { GEAR_RADIUS, FOOTPAD_RADIUS, LEG_ANGLES, GEAR_HEIGHT };
