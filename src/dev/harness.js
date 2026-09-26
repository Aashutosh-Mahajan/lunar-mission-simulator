// ---------------------------------------------------------------------------
// Development test harness. Loaded only by the dev server (see main.js), never
// part of a production build.
//
// Flies each phase headlessly at a fixed step, the way a player would, so
// balance and assist changes can be checked against every site in seconds:
//
//   __harness.descent(level, difficulty, { view })   one descent
//   __harness.descentAll(difficulty)                  every site
//   __harness.ascent(difficulty, { stage, insert })   one launch
//   __harness.coast(difficulty)                       both burns
//
// The descent pilot is deliberately crude: it holds whichever W/A/S/D keys
// point at the pad, with a dead band, and nothing else. If that lands, a
// person can.
// ---------------------------------------------------------------------------

const DT = 1 / 60;

export function installHarness(game) {
  const descent = (levelId, difficulty = "cadet", opts = {}) => {
    game.settings.difficulty = difficulty;
    game.startLevel(levelId);
    const rt = game.runtime;
    const lander = rt.lander;
    const terrain = rt.terrain;
    const view = opts.view ?? { x: 0, z: 1 };
    const dead = opts.dead ?? 3;

    let t = 0;
    while (!rt.result && t < (opts.maxTime ?? 240)) {
      const c = game._neutralControls();
      c.view = view;
      const p = lander.state.position;
      const dx = terrain.padCenter.x - p.x;
      const dz = terrain.padCenter.z - p.z;
      const fwd = dx * view.x + dz * view.z;
      const right = dx * -view.z + dz * view.x;
      c.pitch = Math.abs(fwd) > dead ? Math.sign(fwd) : 0;
      c.roll = Math.abs(right) > dead ? Math.sign(right) : 0;
      opts.each?.(c, rt, t);
      rt.update(DT, c);
      t += DT;
    }

    const r = rt.result;
    if (!r) return { level: levelId, difficulty, outcome: "timeout", time: t };
    const s = r.stats ?? {};
    return {
      level: levelId,
      difficulty,
      outcome: r.outcome,
      score: s.score,
      vs: +(s.verticalSpeed ?? 0).toFixed(2),
      hs: +(s.horizontalSpeed ?? 0).toFixed(2),
      tilt: +(s.tilt ?? 0).toFixed(1),
      pad: +(s.padDistance ?? 0).toFixed(1),
      fuel: Math.round(s.fuelRemaining ?? 0),
      time: +t.toFixed(0),
      reason: r.outcome === "landed" ? undefined : r.reason,
    };
  };

  const format = (r) =>
    `L${r.level} ${r.difficulty} ${r.outcome} score=${r.score} vs=${r.vs} hs=${r.hs} ` +
    `tilt=${r.tilt} pad=${r.pad}m fuel=${r.fuel} t=${r.time}s${r.reason ? " — " + r.reason : ""}`;

  const descentAll = (difficulty = "cadet", opts = {}) => {
    const rows = [];
    for (let i = 1; i <= 6; i++) rows.push(format(descent(i, difficulty, opts)));
    return rows;
  };

  const ascent = (difficulty = "cadet", opts = {}) => {
    game.settings.difficulty = difficulty;
    game.startAscent();
    const a = game.ascent;
    const log = [];
    let t = 0;
    let lastStage = -1;
    while (!a.result && t < (opts.maxTime ?? 1000)) {
      const c = { throttleUp: 0, throttleDown: 0, pitchUp: 0, pitchDown: 0 };
      opts.each?.(c, a, t);
      a.update(DT, c);
      const tel = a.telemetry;
      if (opts.stage && a.status === "flying" && tel.stagePropellant <= 0) a.stage();
      if (tel.stageIndex !== lastStage) {
        lastStage = tel.stageIndex;
        log.push(`${t.toFixed(0)}s stage ${tel.stageName} alt=${(tel.altitude / 1000).toFixed(1)}km`);
      }
      t += DT;
    }
    const r = a.result;
    const s = r?.stats ?? {};
    return {
      outcome: r?.outcome ?? "timeout",
      score: s.score,
      reason: r?.reason,
      altKm: +((s.altitude ?? 0) / 1000).toFixed(1),
      hSpeed: Math.round(s.horizontalSpeed ?? 0),
      fpa: +(s.flightPathAngle ?? 0).toFixed(2),
      maxQ: Math.round((s.maxQ ?? 0) / 100) / 10,
      maxG: +(s.maxG ?? 0).toFixed(2),
      time: Math.round(t),
      log,
    };
  };

  // --- Visual checks: run a phase forward with its camera, then hold the
  // frame (paused, overlay hidden) so it can be screenshotted.
  const hold = () => {
    game.setPaused(true);
    document.getElementById("screen-pause")?.classList.add("hidden");
    game.screens.setCountdownVisible(false);
  };

  const advanceAscent = (seconds, controls = {}) => {
    const a = game.ascent;
    const base = { throttleUp: 0, throttleDown: 0, pitchUp: 0, pitchDown: 0, ...controls };
    const t0 = a.elapsed;
    if (game.state === "paused") game.setPaused(false);
    for (let i = 0; i < seconds * 60; i++) {
      a.update(DT, base);
      const handoff = game.ascentCamera.autoHandoff(a.telemetry.altitude);
      if (handoff) game.ascentHud.setCameraMode(handoff);
      game.ascentCamera.update(DT, a.state, a.vehicleWorldPosition, a.vehicleHeight, t0 + i * DT);
      a.earth.update(game.camera, a.telemetry.altitude, a.vehicleWorldPosition, DT);
      game.particles.update(DT);
      game.ascentHud.update(a, DT);
      if (a.result) break;
    }
    hold();
    return { altKm: +(a.telemetry.altitude / 1000).toFixed(1), camera: game.ascentCamera.mode, stage: a.telemetry.stageName };
  };

  const viewAscent = (seconds, difficulty = "cadet") => {
    game.settings.difficulty = difficulty;
    game.startAscent();
    return advanceAscent(seconds);
  };

  const viewDescent = (levelId, seconds = 1, { difficulty = "cadet", camera = "chase" } = {}) => {
    game.settings.difficulty = difficulty;
    game.startLevel(levelId);
    const rt = game.runtime;
    for (let i = 0; i < seconds * 60 && !rt.result; i++) rt.update(DT, game._neutralControls());
    game.cameraRig.setMode(camera);
    for (let i = 0; i < 200; i++) game.cameraRig.update(DT, rt.lander, rt.terrain, i * DT);
    hold();
    return { alt: Math.round(rt.telemetry.gearAltitude) };
  };

  /**
   * Drives the game's real frame loop — input, autoplay, every phase, the
   * debrief hand-offs — at a fixed 60 Hz, with rendering skipped for speed.
   * Returns seconds of game time run. Stops early when `until()` is true.
   */
  const runLoop = (seconds, until) => {
    const raf = window.requestAnimationFrame;
    const render = game.pipeline.render;
    window.requestAnimationFrame = () => 0;
    game.pipeline.render = () => {};
    let now = game.lastTime || performance.now();
    let frames = 0;
    try {
      for (let i = 0; i < seconds * 60; i++) {
        now += 1000 / 60;
        game.loop(now);
        frames++;
        if (until?.()) break;
      }
    } finally {
      window.requestAnimationFrame = raf;
      game.pipeline.render = render;
    }
    return frames / 60;
  };

  window.__harness = { descent, descentAll, ascent, format, advanceAscent, viewAscent, viewDescent, hold, runLoop };
}
