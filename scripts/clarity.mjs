import assert from "node:assert/strict";
import { chromium } from "playwright";
import { loadSettings, saveSettings } from "../src/ui/settings.js";

let stored = null;
globalThis.localStorage = {
  getItem: () => stored,
  setItem: (_key, value) => { stored = value; },
};
assert.equal(loadSettings().adaptiveResolution, false);
stored = JSON.stringify({ quality: "medium", adaptiveResolution: true, antialias: false, muted: true });
const migrated = loadSettings();
assert.equal(migrated.adaptiveResolution, false);
assert.equal(migrated.antialias, true);
assert.equal(migrated.quality, "medium");
assert.equal(migrated.muted, true);
saveSettings({ ...migrated, adaptiveResolution: true, antialias: false });
assert.equal(loadSettings().adaptiveResolution, true);
assert.equal(loadSettings().antialias, false);
console.log("PASS default clarity, old-settings migration and later user choices");

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => { if (msg.type() === "error" && !/favicon|GPU stall|SwiftShader/i.test(msg.text())) errors.push(msg.text()); });
    await page.goto(process.env.TEST_URL || "http://127.0.0.1:5173/");
    await page.waitForSelector("#screen-menu:not(.hidden)", { timeout: 120_000 });
    await page.waitForFunction(() => window.__game && window.__harness);
    const result = await page.evaluate(({ dpr }) => {
      const g = window.__game;
      const p = g.pipeline;
      window.requestAnimationFrame = () => 0;
      const check = (label) => {
        if (p.adaptive || p.renderScale !== 1) throw new Error(`${label}: unexpected resolution scaling`);
        if (g.canvas.width !== 1280 * dpr || g.canvas.height !== 720 * dpr) throw new Error(`${label}: canvas below native resolution`);
        if (p.composer.renderTarget1.width !== g.canvas.width || p.composer.renderTarget1.height !== g.canvas.height) throw new Error(`${label}: composer resolution mismatch`);
        if (!p.smaaPass.enabled && !p.fxaaPass.enabled) throw new Error(`${label}: no antialiasing`);
        const draw = p.composer.render;
        p.composer.render = () => {};
        try {
          // Exercise the actual frame path under a sustained slow-frame signal
          // without issuing 600 GPU-heavy draws.
          for (let i = 0; i < 600; i++) p.render(1 / 60, i / 60, 1 / 30);
        } finally {
          p.composer.render = draw;
        }
        if (p.renderScale !== 1) throw new Error(`${label}: resolution drifted`);
        p.render(0, 0);
        const image = g.canvas.toDataURL();
        p.render(0, 123);
        if (g.canvas.toDataURL() !== image) throw new Error(`${label}: time-dependent image noise`);
        const gl = p.renderer.getContext();
        if (gl.getError() !== gl.NO_ERROR) throw new Error(`${label}: WebGL error`);
      };
      const labels = [];
      for (const quality of ["low", "medium", "high"]) {
        g.settings.quality = quality;
        g.applySettings();
        check(`menu/${quality}`);
        labels.push(`menu/${quality}`);
      }
      if (dpr === 1) {
        g.startAscent({ autoplay: true });
        window.__harness.advanceAscent(20);
        check("launch"); labels.push("launch");
        g.startCoast({ autoplay: true });
        check("space"); labels.push("space");
        g.startLevel(1, { autoplay: true });
        window.__harness.hold();
        check("landing"); labels.push("landing");
        const gl = p.renderer.getContext();
        const sources = [];
        for (const info of p.renderer.info.programs) {
          for (const shader of gl.getAttachedShaders(info.program) || []) sources.push(gl.getShaderSource(shader));
        }
        if (sources.some((s) => /uniform float grain|time \* 137\.13/.test(s))) throw new Error("grain shader still compiled");
      }
      return { dpr, canvas: [g.canvas.width, g.canvas.height], checks: labels };
    }, { dpr });
    console.log(JSON.stringify(result));
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS native resolution, stable frames and antialiasing across quality presets, phases and DPR 1/2; no browser errors");
} finally {
  await browser.close();
}
