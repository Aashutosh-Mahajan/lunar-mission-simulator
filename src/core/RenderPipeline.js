import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";

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
    // Slight positive exposure: regolith is genuinely dark (albedo ~0.12), and
    // ACES rolls the low end off hard, so a neutral exposure renders the
    // surface muddier than the Apollo surface photography it should evoke.
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

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
    this.bloomPass = new UnrealBloomPass(size, 0.45, 0.5, 3.2);
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.smaaPass = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.smaaPass);
  }

  applySettings(settings) {
    this.settings = settings;
    const q = settings.quality;

    this.renderer.shadowMap.enabled = q !== "low";
    this.bloomPass.enabled = settings.bloom !== false;
    this.smaaPass.enabled = q !== "low" && settings.antialias !== false;
    this.gradePass.enabled = settings.grade !== false;

    this.bloomPass.strength = q === "high" ? 0.5 : 0.4;
    this.gradePass.uniforms.grain.value = settings.grade === false ? 0 : q === "high" ? 0.016 : 0.011;

    const scale = q === "low" ? 0.75 : q === "high" ? Math.min(window.devicePixelRatio, 2) : 1;
    this.renderScale = scale;
    this.resize();
  }

  setExposure(value) {
    this.gradePass.uniforms.exposure.value = value;
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

  render(dt, elapsed) {
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
