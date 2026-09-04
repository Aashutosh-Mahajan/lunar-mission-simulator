import { LOCAL_STORAGE_SETTINGS_KEY } from "../constants.js";

// Graphics settings, persisted locally. Defaults aim at "looks its best on a
// mid-range laptop"; Low drops shadows, postprocessing and render scale for
// integrated GPUs.

const DEFAULTS = {
  quality: "medium",
  bloom: true,
  grade: true,
  antialias: true,
  particles: 1,
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

  quality.value = settings.quality;
  bloom.checked = settings.bloom;
  grade.checked = settings.grade;
  aa.checked = settings.antialias;
  particles.value = String(settings.particles);

  const commit = () => {
    settings.quality = quality.value;
    settings.bloom = bloom.checked;
    settings.grade = grade.checked;
    settings.antialias = aa.checked;
    settings.particles = parseFloat(particles.value);
    saveSettings(settings);
    onChange(settings);
  };

  for (const node of [quality, bloom, grade, aa, particles]) {
    node.addEventListener("change", commit);
  }
}

/**
 * Picks a starting quality tier from what we can infer about the device, so
 * first-run performance is reasonable without the player hunting in menus.
 */
export function detectQuality() {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = navigator.deviceMemory ?? 8;
  if (cores <= 4 || mem <= 4) return "low";
  if (cores >= 8) return "high";
  return "medium";
}
