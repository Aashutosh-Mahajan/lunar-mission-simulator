import * as THREE from "three";
import {
  buildSaturnLivery,
  buildServiceModuleLivery,
  buildTubeWallNormal,
} from "../materials/textures.js";

// ---------------------------------------------------------------------------
// Saturn V geometry, at real scale (SA-506, Apollo 11).
//
//   S-IC     42.1 m   five F-1s, four engine fairings with fins
//   S-II     24.9 m   five J-2s inside the aft interstage, eight ullage motors
//   S-IVB    17.8 m   conical aft interstage, one J-2, two APS modules
//   IU        0.9 m   instrument unit
//   SLA       8.5 m   adapter housing the LM
//   SM        3.9 m   service module (its SPS bell sits inside the SLA)
//   CM        3.2 m   under the boost protective cover
//   LES      10.2 m   tower, escape motor, pitch motor and canards
//
// Stack total 111.5 m against the real 110.6 m. Each stage is its own group
// with its origin at its base, so staging can simply detach it. Paint schemes
// come from textures.js (one livery texture per stage skin).
// ---------------------------------------------------------------------------

export const CORE_RADIUS = 10.1 / 2;
export const SIVB_RADIUS = 6.6 / 2;
const SM_RADIUS = 3.91 / 2;

// F-1: 3.76 m exit diameter, 5.8 m long. Outboard engines sit 4.35 m off the
// axis, each under its own fairing, at 45 degrees to the stage's axes.
const F1 = { throat: 0.45, exit: 1.88, length: 5.8, chamber: 1.25 };
const OUTBOARD_RADIUS = 4.35;
const OUTBOARD_ANGLES = [45, 135, 225, 315].map((d) => THREE.MathUtils.degToRad(d));

// J-2: 2.1 m exit diameter, 3.4 m long.
const J2 = { throat: 0.26, exit: 1.05, length: 3.4, chamber: 0.75 };

/** Builds the materials the stack uses. */
export function buildSaturnMaterials(assets) {
  const tubeNormal = buildTubeWallNormal(178);
  tubeNormal.repeat.set(1, 1);

  const paint = (color, map) =>
    new THREE.MeshStandardMaterial({ color, map: map ?? null, metalness: 0, roughness: 0.46 });

  return {
    livery: {
      sic: paint(0xffffff, buildSaturnLivery("sic", 42.1, CORE_RADIUS)),
      sii: paint(0xffffff, buildSaturnLivery("sii", 24.9, CORE_RADIUS)),
      sivb: paint(0xffffff, buildSaturnLivery("sivb", 13.6, SIVB_RADIUS)),
    },
    white: paint(0xf1f0eb),
    black: paint(0x1c1d20),
    // Boost protective cover over the command module: resin-impregnated
    // fibreglass, off-white and matt.
    cover: new THREE.MeshStandardMaterial({ color: 0xe4e1d8, roughness: 0.75, metalness: 0 }),
    serviceModule: new THREE.MeshStandardMaterial({
      map: buildServiceModuleLivery(3.9, SM_RADIUS),
      metalness: 0.45,
      roughness: 0.42,
    }),
    // Instrument unit and adapter: painted, lightly weathered.
    adapter: new THREE.MeshStandardMaterial({
      color: 0xdedfdc,
      roughness: 0.55,
      metalness: 0.05,
      normalMap: assets.panel.normalMap,
      normalScale: new THREE.Vector2(0.4, 0.4),
    }),
    metal: new THREE.MeshStandardMaterial({ color: 0xa9aeb3, metalness: 0.75, roughness: 0.38 }),
    // The command module's outer skin was polished aluminised Kapton tape:
    // near-mirror bright, which is why it glints in every photograph.
    commandModule: new THREE.MeshStandardMaterial({ color: 0xd8dadc, metalness: 0.92, roughness: 0.18 }),
    // Engine bells: heat-darkened Inconel tube wall.
    bell: new THREE.MeshStandardMaterial({
      color: 0x3b3834,
      metalness: 0.8,
      roughness: 0.42,
      normalMap: tubeNormal,
      normalScale: new THREE.Vector2(0.9, 0.9),
      side: THREE.DoubleSide,
    }),
    // Thermal insulation blankets over the upper engine (F-1s flew wrapped).
    blanket: new THREE.MeshStandardMaterial({
      color: 0x8c8a84,
      metalness: 0.55,
      roughness: 0.6,
      normalMap: assets.foil.normalMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
    }),
    machinery: new THREE.MeshStandardMaterial({ color: 0x4a4b4d, metalness: 0.7, roughness: 0.5 }),
    soot: new THREE.MeshStandardMaterial({ color: 0x1a1918, metalness: 0.3, roughness: 0.9 }),
    // Inside of open skirts: unpainted structure in shadow.
    interior: new THREE.MeshStandardMaterial({
      color: 0x3a3b3d,
      metalness: 0.5,
      roughness: 0.7,
      side: THREE.BackSide,
    }),
    // The launch escape tower's truss was painted a red-orange.
    escapeTower: new THREE.MeshStandardMaterial({ color: 0xa6452a, metalness: 0.25, roughness: 0.6 }),
  };
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** Lathe from a list of [radius, y] points. */
function lathe(points, material, segments = 48) {
  const geo = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  return new THREE.Mesh(geo, material);
}

/**
 * A bell nozzle: steep just past the throat, nearly parallel at the exit —
 * the contour that makes a bell a bell rather than a cone.
 */
function bellPoints(throat, exit, length, steps = 18) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = throat + (exit - throat) * (1 - Math.pow(1 - t, 2.1));
    pts.push([r, -t * length]);
  }
  return pts;
}

