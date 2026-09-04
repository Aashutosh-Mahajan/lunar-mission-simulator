// ---------------------------------------------------------------------------
// Phase 2 — launch and ascent profile.
//
// Data-driven like the descent levels: the vehicle, its pitch program and the
// insertion target all live here, and rocketPhysics.js / ascentRuntime.js read
// them generically.
//
// Figures are the real Saturn V's, rounded. Where the game deliberately
// diverges from the real vehicle it is called out in a comment — per the
// project scope this is a "simplified but convincing" ascent, not a launch
// simulator: the gravity turn is a scripted pitch curve rather than a guidance
// solution, and there is no orbital mechanics anywhere in it.
// ---------------------------------------------------------------------------

export const ASCENT_MISSION = {
  id: "apollo-ascent",
  name: "Trans-Lunar Injection Ascent",
  vehicle: "Saturn V",
  site: "Launch Complex 39A · Kennedy Space Center · 28.6°N 80.6°W",
  description:
    "Fly a Saturn V from the pad to a 185 km parking orbit. Hold the pitch program, " +
    "throttle back through max-Q, stage cleanly, and cut off inside the insertion band.",

  // Combined CSM + LM + spacecraft adapter carried all the way up.
  payloadMass: 45000, // kg

  // -------------------------------------------------------------------------
  // Stages, burned in order.
  //
  // NOTE ON THROTTLE: neither the F-1 nor the J-2 was meaningfully
  // throttleable — the real vehicle limited acceleration by shutting the
  // centre engine down mid-burn. A continuous throttle is a deliberate
  // gameplay simplification so the player has authority over max-Q and over
  // the insertion cutoff.
  // -------------------------------------------------------------------------
  stages: [
    {
      name: "S-IC",
      engines: "5 × F-1",
      dryMass: 131000, // kg
      propellant: 2077000, // kg
      thrustSeaLevel: 34020000, // N
      thrustVacuum: 38700000, // N
      ispSeaLevel: 263, // s
      ispVacuum: 304, // s
      minThrottle: 0.55,
      // Geometry, used by the model and by the drag reference area.
      length: 42.1, // m
      diameter: 10.1, // m
      separationImpulse: 14, // m/s of visual separation drift
    },
    {
      name: "S-II",
      engines: "5 × J-2",
      dryMass: 36000,
      propellant: 444000,
      thrustSeaLevel: 4400000,
      thrustVacuum: 5141000,
      ispSeaLevel: 350,
      ispVacuum: 421,
      minThrottle: 0.5,
      length: 24.9,
      diameter: 10.1,
      separationImpulse: 9,
    },
    {
      name: "S-IVB",
      engines: "1 × J-2",
      dryMass: 13500,
      propellant: 109000,
      thrustSeaLevel: 890000,
      thrustVacuum: 1033000,
      ispSeaLevel: 360,
      ispVacuum: 421,
      minThrottle: 0.4,
      length: 17.8,
      diameter: 6.6,
      separationImpulse: 0,
    },
  ],

  // -------------------------------------------------------------------------
  // Gravity turn.
  //
  // Per the project scope this is an interpolated pitch schedule keyed on
  // altitude, NOT a guidance law derived from thrust-to-weight. Pitch is
  // measured from the horizon: 90 degrees is straight up, 0 is horizontal.
  // The shape mimics the real Saturn V profile — hold vertical to clear the
  // tower, pitch over smoothly through the lower atmosphere, then flatten out
  // as the vehicle trades altitude gain for horizontal speed.
  // -------------------------------------------------------------------------
  // The schedule is keyed on the highest altitude reached so far, not the
  // instantaneous one — see the ratchet in rocketPhysics.js.
  //
  // Two shaping notes, both found by flying it:
  //  * pitching over hard below 10 km spikes dynamic pressure and angle of
  //    attack, so the early part stays comparatively steep;
  //  * the upper part levels off at roughly 22 degrees rather than going flat.
  //    Thrust still has to hold the vehicle up until horizontal speed is high
  //    enough for the vehicle to support itself, and a schedule that flattens
  //    to zero at altitude simply drops the stack back into the atmosphere.
  //    Pushing the nose down as orbital speed approaches is the player's job.
  verticalRiseAltitude: 130, // m — clear the tower before pitching at all
  pitchProgram: [
    { altitude: 0, pitch: 90 },
    { altitude: 200, pitch: 89 },
    { altitude: 1200, pitch: 82 },
    { altitude: 4000, pitch: 71 },
    { altitude: 9000, pitch: 60 },
    { altitude: 14000, pitch: 48 },
    { altitude: 20000, pitch: 38 },
    { altitude: 30000, pitch: 31 },
    { altitude: 45000, pitch: 27 },
    { altitude: 65000, pitch: 25 },
    { altitude: 90000, pitch: 24 },
    { altitude: 120000, pitch: 23 },
    { altitude: 150000, pitch: 22 },
    { altitude: 185000, pitch: 18 },
    { altitude: 230000, pitch: 12 },
  ],

  // How far off the programmed pitch the player may steer, in degrees. Wide
  // enough to flatten the climb out near insertion, which is the manoeuvre
  // the last two minutes of the flight are about.
  pitchAuthority: 24,

  // -------------------------------------------------------------------------
  // Insertion target — an altitude and speed band, deliberately not an orbit
  // solution. Hitting the band means the parking orbit is good enough for the
  // trans-lunar injection burn that follows in Phase 3.
  // -------------------------------------------------------------------------
  orbit: {
    targetAltitude: 185000, // m
    altitudeBand: [155000, 220000],
    targetSpeed: 7793, // m/s — circular velocity at 185 km
    speedBand: [7620, 7930],
    // Vertical speed must be near zero at insertion, or the "orbit" is really
    // a ballistic arc that comes straight back down.
    maxVerticalSpeed: 140, // m/s
    maxFlightPathAngle: 4, // degrees off horizontal
  },

  // -------------------------------------------------------------------------
  // Structural and crew limits. Exceeding these ends the flight.
  // -------------------------------------------------------------------------
  limits: {
    // Dynamic pressure. The real Saturn V peaked near 35 kPa around 13 km;
    // the vehicle is given a little margin over that.
    maxDynamicPressure: 48000, // Pa
    // Aerodynamic angle of attack. In thick air, pointing away from the
    // velocity vector snaps the interstage — this is what killed N-1 style
    // vehicles and why launchers fly zero-alpha through the atmosphere.
    maxAngleOfAttack: 14, // degrees
    // Angle-of-attack limit only bites while there is enough air to matter.
    angleOfAttackQThreshold: 6000, // Pa
    maxAcceleration: 6.0, // g
  },

  // Exponential atmosphere: rho = rho0 * exp(-h / H). Good to a few percent
  // through the troposphere and stratosphere, which is all that matters here.
  atmosphere: {
    seaLevelDensity: 1.225, // kg/m^3
    scaleHeight: 8500, // m
    karmanLine: 100000, // m — nominal "space" boundary, used for HUD cues
  },

  // Launch site dressing.
  pad: {
    towerHeight: 120, // m
    launchAzimuthDeg: 72, // degrees, the Apollo lunar-mission azimuth
  },

  // Countdown callouts, seconds before liftoff.
  countdown: [
    { t: 10, text: "T-minus 10 · guidance is internal" },
    { t: 9, text: "9" },
    { t: 8, text: "8 · ignition sequence start" },
    { t: 7, text: "7" },
    { t: 6, text: "6" },
    { t: 5, text: "5" },
    { t: 4, text: "4" },
    { t: 3, text: "3" },
    { t: 2, text: "2" },
    { t: 1, text: "1" },
    { t: 0, text: "All engines running · LIFTOFF" },
  ],
};

