import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { FXAAPass } from "three/addons/postprocessing/FXAAPass.js";

// ---------------------------------------------------------------------------
// Rendering: physically-based, HDR, tone-mapped.
//
// The scene is lit with real-ish photometric contrast — unfiltered sunlight
// against near-black shadow — which needs an HDR pipeline and filmic tone
// mapping to survive being squeezed into a display. Bloom runs before tone
// mapping (in linear light, where it is physically meaningful), the grade
// pass adds lens character, and antialiasing runs last on the final LDR
// image.
// ---------------------------------------------------------------------------

/**
 * Lens/sensor character: vignette, subtle chromatic aberration toward the
 * frame edge, and animated sensor grain. Applied in linear space before tone
 * mapping so it behaves like an optical effect rather than a filter.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    vignette: { value: 0.85 },
    grain: { value: 0.035 },
    aberration: { value: 0.0016 },
    shadowTint: { value: new THREE.Color(0x0a1424) },
    exposure: { value: 1.0 },
    whiteBalance: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float vignette;
    uniform float grain;
    uniform float aberration;
    uniform float exposure;
    uniform vec3 shadowTint;
    uniform vec3 whiteBalance;
    varying vec2 vUv;

    // Integer-style hash (Hoskins). The usual fract(sin(dot(...))*43758.0)
    // trick is unusable here: at full-resolution fragment coordinates the
    // argument to sin() reaches ~1e6, where float precision collapses and the
    // "noise" degenerates into a regular cross-hatch across the whole frame.
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // Lateral chromatic aberration grows with distance from the axis,
      // as it does in a real lens.
      vec2 offset = c * aberration * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + offset).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - offset).b;

      col *= exposure;
      // Camera white balance (see RenderPipeline.setWhiteBalance).
      col *= whiteBalance;

      // Deep shadows pick up a faint cold cast — reflected starlight rather
      // than pure black, which reads better than crushed blacks.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += shadowTint * (1.0 - smoothstep(0.0, 0.06, luma)) * 0.5;

      // Vignette.
      float v = 1.0 - vignette * r2 * 1.15;
      col *= clamp(v, 0.0, 1.0);

      // Animated sensor grain, stronger in the shadows like real read noise.
      // Hashed on gl_FragCoord so it varies per *pixel*: hashing on a fixed
      // UV grid instead aliases against the render resolution and shows up as
      // a regular cross-hatch over the whole frame rather than as noise.
      float n = hash(gl_FragCoord.xy + vec2(time * 137.13, time * 91.71)) - 0.5;
      // Read noise is worst in the shadows, but never absent — floor it so
      // dark areas don't turn into a snowstorm.
      col += n * grain * (0.3 + 0.7 * (1.0 - smoothstep(0.0, 0.6, luma)));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// Adaptive resolution thresholds (seconds per frame).
// Dropping is quick; raising is slow and needs a wide margin. With symmetric
// thresholds a GPU sitting near the boundary flipped between two scales every
// couple of seconds, and the picture visibly softened and sharpened.
const ADAPT = {
  SLOW_FRAME: 1 / 45, // below ~45 fps, drop resolution
  FAST_FRAME: 1 / 75, // only above ~75 fps is there room to raise it again
  STEP: 0.1,
  MIN_SCALE: 0.55,
  COOLDOWN_DOWN: 1.5, // seconds after any change before dropping again
  COOLDOWN_UP: 6, // seconds after any change before raising
};

export default class RenderPipeline {
  constructor(canvas, scene, camera, settings) {
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA handles this in the composer
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure is set per phase by the shell (setSceneExposure): each scene
    // is exposed like a photograph of itself.
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Adaptive resolution is on unless the player has explicitly turned it
    // off; it is what keeps integrated GPUs smooth.

    this._buildComposer();
    this.applySettings(settings);
    this.resize();
  }

  _buildComposer() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);

    // HDR float target so bloom and the grade pass work on real radiance.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
    });

    this.composer = new EffectComposer(this.renderer, target);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Bloom threshold is in linear HDR luminance, so it must sit *above* 1.0:
    // a sunlit diffuse surface already reads near 1, and thresholding below
    // that blooms the entire landscape into a haze. Only genuinely overbright
    // things — the sun, the nozzle glow, specular hotspots — should flare.
    // The threshold sits well above a sunlit white panel (~1.1 at the lunar
    // calibration in constants.js) so only specular glints, the sun and
    // genuinely hot things flare — not every lit surface.
    this.bloomPass = new UnrealBloomPass(size, 0.45, 0.5, 6.0);
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // Two antialiasing options. SMAA gives the cleanest edges but is three
    // full-screen passes (about 7 ms a frame on integrated graphics); FXAA is
    // one pass at a fraction of the cost. High uses SMAA, Medium FXAA.
    this.smaaPass = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.smaaPass);
    this.fxaaPass = new FXAAPass();
    this.composer.addPass(this.fxaaPass);
  }

  applySettings(settings) {
    this.settings = settings;
    const q = settings.quality;

    this.renderer.shadowMap.enabled = q !== "low";
    this.bloomPass.enabled = settings.bloom !== false;
    const aa = q !== "low" && settings.antialias !== false;
    this.smaaPass.enabled = aa && q === "high";
    this.fxaaPass.enabled = aa && q !== "high";
    this.gradePass.enabled = settings.grade !== false;

    this.adaptive = settings.adaptiveResolution !== false;
    this.bloomPass.strength = q === "high" ? 0.5 : 0.4;
    this.gradePass.uniforms.grain.value = settings.grade === false ? 0 : q === "high" ? 0.016 : 0.011;

    // Render scale multiplies the (capped) device pixel ratio in resize().
    // High used to set this to the device pixel ratio itself, which squared
    // it: on a DPR-2 laptop screen the scene rendered at 4x density — sixteen
    // times the pixels — through bloom and SMAA.
    this.maxRenderScale = q === "low" ? 0.75 : q === "high" ? 1 : 0.9;
    this.renderScale = this.maxRenderScale;
    this._frameAvg = 1 / 60;
    this._sinceChange = 0;
    this.resize();
  }

  /**
   * Adaptive resolution. Tracks a smoothed frame time and steps the render
   * scale down when the GPU cannot hold ~50 fps, and back up when there is
   * headroom. Changes are rate-limited because resizing reallocates every
   * render target in the composer.
   */
  _adaptResolution(dt) {
    if (!(dt > 0) || dt > 0.25) return; // tab switches, debugger pauses
    this._frameAvg += (dt - this._frameAvg) * 0.05;
    this._sinceChange = (this._sinceChange ?? 0) + dt;

    let next = this.renderScale;
    if (this._frameAvg > ADAPT.SLOW_FRAME && this._sinceChange > ADAPT.COOLDOWN_DOWN) {
      next = Math.max(ADAPT.MIN_SCALE, this.renderScale - ADAPT.STEP);
    } else if (this._frameAvg < ADAPT.FAST_FRAME && this._sinceChange > ADAPT.COOLDOWN_UP) {
      next = Math.min(this.maxRenderScale, this.renderScale + ADAPT.STEP);
    }
    if (Math.abs(next - this.renderScale) < 1e-3) return;

    this.renderScale = next;
    this._sinceChange = 0;
    this.resize();
    this.onResolutionChange?.();
  }

  setExposure(value) {
    this.gradePass.uniforms.exposure.value = value;
  }

  /**
   * Camera white balance for the current scene, as RGB gains. A camera on
   * the ground is balanced for sunlight that has come through the air —
   * which is genuinely yellow-orange next to the unfiltered sun in space — so
   * that a white vehicle photographs white. Eased like exposure.
   */
  setWhiteBalance(color, dt = 1) {
    const wb = this.gradePass.uniforms.whiteBalance.value;
    const k = 1 - Math.exp(-4 * Math.min(dt, 0.25));
    wb.r += (color.r - wb.r) * k;
    wb.g += (color.g - wb.g) * k;
    wb.b += (color.b - wb.b) * k;
  }

  /**
   * Photographic exposure for the current scene. Eased rather than snapped,
   * like a camera's auto-exposure settling, so changing phase or scene
   * brightness never pops.
   */
  setSceneExposure(value, dt = 1) {
    const r = this.renderer;
    const k = 1 - Math.exp(-4 * Math.min(dt, 0.25));
    const current = r.toneMappingExposure;
    // Ease in log space: exposure is perceived in stops.
    const next = Math.exp(Math.log(current) + (Math.log(value) - Math.log(current)) * k);
    r.toneMappingExposure = Math.abs(next - value) < 1e-3 ? value : next;
  }

  /** Brief exposure/vignette punch — used on impact. */
  flash(amount) {
    this._flash = amount;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio, 2) * (this.renderScale ?? 1);

    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param {number} dt simulation step (clamped by the shell)
   * @param {number} elapsed
   * @param {number} [frameTime] real, unclamped time since the last frame —
   *   what adaptive resolution needs to see
   */
  render(dt, elapsed, frameTime = dt) {
    if (this.adaptive) this._adaptResolution(frameTime);
    this.gradePass.uniforms.time.value = elapsed;

    if (this._flash) {
      this._flash = Math.max(0, this._flash - dt * 3.2);
      this.gradePass.uniforms.exposure.value = 1 + this._flash;
    } else if (this.gradePass.uniforms.exposure.value !== 1) {
      this.gradePass.uniforms.exposure.value = 1;
    }

    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose();
    this.renderer.dispose();
  }
}
