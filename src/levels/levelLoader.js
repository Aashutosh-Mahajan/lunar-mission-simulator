import * as THREE from "three";
import Terrain from "../entities/Terrain.js";
import Lander from "../entities/Lander.js";
import { stepLanderPhysics, flightData, ventAccelAt } from "../physics/landerPhysics.js";
import { getLevelById } from "./levelConfig.js";
import { PHYSICS_FIXED_STEP, DUST_ONSET_ALTITUDE } from "../constants.js";

// ---------------------------------------------------------------------------
// One playthrough of a level: builds the terrain and lander, advances the
// hand-rolled flight physics, steps cannon-es purely for contact detection,
// and turns the first touchdown into a graded result.
//
// Touchdown is judged the way the real vehicle's survival was: descent rate,
// lateral drift, attitude, and the slope it settles on. Landing softly but
// away from the prepared pad is reported separately from wrecking it — a
// survivable landing that still misses the mission objective.
// ---------------------------------------------------------------------------

const OUT_OF_BOUNDS_MARGIN = 40;
const ALTITUDE_CEILING = 2200;
const SETTLE_TIME = 0.35;
const MAX_SAFE_SLOPE = 15; // degrees; steeper and the gear tips over
const CONTACT_PROBE_LENGTH = 1.7; // m, the LM's surface-sensing probes

export default class LevelRuntime {
  constructor({ scene, world, levelId, particles, assets, audio }) {
    this.scene = scene;
    this.world = world;
    this.particles = particles;
    this.assets = assets;
    this.audio = audio;

    this.config = getLevelById(levelId);
    this.elapsed = 0;
    this.result = null;
    this.status = "flying";

    this.terrain = new Terrain(scene, world, this.config, assets);
    this.lander = new Lander(scene, world, assets);
    this.lander.reset(this.config, this.terrain);

    particles.setTerrain(this.terrain);
    particles.reset();

    // Contact bookkeeping, refreshed every physics step.
    this._touchdown = null;
    this._settleTimer = 0;
    this._legsSeen = [false, false, false, false];
    this._hullStruck = false;
    this._pendingContacts = [];

    this.lander.onCollide = (info) => this._pendingContacts.push(info);

    this._tmpVec = new THREE.Vector3();
    this._plumeDir = new THREE.Vector3();
    this._contactPoint = new THREE.Vector3();
    this.telemetry = flightData(this.lander, this.terrain);
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt, controls) {
    this.terrain.update(dt);

    if (this.status === "flying") {
      this.elapsed += dt;
      this.diagnostics = stepLanderPhysics(this.lander, this.config, controls, dt, this.elapsed);
    }

    this.telemetry = flightData(this.lander, this.terrain);

    // --- Contact detection -----------------------------------------------
    this._pendingContacts.length = 0;
    this.world.step(PHYSICS_FIXED_STEP, dt, 4);
    if (this.status === "flying") this._processContacts();

    // --- Contact probes ---------------------------------------------------
    const probeTripped = this.telemetry.gearAltitude <= CONTACT_PROBE_LENGTH;
    if (probeTripped && !this.lander.state.contactProbe) {
      this.lander.state.contactProbe = true;
      this.audio?.contactLight();
    } else if (!probeTripped && this.telemetry.gearAltitude > CONTACT_PROBE_LENGTH * 1.6) {
      this.lander.state.contactProbe = false;
    }

    // --- Settling after first contact -------------------------------------
    if (this._touchdown && this.status === "flying") {
      this._settleTimer += dt;
      if (this._settleTimer >= SETTLE_TIME) this._resolveTouchdown();
    }

    if (this.status === "crashed") this.lander.updateWreck(dt, this.terrain);

    this._updateEffects(dt);
    this._checkBounds();

    this.lander.updateVisuals(dt, this.elapsed);
    return this.telemetry;
  }

