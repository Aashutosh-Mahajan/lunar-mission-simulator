import assert from "node:assert/strict";
import { chromium } from "playwright";
import Autoplay from "../src/levels/autoplay.js";

// Acceleration must preserve elapsed time, cap step size and stop at results.
const auto = new Autoplay();
auto.active = true;
for (const speed of [1, 2, 3]) {
  auto.setSpeed(speed);
  for (const dt of [1 / 144, 1 / 60, 1 / 45]) {
    const steps = [];
    auto.advance(dt, true, (step) => { steps.push(step); });
    assert.ok(Math.abs(steps.reduce((a, b) => a + b, 0) - dt * speed) < 1e-10);
    if (speed > 1) assert.ok(Math.max(...steps) <= 1 / 60);
    assert.ok(steps.length <= 4);
  }
}
for (const active of [false, true]) {
  auto.active = active;
  const steps = [];
  auto.advance(1 / 60, false, (dt) => { steps.push(dt); });
  assert.deepEqual(steps, [1 / 60]);
}
auto.active = true;
let calls = 0;
auto.advance(1 / 45, true, () => { calls++; return true; });
assert.equal(calls, 1);
auto.setSpeed(99);
assert.equal(auto.speed, 3);
console.log("PASS bounded steps, time ratios, inactive behavior and result cutoff");

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !/favicon|GPU stall|SwiftShader/i.test(msg.text())) errors.push(msg.text()); });
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:5173/");
  await page.waitForSelector("#screen-menu:not(.hidden)", { timeout: 120_000 });
  await page.waitForFunction(() => window.__harness && window.__game);
  await page.click('#screen-menu [data-autoplay-speed="3"]');
  assert.equal(await page.locator('#screen-menu [data-autoplay-speed="3"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('#autoplay-badge [data-autoplay-speed="3"]').getAttribute("aria-pressed"), "true");
  const checks = await page.evaluate(() => {
    const g = window.__game;
    const h = window.__harness;
    const rows = [];
    for (const speed of [1, 2, 3]) {
      g.autoplay.setSpeed(speed);
      g.startLevel(1, { autoplay: true });
      h.runLoop(1);
      const elapsed = g.runtime.elapsed;
      if (Math.abs(elapsed - speed) > 0.001) throw new Error(`wrong descent clock at ${speed}: ${elapsed}`);
      g.setPaused(true);
      h.runLoop(1);
      if (g.runtime.elapsed !== elapsed) throw new Error("pause advanced simulation");
      g.setPaused(false);
      const wall = h.runLoop(240 / speed, () => !!g.runtime.result);
      rows.push({ speed, phase: "descent", outcome: g.runtime.result?.outcome, wallSeconds: wall, flightSeconds: g.runtime.elapsed });
      if (g.runtime.result?.outcome !== "landed") throw new Error(`landing failed at ${speed}`);
      g.startAscent({ autoplay: true });
      h.runLoop(1);
      if (Math.abs(g.ascent.countdown.t - (10 - speed)) > 0.01) throw new Error("wrong countdown speed");
      g.toggleAutoplay();
      if (g.autoplay.active || g.ascent.timeScale !== 1) throw new Error("manual handback failed");
      // A one-off launch hides autoplay on its debrief. Its Continue buttons
      // must restore the pilot and selected speed in both following phases.
      g.toggleAutoplay();
      g._markAutoplayDebrief("asc-result-tag");
      document.getElementById("btn-asc-descent").click();
      if (!g.autoplay.active || g.autoplay.speed !== speed || g.mode !== "coast") throw new Error("orbit continuation lost autoplay");
      g._markAutoplayDebrief("coast-result-tag");
      document.getElementById("btn-coast-descend").click();
      if (!g.autoplay.active || g.autoplay.speed !== speed || g.mode !== "descent") throw new Error("landing continuation lost autoplay");
      h.runLoop(1);
      if (Math.abs(g.runtime.elapsed - speed) > 0.001) throw new Error("continued landing has wrong speed");
    }
    return rows;
  });
  console.log(JSON.stringify(checks, null, 2));
  // Complete the real chain, including launch, both burns, arrival and landing.
  const mission = await page.evaluate(async () => {
    const g = window.__game;
    g.autoplay.setSpeed(3);
    g.watchMission();
    let wall = 0;
    for (let leg = 0; leg < 3; leg++) {
      wall += window.__harness.runLoop(900, () => g.state === "transition" || g.state === "result" || (g.mode === "descent" && !!g.runtime?.result));
      if (g.state === "transition") await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { wall, mode: g.mode, outcome: g.runtime?.result?.outcome, speed: g.autoplay.speed };
  });
  console.log("Full mission:", mission);
  assert.equal(mission.outcome, "landed");
  assert.equal(mission.speed, 3);
  assert.deepEqual(errors, []);
  console.log("PASS speed controls, pause, handback, landings, full mission and browser errors");
} finally {
  await browser.close();
}
