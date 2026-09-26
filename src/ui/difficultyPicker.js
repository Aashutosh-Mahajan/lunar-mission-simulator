import { DIFFICULTIES, DIFFICULTY_ORDER, getDifficulty } from "../levels/difficulty.js";

// ---------------------------------------------------------------------------
// Main-menu difficulty picker. Writes the choice into the settings object
// (which persists it) and rewrites the control summary under the menu, since
// what W A S D and Space do differs between the assisted and manual settings.
// ---------------------------------------------------------------------------

const CONTROL_SUMMARY = {
  cadet: [
    ["W A S D", "fly toward"],
    ["Shift", "hover"],
    ["Ctrl", "descend faster"],
    ["C", "camera"],
  ],
  pilot: [
    ["Space", "main engine"],
    ["W A S D", "lean to steer"],
    ["G", "descent-rate hold"],
    ["C", "camera"],
  ],
  commander: [
    ["Space", "main engine"],
    ["W A S D", "attitude"],
    ["Shift / Ctrl", "throttle"],
    ["C", "camera"],
  ],
};

/**
 * @param {object} settings live settings object; `difficulty` is read/written
 * @param {(id:string)=>void} onChange called after the choice is saved
 */
export function bindDifficultyPicker(settings, onChange) {
  const picker = document.getElementById("difficulty-picker");
  const summary = document.getElementById("difficulty-summary");
  const foot = document.getElementById("menu-foot");
  if (!picker) return;

  const render = () => {
    const current = getDifficulty(settings.difficulty).id;
    for (const btn of picker.querySelectorAll(".diff-opt")) {
      const active = btn.dataset.diff === current;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    summary.textContent = DIFFICULTIES[current].summary;
    foot.innerHTML = CONTROL_SUMMARY[current]
      .map(([key, what]) => `<span><b>${key}</b> ${what}</span>`)
      .join("");
  };

  const choose = (id) => {
    settings.difficulty = id;
    render();
    onChange(id);
  };

  picker.addEventListener("click", (e) => {
    const btn = e.target.closest(".diff-opt");
    if (btn) choose(btn.dataset.diff);
  });

  // Arrow keys move between options, as a radio group should.
  picker.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = DIFFICULTY_ORDER.indexOf(getDifficulty(settings.difficulty).id);
    const next = DIFFICULTY_ORDER[(i + (e.key === "ArrowRight" ? 1 : -1) + DIFFICULTY_ORDER.length) % DIFFICULTY_ORDER.length];
    choose(next);
    picker.querySelector(`[data-diff="${next}"]`)?.focus();
    e.preventDefault();
    e.stopPropagation();
  });

  render();
}