  _processContacts() {
    const s = this.lander.state;
    for (const info of this._pendingContacts) {
      if (info.isHull) {
        // The descent stage or hull striking terrain is unsurvivable,
        // regardless of how gently it happened.
        this._hullStruck = true;
      }
      if (info.legIndex >= 0) {
        this._legsSeen[info.legIndex] = true;
        s.legsDown[info.legIndex] = true;
      }
    }

    const anyContact = this._hullStruck || this._legsSeen.some(Boolean);
    if (!anyContact || this._touchdown) return;

    // Freeze the flight state at the moment of first contact — this is what
    // determines whether the vehicle survives.
    const t = this.telemetry;

    // Lateral drift is measured *relative to the surface being landed on*.
    // On a traversing deck what matters to the gear is the closing speed
    // between vehicle and deck, not either one's speed over the ground —
    // matching the deck's motion is a perfect landing.
    const padVel = this.terrain.movingPad ? this.terrain.padVelocity : null;
    const relX = s.velocity.x - (padVel ? padVel.x : 0);
    const relZ = s.velocity.z - (padVel ? padVel.z : 0);
    const relativeHorizontal = padVel && this.terrain.isOnPad(s.position.x, s.position.z)
      ? Math.hypot(relX, relZ)
      : t.horizontalSpeed;

    this._touchdown = {
      verticalSpeed: Math.abs(Math.min(0, t.verticalSpeed)),
      horizontalSpeed: relativeHorizontal,
      groundSpeed: t.horizontalSpeed,
      tilt: t.tilt,
      position: s.position.clone(),
      hullStruck: this._hullStruck,
    };
    this._settleTimer = 0;

    // Kill remaining motion: the gear absorbs the stroke and the vehicle is
    // now resting (or wrecked) rather than flying.
    s.velocity.multiplyScalar(0.06);
    s.angularVelocity.multiplyScalar(0.1);

    const energy = THREE.MathUtils.clamp(this._touchdown.verticalSpeed / 3, 0.35, 3);
    for (let i = 0; i < 4; i++) {
      if (this._legsSeen[i]) {
        this.lander.footPosition(i, this._contactPoint);
        this.particles.emitTouchdownDust(this._contactPoint, energy);
      }
    }
    this.onTouchdownEffect?.(energy);
  }

  _resolveTouchdown() {
    const td = this._touchdown;
    const s = this.lander.state;
    const cfg = this.config;
    const limits = cfg.thresholds;

    const legsDown = this._legsSeen.filter(Boolean).length;
    const padDistance = this.terrain.distanceToPad(td.position.x, td.position.z);
    const onPad = padDistance <= this.terrain.padRadius;
    const slope = onPad ? 0 : this.terrain.slopeAt(td.position.x, td.position.z);

    const failures = [];
    if (td.hullStruck) failures.push("Hull struck the surface");
    if (td.verticalSpeed > limits.maxVerticalSpeed) {
      failures.push(`Descent rate ${td.verticalSpeed.toFixed(1)} m/s exceeded the ${limits.maxVerticalSpeed.toFixed(1)} m/s gear limit`);
    }
    if (td.horizontalSpeed > limits.maxHorizontalSpeed) {
      const relative = this.terrain.movingPad ? " relative to the deck" : "";
      failures.push(`Lateral drift ${td.horizontalSpeed.toFixed(1)} m/s${relative} exceeded the ${limits.maxHorizontalSpeed.toFixed(1)} m/s limit`);
    }
    if (td.tilt > limits.maxTilt) {
      failures.push(`Attitude ${td.tilt.toFixed(0)}° past the ${limits.maxTilt}° stability margin`);
    }
    if (slope > MAX_SAFE_SLOPE) {
      failures.push(`Settled on a ${slope.toFixed(0)}° slope and tipped over`);
    }

    const stats = {
      verticalSpeed: td.verticalSpeed,
      horizontalSpeed: td.horizontalSpeed,
      groundSpeed: td.groundSpeed,
      surfaceMoving: Boolean(this.terrain.movingPad),
      tilt: td.tilt,
      legsDown,
      padDistance,
      onPad,
      slope,
      fuelRemaining: s.fuel,
      fuelCapacity: s.fuelCapacity,
      rcsRemaining: s.rcsFuel,
      time: this.elapsed,
    };

    if (failures.length > 0) {
      this.status = "crashed";
      s.crashed = true;
      stats.score = 0;
      this.result = {
        outcome: "crashed",
        title: "Vehicle Lost",
        reason: failures[0],
        allReasons: failures,
        stats,
      };
      const energy = THREE.MathUtils.clamp(td.verticalSpeed / 4 + td.horizontalSpeed / 6, 0.5, 2.6);
      this.particles.emitCrash(td.position, energy);
      // Topple the wreck in the direction it was travelling.
      this.lander.startWreck(this.lander.state.velocity);
      this.onCrashEffect?.(energy);
    } else if (!onPad) {
      this.status = "landed";
      s.landed = true;
      stats.score = Math.round(this._score(stats) * 0.45);
      this.result = {
        outcome: "offTarget",
        title: "Down Safe · Off Target",
        reason: `Soft landing ${padDistance.toFixed(0)} m from the pad — the vehicle is intact but the site was missed.`,
        allReasons: [],
        stats,
      };
      this.onLandedEffect?.(false);
    } else {
      this.status = "landed";
      s.landed = true;
      stats.score = Math.round(this._score(stats));
      this.result = {
        outcome: "landed",
        title: "Touchdown Confirmed",
        reason: `Contact light, engine stop. ${legsDown} of 4 pads down, ${padDistance.toFixed(1)} m from pad centre.`,
        allReasons: [],
        stats,
      };
      this.onLandedEffect?.(true);
    }
  }

