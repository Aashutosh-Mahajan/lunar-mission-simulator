import * as THREE from "three";
import Rocket from "../entities/Rocket.js";
import LaunchComplex from "../entities/LaunchComplex.js";
import EarthScene from "../scenes/earthScene.js";
import Countdown from "../ui/countdown.js";
import {
  createAscentState,
  stepRocketPhysics,
  separateStage,
  checkLimits,
  evaluateInsertion,
  activeStage,
  gravityAtAltitude,
} from "../physics/rocketPhysics.js";
import { ASCENT_MISSION, pressureRatio, programmedPitch } from "./ascentConfig.js";
import { applyAscentDifficulty, DEFAULT_DIFFICULTY } from "./difficulty.js";

// ---------------------------------------------------------------------------
// Phase 2 runtime: owns one launch attempt.
//
// Mirrors LevelRuntime's shape (update / result / dispose) so the game shell
// can drive either phase, but shares no code with it — Phase 1 keeps working
// if this file is deleted.
// ---------------------------------------------------------------------------

const MAX_MISSION_TIME = 1500; // s — a hard stop so a stuck flight ends

// Exhaust trail tuning. Below TRAIL_MIN_PRESSURE (roughly 35 km) there is too
// little air for a visible trail.
const TRAIL_MIN_PRESSURE = 0.015;
const TRAIL_SPACING = 7; // m of flight path per puff
const TRAIL_MAX_PER_FRAME = 36;

// Delay between burnout and automatic staging, mission seconds. The real
// sequence ran about this long between cutoff and next-stage ignition.
const AUTO_STAGE_DELAY = 1.2;

export default class AscentRuntime {
  constructor({ scene, particles, assets, audio, difficulty = DEFAULT_DIFFICULTY }) {
    this.scene = scene;
    this.particles = particles;
    this.assets = assets;
    this.audio = audio;
    // Wider windows and margins at the easier settings; same vehicle.
    this.mission = applyAscentDifficulty(ASCENT_MISSION, difficulty);
    this.assists = this.mission.assists;
    // The flight director's current recommendation, degrees of pitch bias,
    // or null while it is not engaged. Shown on the HUD at every setting.
    this.guidanceBias = null;
    this._stageTimer = 0;
    this._trailNozzle = new THREE.Vector3();
    this._trailLast = new THREE.Vector3();
    this._trailPrimed = false;

    this.state = createAscentState(this.mission);
    this.result = null;
    this.status = "countdown";
    this.elapsed = 0;
    this.timeScale = 1;

    this.earth = new EarthScene(scene, this.mission, assets);
    this.pad = new LaunchComplex(scene, assets, this.mission);
    this.earth.ground = this.pad;
    this.rocket = new Rocket(scene, assets, this.mission);
    this.countdown = new Countdown();
    this.countdown.start();

    // Vehicle sits on the launcher deck.
    this.padDeckHeight = this.pad.deckHeight + 5.4;
    this.state.position.set(0, 0, 0);

    this.events = [];
    this._eventFlags = new Set();
    this._worldPos = new THREE.Vector3();
    this._maxQ = 0;
    this._maxG = 0;
    this._maxAltitude = 0;

    this.telemetry = {
      altitude: 0,
      downrange: 0,
      speed: 0,
      horizontalSpeed: 0,
      verticalSpeed: 0,
      flightPathAngle: 90,
      pitch: 90,
      commandedPitch: 90,
      angleOfAttack: 0,
      dynamicPressure: 0,
      mach: 0,
      drag: 0,
      gravity: 9.81,
      mass: 0,
      thrust: 0,
      throttle: 0,
      acceleration: 1,
      twr: 0,
      stageName: this.mission.stages[0].name,
      stageIndex: 0,
      stagePropellant: this.mission.stages[0].propellant,
      stagePropellantFraction: 1,
      inAtmosphere: true,
    };

    particles.setTerrain(null);
    particles.reset();
    this._syncVehicle();
  }

  // -------------------------------------------------------------------------
  // Mission log
  // -------------------------------------------------------------------------

