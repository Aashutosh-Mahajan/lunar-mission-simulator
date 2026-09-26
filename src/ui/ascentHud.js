import * as THREE from "three";
import { ASCENT_MISSION, programmedPitch } from "../levels/ascentConfig.js";

// ---------------------------------------------------------------------------
// Launch HUD. Instrument set is the one a launch actually needs: altitude,
// downrange, velocity split into its horizontal and vertical parts, dynamic
// pressure, acceleration, and a pitch tape showing the commanded gravity-turn
// angle against where the vehicle is actually pointing.
// ---------------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

export default class AscentHud {
  constructor() {
    this.dom = {
      met: el("asc-met"),
      camera: el("asc-camera"),
      timescale: el("asc-timescale"),
      phase: el("asc-phase"),

      altitude: el("asc-altitude"),
      downrange: el("asc-downrange"),
      speed: el("asc-speed"),
      vspeed: el("asc-vspeed"),
      hspeed: el("asc-hspeed"),
      mach: el("asc-mach"),

      stage: el("asc-stage"),
      stageProp: el("asc-stage-prop"),
      gaugeProp: el("gauge-asc-prop"),
      throttle: el("asc-throttle"),
      gaugeThrottle: el("gauge-asc-throttle"),
      twr: el("asc-twr"),
      mass: el("asc-mass"),
      accel: el("asc-accel"),
      gaugeAccel: el("gauge-asc-accel"),

      q: el("asc-q"),
      gaugeQ: el("gauge-asc-q"),
      aoa: el("asc-aoa"),
      gaugeAoa: el("gauge-asc-aoa"),

      pitchActual: el("asc-pitch"),
      pitchCmd: el("asc-pitch-cmd"),
      pitchNeedle: el("pitch-needle"),
      pitchCmdNeedle: el("pitch-cmd-needle"),
      pitchFdNeedle: el("pitch-fd-needle"),
      pitchFd: el("asc-pitch-fd"),
      pitchFdRow: el("asc-pitch-fd-row"),

      insertionFill: el("insertion-fill"),
      insertionAlt: el("insertion-alt"),
      insertionSpd: el("insertion-spd"),
      insertionFpa: el("insertion-fpa"),
      insertionPanel: el("insertion-panel"),

      cwStage: el("asc-cw-stage"),
      cwQ: el("asc-cw-q"),
      cwAoa: el("asc-cw-aoa"),
      cwG: el("asc-cw-g"),
      cwProp: el("asc-cw-prop"),
      cwInsert: el("asc-cw-insert"),

      log: el("asc-log"),
      hint: el("asc-hint"),
    };

    this._hintTimer = 0;
    this.alarmActive = false;
    this.mission = ASCENT_MISSION;
  }

  setCameraMode(label) {
    this.dom.camera.textContent = label;
  }

  setTimeScale(scale) {
    this.dom.timescale.textContent = `${scale}×`;
    this.dom.timescale.classList.toggle("warp", scale > 1);
  }

  showHint(text, duration = 4) {
    this.dom.hint.textContent = text;
    this.dom.hint.classList.add("show");
    this._hintTimer = duration;
  }

  pushLogEntry(t, text) {
    const line = document.createElement("div");
    line.className = "log-line";
    const mins = Math.floor(Math.abs(t) / 60);
    const secs = Math.abs(t) % 60;
    line.innerHTML = `<span class="log-time">T+${String(mins).padStart(2, "0")}:${secs.toFixed(0).padStart(2, "0")}</span> ${text}`;
    this.dom.log.prepend(line);
    while (this.dom.log.children.length > 6) {
      this.dom.log.removeChild(this.dom.log.lastChild);
    }
  }

  clearLog() {
    this.dom.log.innerHTML = "";
  }

  update(runtime, dt) {
    // The runtime's mission carries the difficulty's windows and limits; the
    // base config does not, so read it from the flight being flown.
    this.mission = runtime.mission;
    const t = runtime.telemetry;
    const s = runtime.state;
    const L = this.mission.limits;
    const O = this.mission.orbit;

    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.dom.hint.classList.remove("show");
    }