/**
 * One rocket engine, origin at its gimbal point at the top.
 * @param {object} spec { throat, exit, length, chamber }
 * @param {object} m materials
 * @param {boolean} f1 add the F-1's turbine exhaust manifold and blankets
 */
function buildEngine(spec, m, f1) {
  const engine = new THREE.Group();

  // Combustion chamber and injector dome above the throat.
  const chamber = lathe(
    [
      [0.001, 0.15],
      [spec.throat * 1.35, 0.1],
      [spec.throat * 1.55, -spec.chamber * 0.35],
      [spec.throat * 1.25, -spec.chamber * 0.85],
      [spec.throat, -spec.chamber],
    ],
    m.bell,
    32
  );
  engine.add(chamber);

  // The bell itself, starting at the throat.
  const bell = lathe(bellPoints(spec.throat, spec.exit, spec.length - spec.chamber), m.bell, 64);
  bell.position.y = -spec.chamber;
  engine.add(bell);

  // Turbopump and gas generator hung off the side of the chamber.
  const pump = new THREE.Mesh(
    new THREE.CylinderGeometry(spec.throat * 0.75, spec.throat * 0.75, spec.chamber * 1.1, 16),
    m.machinery
  );
  pump.position.set(spec.throat * 2.1, -spec.chamber * 0.4, 0);
  engine.add(pump);

  if (f1) {
    // Turbine exhaust manifold: the torus a third of the way down the bell
    // that fed turbine exhaust in as a cool film over the nozzle extension.
    const yManifold = -spec.chamber - (spec.length - spec.chamber) * 0.36;
    const t = 0.36;
    const rAt = spec.throat + (spec.exit - spec.throat) * (1 - Math.pow(1 - t, 2.1));
    const manifold = new THREE.Mesh(new THREE.TorusGeometry(rAt + 0.12, 0.16, 12, 48), m.machinery);
    manifold.rotation.x = Math.PI / 2;
    manifold.position.y = yManifold;
    engine.add(manifold);

    // Insulation blanket over the chamber and upper bell.
    const blanket = lathe(
      [
        [spec.throat * 1.45, 0.12],
        [spec.throat * 1.7, -spec.chamber * 0.4],
        [spec.throat * 1.45, -spec.chamber],
        [rAt * 0.88 + 0.08, yManifold + 0.2],
      ],
      m.blanket,
      32
    );
    engine.add(blanket);
  }
  return engine;
}

