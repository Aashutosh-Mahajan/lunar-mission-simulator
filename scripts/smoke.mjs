/**
 * Boot smoke test.
 *
 * The project has no unit tests, and the failures that have actually broken it
 * were runtime ones a build cannot catch: an invalid line of GLSL that made a
 * shader fail to compile, a module that threw on import. Both leave the build
 * perfectly green and the game stuck on the loading screen.
 *
 * So this serves the production build, loads it in a real browser, and asserts
 * that the game finishes booting and reaches its main menu without logging an
 * error. It is deliberately shallow — it proves the thing starts, nothing more.
 */

import { preview } from "vite";
import { chromium } from "playwright";

const BOOT_TIMEOUT_MS = 90_000;

// Errors that say nothing about our code. WebGL in CI runs on SwiftShader,
// which is noisier about performance than a real GPU driver.
const IGNORED = [
  /favicon/i,
  /GPU stall/i,
  /Automatic fallback to software WebGL/i,
  /SwiftShader/i,
];

const isRealError = (text) => !IGNORED.some((re) => re.test(text));

const server = await preview({ preview: { port: 4173, strictPort: true } });
const url = server.resolvedUrls.local[0];
console.log(`serving build at ${url}`);

const browser = await chromium.launch({
  // Headless Chromium has no GPU; route WebGL through ANGLE's software
  // rasteriser so the shaders actually compile instead of silently no-oping.
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const problems = [];
let exitCode = 0;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  page.on("console", (msg) => {
    if (msg.type() === "error" && isRealError(msg.text())) {
      problems.push(`console.error: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
  page.on("requestfailed", (req) => {
    if (isRealError(req.url())) {
      problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`);
    }
  });

  await page.goto(url, { waitUntil: "load", timeout: 30_000 });

  // Booting bakes every texture and generates the terrain, so this is slow by
  // design. The menu appearing is the signal that all of it succeeded.
  await page.waitForSelector("#screen-menu:not(.hidden)", { timeout: BOOT_TIMEOUT_MS });
  console.log("✓ reached the main menu");

  // A canvas that exists but never got a drawing context would still let the
  // menu show, so confirm WebGL really came up.
  const renderer = await page.evaluate(() => {
    const gl = document.getElementById("scene")?.getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "webgl2";
  });
  if (!renderer) throw new Error("no WebGL2 context on the scene canvas");
  console.log(`✓ WebGL2 context up (${renderer})`);

  // Every menu entry point should be wired.
  const buttons = ["btn-campaign", "btn-launch", "btn-fly", "btn-controls", "btn-settings"];
  const missing = await page.evaluate(
    (ids) => ids.filter((id) => !document.getElementById(id)),
    buttons
  );
  if (missing.length) throw new Error(`menu buttons missing: ${missing.join(", ")}`);
  console.log(`✓ ${buttons.length} menu actions present`);

  // Open the mission board — this instantiates the level list and is the
  // cheapest way to exercise a code path past the menu.
  await page.click("#btn-fly");
  await page.waitForSelector("#screen-sites:not(.hidden)", { timeout: 15_000 });
  const sites = await page.evaluate(() => document.querySelectorAll("#screen-sites .site-card").length);
  console.log(`✓ mission board rendered (${sites} sites)`);

  if (problems.length) throw new Error(`${problems.length} runtime problem(s)`);
  console.log("\nsmoke test passed");
} catch (err) {
  console.error(`\nsmoke test FAILED: ${err.message}`);
  exitCode = 1;
} finally {
  if (problems.length) {
    console.error("\nruntime problems:");
    for (const p of problems) console.error(`  - ${p}`);
  }
  await browser.close();
  await server.close();
}

process.exit(exitCode);