  /**
   * Mission score out of 100: mostly propellant margin (the metric that
   * actually mattered on Apollo), plus accuracy and how gently it was set
   * down.
   */
  _score(stats) {
    const limits = this.config.thresholds;
    const fuelFrac = stats.fuelCapacity > 0 ? stats.fuelRemaining / stats.fuelCapacity : 0;
    const accuracy = 1 - THREE.MathUtils.clamp(stats.padDistance / this.terrain.padRadius, 0, 1);
    const soft =
      1 -
      THREE.MathUtils.clamp(
        stats.verticalSpeed / limits.maxVerticalSpeed * 0.6 +
          stats.horizontalSpeed / limits.maxHorizontalSpeed * 0.25 +
          stats.tilt / limits.maxTilt * 0.15,
        0,
        1
      );
    return THREE.MathUtils.clamp(fuelFrac * 48 + accuracy * 27 + soft * 25, 0, 100);
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  _updateEffects(dt) {
    const s = this.lander.state;
    const t = this.telemetry;

    // Engine plume, aligned with the nozzle and cut short by the ground.
    const origin = this.lander.enginePosition(this._tmpVec);
    this._plumeDir.copy(this.lander.upVector()).negate();
    this.particles.updatePlume(
      origin,
      this._plumeDir,
      this.status === "flying" ? s.throttle : 0,
      t.altitude,
      this.elapsed
    );

    // Regolith sheet, once the plume actually reaches the surface.
    if (this.status === "flying" && s.throttle > 0.05 && t.altitude < DUST_ONSET_ALTITUDE) {
      this._contactPoint.set(
        s.position.x,
        this.terrain.heightAt(s.position.x, s.position.z),
        s.position.z
      );
      this.particles.emitGroundDust(this._contactPoint, s.throttle, t.altitude, dt);
    }

    // Vent geysers.
    if (this.config.vents) {
      for (const v of this.config.vents) {
        const pulse = Math.max(0, Math.sin(this.elapsed * v.rate + (v.phase ?? 0)));
        if (pulse > 0.25) {
          this.particles.emitVent(
            v.x,
            this.terrain.heightAt(v.x, v.z),
            v.z,
            pulse * v.strength * 0.7,
            dt
          );
        }
      }
    }
  }

  _checkBounds() {
    if (this.status !== "flying") return;
    const s = this.lander.state;
    const limit = this.terrain.half - OUT_OF_BOUNDS_MARGIN;

    if (Math.abs(s.position.x) > limit || Math.abs(s.position.z) > limit) {
      this._abort("Flew outside the surveyed landing area");
    } else if (s.position.y - this.telemetry.surfaceHeight > ALTITUDE_CEILING) {
      this._abort("Climbed out of the descent corridor");
    } else if (s.position.y < this.terrain.minHeight - 120) {
      this._abort("Contact lost below the surface datum");
    }
  }

  _abort(reason) {
    this.status = "crashed";
    this.lander.state.crashed = true;
    this.result = {
      outcome: "aborted",
      title: "Mission Aborted",
      reason,
      allReasons: [reason],
      stats: {
        verticalSpeed: Math.abs(this.telemetry.verticalSpeed),
        horizontalSpeed: this.telemetry.horizontalSpeed,
        tilt: this.telemetry.tilt,
        legsDown: 0,
        padDistance: this.terrain.distanceToPad(
          this.lander.state.position.x,
          this.lander.state.position.z
        ),
        onPad: false,
        slope: 0,
        fuelRemaining: this.lander.state.fuel,
        fuelCapacity: this.lander.state.fuelCapacity,
        rcsRemaining: this.lander.state.rcsFuel,
        time: this.elapsed,
        score: 0,
      },
    };
  }

  /** True once the vehicle has made first contact, before the result resolves. */
  get hasTouchedDown() {
    return this._touchdown !== null;
  }

  /** Vent acceleration at the vehicle, for the HUD's disturbance indicator. */
  currentVentAccel() {
    const s = this.lander.state;
    return ventAccelAt(
      this.config,
      s.position.x,
      s.position.y,
      s.position.z,
      this.elapsed,
      this._tmpVec.clone()
    );
  }

  dispose() {
    this.lander.dispose();
    this.terrain.dispose();
    this.particles.setTerrain(null);
  }
}
