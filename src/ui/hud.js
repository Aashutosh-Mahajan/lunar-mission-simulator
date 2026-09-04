import * as THREE from "three";

// ---------------------------------------------------------------------------
// Flight instruments. Plain DOM/SVG overlay driven from the simulation state
// each frame (per the project convention: no in-3D text).
//
// The two round instruments mirror what the LM crew actually flew on: an
// attitude display showing lean magnitude and direction against the gear's
// stability limit, and a cross-pointer showing lateral drift together with
// where the landing site sits relative to the nose.
// ---------------------------------------------------------------------------

const MAX_DISPLAY_TILT = 45; // degrees at the outer edge of the attitude dial
const INSTRUMENT_RADIUS = 88;
const LPD_MAX_RANGE = 220; // m mapped to the edge of the cross-pointer
const LPD_MAX_DRIFT = 8; // m/s mapped to a full-length velocity vector

function el(id) {
  return document.getElementById(id);
}

export default class Hud {
  constructor() {
    this.dom = {
      site: el("hud-site"),
      met: el("hud-met"),
      camera: el("hud-camera"),

      alt: el("hud-alt"),
      vs: el("hud-vs"),
      hs: el("hud-hs"),
      tilt: el("hud-tilt"),
      range: el("hud-range"),
      gravity: el("hud-gravity"),

      gaugeVs: el("gauge-vs"),
      gaugeHs: el("gauge-hs"),
      gaugeTilt: el("gauge-tilt"),
      limitVs: el("limit-vs"),
      limitHs: el("limit-hs"),
      limitTilt: el("limit-tilt"),

      fuel: el("hud-fuel"),
      throttle: el("hud-throttle"),
      rcs: el("hud-rcs"),
      twr: el("hud-twr"),
      mass: el("hud-mass"),
      gaugeFuel: el("gauge-fuel"),
      gaugeThrottle: el("gauge-throttle"),
      gaugeRcs: el("gauge-rcs"),
      markMinThrottle: el("mark-min-throttle"),

      pillSas: el("pill-sas"),
      pillEngine: el("pill-engine"),

      attMarker: el("att-marker"),
      attMarkerCircle: document.querySelector("#att-marker .inst-marker"),
      attMarkerLine: document.querySelector("#att-marker .inst-marker-line"),
      attSafe: el("att-safe"),
      attPadNeedle: el("att-pad-needle"),

      lpdPad: el("lpd-pad"),
      lpdVel: el("lpd-vel"),
      lpdVelTip: el("lpd-vel-tip"),

      cwContact: el("cw-contact"),
      cwFuel: el("cw-fuel"),
      cwVel: el("cw-vel"),
      cwAtt: el("cw-att"),
      cwRcs: el("cw-rcs"),
      cwVent: el("cw-vent"),

      padLocator: el("pad-locator"),
      padLocatorArrow: document.querySelector("#pad-locator .pad-locator-arrow"),
      padLocatorRange: document.querySelector("#pad-locator .pad-locator-range"),

      hint: el("hud-hint"),
    };

    this._hintTimer = 0;
    this._fwd = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._padScreen = new THREE.Vector3();
    this.alarmActive = false;
  }

  setLevel(config) {
    this.config = config;
    this.dom.site.textContent = config.name;

    // Place the red limit ticks on the rate gauges. Each gauge spans twice
    // its limit, so the tick sits at the halfway point.
    this.dom.limitVs.style.left = "50%";
    this.dom.limitHs.style.left = "50%";
    this.dom.limitTilt.style.left = "50%";

    // Stability-limit ring on the attitude dial.
    const safeR = (config.thresholds.maxTilt / MAX_DISPLAY_TILT) * INSTRUMENT_RADIUS;
    this.dom.attSafe.setAttribute("r", safeR.toFixed(1));

    // Engine minimum-throttle marker.
    this.dom.markMinThrottle.style.left = "10%";
  }

  setCameraMode(label) {
    this.dom.camera.textContent = label;
  }

  showHint(text, duration = 3.4) {
    this.dom.hint.textContent = text;
    this.dom.hint.classList.add("show");
    this._hintTimer = duration;
  }

  /**
   * @param {LevelRuntime} runtime
   * @param {THREE.Camera} camera
   * @param {number} dt
   */
  update(runtime, camera, dt) {
    const lander = runtime.lander;
    const s = lander.state;
    const t = runtime.telemetry;
    const terrain = runtime.terrain;
    const limits = this.config.thresholds;

    // --- Hint timer -------------------------------------------------------
    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.dom.hint.classList.remove("show");
    }