/** Pitch commanded by the gravity-turn program at a given altitude. */
export function programmedPitch(altitude) {
  const program = ASCENT_MISSION.pitchProgram;
  if (altitude <= program[0].altitude) return program[0].pitch;
  const last = program[program.length - 1];
  if (altitude >= last.altitude) return last.pitch;

  for (let i = 0; i < program.length - 1; i++) {
    const a = program[i];
    const b = program[i + 1];
    if (altitude >= a.altitude && altitude <= b.altitude) {
      const t = (altitude - a.altitude) / (b.altitude - a.altitude);
      // Smoothstep between keyframes so the commanded pitch has no corners —
      // a kinked pitch command would show up as a visible twitch.
      const s = t * t * (3 - 2 * t);
      return a.pitch + (b.pitch - a.pitch) * s;
    }
  }
  return last.pitch;
}

/** Air density at altitude, from the exponential atmosphere model. */
export function airDensity(altitude) {
  const { seaLevelDensity, scaleHeight } = ASCENT_MISSION.atmosphere;
  if (altitude < 0) return seaLevelDensity;
  return seaLevelDensity * Math.exp(-altitude / scaleHeight);
}

/** Atmospheric pressure ratio (1 at sea level, 0 in vacuum). */
export function pressureRatio(altitude) {
  return Math.min(1, airDensity(altitude) / ASCENT_MISSION.atmosphere.seaLevelDensity);
}
