// Global physical/engine constants. Per-level tunables (fuel load, thresholds,
// terrain shape) live in src/levels/levelConfig.js — this file holds only the
// values that must stay identical everywhere they are referenced.
//
// Where a number comes from a real Apollo Lunar Module figure it is cited, so
// the physics can be justified in the project viva.

// ---------------------------------------------------------------------------
// Gravity
// ---------------------------------------------------------------------------

// Moon's mean surface gravity (NASA lunar fact sheet). Cited in the project's
// literature review and used as the single source of gravitational accel.
export const LUNAR_GRAVITY = 1.62; // m/s^2

// Earth surface gravity — only used by Phase 2 ascent physics.
export const EARTH_GRAVITY = 9.81; // m/s^2

// ---------------------------------------------------------------------------
// Lander mass & propulsion (Apollo LM descent stage, rounded)
// ---------------------------------------------------------------------------

// Dry mass of the vehicle at touchdown, excluding usable descent propellant.
// Apollo LM landed mass was ~7,300 kg; 6,800 kg dry + per-level propellant
// keeps the total in that ballpark.
export const LANDER_DRY_MASS = 6800; // kg

// Descent Propulsion System max thrust (Apollo DPS: 45,040 N at full throttle).
export const ENGINE_MAX_THRUST = 45040; // N

// The real DPS could only run at 10-60% or 100% throttle (it would erode at
// intermediate settings). We allow a continuous band but keep a realistic
// minimum so the engine can't be feathered to a whisper.
export const ENGINE_MIN_THROTTLE = 0.1;

// Effective exhaust velocity (Isp ~311 s in vacuum → v_e = Isp * g0).
// Mass flow = thrust / v_e, so full throttle burns ~14.8 kg/s as it really did.
export const ENGINE_EXHAUST_VELOCITY = 311 * 9.80665; // m/s

// Throttle slew rate — how fast the commanded throttle can move, per second.
export const THROTTLE_RATE = 0.9;

// ---------------------------------------------------------------------------
// Reaction Control System (attitude)
// ---------------------------------------------------------------------------

// Angular acceleration the RCS quads can produce about pitch/roll/yaw.
// The LM's 16 x 445 N thrusters gave a brisk but not instant response.
export const RCS_ANGULAR_ACCEL = 26; // deg/s^2

// Rate limit so attitude control stays flyable rather than spinning up forever.
export const RCS_MAX_RATE = 28; // deg/s

// With the stabiliser (SAS) engaged, residual rotation is bled off at this
// rate — models the LM's rate-damping autopilot mode.
export const RCS_DAMPING = 4.2; // 1/s

// Maximum lean the attitude-hold autopilot will allow away from vertical.
// Without a limit, holding a translation input just keeps rotating the
// vehicle — past 90 degrees the engine is thrusting downward and the descent
// is unrecoverable, which is not a skill test, just a trap. The real LM's
// digital autopilot enforced exactly this kind of bank limit. Switch the
// stabiliser off (T) to rotate freely.
export const RCS_TILT_LIMIT = 45; // degrees from vertical

// With attitude hold on and no steering input, the autopilot flies the vehicle
// back to vertical at this rate. The real LM's ATT HOLD merely froze the
// current attitude; levelling instead makes "let go and it comes upright" true,
// which is the difference between a landing that can be learned and one where
// every correction leaves the vehicle permanently leaning.
export const RCS_LEVEL_RATE = 20; // degrees/second