    // --- Mission clock ----------------------------------------------------
    const mins = Math.floor(runtime.elapsed / 60);
    const secs = runtime.elapsed % 60;
    this.dom.met.textContent = `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;

    // --- Primary flight data ---------------------------------------------
    // Over a traversing deck, drift is shown relative to the deck — matching
    // its motion reads as zero drift, which is exactly the flying task.
    const drift = t.surfaceMoving ? t.relativeHorizontalSpeed : t.horizontalSpeed;

    this.dom.alt.textContent = t.gearAltitude.toFixed(1);
    this.dom.vs.textContent = t.verticalSpeed.toFixed(2);
    this.dom.hs.textContent = drift.toFixed(2);
    this.dom.tilt.textContent = t.tilt.toFixed(1);

    const range = terrain.distanceToPad(s.position.x, s.position.z);
    this.dom.range.textContent = range.toFixed(0);
    this.dom.gravity.textContent = (runtime.diagnostics?.gravity ?? 1.62).toFixed(2);

    // Rate gauges: full width = twice the limit, so the limit tick is mid-bar.
    const descentRate = Math.max(0, -t.verticalSpeed);
    this._gauge(this.dom.gaugeVs, descentRate / (limits.maxVerticalSpeed * 2), descentRate / limits.maxVerticalSpeed);
    this._gauge(this.dom.gaugeHs, drift / (limits.maxHorizontalSpeed * 2), drift / limits.maxHorizontalSpeed);
    this._gauge(this.dom.gaugeTilt, t.tilt / (limits.maxTilt * 2), t.tilt / limits.maxTilt);

    // Readout colouring: only nag about rates once close to the surface,
    // where they actually matter.
    const nearSurface = t.gearAltitude < 60;
    this._colour(this.dom.vs, nearSurface ? descentRate / limits.maxVerticalSpeed : 0);
    this._colour(this.dom.hs, nearSurface ? drift / limits.maxHorizontalSpeed : 0);
    this._colour(this.dom.tilt, t.tilt / limits.maxTilt);

    // --- Propulsion -------------------------------------------------------
    const fuelFrac = s.fuelCapacity > 0 ? s.fuel / s.fuelCapacity : 0;
    this.dom.fuel.textContent = s.fuel.toFixed(0);
    this.dom.gaugeFuel.style.width = `${fuelFrac * 100}%`;
    this.dom.gaugeFuel.className = `gauge-fill fuel${fuelFrac < 0.12 ? " warning" : fuelFrac < 0.28 ? " caution" : ""}`;
    this._colour(this.dom.fuel, fuelFrac < 0.12 ? 1.1 : fuelFrac < 0.28 ? 0.8 : 0);

    this.dom.throttle.textContent = (s.throttle * 100).toFixed(0);
    this.dom.gaugeThrottle.style.width = `${s.throttle * 100}%`;

    const rcsFrac = s.rcsFuelCapacity > 0 ? s.rcsFuel / s.rcsFuelCapacity : 0;
    this.dom.rcs.textContent = s.rcsFuel.toFixed(0);
    this.dom.gaugeRcs.style.width = `${rcsFrac * 100}%`;

    const gravity = runtime.diagnostics?.gravity ?? 1.62;
    const twr = (runtime.diagnostics?.thrustAccel ?? 0) / gravity;
    this.dom.twr.textContent = twr.toFixed(2);
    this.dom.mass.textContent = s.mass.toFixed(0);

    this.dom.pillSas.classList.toggle("on", s.stabiliser);
    this.dom.pillEngine.classList.toggle("on", s.engineOn);

    // --- Attitude dial ----------------------------------------------------
    lander.upVector(this._up);
    // Vehicle heading (yaw) so the dial is vehicle-relative.
    this._fwd.set(0, 0, 1).applyQuaternion(s.quaternion);
    const heading = Math.atan2(this._fwd.x, this._fwd.z);
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);

    // Lean direction, rotated from world into the vehicle's frame.
    const leanX = this._up.x * cosH - this._up.z * sinH;
    const leanZ = this._up.x * sinH + this._up.z * cosH;
    const leanLen = Math.hypot(leanX, leanZ) || 1e-6;
    const tiltR = Math.min(t.tilt / MAX_DISPLAY_TILT, 1.05) * INSTRUMENT_RADIUS;
    const mx = 100 + (leanX / leanLen) * tiltR;
    const my = 100 - (leanZ / leanLen) * tiltR;

    this.dom.attMarkerCircle.setAttribute("cx", mx.toFixed(1));
    this.dom.attMarkerCircle.setAttribute("cy", my.toFixed(1));
    this.dom.attMarkerLine.setAttribute("x2", mx.toFixed(1));
    this.dom.attMarkerLine.setAttribute("y2", my.toFixed(1));
    this.dom.attMarkerCircle.classList.toggle("warning", t.tilt > limits.maxTilt);

    // Bearing to the pad, as a needle around the dial rim.
    this._delta.subVectors(terrain.padCenter, s.position);
    const padX = this._delta.x * cosH - this._delta.z * sinH;
    const padZ = this._delta.x * sinH + this._delta.z * cosH;
    const padBearing = Math.atan2(padX, padZ);
    this.dom.attPadNeedle.setAttribute(
      "transform",
      `rotate(${THREE.MathUtils.radToDeg(padBearing).toFixed(1)} 100 100)`
    );

    // --- Cross-pointer: drift and pad offset ------------------------------
    const padRangeNorm = Math.pow(THREE.MathUtils.clamp(range / LPD_MAX_RANGE, 0, 1), 0.55);
    const padDist = Math.hypot(padX, padZ) || 1e-6;
    const px = 100 + (padX / padDist) * padRangeNorm * INSTRUMENT_RADIUS;
    const py = 100 - (padZ / padDist) * padRangeNorm * INSTRUMENT_RADIUS;
    this.dom.lpdPad.setAttribute("transform", `translate(${(px - 100).toFixed(1)} ${(py - 100).toFixed(1)})`);

    // Velocity vector is drawn relative to the landing surface too, so on the
    // moving deck a centred needle really does mean "matched".
    const padVel = t.surfaceMoving ? terrain.padVelocity : null;
    const vWorldX = s.velocity.x - (padVel ? padVel.x : 0);
    const vWorldZ = s.velocity.z - (padVel ? padVel.z : 0);
    const velX = vWorldX * cosH - vWorldZ * sinH;
    const velZ = vWorldX * sinH + vWorldZ * cosH;
    const velNorm = THREE.MathUtils.clamp(drift / LPD_MAX_DRIFT, 0, 1);
    const velLen = Math.hypot(velX, velZ) || 1e-6;
    const vx = 100 + (velX / velLen) * velNorm * 72;
    const vy = 100 - (velZ / velLen) * velNorm * 72;
    this.dom.lpdVel.setAttribute("x2", vx.toFixed(1));
    this.dom.lpdVel.setAttribute("y2", vy.toFixed(1));
    this.dom.lpdVelTip.setAttribute("cx", vx.toFixed(1));
    this.dom.lpdVelTip.setAttribute("cy", vy.toFixed(1));

    // --- Caution & warning ------------------------------------------------
    const ventAccel = runtime.diagnostics?.ventAccel ?? 0;
    const velWarn = nearSurface &&
      (descentRate > limits.maxVerticalSpeed || drift > limits.maxHorizontalSpeed);
    const attWarn = t.tilt > limits.maxTilt;
    const fuelWarn = fuelFrac < 0.12;

    this._light(this.dom.cwContact, s.contactProbe, "ok");
    this._light(this.dom.cwFuel, fuelFrac < 0.28, fuelWarn ? "danger" : "on");
    this._light(this.dom.cwVel, velWarn, "danger");
    this._light(this.dom.cwAtt, attWarn, "danger");
    this._light(this.dom.cwRcs, rcsFrac < 0.2, "on");
    this._light(this.dom.cwVent, ventAccel > 0.12, "on");

    // Master caution sounds only for conditions that will lose the vehicle.
    this.alarmActive = runtime.status === "flying" && (velWarn || attWarn || fuelWarn);

    // --- Off-screen pad locator ------------------------------------------
    this._updatePadLocator(camera, terrain, range);
  }

  _updatePadLocator(camera, terrain, range) {
    this._padScreen.copy(terrain.padCenter).project(camera);
    const behind = this._padScreen.z > 1;
    const onScreen =
      !behind &&
      Math.abs(this._padScreen.x) < 0.94 &&
      Math.abs(this._padScreen.y) < 0.9;

    if (onScreen || range < 6) {
      this.dom.padLocator.classList.add("hidden");
      return;
    }

    this.dom.padLocator.classList.remove("hidden");

    let nx = this._padScreen.x;
    let ny = this._padScreen.y;
    if (behind) {
      // Behind the camera: point back the way we came.
      nx = -nx;
      ny = -1;
    }
    const len = Math.hypot(nx, ny) || 1e-6;
    const scale = 0.86 / len;
    nx *= Math.min(1, scale);
    ny *= Math.min(1, scale);

    const sx = (nx * 0.5 + 0.5) * window.innerWidth;
    const sy = (-ny * 0.5 + 0.5) * window.innerHeight;
    this.dom.padLocator.style.left = `${sx}px`;
    this.dom.padLocator.style.top = `${sy}px`;
    this.dom.padLocatorArrow.style.transform = `rotate(${THREE.MathUtils.radToDeg(Math.atan2(nx, ny)).toFixed(0)}deg)`;
    this.dom.padLocatorRange.textContent = `${range.toFixed(0)} m`;
  }

  _gauge(node, fillFrac, warnRatio) {
    node.style.width = `${THREE.MathUtils.clamp(fillFrac, 0, 1) * 100}%`;
    node.className = `gauge-fill${warnRatio > 1 ? " warning" : warnRatio > 0.7 ? " caution" : ""}`;
  }

  _colour(node, ratio) {
    node.classList.remove("caution", "warning", "good");
    if (ratio > 1) node.classList.add("warning");
    else if (ratio > 0.7) node.classList.add("caution");
  }

  _light(node, on, cls) {
    node.classList.remove("on", "danger", "ok");
    if (on) node.classList.add(cls);
  }

  reset() {
    this.dom.padLocator.classList.add("hidden");
    this.dom.hint.classList.remove("show");
    this._hintTimer = 0;
    this.alarmActive = false;
  }
}
