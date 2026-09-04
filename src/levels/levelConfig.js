// ---------------------------------------------------------------------------
// Level definitions (Phase 1, lander core).
//
// Per the project conventions, tuning or adding a level should only require
// editing this file. Terrain.js, landerPhysics.js and levelLoader.js read
// these fields generically and never branch on `id`.
//
// Landing limits are anchored to the real Apollo LM design case: 3.0 m/s
// vertical (10 ft/s), 1.2 m/s horizontal (4 ft/s), and roughly 12 degrees of
// tilt before the gear's stability margin is gone. Early levels are looser
// than the real thing; the late ones are not.
//
// Field reference
//   terrain.size/divisions  extent (m) and grid resolution of the height field
//   terrain.baseScale       wavelength of the broad undulation (m)
//   terrain.*Roughness      amplitude (m) of broad / ridged / fine detail
//   terrain.crater*         count and diameter range (m) of geometry craters
//   terrain.boulder*        count, size range, and the size above which a
//                           boulder becomes a real collision hazard
//   terrain.rille           null, or a sinuous collapsed lava channel
//   pad.plateau             null, or raises the pad into a mesa
//   pad.moving              null, or a rail-traversing mobile pad
//   fuel.descent/rcs        propellant load, kg (separate pools)
//   mascons                 local gravity anomalies (Gaussian bumps in g)
//   vents                   volatile outgassing jets (the spec's "wind")
//   sun.elevationDeg        low sun = long shadows = readable relief
// ---------------------------------------------------------------------------

