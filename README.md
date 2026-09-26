# Lunar Mission Simulator

A browser-based 3D simulation of a full Apollo-style lunar mission, flown end to end:
**Saturn V launch → gravity turn → orbit insertion → trans-lunar coast → powered
descent → landing.**

Built with Three.js and Cannon-es. No game engine, no binary assets — every texture,
mesh and sound in the project is generated procedurally at load time.

### ▶ [Play it in your browser](https://lunar-mission-simulator.vercel.app/)

[![CI](https://github.com/Aashutosh-Mahajan/lunar-mission-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/Aashutosh-Mahajan/lunar-mission-simulator/actions/workflows/ci.yml)

> Computer Graphics course project — T.E. Information Technology, Semester V,
> Vidyalankar Institute of Technology, Mumbai.

---

## Table of contents

- [Play online](https://lunar-mission-simulator.vercel.app/)
- [Quick start](#quick-start)
- [What the game is](#what-the-game-is)
- [Difficulty](#difficulty)
- [Autoplay](#autoplay)
- [Controls](#controls)
- [Landing sites](#landing-sites)
- [Project structure](#project-structure)
- [Simulation model](#simulation-model)
- [Graphics pipeline](#graphics-pipeline)
- [Design decisions](#design-decisions)
- [Tech stack](#tech-stack)
- [License](#license)

---

## Quick start

Requires Node.js 18 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open the URL Vite prints (by default `http://localhost:5173`).

To produce a static production build in `dist/`:

```bash
npm run build
```

```bash
npm run preview
```

---

## What the game is

The simulator is organised into three flight phases plus a campaign that chains them
together. Each phase is playable on its own from the main menu.

### Phase 1 — Lunar descent

The core of the project. A six-degree-of-freedom Apollo Lunar Module is flown by hand
from a few hundred metres above the surface onto a landing pad. You manage throttle,
attitude and a finite propellant budget, and you are graded on how gently and how
accurately you arrive.

Landing is judged against the real LM design case — **3 m/s vertical, 1.2 m/s lateral,
about 12° of tilt** — relaxed on the early sites and tightened on the later ones. Come in
too fast, too sideways or too far over and the vehicle topples and is lost.

Six sites, a mission board with terrain cross-sections, a graded debrief, per-site best
scores in local storage, and a contextual coach on the training levels.

### Phase 2 — Launch and ascent

A Saturn V flown from the pad to a parking orbit. The countdown runs from T-10 with
callouts; the engines light at T-8.5 while the vehicle is still clamped, and the
hold-downs release only when the clock reaches zero *and* the engines are at full thrust.

From there you fly a **gravity turn** — an interpolated pitch schedule keyed on altitude —
staging as each stage burns out, watching dynamic pressure through max-Q, and cutting off
inside an insertion window defined by altitude, horizontal velocity and flight path angle.
Time warp up to 8× is available, because a full ascent takes about eleven minutes.

The vehicle can be lost for real reasons: exceeding maximum dynamic pressure, holding a
large angle of attack while there is still air, or pulling more than 6 g.

### Phase 3 — Trans-lunar coast

The crossing from Earth orbit to the Moon. This is a *scripted transition*, not a third
simulation: the sequence runs `parking → TLI → cruise → LOI → arrived`, and the two burns
are graded on delta-v against a target band. The cruise between them is a time-warped
visual with milestone callouts and a skip.

### Campaign

**Fly the Full Mission** runs all three phases as one continuous flight. Each leg's score
is banked as it completes, and the mission score is the mean of the three. Failing any leg
ends the run.

---

## Difficulty

Chosen on the main menu. The simulation is identical at every setting — same gravity,
thrust, mass flow and vehicles. What changes is how much of the flying the computer does,
and how much margin the gear and tanks give you. That mirrors the real vehicles: the Apollo
LM could be flown fully automatic, in attitude-hold, or in direct mode.

| | Cadet | Pilot | Commander |
| --- | --- | --- | --- |
| **Descent** | Autopilot holds a safe sink rate; `W A S D` pick a direction *relative to the camera*; let go and it stops and sets itself down | You fly it; releasing the keys kills drift automatically; `G` holds descent rate | Direct control |
| **Landing limits** | 1.7× vertical, 1.8× lateral, +10° tilt | 1.3× / 1.35× / +4° | Real LM design limits |
| **Propellant** | 1.6× | 1.25× | As flown |
| **Launch** | Stages, steers and cuts off by itself | Auto-staging; a flight director shows where to steer | Manual staging |
| **Coast burns** | Engine cuts off on target | Wider window | Real window |

The assists never touch the physics. They turn your inputs into the same things a pilot
controls — a throttle setting and an attitude — using thrust-vector guidance, modelled on
the LM's own autopilot modes (including P66, the descent-rate hold used for every actual
Apollo landing).

**Medals.** Each site has a bronze, silver and gold medal, for landing it on Cadet, Pilot
and Commander. Records rank by difficulty first: a Commander landing always outranks a
Cadet one, whatever the scores.

---

## Autoplay

The game can fly itself, in every phase and at every difficulty:

- **▶ Watch Autoplay** on the main menu flies the whole mission — launch, coast and
  landing — moving on from each debrief by itself.
- **▶ Autoplay** on any site card on the mission board flies that landing.
- **`O`** (or the pause menu) hands control to the computer mid-flight, and takes it back.

Autoplay is a virtual pilot, not a separate model: it produces the same controls a player
does and feeds them through the same assists and physics. It steers the descent toward the
pad with an analog stick, holds height until it is over the pad, and comes down briskly
while high up — a leisurely descent spends too much propellant on gravity for the polar
site's tank. It lands all six sites at all three difficulties, including Commander's real
limits. Flights the computer flew any part of are marked *Autoplay — not recorded*: they
set no records and unlock nothing.

---

## Controls

### Lunar descent — Cadet

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Fly away / left / back / right, relative to the camera |
| `Shift` | Hover in place |
| `Ctrl` | Come down faster |
| `Space` | Climb |
| Release all keys | Stop drifting and set down |

### Lunar descent — Pilot and Commander

| Input | Action |
| --- | --- |
| `Space` | Full thrust (hold) |
| `Shift` / `Ctrl` | Throttle up / down |
| `Z` / `X` | Throttle to 100% / cut |
| `W` `S` | Pitch |
| `A` `D` | Roll |
| `Q` `E` | Yaw |
| `↑` `↓` `←` `→` | RCS translation (fine lateral trim) |
| `T` | Toggle attitude hold |
| `G` | Descent-rate hold (throttles for you) |
| `C` / `V` | Next / previous camera |
| Mouse drag | Swing the view · wheel zooms |

### Launch and ascent

| Input | Action |
| --- | --- |
| `Shift` / `Ctrl` | Throttle up / down |
| `W` `S` | Bias the pitch program (±24°) — steer the CMD needle onto the magenta FD bracket |
| `Space` | Stage |
| `I` | Engine cut-off and insertion attempt |
| `,` / `.` | Time warp down / up (1×–8×) |
| `C` / `V` | Next / previous camera |

### Coast

| Input | Action |
| --- | --- |
| `Space` | Burn (hold) |
| `I` | Cut off |
| `,` / `.` | Time warp |
| `K` | Skip the cruise |

### Everywhere

| Input | Action |
| --- | --- |
| `O` | Autoplay on / off |
| `Esc` / `P` | Pause |
| `H` | Controls |
| `R` | Restart the current flight |
| `M` | Mute |

A gamepad is supported for the descent phase.

### How to actually land (Pilot and Commander)

On Cadet, point `W A S D` at the pad and let go when you are over it. In the manual modes:

Thrust leaves the bottom of the lander along its own axis, so tilting the vehicle splits
that thrust into "hold me up" and "push me sideways". **This — not the RCS translation
keys — is how you kill lateral drift.** At full throttle the descent engine gives about
5.8 m/s²; leaning 15° puts 1.5 m/s² of it sideways, nearly three times what the
translation jets can manage.

1. Read the drift cross-pointer on the HUD.
2. Lean *against* it and hold `Space` — tilt alone does nothing, the engine supplies the force.
3. Release early; auto-level flies you back to vertical at 20°/s and you keep braking on the way.
4. Save the arrow keys for the final trim below ~20 m.
5. Kill drift high, while you still have altitude to spend.

---

## Landing sites

| # | Site | Location | Difficulty | The problem |
| --- | --- | --- | --- | --- |
| 1 | Tranquility Base | Mare Tranquillitatis · 0.7°N 23.5°E | Training | A wide pad on a flat basalt plain |
| 2 | Crater Field | Sinus Medii · 0.0°N 0.0°E | Standard | Cratered ground, little clear space |
| 3 | Rille Mesa | Hadley Rille · 25.0°N 3.7°E | Hard | A narrow plateau beside a sinuous rille |
| 4 | Survey Platform | Schröter's Valley · 26.2°N 50.8°W | Hard | A moving deck — drift is judged relative to it |
| 5 | Polar Reserve | Shackleton Rim · 89.9°S 0.0°E | Expert | The tightest propellant budget in the game |
| 6 | Outgassing Field | Ina Caldera · 18.6°N 5.3°E | Expert | Pulsing volatile vents shove you off the approach |

All six are validated as winnable two independent ways: a delta-v budget check, and a
guided autopilot that flies each of them to touchdown.

---

## Project structure

```
index.html            Markup for every screen and HUD
style.css             All styling
src/
  main.js             Scene setup, render loop, phase state machine
  constants.js        Physical and vehicle constants
  core/
    RenderPipeline.js HDR pipeline, tone mapping, post-processing
    CameraRig.js      Descent cameras      AscentCamera.js   Launch cameras
    CoastCamera.js    Cislunar cameras     MouseLook.js      Shared mouse control
    Input.js          Keyboard and gamepad AudioEngine.js    Procedural Web Audio
    mergeStatic.js    Static geometry batching
  physics/
    landerPhysics.js  6-DOF descent integration
    rocketPhysics.js  Ascent, atmosphere, staging
    landerAssist.js   Autopilot, drift-kill and descent-rate hold
  entities/
    Lander.js         Apollo LM at real scale
    Rocket.js         Saturn V             LaunchComplex.js  Pad and tower
    Terrain.js        Height field and collision
    Environment.js    Lunar sky            Spacecraft.js     CSM + LM stack
  levels/
    levelConfig.js    Data for the six descent sites
    difficulty.js     Cadet / Pilot / Commander presets
    levelLoader.js    Descent runtime
    ascentConfig.js   ascentRuntime.js     coastRuntime.js
  scenes/
    earthScene.js     Ascent sky and globe
    spaceScene.js     Cislunar sky
  materials/
    textures.js       Procedural texture baking
    noise.js          Simplex, FBM, ridged noise
    photometry.js     Lommel-Seeliger regolith shading
    assets.js
  fx/
    particles.js      Plume, dust, ice, pyrotechnics
  ui/
    hud.js  ascentHud.js  coastHud.js      Instrument panels
    debrief.js  ascentDebrief.js  coastDebrief.js
    levelSelect.js  leaderboard.js  campaign.js
    screens.js  settings.js  countdown.js  coach.js  difficultyPicker.js
  dev/
    harness.js        Headless test pilots (dev server only, never shipped)
```

Each phase is deliberately isolated: deleting the Phase 2 and Phase 3 files leaves the
descent trainer fully working.

---

## Simulation model

The brief called for a *simplified but convincing* simulation rather than a
Kerbal Space Program clone, so the physics is hand-rolled and deliberately bounded.
There is no n-body gravity, no orbit determination and no delta-v budgeting.

### Integration

Translation is advanced with a hand-written **Euler step** — semi-implicit for the
descent, explicit for the ascent — rather than being handed to the physics engine's force
model. Cannon-es is used only for collision detection and rigid-body basics.

Attitude is carried as a quaternion advanced from body-frame angular rates, with a
rate-damping attitude-hold mode.

### Vehicle figures

Real Apollo and Saturn V numbers throughout:

| | |
| --- | --- |
| Lunar gravity | 1.62 m/s² |
| LM descent engine | 45,040 N, Isp 311 s, 10% minimum throttle |
| LM dry mass | 6,800 kg |
| S-IC thrust | 34.0 MN at sea level |
| Saturn V propellant | 2,077 t in the first stage |
| Stages / payload | 3 / 45 t |

**Mass is variable.** Burning propellant lightens the vehicle, so acceleration rises
through the burn exactly as it did on Apollo.

### Descent specifics

- Gravity varies *spatially* through mascons — Gaussian bumps in g — rather than being
  fudged over time.
- There is no atmosphere, so the brief's "wind" is modelled as pulsing volatile
  outgassing vents. Lateral forces come from gas jets, which is what actually happens.
- On the traversing deck, drift is judged **relative to the deck**. Matching its motion
  reads as zero drift, which is the flying task.

### Ascent specifics

- Thrust is interpolated between the sea-level and vacuum ratings by ambient pressure.
- Propellant mass flow comes from `F / (Isp · g₀)`.
- Drag runs against an exponential atmosphere with a Mach-dependent drag coefficient,
  which puts max-Q near 13 km where it belongs.
- **One concession to a round planet**: effective gravity is reduced by `v_h² / (R + h)`.
  Nothing integrates a trajectory around a central body, but without this term a gravity
  turn cannot physically close — the vehicle would need thrust to hold itself up at any
  speed. With it, the vehicle becomes self-supporting exactly at orbital velocity.

### The gravity turn

Per the brief this is an interpolated pitch schedule keyed on altitude, not a guidance
law. Two properties matter and were found by flying it:

1. **The schedule is ratcheted on the highest altitude reached**, not the current one.
   Keyed on raw altitude it runs backwards whenever the vehicle sinks, commanding the nose
   up while the velocity vector points down — a guaranteed loss of vehicle.
2. **It levels off near 22°, not at 0°.** Thrust has to hold the stack up until horizontal
   speed can do it instead. Pushing the nose down as orbital speed approaches is the
   player's job, which is what the pitch authority is for.

---

## Graphics pipeline

- **HDR rendering** with ACES filmic tone mapping, bloom, chromatic aberration, vignette,
  film grain and SMAA (High) or FXAA (Medium) anti-aliasing.
- **Lunar photometry.** Regolith is shaded with a Lommel–Seeliger/Lambert blend rather
  than pure Lambert. Lommel–Seeliger is the standard first-order photometric law for the
  Moon — the reason the full Moon is not darkened at its edge. At these sites' 5–15° sun
  elevations, Lambert shading dropped the whole foreground to near-black; real surface
  photography at those angles shows bright, readable ground with crisp shadows.
- **Propellant-correct exhaust.** The S-IC's kerosene flame is the brilliant orange plume;
  the upper stages burned liquid hydrogen, whose exhaust is almost invisible — a faint
  blue-violet haze. The first stage also lays a smoke trail that thins out with the air.
- **Everything is procedural.** The repository ships no binary assets. Regolith PBR maps,
  crinkled MLI foil, spacecraft panels, the Earth's surface and clouds, and the lunar
  surface shader are all baked from noise at load time.
- **Terrain self-shadowing is baked into vertex colours** by ray-marching toward the sun
  when the height field is generated. Shadow mapping is unusable at the ~10° sun
  elevations these sites are lit at — it produces acne across the whole surface.
- **Crater morphology follows real fresh craters**: a 1:5 depth-to-diameter ratio, a
  raised rim and decaying ejecta.
- **Vacuum-correct effects.** Dust thrown by the plume travels ballistically in sheets and
  does not billow; the over-expanded exhaust plume is nearly invisible; the nozzle glow
  lights the ground beneath it.
- **Procedural audio** through Web Audio — structure-borne engine rumble, RCS bangs,
  contact chimes, caution tones. No audio files.

### Performance

- **Adaptive resolution** steps the render scale down when the frame rate drops below
  ~48 fps and back up when there is headroom, so integrated GPUs stay smooth.
- **Quality is picked from the GPU**, not the CPU core count, on first launch.
- **Static geometry is batched.** The launch tower's ~115 beams are baked into one mesh,
  which took the pad view from 371 draw calls to 170.
- **Particle sprites are sized from the projection**, so they stay correct at any field of
  view and resolution — including under the launch tracker's telephoto zoom.

Measured on Intel UHD integrated graphics at 1440×810, Medium quality: 7.5–13.7 ms per
frame across all three phases.

### The scale problem

An ascent spans 185 km with a 110 m vehicle, which will not fit in one depth buffer. The
horizon dip angle depends only on `h/R`, so the Earth is drawn at **1/2000 scale with the
camera's altitude scaled by the same factor**. Curvature and horizon position are then
exact at every altitude while everything stays inside a small far plane. The globe is
drawn behind everything without depth write, so the real-scale launch complex overlays it
near the ground and fades out as it stops mattering.

---

## Design decisions

A few choices that are load-bearing and easy to get wrong:

**The lander is a `DYNAMIC` body with zero mass.** Cannon-es treats a kinematic-versus-
static pair as an overlap-only test: it never creates a contact and never fires `collide`,
so the lander fell through the terrain. A dynamic body with `mass: 0` has infinite inertia
— the solver can never move it — while still generating real contacts.

**Tilt is capped and auto-levelled.** Without a limit, holding a steering key rotates the
vehicle past 90°, where the engine thrusts *downward*. Past about 60° the descent is
unrecoverable, which is a trap rather than a skill test. Releasing the key now flies the
vehicle back to vertical, because rate damping alone holds whatever attitude you stopped
at and leaves thrust pointing sideways.

**Camera orbit pivots on the vehicle, never the look target.** The coast views aim at
points thousands of units away; orbiting about those threw the camera across the system on
a single drag.

**Bodies are placed by distance, not just radius.** Angular size is `asin(r/d)`, and a
sphere placed nearer than its own radius swallows the camera.

**Lunar albedo is about 0.12.** Painting the Moon pale grey is the fastest way to make it
look fake. The shader keeps it dark and lets the unfiltered sun do the work.

---

## Tech stack

| | |
| --- | --- |
| Rendering | [Three.js](https://threejs.org) |
| Collision | [Cannon-es](https://pmndrs.github.io/cannon-es/) |
| Build | [Vite](https://vitejs.dev) |
| UI | Plain HTML/CSS overlay on the canvas |
| Audio | Web Audio API |

No framework, no bundled assets, no backend. Scores live in `localStorage`.

### Continuous integration

Every push and pull request runs [three jobs](.github/workflows/ci.yml):

| Job | What it checks |
| --- | --- |
| **Build** | Builds on Node 20 and 22, then verifies the output is a usable site — bundles emitted, and no root-absolute asset paths, which work locally and break under a subdirectory |
| **Boot smoke test** | Loads the production build in headless Chromium and asserts the game reaches its menu with a live WebGL2 context and no console errors. A build cannot catch a shader that fails to compile — this can |
| **Invariants** | Fails if a binary asset is ever committed, or if the cited real-world constants drift from the values documented here |

Deployment is handled by Vercel, which builds from this repository directly.

Run the smoke test locally:

```bash
npx playwright install chromium && npm run build && npm run smoke
```

---

## License

Released under the MIT License. See [LICENSE](LICENSE).