  logEvent(key, text) {
    if (this._eventFlags.has(key)) return;
    this._eventFlags.add(key);
    this.events.push({ t: this.state.missionTime, text });
    this.onEvent?.(text);
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(rawDt, controls) {
    // Time acceleration. Physics is substepped so the integrator never sees a
    // step larger than it can handle, however fast the clock is running.
    const scaled = rawDt * this.timeScale;
    const substeps = Math.max(1, Math.ceil(scaled / (1 / 45)));
    const dt = scaled / substeps;

    if (this.status === "countdown") {
      this._updateCountdown(rawDt);
      // The vehicle is held down but the engines may already be running.
      for (let i = 0; i < substeps; i++) {
        this.telemetry = stepRocketPhysics(this.state, this._holdControls(), dt, this.mission);
      }
    } else if (this.status === "flying") {
      this.guidanceBias = this._flightDirector();
      const flown = this.assists.autoGuidance && this.guidanceBias !== null
        ? { ...controls, autoBias: this.guidanceBias }
        : controls;
      for (let i = 0; i < substeps; i++) {
        this.telemetry = stepRocketPhysics(this.state, flown, dt, this.mission);
        const failure = checkLimits(this.state, this.telemetry, this.mission);
        if (failure) {
          this._fail(failure);
          break;
        }
        if (this.state.missionTime > MAX_MISSION_TIME) {
          this._fail({ kind: "timeout", reason: "Flight exceeded the mission clock." });
          break;
        }
      }
      this._trackMilestones();
      this._runAssists(scaled);
    }

    this._maxQ = Math.max(this._maxQ, this.telemetry.dynamicPressure);
    this._maxG = Math.max(this._maxG, this.telemetry.acceleration);
    this._maxAltitude = Math.max(this._maxAltitude, this.telemetry.altitude);

    this.elapsed += rawDt;
    this._syncVehicle();
    this._updateEffects(rawDt, scaled, controls);
    return this.telemetry;
  }

  /**
   * Recommended pitch bias, or null below the engage altitude. See the
   * guidance block in ascentConfig.js for the law.
   */
  _flightDirector() {
    const t = this.telemetry;
    const g = this.mission.guidance;
    const limits = this.mission.limits;
    if (t.altitude < g.engageAltitude || t.dynamicPressure > limits.angleOfAttackQThreshold) {
      return null;
    }
    const thrustAccel = t.mass > 0 ? t.thrust / t.mass : 0;
    // Engine out between stages: hold whatever bias is set.
    if (thrustAccel < 1) return this.state.pitchBias;

    const climb = THREE.MathUtils.clamp(
      (this.mission.orbit.targetAltitude - t.altitude) * g.altitudeGain,
      g.minClimb,
      g.maxClimb
    );
    const ay = (climb - t.verticalSpeed) * g.rateGain + t.effectiveGravity;
    const sinPitch = THREE.MathUtils.clamp(ay / thrustAccel, -0.35, 0.97);
    const pitch = THREE.MathUtils.radToDeg(Math.asin(sinPitch));
    const bias = pitch - programmedPitch(this.state.programAltitude);
    const a = this.mission.pitchAuthority;
    return THREE.MathUtils.clamp(bias, -a, a);
  }

  /** Automatic staging and cut-off, where the difficulty provides them. */
  _runAssists(missionDt) {
    if (this.status !== "flying") return;
    const s = this.state;
    const stage = activeStage(s);

    if (this.assists.autoStage && stage && stage.propellant <= 0 && s.stageIndex < s.stages.length - 1) {
      this._stageTimer += missionDt;
      if (this._stageTimer >= AUTO_STAGE_DELAY) {
        this._stageTimer = 0;
        this.stage();
      }
    } else {
      this._stageTimer = 0;
    }

    // Insertion is only ever attempted on the last stage.
    if (!this.assists.autoInsert || s.stageIndex < s.stages.length - 1) return;
    const evaluation = evaluateInsertion(this.telemetry, this.mission);
    if (!evaluation.passed) return;
    const target = this.mission.orbit.targetSpeed - this.mission.guidance.cutoffMargin;
    const dry = !stage || stage.propellant <= 0;
    if (this.telemetry.horizontalSpeed >= target || dry) this.attemptInsertion();
  }

  /** True while the flight is inside every insertion band — for HUD cues. */
  get inWindow() {
    if (this.status !== "flying") return false;
    return evaluateInsertion(this.telemetry, this.mission).passed;
  }

  _holdControls() {
    return {
      throttleUp: 0,
      throttleDown: 0,
      pitchUp: 0,
      pitchDown: 0,
      burn: false,
    };
  }

  _updateCountdown(dt) {
    this.countdown.update(dt, {
      onIgnition: () => {
        this.state.ignited = true;
        this.logEvent("ignition", "Ignition sequence start");
        this.audio?.startLaunchRumble();
        this.onIgnition?.();
      },
      onCallout: (line) => this.onCallout?.(line),
      onLiftoff: () => {
        this.status = "flying";
        // Release the hold-downs only now: the engines have been at full
        // thrust for several seconds already, clamped to the launcher.
        this.state.holdDownArmed = true;
        this.logEvent("liftoff", "Liftoff — the clock is running");
        this.pad.releaseArms();
        this.onLiftoff?.();
      },
    });
  }

  /** Fires one-shot mission events as the flight passes their conditions. */
  _trackMilestones() {
    const t = this.telemetry;
    const s = this.state;

    if (t.altitude > this.mission.pad.towerHeight && !this._eventFlags.has("towerClear")) {
      this.logEvent("towerClear", "Tower cleared");
    }
    if (t.mach >= 1 && !this._eventFlags.has("mach1")) {
      this.logEvent("mach1", "Mach 1");
    }
    // Max-Q is called as dynamic pressure starts falling again.
    if (
      !this._eventFlags.has("maxq") &&
      t.dynamicPressure < this._maxQ * 0.92 &&
      this._maxQ > 12000
    ) {
      this.logEvent("maxq", `Max-Q — ${(this._maxQ / 1000).toFixed(1)} kPa`);
    }
    if (t.altitude > this.mission.atmosphere.karmanLine && !this._eventFlags.has("karman")) {
      this.logEvent("karman", "Passing the Kármán line — out of the atmosphere");
    }

    // Warn once when the burning stage runs dry.
    const stage = activeStage(s);
    if (stage && stage.propellant <= 0) {
      const key = `burnout${s.stageIndex}`;
      if (!this._eventFlags.has(key)) {
        this.logEvent(key, `${stage.config.name} burnout — ready to stage`);
        this.onStageReady?.();
      }
    }
  }

  /** Player-commanded staging. */
  stage() {
    if (this.status !== "flying") return false;
    const current = activeStage(this.state);
    if (!current) return false;
    if (this.state.stageIndex >= this.state.stages.length - 1) return false;

    const index = this.state.stageIndex;
    const husk = separateStage(this.state);
    if (!husk) return false;

    const record = this.rocket.jettison(index);
    if (record) {
      // Push the spent stage back along the flight path so it visibly falls
      // away — real separation used retro-rockets to do exactly this.
      const pitchRad = THREE.MathUtils.degToRad(this.state.pitch);
      record.velocity
        .copy(this.state.velocity)
        .addScaledVector(
          new THREE.Vector3(Math.cos(pitchRad), Math.sin(pitchRad), 0),
          -husk.config.separationImpulse
        );
    }

    // Separation pyrotechnics: retro-rockets on the spent stage push it back,
    // ullage motors on the new stage settle its propellant before ignition.
    this._emitSeparationBurst();

    this.logEvent(
      `stage${index}`,
      `${husk.config.name} separation — ${this.mission.stages[index + 1].name} ignition`
    );

    // The escape tower goes shortly after second-stage ignition.
    if (index === 0) this.rocket.jettisonEscapeTower();

    this.onStaging?.(index);
    return true;
  }

  /**
   * Player-commanded engine cutoff and insertion attempt. This is the moment
   * the flight is graded on.
   */
  attemptInsertion() {
    if (this.status !== "flying") return;

    const evaluation = evaluateInsertion(this.telemetry, this.mission);
    this.state.commandedThrottle = this.state.stages[this.state.stageIndex]?.config.minThrottle ?? 0;
    this.state.ignited = false;
    this.state.throttle = 0;
    this.state.engineOn = false;

    const stats = this._buildStats(evaluation);

    if (evaluation.passed) {
      this.status = "inserted";
      this.state.inserted = true;
      this.result = {
        outcome: "orbit",
        title: "Orbit Achieved",
        reason: `Parking orbit at ${(this.telemetry.altitude / 1000).toFixed(0)} km, ${this.telemetry.horizontalSpeed.toFixed(0)} m/s. The stack is where it needs to be for trans-lunar injection.`,
        evaluation,
        stats,
      };
      this.logEvent("insertion", "Insertion confirmed — orbit achieved");
      this.onInsertion?.(true);
    } else {
      this.status = "failed";
      const missed = Object.values(evaluation.checks).find((c) => !c.pass);
      this.result = {
        outcome: "badOrbit",
        title: "Insertion Missed",
        reason: `Cut off outside the insertion band — ${missed.label.toLowerCase()} was ${missed.format(missed.value)} against a target of ${missed.bandFormat(missed.band)}. The stack will not stay up.`,
        evaluation,
        stats,
      };
      this.onInsertion?.(false);
    }
  }

  _fail(failure) {
    if (this.result) return;
    this.status = "failed";
    this.state.failed = true;
    this.state.engineOn = false;
    this.state.throttle = 0;

    this.result = {
      outcome: "lost",
      title: "Vehicle Lost",
      reason: failure.reason,
      evaluation: evaluateInsertion(this.telemetry, this.mission),
      stats: this._buildStats(null),
    };
    this.logEvent("failure", failure.reason);

    // Break-up: a bright expanding cloud at altitude.
    this._worldPos.set(this.telemetry.downrange, this.telemetry.altitude, 0);
    this.particles.emitCrash(this._worldPos, 2.4);
    this.onFailure?.(failure);
  }

  _buildStats(evaluation) {
    const remaining = this.state.stages
      .slice(this.state.stageIndex)
      .reduce((sum, s) => sum + s.propellant, 0);

    return {
      altitude: this.telemetry.altitude,
      downrange: this.telemetry.downrange,
      horizontalSpeed: this.telemetry.horizontalSpeed,
      verticalSpeed: this.telemetry.verticalSpeed,
      flightPathAngle: this.telemetry.flightPathAngle,
      maxQ: this._maxQ,
      maxG: this._maxG,
      maxAltitude: this._maxAltitude,
      propellantRemaining: remaining,
      stageReached: this.telemetry.stageName,
      missionTime: this.state.missionTime,
      evaluation,
      score: evaluation ? this._score(evaluation) : 0,
    };
  }

  /**
   * Insertion is scored on how centred it is in the target band, plus the
   * propellant left for the burn that follows.
   */
  _score(evaluation) {
    if (!evaluation.passed) return 0;
    const o = this.mission.orbit;

    const centred = (value, band) => {
      const mid = (band[0] + band[1]) / 2;
      const halfWidth = (band[1] - band[0]) / 2;
      return 1 - THREE.MathUtils.clamp(Math.abs(value - mid) / halfWidth, 0, 1);
    };

    const altScore = centred(this.telemetry.altitude, o.altitudeBand);
    const spdScore = centred(this.telemetry.horizontalSpeed, o.speedBand);
    const fpaScore = 1 - THREE.MathUtils.clamp(
      Math.abs(this.telemetry.flightPathAngle) / o.maxFlightPathAngle, 0, 1
    );

    // Propellant left in the third stage is what buys the trans-lunar burn.
    const s3 = this.state.stages[2];
    const propFraction = s3 ? s3.propellant / s3.config.propellant : 0;

    return Math.round(
      THREE.MathUtils.clamp(
        altScore * 26 + spdScore * 26 + fpaScore * 16 + propFraction * 32,
        0,
        100
      )
    );
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  _syncVehicle() {
    // Physics tracks the base of the burning stage; put it on the pad deck.
    this._worldPos.set(
      this.state.position.x,
      this.state.position.y + this.padDeckHeight,
      0
    );
    this.rocket.setTransform(this._worldPos, this.state.pitch, this.state.stageIndex);
  }

  _updateEffects(dt, scaledDt, controls) {
    const t = this.telemetry;
    const p = pressureRatio(t.altitude);

    this.rocket.updatePlume(this.state.throttle, p, this.state.stageIndex, this.elapsed);
    this.rocket.updateHusks(scaledDt, gravityAtAltitude(t.altitude));

    // Gimbal follows the pitch command plus whatever the program is asking
    // for, so the bells move even on an unattended ascent.
    const programDemand = THREE.MathUtils.clamp(
      (this.state.commandedPitch - this.state.pitch) / 6,
      -1,
      1
    );
    const pilotDemand = (controls?.pitchUp ?? 0) - (controls?.pitchDown ?? 0);
    this.rocket.updateGimbal(
      THREE.MathUtils.clamp(programDemand + pilotDemand, -1, 1),
      dt
    );

    // Ice shedding. A Saturn V stood for hours with cryogenic tanks, and the
    // frost that built up on the skin broke away in sheets the moment the
    // hold-downs released — one of the most recognisable things about the
    // first two seconds of the launch.
    if (this.state.liftedOff && t.altitude < 260) {
      this._emitIceShedding(dt, t.altitude);
    }

    this.pad.update(dt, t.altitude, this.elapsed);
    this.pad.updateArms(dt);

    // Exhaust cloud rolling out of the flame trench during the first seconds.
    if (this.state.engineOn && t.altitude < 400) {
      const intensity = this.state.throttle * (1 - t.altitude / 400);
      this._emitPadExhaust(intensity, dt);
    }

    this._emitExhaustTrail(p);
  }

  /**
   * The exhaust trail: the long white column that is the most recognisable
   * thing in launch footage. Dense low down, thinning with the air, gone by
   * the upper stratosphere. Emitted by distance travelled rather than per
   * frame, and interpolated along the path, so time warp leaves no gaps.
   */
  _emitExhaustTrail(pressure) {
    const s = this.state;
    const nozzle = this._trailNozzle.copy(this.vehicleWorldPosition);
    const last = this._trailLast;
    const active = s.engineOn && s.liftedOff && pressure > TRAIL_MIN_PRESSURE && this.telemetry.altitude > 60;
    if (!active) {
      this._trailPrimed = false;
      return;
    }
    if (!this._trailPrimed) {
      last.copy(nozzle);
      this._trailPrimed = true;
      return;
    }

    const travelled = nozzle.distanceTo(last);
    const count = Math.min(TRAIL_MAX_PER_FRAME, Math.floor(travelled / TRAIL_SPACING));
    if (count <= 0) return;

    // Thin air: the puffs start larger and spread faster, but there are fewer
    // of them and they fade sooner.
    const thin = 1 - pressure;
    const density = Math.pow(pressure, 0.35) * s.throttle;
    const v = s.velocity;
    for (let i = 1; i <= count; i++) {
      if (Math.random() > density) continue;
      const k = i / count;
      const x = last.x + (nozzle.x - last.x) * k;
      const y = last.y + (nozzle.y - last.y) * k;
      const z = last.z + (nozzle.z - last.z) * k;
      const jitter = 5 + thin * 18;
      this.particles.emitSmoke(
        x + (Math.random() - 0.5) * jitter,
        y + (Math.random() - 0.5) * jitter,
        z + (Math.random() - 0.5) * jitter,
        // A little of the vehicle's velocity, plus a spread.
        v.x * 0.04 + (Math.random() - 0.5) * 10,
        v.y * 0.04 + (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        14 + Math.random() * 12 * (1 - thin * 0.5),
        12 + thin * 30 + Math.random() * 6,
        3.5 + thin * 7
      );
    }
    last.copy(nozzle);
  }

  /**
   * The ring of solid-motor exhaust thrown out sideways at separation. Brief
   * and bright, and the clearest visual confirmation that staging happened.
   */
  _emitSeparationBurst() {
    const pitchRad = THREE.MathUtils.degToRad(this.state.pitch);
    const axis = new THREE.Vector3(Math.cos(pitchRad), Math.sin(pitchRad), 0);
    const origin = this._worldPos.clone().addScaledVector(axis, -2);

    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2 + Math.random() * 0.3;
      // Fire radially outward, perpendicular to the stack.
      const radial = new THREE.Vector3(-Math.sin(pitchRad), Math.cos(pitchRad), 0)
        .multiplyScalar(Math.cos(a))
        .addScaledVector(new THREE.Vector3(0, 0, 1), Math.sin(a));
      const speed = 22 + Math.random() * 38;
      this.particles.sparks.spawn(
        origin.x, origin.y, origin.z,
        this.state.velocity.x + radial.x * speed,
        this.state.velocity.y + radial.y * speed,
        radial.z * speed,
        0.35 + Math.random() * 0.5,
        0.2 + Math.random() * 0.4
      );
    }
  }

  /**
   * Sheets of frost breaking off the cryogenic tanks and tumbling away past
   * the vehicle. Heaviest at the moment of release, gone within a few
   * hundred metres as the ice runs out.
   */
  _emitIceShedding(dt, altitude) {
    const intensity = 1 - THREE.MathUtils.clamp(altitude / 260, 0, 1);
    // Heavy in the first moments — the whole skin sheds at once — then falls
    // away quickly as the ice runs out.
    const rate = 320 * intensity * intensity;
    this._iceAcc = (this._iceAcc ?? 0) + rate * dt;

    const stack = this.rocket.stageGroups;
    let height = 0;
    for (let i = this.state.stageIndex; i < stack.length; i++) height += stack[i].height;

    while (this._iceAcc >= 1) {
      this._iceAcc -= 1;
      // Spawn on the skin of the vehicle and fall away behind it.
      const a = Math.random() * Math.PI * 2;
      const r = 5.2;
      const up = Math.random() * height;
      this.particles.debris.spawn(
        this._worldPos.x + Math.cos(a) * r,
        this._worldPos.y + up,
        Math.sin(a) * r,
        Math.cos(a) * (2 + Math.random() * 5),
        // Shed ice is left behind immediately by an accelerating vehicle.
        this.state.velocity.y * 0.25 - Math.random() * 8,
        Math.sin(a) * (2 + Math.random() * 5),
        1.6 + Math.random() * 2.2,
        0.22 + Math.random() * 0.5
      );
    }
  }

  /**
   * The enormous cloud that boils out of the trench at liftoff. Unlike the
   * lunar dust this *is* in an atmosphere, so it billows, rises and lingers.
   */
  _emitPadExhaust(intensity, dt) {
    const rate = 420 * intensity;
    this._exhaustAcc = (this._exhaustAcc ?? 0) + rate * dt;
    while (this._exhaustAcc >= 1) {
      this._exhaustAcc -= 1;
      // Two jets, thrown out of both ends of the flame trench.
      const side = Math.random() < 0.5 ? -1 : 1;
      const along = side * (18 + Math.random() * 90);
      const spread = (Math.random() - 0.5) * 30;
      const speed = 26 + Math.random() * 46;
      this.particles.dust.spawn(
        along,
        2 + Math.random() * 8,
        spread,
        side * speed,
        6 + Math.random() * 16,
        (Math.random() - 0.5) * 16,
        2.6 + Math.random() * 3.4,
        4.5 + Math.random() * 7
      );
    }
  }

  /** Time acceleration, 1x to 8x. */
  setTimeScale(scale) {
    this.timeScale = THREE.MathUtils.clamp(scale, 1, 8);
    return this.timeScale;
  }

  cycleTimeScale(dir) {
    const steps = [1, 2, 4, 8];
    const i = steps.indexOf(this.timeScale);
    const next = THREE.MathUtils.clamp((i < 0 ? 0 : i) + dir, 0, steps.length - 1);
    return this.setTimeScale(steps[next]);
  }

  get vehicleHeight() {
    let h = 0;
    for (let i = this.state.stageIndex; i < this.rocket.stageGroups.length; i++) {
      h += this.rocket.stageGroups[i].height;
    }
    return h + 20; // payload stack above the last stage
  }

  get vehicleWorldPosition() {
    return this._worldPos;
  }

  dispose() {
    this.rocket.dispose();
    this.pad.dispose();
    this.earth.dispose();
    this.countdown.reset();
  }
}