export const LEVELS = [
  {
    id: 1,
    name: "Tranquility Base",
    site: "Mare Tranquillitatis · 0.7°N 23.5°E",
    description:
      "A flat basalt plain with a wide prepared pad. Learn the throttle, the attitude jets and the approach.",
    difficulty: "Training",
    seed: 11071969,
    terrain: {
      size: 1000,
      divisions: 300,
      baseScale: 340,
      baseRoughness: 7,
      ridgeRoughness: 1.6,
      microRoughness: 0.5,
      craterCount: 16,
      craterMin: 22,
      craterMax: 90,
      boulderCount: 220,
      boulderMin: 0.5,
      boulderMax: 3.2,
      boulderHazardSize: 2.2,
      rille: null,
    },
    pad: { x: 0, z: 0, radius: 26, clearance: 55, flatMargin: 10, blend: 40, plateau: null, moving: null },
    // Training start: a short, slow approach. There is still drift to null out
    // — that is the skill the level teaches — but not so much that a first
    // attempt is spent just catching up with the vehicle.
    start: { x: 0, z: -120, altitude: 170, vx: 0, vy: -4, vz: 5, headingDeg: 0 },
    fuel: { descent: 430, rcs: 55 },
    thresholds: { maxVerticalSpeed: 4.5, maxHorizontalSpeed: 2.8, maxTilt: 15, minLegs: 2 },
    gravityScale: 1,
    mascons: null,
    vents: null,
    sun: { azimuthDeg: 96, elevationDeg: 14 },
    earth: { azimuthDeg: -70, elevationDeg: 38 },
  },

  {
    id: 2,
    name: "Crater Field",
    site: "Sinus Medii · 0.0°N 0.0°E",
    description:
      "Pocked, rolling ground. The pad is clear but the approach is not — pick your line and mind the rims.",
    difficulty: "Standard",
    seed: 20240712,
    terrain: {
      size: 1000,
      divisions: 300,
      baseScale: 280,
      baseRoughness: 11,
      ridgeRoughness: 3.4,
      microRoughness: 0.8,
      craterCount: 42,
      craterMin: 24,
      craterMax: 135,
      boulderCount: 420,
      boulderMin: 0.6,
      boulderMax: 4.4,
      boulderHazardSize: 2.0,
      rille: null,
    },
    pad: { x: 60, z: 40, radius: 17, clearance: 42, flatMargin: 8, blend: 32, plateau: null, moving: null },
    start: { x: -140, z: -220, altitude: 280, vx: 7, vy: -8, vz: 14, headingDeg: 22 },
    fuel: { descent: 380, rcs: 50 },
    thresholds: { maxVerticalSpeed: 3.4, maxHorizontalSpeed: 1.9, maxTilt: 13, minLegs: 3 },
    gravityScale: 1,
    mascons: null,
    vents: null,
    sun: { azimuthDeg: 122, elevationDeg: 11 },
    earth: { azimuthDeg: 30, elevationDeg: 62 },
  },

  {
    id: 3,
    name: "Rille Mesa",
    site: "Hadley Rille · 25.0°N 3.7°E",
    description:
      "A narrow mesa standing between the branches of a collapsed lava channel. Miss the top and there is a long way down.",
    difficulty: "Hard",
    seed: 19710726,
    terrain: {
      size: 1000,
      divisions: 300,
      baseScale: 300,
      baseRoughness: 13,
      ridgeRoughness: 4.6,
      microRoughness: 0.9,
      craterCount: 26,
      craterMin: 20,
      craterMax: 96,
      boulderCount: 480,
      boulderMin: 0.7,
      boulderMax: 5.2,
      boulderHazardSize: 2.0,
      rille: { width: 240, depth: 62, sinuosity: 90, offset: -40 },
    },
    pad: {
      x: 0,
      z: 20,
      radius: 11,
      clearance: 30,
      flatMargin: 4,
      blend: 22,
      plateau: { height: 26, scarp: 3.0 },
      moving: null,
    },
    start: { x: -60, z: -230, altitude: 290, vx: 5, vy: -8, vz: 15, headingDeg: 12 },
    fuel: { descent: 360, rcs: 50 },
    thresholds: { maxVerticalSpeed: 3.0, maxHorizontalSpeed: 1.4, maxTilt: 11, minLegs: 3 },
    gravityScale: 1,
    mascons: null,
    vents: null,
    sun: { azimuthDeg: 74, elevationDeg: 16 },
    earth: { azimuthDeg: -120, elevationDeg: 44 },
  },

  {
    id: 4,
    name: "Survey Platform",
    site: "Schröter's Valley · 26.2°N 50.8°W",
    description:
      "A rail-mounted survey deck traversing its track. Match its motion on the way down — a static hover will not do.",
    difficulty: "Hard",
    seed: 47110815,
    terrain: {
      size: 1000,
      divisions: 300,
      baseScale: 320,
      baseRoughness: 9,
      ridgeRoughness: 2.8,
      microRoughness: 0.7,
      craterCount: 30,
      craterMin: 22,
      craterMax: 110,
      boulderCount: 340,
      boulderMin: 0.6,
      boulderMax: 4.0,
      boulderHazardSize: 2.1,
      rille: null,
    },
    pad: {
      x: 0,
      z: 0,
      radius: 13,
      clearance: 90,
      flatMargin: 70,
      blend: 46,
      plateau: null,
      // Peak rail speed is amplitude * speed = 4.0 m/s, at mid-traverse.
      // The deck is momentarily stationary at each end of its run, so the
      // approach can either match its drift or time the turnaround.
      moving: { amplitude: 40, speed: 0.1, axis: "x" },
    },
    start: { x: -40, z: -240, altitude: 285, vx: 4, vy: -7, vz: 14, headingDeg: 8 },
    fuel: { descent: 340, rcs: 55 },
    thresholds: { maxVerticalSpeed: 3.0, maxHorizontalSpeed: 1.6, maxTilt: 11, minLegs: 3 },
    gravityScale: 1,
    mascons: null,
    vents: null,
    sun: { azimuthDeg: 140, elevationDeg: 13 },
    earth: { azimuthDeg: -20, elevationDeg: 26 },
  },

  {
    id: 5,
    name: "Polar Reserve",
    site: "Shackleton Rim · 89.9°S 0.0°E",
    description:
      "A polar rim landing on the propellant you have left. The sun never rises here — shadows run to the horizon.",
    difficulty: "Expert",
    seed: 89901234,
    terrain: {
      size: 1000,
      divisions: 300,
      baseScale: 240,
      baseRoughness: 16,
      ridgeRoughness: 6.2,
      microRoughness: 1.0,
      craterCount: 38,
      craterMin: 26,
      craterMax: 150,
      boulderCount: 520,
      boulderMin: 0.7,
      boulderMax: 5.0,
      boulderHazardSize: 1.9,
      rille: null,
    },
    pad: { x: -40, z: 55, radius: 15, clearance: 40, flatMargin: 7, blend: 30, plateau: null, moving: null },
    start: { x: 90, z: -180, altitude: 240, vx: -6, vy: -7, vz: 12, headingDeg: -18 },
    // The tightest budget in the game by a wide margin — roughly 1.5x the
    // delta-v the descent strictly needs, where every other site carries 2.5x.
    // It was 165 kg, which measured out at about 1.05x: a guided approach ran
    // the tank dry four metres short of the pad, which is not a challenge, it
    // is a level that cannot be flown.
    fuel: { descent: 230, rcs: 40 },
    thresholds: { maxVerticalSpeed: 3.2, maxHorizontalSpeed: 1.8, maxTilt: 13, minLegs: 3 },
    gravityScale: 1,
    mascons: null,
    vents: null,
    // Grazing polar sunlight: the defining visual of a south-pole landing.
    sun: { azimuthDeg: 205, elevationDeg: 4.5 },
    earth: { azimuthDeg: 60, elevationDeg: 6 },
    // Earth sits on the horizon here, so Earthshine does much of the lighting
    // in the shadowed ground the sun never reaches.
    lighting: { ambientScale: 3.2 },
  },

  {
    id: 6,
    name: "Outgassing Field",
    site: "Ina Caldera · 18.6°N 5.3°E",
    description:
      "Volatile vents jet without warning and a buried mascon drags gravity up as you cross it. Fly it loose.",
    difficulty: "Expert",
    seed: 18605301,
    terrain: {
      size: 1000,
      divisions: 300,
      baseScale: 260,
      baseRoughness: 12,
      ridgeRoughness: 5.0,
      microRoughness: 1.1,
      craterCount: 34,
      craterMin: 20,
      craterMax: 120,
      boulderCount: 460,
      boulderMin: 0.6,
      boulderMax: 4.6,
      boulderHazardSize: 2.0,
      rille: null,
    },
    pad: { x: 35, z: 30, radius: 14, clearance: 38, flatMargin: 7, blend: 28, plateau: null, moving: null },
    start: { x: -120, z: -215, altitude: 275, vx: 8, vy: -8, vz: 13, headingDeg: 26 },
    // Fighting the vents costs propellant that a still site does not; a guided
    // approach landed here with exactly zero left, which leaves a human none.
    fuel: { descent: 395, rcs: 55 },
    thresholds: { maxVerticalSpeed: 3.2, maxHorizontalSpeed: 1.7, maxTilt: 12, minLegs: 3 },
    gravityScale: 1,
    // A buried mass concentration: gravity rises ~30% over the pad approach.
    mascons: [{ x: 10, z: -10, radius: 120, amplitude: 0.3 }],
    // Transient gas jets standing in for the spec's "wind" — there is no
    // atmosphere, so lateral forces come from venting volatiles instead.
    vents: [
      { x: -20, z: -60, y: 0, strength: 1.5, radius: 46, rate: 0.55, phase: 0.0, reach: 130 },
      { x: 80, z: -10, y: 0, strength: 1.2, radius: 40, rate: 0.42, phase: 2.1, reach: 120 },
      { x: 20, z: 90, y: 0, strength: 1.35, radius: 44, rate: 0.63, phase: 4.0, reach: 125 },
      { x: -90, z: 40, y: 0, strength: 1.1, radius: 38, rate: 0.5, phase: 1.2, reach: 115 },
    ],
    sun: { azimuthDeg: 158, elevationDeg: 9 },
    earth: { azimuthDeg: -95, elevationDeg: 52 },
  },
];

export function getLevelById(id) {
  return LEVELS.find((lvl) => lvl.id === id) ?? null;
}