// Flight-control assists (physics/landerAssist.js). Modelled on the LM's own
// autopilot modes; see that file for how they are used.
export const ASSIST = {
  // How fast the attitude-command autopilot slews toward its target attitude.
  // Comparable to the LM's RCS-limited rates, and quick enough that a change
  // of travel direction feels responsive.
  SLEW_RATE: 28, // degrees/second

  // Scheduled sink rate: SINK_RATE_MIN + h * SINK_RATE_PER_METRE, clamped.
  // At 150 m this is ~6 m/s; it tapers to about 1 m/s at contact, which is
  // the LM's own design touchdown rate.
  SINK_RATE_MIN: 0.9, // m/s
  SINK_RATE_PER_METRE: 0.034, // (m/s)/m
  SINK_RATE_MAX: 6.0, // m/s
  FAST_DESCENT_FACTOR: 1.8,
  CLIMB_RATE: 2.0, // m/s, Space in full assist

  // Commanded travel speed for W A S D in full assist, also shrinking near the
  // ground so the final approach cannot arrive fast.
  TRAVEL_SPEED_MIN: 2.0, // m/s
  TRAVEL_SPEED_PER_METRE: 0.06, // (m/s)/m
  TRAVEL_SPEED_MAX: 10.0, // m/s

  // Guidance gains (1/s): how quickly velocity errors are closed.
  VELOCITY_GAIN: 0.65,
  RATE_GAIN: 1.4,
  // Floor on vertical acceleration, as a fraction of g — a rocket cannot pull
  // downward, so never demand it.
  MIN_VERTICAL_G: 0.25,

  // Lean limits: full assist, drift-kill, and the tighter caps near the ground.
  MAX_TILT: 26, // degrees
  DRIFT_KILL_TILT: 16, // degrees
  LOW_ALTITUDE: 14, // m above the footpads
  LOW_TILT: 18, // degrees
  FLARE_ALTITUDE: 1.5, // m above the footpads
  FLARE_TILT: 6, // degrees

  // Drift arrest: below this height, if the drift error is larger than
  // ARREST_DRIFT, stop descending until it is nulled — what a pilot does
  // ("hold it, kill the drift, then let it down") rather than carrying drift
  // into a flare that has no lean authority left to remove it.
  ARREST_ALTITUDE: 16, // m above the footpads
  ARREST_DRIFT: 1.0, // m/s
  // Below this, arresting drift climbs gently instead of just holding: a
  // lean near the ground swings the downhill footpad into the surface
  // (half the 9.4 m gear span times sin(tilt) is 1.5 m at 18 degrees).
  ARREST_CLIMB_BELOW: 5, // m above the footpads
  ARREST_CLIMB_RATE: 0.8, // m/s

  // Within this distance of a moving deck, "stopped" means matching the deck.
  DECK_MATCH_RANGE: 60, // m
};

// RCS propellant is a small separate budget from the descent tanks.
export const RCS_PROPELLANT = 60; // kg
export const RCS_FLOW_PER_AXIS = 0.32; // kg/s while a translation/attitude jet fires

// Attitude authority is useless past a certain lean; beyond this the vehicle is
// considered tumbling and unrecoverable for landing purposes.
export const MAX_SURVIVABLE_TILT = 75; // degrees from vertical

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

// Cap on the integration step so a tab-refocus spike can't blow up the
// explicit Euler integrator.
export const MAX_DT = 1 / 45; // s

// Fixed step used to drive the collision world.
export const PHYSICS_FIXED_STEP = 1 / 60; // s

// ---------------------------------------------------------------------------
// World / rendering
// ---------------------------------------------------------------------------

// Sunlight colour and intensity. With no atmosphere the terminator is razor
// sharp and shadows are nearly black, so ambient fill is deliberately tiny —
// almost all fill light is bounce from the regolith itself, which arrives
// through the baked environment map.
//
// The intensity is calibrated against the ground, not the vehicle: Apollo
// surface cameras were exposed for the regolith ("sunny 16"), which puts a
// 0.12-albedo soil at a photographic mid grey. With three's photometric units
// that needs an irradiance of about 4.4 at the scene's exposure. A white
// sunlit panel then sits near 1.1 in linear radiance — bright, inside the tone
// mapper's shoulder, and below the bloom threshold, so only true specular
// glints flare.
export const SUN_COLOR = 0xfff6e8;
export const SUN_INTENSITY = 4.4;
export const AMBIENT_SKY_COLOR = 0x0a1020; // faint starlight from above
export const AMBIENT_GROUND_COLOR = 0x3a342c; // regolith bounce from below
// Ground bounce now arrives through the baked environment map (see
// materials/environmentMaps.js), which knows where the sun is; this residual
// hemisphere term only keeps fully shadowed terrain from crushing to black.
export const AMBIENT_INTENSITY = 0.45;

// Normal albedo of mare regolith: about 0.07 (Tranquility) to 0.12; highland
// soils run to ~0.18. Terrain materials are calibrated to this value rather
// than tinted by eye, so the ground and the spacecraft keep their real
// brightness ratio — sunlit foil is several times brighter than the soil.
export const REGOLITH_ALBEDO = 0.12;

// Photographic exposure for the lunar surface. The scene's gain lives in the
// sun's irradiance above; this is only the camera's small push, and emissive
// effects (nozzle glow, plume, stars) are tuned against it.
export const LUNAR_EXPOSURE = 1.18;

// Altitude below which ground-interaction effects (dust blowing) kick in.
export const DUST_ONSET_ALTITUDE = 30; // m

export const LOCAL_STORAGE_LEADERBOARD_KEY = "lunar-sim.leaderboard.v2";
export const LOCAL_STORAGE_UNLOCKED_KEY = "lunar-sim.unlocked.v2";
export const LOCAL_STORAGE_SETTINGS_KEY = "lunar-sim.settings.v1";
