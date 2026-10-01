import * as THREE from "three";
import SpaceScene from "../scenes/spaceScene.js";
import Spacecraft from "../entities/Spacecraft.js";
import { applyCoastDifficulty, DEFAULT_DIFFICULTY } from "./difficulty.js";

// ---------------------------------------------------------------------------
// Phase 3 — trans-lunar injection and the coast to the Moon.
//
// Per the project brief this is a *scripted transition* into the descent, not
// another simulation: there is no orbital mechanics here, and the crossing is
// a timed sequence rather than an integrated trajectory. What is interactive
// is the burn itself — the one thing the crew actually did by hand-ish — and
// it is graded the same way the ascent's insertion is: hit the target inside a
// band, or arrive on a trajectory that misses.
//
// Sequence:
//   coast-out  brief parking-orbit hold before the burn window opens
//   tli        hold the engine until the delta-v target is met, then cut off
//   cruise     time-compressed crossing with milestones; Earth shrinks, Moon grows
//   loi        lunar orbit insertion burn
//   orbit      the stack settles into lunar orbit; the LM's gear comes down
//   undock     the LM separates, backs clear and turns its engine to the Moon
//   lmDescent  descent-orbit burn: the LM drops away toward the surface
//   arrived    hands off to the Phase 1 descent
//
// The last three are a scripted, hands-off sequence — the hand-over from the
// coast to the landing — and can be skipped with K like the crossing.
// ---------------------------------------------------------------------------

export const TLI_MISSION = {
  name: "Trans-Lunar Injection",
  // Real TLI was about 3040 m/s of delta-v over roughly a 350 s burn.
  targetDeltaV: 3040, // m/s
  deltaVBand: [2960, 3120],
  burnAcceleration: 8.6, // m/s^2 — S-IVB restart, light stack
  // Lunar orbit insertion, a shorter retrograde burn on the SPS.
  loiTargetDeltaV: 915,
  loiBand: [865, 965],
  loiAcceleration: 3.1,
  // Crossing took about three days; compressed to a couple of playable minutes.
  cruiseSeconds: 96,
  parkingHoldSeconds: 8,
  // The arrival sequence, in seconds of each step.
  orbitSeconds: 6,
  undockSeconds: 10,
  lmDescentSeconds: 9,
  milestones: [
    { at: 0.02, text: "S-IVB restart · trans-lunar injection complete" },
    { at: 0.12, text: "Transposition and docking · LM extracted from the adapter" },
    { at: 0.26, text: "S-IVB jettisoned onto a lunar impact trajectory" },
    { at: 0.44, text: "Passive thermal control · the stack rolls to even the heat load" },
    { at: 0.62, text: "Mid-course correction · trajectory nominal" },
    { at: 0.80, text: "Crossing into the Moon's sphere of influence" },
    { at: 0.94, text: "Lunar orbit insertion burn in one minute · standing by" },
  ],
};