/** Engine fairing over an outboard F-1: a flared, tapering shroud. */
function buildFairing(m) {
  return lathe(
    [
      [2.45, -1.1],
      [2.4, -0.2],
      [2.15, 1.8],
      [1.7, 4.2],
      [1.1, 6.6],
      [0.5, 8.6],
      [0.001, 9.4],
    ],
    m.white,
    40
  );
}

/** A swept fin, extruded, in the plane containing the vehicle axis. */
function buildFin(m) {
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.0);
  shape.lineTo(3.3, -0.6);
  shape.lineTo(3.3, 1.2);
  shape.lineTo(0, 5.6);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.34,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -0.17);
  return new THREE.Mesh(geo, m.white);
}

/** Small solid motor: cylinder with a nose cone (ullage and retro rockets). */
function buildSmallMotor(radius, length, m) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), m.black);
  body.position.y = length / 2;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(radius, length * 0.35, 12), m.black);
  nose.position.y = length + length * 0.175;
  g.add(nose);
  return g;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function buildSIC(stage, m) {
  const g = new THREE.Group();
  const h = stage.length;

  const body = new THREE.Mesh(new THREE.CylinderGeometry(CORE_RADIUS, CORE_RADIUS, h, 96, 1), m.livery.sic);
  body.position.y = h / 2;
  g.add(body);

  // Heat shield across the base, sooted by the engines.
  const shield = new THREE.Mesh(new THREE.CircleGeometry(CORE_RADIUS * 0.97, 64), m.soot);
  shield.rotation.x = Math.PI / 2;
  shield.position.y = 0.02;
  g.add(shield);

  const bells = [];
  const centre = buildEngine(F1, m, true);
  centre.position.y = 0.3;
  g.add(centre);
  bells.push(centre);

  for (const a of OUTBOARD_ANGLES) {
    const x = Math.cos(a) * OUTBOARD_RADIUS;
    const z = Math.sin(a) * OUTBOARD_RADIUS;

    const engine = buildEngine(F1, m, true);
    engine.position.set(x, 0.3, z);
    g.add(engine);
    bells.push(engine);

    const fairing = buildFairing(m);
    fairing.position.set(x, 0, z);
    g.add(fairing);

    // The fin rides on the outside of its fairing, in the radial plane.
    const fin = buildFin(m);
    fin.rotation.y = -a;
    fin.position.set(Math.cos(a) * (OUTBOARD_RADIUS + 1.35), 0, Math.sin(a) * (OUTBOARD_RADIUS + 1.35));
    g.add(fin);
  }

  return { group: g, bells, gimballed: bells.slice(1), nozzleExit: 0.3 - F1.length };
}

function buildSII(stage, m) {
  const g = new THREE.Group();
  const h = stage.length;

  // Open at the bottom: after staging, the J-2s are visible up inside the
  // interstage skirt. The inside is lined so it does not read as see-through.
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(CORE_RADIUS, CORE_RADIUS, h, 96, 1, true),
    m.livery.sii
  );
  body.position.y = h / 2;
  g.add(body);
  const lining = new THREE.Mesh(
    new THREE.CylinderGeometry(CORE_RADIUS - 0.02, CORE_RADIUS - 0.02, 5.6, 64, 1, true),
    m.interior
  );
  lining.position.y = 2.8;
  g.add(lining);
  const lid = new THREE.Mesh(new THREE.CircleGeometry(CORE_RADIUS, 64), m.white);
  lid.rotation.x = -Math.PI / 2;
  lid.position.y = h;
  g.add(lid);

  // Eight ullage motors round the aft interstage, which settled the S-II's
  // propellant before its engines lit.
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * Math.PI * 2;
    const motor = buildSmallMotor(0.26, 2.3, m);
    motor.position.set(Math.cos(a) * (CORE_RADIUS + 0.2), 0.8, Math.sin(a) * (CORE_RADIUS + 0.2));
    g.add(motor);
  }

  // Five J-2s hang inside the interstage skirt from the thrust structure.
  const mount = 5.6;
  const positions = [[0, 0], ...OUTBOARD_ANGLES.map((a) => [Math.cos(a) * 2.75, Math.sin(a) * 2.75])];
  for (const [x, z] of positions) {
    const engine = buildEngine(J2, m, false);
    engine.position.set(x, mount, z);
    g.add(engine);
  }
  const bulkhead = new THREE.Mesh(new THREE.CircleGeometry(CORE_RADIUS * 0.98, 64), m.soot);
  bulkhead.rotation.x = Math.PI / 2;
  bulkhead.position.y = mount + 0.05;
  g.add(bulkhead);

  return { group: g, nozzleExit: mount - J2.length };
}