    // --- Clock and phase --------------------------------------------------
    const mt = s.missionTime;
    const mins = Math.floor(mt / 60);
    const secs = mt % 60;
    this.dom.met.textContent =
      runtime.status === "countdown"
        ? `T-${Math.max(0, runtime.countdown.t).toFixed(1)}`
        : `T+${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;

    this.dom.phase.textContent =
      runtime.status === "countdown"
        ? s.ignited ? "IGNITION" : "TERMINAL COUNT"
        : runtime.status === "flying"
          ? t.inAtmosphere ? "POWERED ASCENT" : "EXO-ATMOSPHERIC"
          : runtime.status === "inserted" ? "ORBIT" : "FLIGHT ENDED";

    // --- Trajectory --------------------------------------------------------
    this.dom.altitude.textContent =
      t.altitude < 10000 ? `${t.altitude.toFixed(0)}` : `${(t.altitude / 1000).toFixed(1)}k`;
    this.dom.downrange.textContent =
      Math.abs(t.downrange) < 10000
        ? `${t.downrange.toFixed(0)} m`
        : `${(t.downrange / 1000).toFixed(1)} km`;
    this.dom.speed.textContent = t.speed.toFixed(0);
    this.dom.vspeed.textContent = t.verticalSpeed.toFixed(0);
    this.dom.hspeed.textContent = t.horizontalSpeed.toFixed(0);
    this.dom.mach.textContent = t.inAtmosphere ? t.mach.toFixed(2) : "—";

    // --- Propulsion --------------------------------------------------------
    this.dom.stage.textContent = t.stageName;
    this.dom.stageProp.textContent = `${(t.stagePropellant / 1000).toFixed(0)} t`;
    this.dom.gaugeProp.style.width = `${t.stagePropellantFraction * 100}%`;
    this.dom.gaugeProp.className =
      `gauge-fill fuel${t.stagePropellantFraction < 0.08 ? " warning" : t.stagePropellantFraction < 0.2 ? " caution" : ""}`;

    this.dom.throttle.textContent = (t.throttle * 100).toFixed(0);
    this.dom.gaugeThrottle.style.width = `${t.throttle * 100}%`;
    this.dom.twr.textContent = t.twr.toFixed(2);
    this.dom.mass.textContent = `${(t.mass / 1000).toFixed(0)} t`;

    this.dom.accel.textContent = t.acceleration.toFixed(2);
    const gRatio = t.acceleration / L.maxAcceleration;
    this.dom.gaugeAccel.style.width = `${THREE.MathUtils.clamp(gRatio, 0, 1) * 100}%`;
    this._gaugeClass(this.dom.gaugeAccel, gRatio);
    this._valueClass(this.dom.accel, gRatio);

    // --- Aerodynamics ------------------------------------------------------
    this.dom.q.textContent = (t.dynamicPressure / 1000).toFixed(1);
    const qRatio = t.dynamicPressure / L.maxDynamicPressure;
    this.dom.gaugeQ.style.width = `${THREE.MathUtils.clamp(qRatio, 0, 1) * 100}%`;
    this._gaugeClass(this.dom.gaugeQ, qRatio);
    this._valueClass(this.dom.q, qRatio);

    const aoaMatters = t.dynamicPressure > L.angleOfAttackQThreshold;
    this.dom.aoa.textContent = aoaMatters ? t.angleOfAttack.toFixed(1) : "—";
    const aoaRatio = aoaMatters ? t.angleOfAttack / L.maxAngleOfAttack : 0;
    this.dom.gaugeAoa.style.width = `${THREE.MathUtils.clamp(aoaRatio, 0, 1) * 100}%`;
    this._gaugeClass(this.dom.gaugeAoa, aoaRatio);
    this._valueClass(this.dom.aoa, aoaRatio);

    // --- Pitch tape --------------------------------------------------------
    // 0-90 degrees mapped onto the tape. CMD is what the vehicle is actually
    // being steered to — the program *plus* the player's W/S bias. (It used to
    // show the bare program, so the needle the player was told to hold did
    // not move when they steered.) FD is the flight director's recommendation
    // once it engages: put CMD on FD and the insertion takes care of itself.
    this.dom.pitchActual.textContent = `${t.pitch.toFixed(1)}°`;
    this.dom.pitchCmd.textContent = `${t.commandedPitch.toFixed(1)}°`;
    const toPct = (p) => `${(1 - THREE.MathUtils.clamp(p, 0, 90) / 90) * 100}%`;
    this.dom.pitchNeedle.style.top = toPct(t.pitch);
    this.dom.pitchCmdNeedle.style.top = toPct(t.commandedPitch);

    const director = runtime.guidanceBias;
    const fdActive = director !== null && director !== undefined && runtime.status === "flying";
    this.dom.pitchFdNeedle.classList.toggle("hidden", !fdActive);
    this.dom.pitchFdRow.classList.toggle("dim", !fdActive);
    if (fdActive) {
      const fdPitch = programmedPitch(s.programAltitude) + director;
      this.dom.pitchFdNeedle.style.top = toPct(fdPitch);
      this.dom.pitchFd.textContent = runtime.assists?.autoGuidance ? "AUTO" : `${fdPitch.toFixed(1)}°`;
    } else {
      this.dom.pitchFd.textContent = "—";
    }

    // --- Insertion cue -----------------------------------------------------
    const altPass = t.altitude >= O.altitudeBand[0] && t.altitude <= O.altitudeBand[1];
    const spdPass =
      t.horizontalSpeed >= O.speedBand[0] && t.horizontalSpeed <= O.speedBand[1];
    const fpaPass = Math.abs(t.flightPathAngle) <= O.maxFlightPathAngle;

    this._pill(this.dom.insertionAlt, altPass, `${(t.altitude / 1000).toFixed(0)} km`);
    this._pill(this.dom.insertionSpd, spdPass, `${t.horizontalSpeed.toFixed(0)} m/s`);
    this._pill(this.dom.insertionFpa, fpaPass, `${t.flightPathAngle.toFixed(1)}°`);

    const readiness = Math.min(
      t.altitude / O.altitudeBand[0],
      t.horizontalSpeed / O.speedBand[0]
    );
    this.dom.insertionFill.style.width = `${THREE.MathUtils.clamp(readiness, 0, 1) * 100}%`;
    const ready = altPass && spdPass && fpaPass;
    this.dom.insertionPanel.classList.toggle("ready", ready);

    // --- Caution and warning ----------------------------------------------
    const stageReady = t.stagePropellant <= 0 && t.stageIndex < s.stages.length - 1;
    const propLow = t.stagePropellantFraction < 0.15;

    this._light(this.dom.cwStage, stageReady, "on");
    this._light(this.dom.cwQ, qRatio > 0.72, qRatio > 0.92 ? "danger" : "on");
    this._light(this.dom.cwAoa, aoaRatio > 0.6, aoaRatio > 0.85 ? "danger" : "on");
    this._light(this.dom.cwG, gRatio > 0.75, gRatio > 0.92 ? "danger" : "on");
    this._light(this.dom.cwProp, propLow, "on");
    this._light(this.dom.cwInsert, ready, "ok");

    this.alarmActive =
      runtime.status === "flying" && (qRatio > 0.92 || aoaRatio > 0.85 || gRatio > 0.92);
  }

  _gaugeClass(node, ratio) {
    node.className = `gauge-fill${ratio > 0.92 ? " warning" : ratio > 0.72 ? " caution" : ""}`;
  }

  _valueClass(node, ratio) {
    node.classList.remove("caution", "warning");
    if (ratio > 0.92) node.classList.add("warning");
    else if (ratio > 0.72) node.classList.add("caution");
  }

  _pill(node, pass, text) {
    node.textContent = text;
    node.classList.toggle("pass", pass);
    node.classList.toggle("fail", !pass);
  }

  _light(node, on, cls) {
    node.classList.remove("on", "danger", "ok");
    if (on) node.classList.add(cls);
  }

  reset() {
    this.clearLog();
    this.dom.hint.classList.remove("show");
    this._hintTimer = 0;
    this.alarmActive = false;
    this.dom.insertionPanel.classList.remove("ready");
  }
}
