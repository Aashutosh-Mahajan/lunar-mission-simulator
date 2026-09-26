import { LOCAL_STORAGE_SETTINGS_KEY } from "../constants.js";

// Graphics settings, persisted locally. Defaults aim at "looks its best on a
// mid-range laptop"; Low drops shadows, postprocessing and render scale for
// integrated GPUs.

const DEFAULTS = {
  difficulty: "cadet",
  quality: "medium",
  bloom: true,
  grade: true,
  antialias: true,
  particles: 1,
  adaptiveResolution: true,
  muted: false,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_SETTINGS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(LOCAL_STORAGE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* non-fatal */
  }
}

/**
 * Wires the settings panel to a live settings object.
 * @param {object} settings
 * @param {(settings:object)=>void} onChange
 */
export function bindSettingsUi(settings, onChange) {
  const quality = document.getElementById("set-quality");
  const bloom = document.getElementById("set-bloom");
  const grade = document.getElementById("set-grade");
  const aa = document.getElementById("set-aa");
  const particles = document.getElementById("set-particles");
  const adaptive = document.getElementById("set-adaptive");

  quality.value = settings.quality;
  bloom.checked = settings.bloom;
  grade.checked = settings.grade;
  aa.checked = settings.antialias;
  particles.value = String(settings.particles);
  if (adaptive) adaptive.checked = settings.adaptiveResolution !== false;

  const commit = () => {
    settings.quality = quality.value;
    settings.bloom = bloom.checked;
    settings.grade = grade.checked;
    settings.antialias = aa.checked;
    settings.particles = parseFloat(particles.value);
    if (adaptive) settings.adaptiveResolution = adaptive.checked;
    saveSettings(settings);
    onChange(settings);
  };

  for (const node of [quality, bloom, grade, aa, particles, adaptive].filter(Boolean)) {
    node.addEventListener("change", commit);
  }
}

/**
 * Reads the GPU's name through a throwaway WebGL context. Returns "" when the
 * browser hides it.
 */
function gpuName() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return String(name ?? "");
  } catch {
    return "";
  }
}

/**
 * Picks a starting quality tier, so first-run performance is reasonable
 * without the player hunting in menus. The GPU is what decides this: the old
 * heuristic used CPU core count, which put integrated-graphics laptops with
 * eight-core CPUs on High.
 */
export function detectQuality() {
  const gpu = gpuName();
  if (/SwiftShader|llvmpipe|Basic Render|Software/i.test(gpu)) return "low";
  if (/NVIDIA|GeForce|RTX|GTX|Quadro|Radeon (RX|Pro)|Apple M\d/i.test(gpu)) return "high";
  if (/Intel|UHD|Iris|HD Graphics|Mali|Adreno|PowerVR|Radeon\(TM\) Graphics|Vega \d/i.test(gpu)) {
    return "medium";
  }

  // Unknown GPU: fall back to what the CPU and memory suggest.
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = navigator.deviceMemory ?? 8;
  if (cores <= 4 || mem <= 4) return "low";
  if (cores >= 8) return "high";
  return "medium";
}