function buildSIVB(stage, m) {
  const g = new THREE.Group();
  const coneH = 4.2;
  const skinH = stage.length - coneH;

  // Conical aft interstage from the 10.1 m core down to the 6.6 m stage.
  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(SIVB_RADIUS, CORE_RADIUS, coneH, 96, 1, true),
    m.white
  );
  cone.position.y = coneH / 2;
  g.add(cone);
  const coneLining = new THREE.Mesh(
    new THREE.CylinderGeometry(SIVB_RADIUS - 0.02, CORE_RADIUS - 0.02, coneH, 64, 1, true),
    m.interior
  );
  coneLining.position.y = coneH / 2;
  g.add(coneLining);
  // Retro-rockets that backed the spent S-II away at separation.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const motor = buildSmallMotor(0.2, 1.9, m);
    const r = CORE_RADIUS - 0.55;
    motor.position.set(Math.cos(a) * r, 0.5, Math.sin(a) * r);
    // Lying on the cone, which narrows upward: top tipped toward the axis.
    motor.rotation.set(-Math.sin(a) * 0.39, 0, Math.cos(a) * 0.39);
    g.add(motor);
  }

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(SIVB_RADIUS, SIVB_RADIUS, skinH, 80, 1),
    m.livery.sivb
  );
  body.position.y = coneH + skinH / 2;
  g.add(body);

  // Auxiliary propulsion system modules, 180 degrees apart on the aft skirt.
  for (const a of [0, Math.PI]) {
    const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 1.6, 6, 16), m.black);
    pod.scale.set(1, 1, 0.7);
    pod.position.set(Math.cos(a) * (SIVB_RADIUS + 0.35), coneH + 1.6, Math.sin(a) * (SIVB_RADIUS + 0.35));
    g.add(pod);
  }

  const j2 = buildEngine(J2, m, false);
  j2.position.y = coneH;
  g.add(j2);

  // ---- Payload stack ----------------------------------------------------
  let y = stage.length;

  const iu = new THREE.Mesh(new THREE.CylinderGeometry(SIVB_RADIUS + 0.01, SIVB_RADIUS + 0.01, 0.91, 80), m.adapter);
  iu.position.y = y + 0.455;
  g.add(iu);
  y += 0.91;

  // Spacecraft-LM adapter: four petals, faint seams.
  const sla = new THREE.Mesh(new THREE.CylinderGeometry(SM_RADIUS, SIVB_RADIUS, 8.5, 64, 1), m.adapter);
  sla.position.y = y + 4.25;
  g.add(sla);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.06, 8.52, 0.06), m.soot);
    const rMid = (SM_RADIUS + SIVB_RADIUS) / 2 + 0.01;
    seam.position.set(Math.cos(a) * rMid, y + 4.25, Math.sin(a) * rMid);
    seam.rotation.set(-Math.sin(a) * 0.157, 0, Math.cos(a) * 0.157);
    g.add(seam);
  }
  y += 8.5;

  const sm = new THREE.Mesh(new THREE.CylinderGeometry(SM_RADIUS, SM_RADIUS, 3.9, 64), m.serviceModule);
  sm.position.y = y + 1.95;
  g.add(sm);
  // RCS quads, four round the service module.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const quad = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.5), m.metal);
    quad.position.set(Math.cos(a) * (SM_RADIUS + 0.2), y + 3.1, Math.sin(a) * (SM_RADIUS + 0.2));
    quad.rotation.y = -a;
    g.add(quad);
  }
  y += 3.9;

  // Command module: polished aluminised skin over the heat shield. During
  // ascent it sits under the boost protective cover, which is attached to the
  // escape tower and leaves with it — so the cover is part of the escape
  // system, and the command module underneath appears when the tower goes.
  const cm = lathe(
    [
      [SM_RADIUS - 0.02, 0],
      [SM_RADIUS - 0.1, 0.2],
      [0.5, 3.0],
      [0.4, 3.12],
      [0.001, 3.14],
    ],
    m.commandModule,
    64
  );
  cm.position.y = y;
  g.add(cm);

  const escape = buildEscapeSystem(m);
  escape.position.y = y + 3.2;
  const cover = lathe(
    [
      [SM_RADIUS + 0.03, 0],
      [SM_RADIUS - 0.05, 0.25],
      [0.55, 3.0],
      [0.42, 3.2],
      [0.001, 3.22],
    ],
    m.cover,
    64
  );
  cover.position.y = -3.2;
  escape.add(cover);
  g.add(escape);
  y += 3.2;

  return { group: g, nozzleExit: coneH - J2.length, escape, top: y + 10.2 };
}

