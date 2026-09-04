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
// almost all fill light is bounce from the regolith itself.
// Sun intensity is set so a light-toned sunlit surface lands near 1.5 in
// linear radiance — comfortably inside the tone mapper's range and below the
// bloom threshold. Pushing it higher makes ordinary lit surfaces cross the
// bloom cut-off and the whole vehicle turns into a glowing blob.
export const SUN_COLOR = 0xfff6e8;
export const SUN_INTENSITY = 2.0;
export const AMBIENT_SKY_COLOR = 0x0a1020; // faint starlight from above
export const AMBIENT_GROUND_COLOR = 0x3a342c; // regolith bounce from below
export const AMBIENT_INTENSITY = 0.5;

// Altitude below which ground-interaction effects (dust blowing) kick in.
export const DUST_ONSET_ALTITUDE = 30; // m

export const LOCAL_STORAGE_LEADERBOARD_KEY = "lunar-sim.leaderboard.v2";
export const LOCAL_STORAGE_UNLOCKED_KEY = "lunar-sim.unlocked.v2";
export const LOCAL_STORAGE_SETTINGS_KEY = "lunar-sim.settings.v1";