export default class CoastRuntime {
  constructor({ scene, assets, audio, particles = null, difficulty = DEFAULT_DIFFICULTY }) {
    this.scene = scene;
    this.assets = assets;
    this.audio = audio;
    this.particles = particles;
    this.mission = applyCoastDifficulty(TLI_MISSION, difficulty);

    this.space = new SpaceScene(scene, assets);
    this.craft = new Spacecraft(scene, assets);

    this.phase = "parking";
    this.status = "flying";
    this.result = null;

    this.elapsed = 0;
    this.phaseTime = 0;
    this.journey = 0;
    this.timeScale = 1;

    this.deltaV = 0;
    this.loiDeltaV = 0;
    this.throttle = 0;
    this.engineOn = false;

    this.events = [];
    this._firedMilestones = new Set();
    this._eventFlags = new Set();

    this.craft.group.position.set(0, 0, 0);
    // Nose pointing along +Z so the chase camera looks down the stack.
    this.craft.group.rotation.set(Math.PI / 2, 0, 0);

    /**
     * What the camera should follow during the arrival sequence: the LM once
     * it is flying on its own. Null means "the stack".
     */
    this.focus = null;
    /** How far back the camera should sit from the focus. */
    this.focusDistance = 30;
    this._lmUndocked = false;
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  logEvent(key, text) {
    if (this._eventFlags.has(key)) return;
    this._eventFlags.add(key);
    this.events.push({ t: this.elapsed, text });
    this.onEvent?.(text);
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(rawDt, controls) {
    // Once the flight has resolved, stop integrating. The shell keeps calling
    // update() for a beat before the debrief appears, and without this the
    // burn would keep accumulating delta-v and the report would quote a
    // number the player never actually flew.
    if (this.result) {
      // After the arrival sequence the LM keeps flying down while the shell
      // hands over to the landing; nothing is graded any more.
      if (this.result.outcome === "arrived" && this._lmUndocked) {
        this.elapsed += rawDt;
        this.phaseTime += rawDt;
        this._updateLmDescent(rawDt);
        return this.telemetry;
      }
      this.throttle = 0;
      this.engineOn = false;
      this.craft.setEngine(0, this.elapsed);
      return this.telemetry;
    }

    // Time compression applies to the burns as well as the coast. A real TLI
    // burn ran about six minutes; holding a key for that long is not a game,
    // and warping it is exactly what a player would do anyway.
    const warpable = this.phase === "cruise" || this.phase === "tli" || this.phase === "loi";
    const dt = rawDt * (warpable ? this.timeScale : 1);
    this.elapsed += dt;
    this.phaseTime += dt;

    switch (this.phase) {
      case "parking":
        this._updateParking(dt);
        break;
      case "tli":
        this._updateBurn(dt, controls, "tli");
        break;
      case "cruise":
        this._updateCruise(dt);
        break;
      case "loi":
        this._updateBurn(dt, controls, "loi");
        break;
      case "orbit":
        this._updateOrbit(dt);
        break;
      case "undock":
        this._updateUndock(dt);
        break;
      case "lmDescent":
        this._updateLmDescent(dt);
        break;
      default:
        break;
    }

    // The CSM's own engine only burns for TLI and LOI.
    this.craft.setEngine(this.phase === "lmDescent" ? 0 : this.throttle, this.elapsed);
    // A slow roll, as the real stack held for thermal control.
    if (this.phase === "cruise") this.craft.group.rotation.y += dt * 0.06;
    // The high-gain antenna keeps chasing Earth through that roll.
    this.craft.aimAntenna(this.space.earthPosition, dt);

    return this.telemetry;
  }

  _updateParking(dt) {
    void dt;
    if (this.phaseTime > this.mission.parkingHoldSeconds) {
      this.phase = "tli";
      this.phaseTime = 0;
      this.logEvent("tliWindow", "TLI window open — hold SPACE to burn, I to cut off");
      this.onBurnWindow?.("tli");
    }
  }

  /**
   * The burn. Holding the engine accumulates delta-v; the player cuts off when
   * the gauge is inside the band. Overburning is as bad as underburning.
   */
  _updateBurn(dt, controls, which) {
    const isTli = which === "tli";
    const accel = isTli ? this.mission.burnAcceleration : this.mission.loiAcceleration;

    const want = controls.burn ? 1 : 0;
    this.throttle += (want - this.throttle) * (1 - Math.exp(-7 * dt));
    if (this.throttle < 0.01) this.throttle = 0;
    this.engineOn = this.throttle > 0.02;

    if (this.engineOn) {
      const gained = accel * this.throttle * dt;
      if (isTli) this.deltaV += gained;
      else this.loiDeltaV += gained;
      // The crossing only starts advancing once the vehicle is actually on
      // its way, so the burn visibly "throws" it toward the Moon.
      if (isTli) this.journey = Math.min(0.02, this.journey + dt * 0.002);
    }

    // Drop out of time warp as the band approaches, so a cut-off is never
    // missed simply because the clock was running fast.
    const current = isTli ? this.deltaV : this.loiDeltaV;
    const lower = (isTli ? this.mission.deltaVBand : this.mission.loiBand)[0];
    // Not needed when the computer cuts the engine off itself (Cadet and
    // autoplay): it stops on the target whatever the clock is doing.
    if (this.timeScale > 1 && current > lower - 220 && !this.mission.autoCutoff) {
      this.timeScale = 1;
      this.onWarpCancelled?.();
    }

    // A burn that runs far past the band is unrecoverable — call it there
    // rather than letting the player hold forever.
    const value = isTli ? this.deltaV : this.loiDeltaV;
    const band = isTli ? this.mission.deltaVBand : this.mission.loiBand;
    const target = isTli ? this.mission.targetDeltaV : this.mission.loiTargetDeltaV;
    // Cadet: the guidance computer shuts the engine down on the target, as
    // the real S-IVB and SPS did. The player only has to light it.
    if (this.mission.autoCutoff && value >= target) this._resolveBurn(which);
    else if (value > band[1] * 1.5) this._resolveBurn(which);
  }

  /** Player-commanded cut-off. */
  cutoff() {
    if (this.phase !== "tli" && this.phase !== "loi") return false;
    this._resolveBurn(this.phase);
    return true;
  }

  _resolveBurn(which) {
    if (this.result) return; // already decided
    const isTli = which === "tli";
    const value = isTli ? this.deltaV : this.loiDeltaV;
    const band = isTli ? this.mission.deltaVBand : this.mission.loiBand;
    const target = isTli ? this.mission.targetDeltaV : this.mission.loiTargetDeltaV;

    this.throttle = 0;
    this.engineOn = false;

    const inBand = value >= band[0] && value <= band[1];

    if (!inBand) {
      const over = value > band[1];
      this.status = "failed";
      this.result = {
        outcome: "badBurn",
        title: isTli ? "Trans-Lunar Injection Missed" : "Lunar Orbit Insertion Missed",
        reason: isTli
          ? over
            ? `Burned ${value.toFixed(0)} m/s against a ${target} m/s target — the stack is on a trajectory that overshoots the Moon entirely.`
            : `Cut off at ${value.toFixed(0)} m/s against a ${target} m/s target — not enough to leave Earth orbit. The stack falls back.`
          : over
            ? `Burned ${value.toFixed(0)} m/s retrograde against a ${target} m/s target — the stack drops into the surface rather than into orbit.`
            : `Cut off at ${value.toFixed(0)} m/s against a ${target} m/s target — too little to capture. The stack swings past the Moon and back toward Earth.`,
        stats: this._buildStats(),
      };
      this.onBurnResult?.(which, false);
      return;
    }

    if (isTli) {
      this.phase = "cruise";
      this.phaseTime = 0;
      this.timeScale = 1;
      this.logEvent("tliDone", `TLI cut-off at ${value.toFixed(0)} m/s — outbound for the Moon`);
      this.onBurnResult?.("tli", true);
    } else {
      // Captured. The arrival sequence plays before the hand-off.
      this.phase = "orbit";
      this.phaseTime = 0;
      this.timeScale = 1;
      this.logEvent("loiDone", `Lunar orbit insertion complete at ${value.toFixed(0)} m/s`);
      this.onBurnResult?.("loi", true);
    }
  }

  _arrive() {
    if (this.result) return;
    this.phase = "arrived";
    this.status = "arrived";
    this.engineOn = false;
    this.throttle = 0;
    this.result = {
      outcome: "arrived",
      title: "In Lunar Orbit",
      reason:
        "The stack is in a stable lunar parking orbit and the LM is on its way down. Take it to the surface.",
      stats: this._buildStats(),
    };
  }

  // -------------------------------------------------------------------------
  // Arrival sequence (scripted)
  // -------------------------------------------------------------------------

  /** Settling into lunar orbit: the Moon swings beneath, the gear comes down. */
  _updateOrbit(dt) {
    void dt;
    const T = this.mission.orbitSeconds;
    const k = Math.min(1, this.phaseTime / T);
    this.space.orbit = THREE.MathUtils.smoothstep(k, 0, 1);
    // The crew deployed the LM's legs in lunar orbit, before undocking.
    if (k > 0.35) {
      this.logEvent("gear", "LM landing gear deployed");
      this.craft.lander.setGearStowed(1 - THREE.MathUtils.smoothstep(k, 0.35, 0.95));
    }
    if (this.phaseTime >= T) {
      this.phase = "undock";
      this.phaseTime = 0;
      this.logEvent("undock", "Undocking · the LM backs away from the command module");
    }
  }

  /**
   * Separation: the LM is released from the command module, backs clear on
   * its RCS, and turns to put its descent engine toward the Moon.
   */
  _updateUndock(dt) {
    const lm = this.craft.lander;
    if (!this._lmUndocked) {
      this._lmUndocked = true;
      this.craft.lander.setGearStowed(false);
      // Free the LM into the scene, keeping its exact world placement.
      this.scene.attach(lm.group);
      this._lmStart = lm.group.position.clone();
      this._lmStartQuat = lm.group.quaternion.clone();
      this._craftStart = this.craft.group.position.clone();
      // The stack's long axis (the CSM's local +Y) in the world.
      this._axis = new THREE.Vector3(0, 1, 0).applyQuaternion(this.craft.group.quaternion).normalize();
      this.onUndock?.();
    }

    const T = this.mission.undockSeconds;
    const k = Math.min(1, this.phaseTime / T);
    // Back clear along the docking axis; the CSM drifts the other way.
    const sep = THREE.MathUtils.smoothstep(k, 0, 0.55);
    lm.group.position.copy(this._lmStart).addScaledVector(this._axis, sep * 14);
    this.craft.group.position.copy(this._craftStart).addScaledVector(this._axis, -sep * 4);

    // Then pitch round so the descent engine faces the Moon.
    const turn = THREE.MathUtils.smoothstep(k, 0.4, 1);
    const toMoon = this._v.copy(this.space.moonPosition).sub(lm.group.position).normalize();
    const upStart = new THREE.Vector3(0, 1, 0).applyQuaternion(this._lmStartQuat);
    const target = new THREE.Quaternion()
      .setFromUnitVectors(upStart, toMoon.clone().negate())
      .multiply(this._lmStartQuat);
    lm.group.quaternion.copy(this._lmStartQuat).slerp(target, turn);

    // RCS jets fire while it translates and turns.
    const s = lm.state;
    const thrusting = (k > 0.03 && k < 0.5) || (turn > 0.02 && turn < 0.98);
    s.rcsFiring.set(thrusting ? 0.8 : 0, 0, thrusting ? 0.5 : 0);
    s.engineOn = false;
    s.throttle = 0;
    lm.updateVisuals(dt, this.elapsed);

    // Frame the pair while they separate, then settle onto the LM.
    this._focus = this._focus ?? new THREE.Vector3();
    this.craft.group.updateMatrixWorld();
    const csm = this.craft.group.localToWorld(new THREE.Vector3(0, this.craft.height * 0.35, 0));
    this.focus = this._focus.copy(csm).lerp(lm.group.position, THREE.MathUtils.lerp(0.5, 1, turn));
    // Wide enough for both vehicles while they part, closing in on the LM.
    this.focusDistance = THREE.MathUtils.lerp(58, 32, turn);
    if (this.phaseTime >= T) {
      this.phase = "lmDescent";
      this.phaseTime = 0;
      s.rcsFiring.set(0, 0, 0);
      this.logEvent("doi", "Descent orbit insertion · the LM's engine lights");
      this.onLmIgnition?.();
    }
  }

  /** The LM's engine lights and it drops away toward the surface. */
  _updateLmDescent(dt) {
    const lm = this.craft.lander;
    const T = this.mission.lmDescentSeconds;
    const k = Math.min(1, this.phaseTime / T);

    // Throttle up, then accelerate down toward the Moon; the CSM is left
    // behind in orbit.
    const s = lm.state;
    s.engineOn = true;
    s.throttle = THREE.MathUtils.lerp(0.1, 0.65, THREE.MathUtils.smoothstep(k, 0, 0.3));
    this.throttle = s.throttle;
    this.engineOn = true;
    const toMoon = this._v.copy(this.space.moonPosition).sub(lm.group.position).normalize();
    const speed = 2 + this.phaseTime * 7;
    lm.group.position.addScaledVector(toMoon, speed * dt);
    // Keep the engine pointed down as the Moon's direction drifts.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(lm.group.quaternion);
    const correct = new THREE.Quaternion().setFromUnitVectors(up, toMoon.clone().negate());
    lm.group.quaternion.premultiply(new THREE.Quaternion().slerp(correct, 0.1));
    lm.updateVisuals(dt, this.elapsed);

    // The surface rises to meet it.
    this.space.approach = THREE.MathUtils.smoothstep(k, 0, 1);

    if (this.particles) {
      lm.group.updateMatrixWorld();
      const nozzle = lm.group.localToWorld(new THREE.Vector3(0, lm.engineExitY, 0));
      this.particles.updatePlume(nozzle, toMoon, s.throttle, 100, this.elapsed);
    }

    this.focus = lm.group.position;
    if (this.phaseTime >= T) this._arrive();
  }

  _updateCruise(dt) {
    this.journey = Math.min(1, this.journey + dt / this.mission.cruiseSeconds);

    for (const m of this.mission.milestones) {
      if (this._firedMilestones.has(m.at)) continue;
      if (this.journey >= m.at) {
        this._firedMilestones.add(m.at);
        this.logEvent(`ms${m.at}`, m.text);
      }
    }

    if (this.journey >= 1) {
      this.phase = "loi";
      this.phaseTime = 0;
      this.timeScale = 1;
      this.logEvent("loiWindow", "LOI window open — hold SPACE to burn retrograde, I to cut off");
      this.onBurnWindow?.("loi");
    }
  }

  _buildStats() {
    const tliError = Math.abs(this.deltaV - this.mission.targetDeltaV);
    const loiError = Math.abs(this.loiDeltaV - this.mission.loiTargetDeltaV);
    const inTli = this.deltaV >= this.mission.deltaVBand[0] && this.deltaV <= this.mission.deltaVBand[1];
    const inLoi = this.loiDeltaV >= this.mission.loiBand[0] && this.loiDeltaV <= this.mission.loiBand[1];

    // Accuracy of both burns, weighted toward the one that actually happened.
    const tliScore = inTli ? 1 - Math.min(1, tliError / 120) : 0;
    const loiScore = inLoi ? 1 - Math.min(1, loiError / 70) : 0;
    const score = this.phase === "arrived"
      ? Math.round(THREE.MathUtils.clamp(tliScore * 50 + loiScore * 50, 0, 100))
      : 0;

    return {
      tliDeltaV: this.deltaV,
      tliTarget: this.mission.targetDeltaV,
      tliBand: this.mission.deltaVBand,
      tliInBand: inTli,
      loiDeltaV: this.loiDeltaV,
      loiTarget: this.mission.loiTargetDeltaV,
      loiBand: this.mission.loiBand,
      loiInBand: inLoi,
      journey: this.journey,
      elapsed: this.elapsed,
      score,
    };
  }

  /** Time compression, available through the burns and the coast. */
  cycleTimeScale(dir) {
    if (this.phase !== "cruise" && this.phase !== "tli" && this.phase !== "loi") {
      return this.timeScale;
    }
    const steps = [1, 2, 4, 8];
    const i = steps.indexOf(this.timeScale);
    const next = THREE.MathUtils.clamp((i < 0 ? 0 : i) + dir, 0, steps.length - 1);
    this.timeScale = steps[next];
    return this.timeScale;
  }

  /** Skips the remainder of the crossing — it is a scripted sequence. */
  skipCruise() {
    if (this.phase === "orbit" || this.phase === "undock" || this.phase === "lmDescent") {
      // The arrival sequence is scripted too: jump to the hand-off.
      this.craft.lander.setGearStowed(false);
      this.space.orbit = 1;
      this.space.approach = 1;
      this._arrive();
      return true;
    }
    if (this.phase !== "cruise") return false;
    this.journey = 1;
    for (const m of this.mission.milestones) this._firedMilestones.add(m.at);
    this._updateCruise(0);
    return true;
  }

  get telemetry() {
    const isTli = this.phase === "tli";
    const isLoi = this.phase === "loi";
    return {
      phase: this.phase,
      journey: this.journey,
      deltaV: isLoi ? this.loiDeltaV : this.deltaV,
      target: isLoi ? this.mission.loiTargetDeltaV : this.mission.targetDeltaV,
      band: isLoi ? this.mission.loiBand : this.mission.deltaVBand,
      burning: this.engineOn,
      throttle: this.throttle,
      inBurnWindow: isTli || isLoi,
      timeScale: this.timeScale,
      elapsed: this.elapsed,
    };
  }

  dispose() {
    this.craft.dispose();
    this.space.dispose();
  }
}