/** Launch escape system: truss tower, escape motor, pitch motor, canards. */
function buildEscapeSystem(m) {
  const les = new THREE.Group();
  const towerH = 3.0;
  const bottom = 0.62;
  const top = 0.3;
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const strut = (a, b, radius = 0.045) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6), m.escapeTower);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    les.add(mesh);
  };
  const at = (c, t) => {
    const s = bottom + (top - bottom) * t;
    return new THREE.Vector3(c[0] * s, t * towerH, c[1] * s);
  };
  // Four legs with X-bracing in three bays.
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    const n = corners[(i + 1) % 4];
    strut(at(c, 0), at(c, 1), 0.06);
    for (let bay = 0; bay < 3; bay++) {
      const t0 = bay / 3;
      const t1 = (bay + 1) / 3;
      strut(at(c, t0), at(n, t1));
      strut(at(n, t0), at(c, t1));
      strut(at(c, t1), at(n, t1), 0.035);
    }
  }

  let y = towerH;
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 4.7, 32), m.white);
  motor.position.y = y + 2.35;
  les.add(motor);
  // Four canted escape nozzles at the motor's base.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.4, 12, 1, true), m.machinery);
    nozzle.position.set(Math.cos(a) * 0.3, y + 0.15, Math.sin(a) * 0.3);
    // Canted outward: exits point away from the tower below.
    nozzle.rotation.set(-Math.sin(a) * 0.6, 0, Math.cos(a) * 0.6);
    les.add(nozzle);
  }
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.5, 32), m.black);
  band.position.y = y + 3.9;
  les.add(band);
  y += 4.7;

  // Pitch control motor and ballast, then the nose with its canards.
  const nose = lathe([[0.33, 0], [0.3, 0.9], [0.18, 2.1], [0.05, 2.45], [0.001, 2.5]], m.black, 32);
  nose.position.y = y;
  les.add(nose);
  for (const s of [1, -1]) {
    const canard = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.9, 0.55), m.escapeTower);
    canard.position.set(s * 0.36, y + 0.7, 0);
    les.add(canard);
  }
  return les;
}

/**
 * Builds the three stage groups, bottom to top.
 * @returns {{ stages: object[], bells: THREE.Object3D[], gimballed: THREE.Object3D[], escape: THREE.Group, totalHeight: number }}
 */
export function buildSaturnV(mission, materials) {
  const [sic, sii, sivb] = mission.stages;
  const first = buildSIC(sic, materials);
  const second = buildSII(sii, materials);
  const third = buildSIVB(sivb, materials);

  second.group.position.y = sic.length;
  third.group.position.y = sic.length + sii.length;

  return {
    stages: [
      { group: first.group, height: sic.length, config: sic, nozzleExit: first.nozzleExit },
      { group: second.group, height: sii.length, config: sii, nozzleExit: second.nozzleExit },
      { group: third.group, height: sivb.length, config: sivb, nozzleExit: third.nozzleExit },
    ],
    bells: first.bells,
    gimballed: first.gimballed,
    escape: third.escape,
    totalHeight: sic.length + sii.length + third.top,
  };
}
