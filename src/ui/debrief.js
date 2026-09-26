import { DIFFICULTIES } from "../levels/difficulty.js";
// Mission report screen: grades the descent against the level's limits and
// shows which parameters were inside them.

const ARC_LENGTH = 327; // circumference of the r=52 score ring

function row(label, value, verdict) {
  const cls = verdict === true ? "pass" : verdict === false ? "fail" : "";
  return `<dt>${label}</dt><dd class="${cls}">${value}</dd>`;
}

/**
 * @param {object} result from LevelRuntime
 * @param {object} config level config
 * @param {object} bestInfo { best, improved } from the leaderboard
 * @param {boolean} hasNext
 */
export function renderDebrief(result, config, bestInfo, hasNext) {
  const stats = result.stats;
  const limits = config.thresholds;

  const titleEl = document.getElementById("result-title");
  titleEl.textContent = result.title;
  titleEl.className = `heading ${result.outcome}`;

  document.getElementById("result-tag").textContent =
    result.outcome === "landed" ? "Mission Accomplished" : "Mission Report";
  document.getElementById("result-reason").textContent = result.reason;

  const fuelPct = stats.fuelCapacity ? (stats.fuelRemaining / stats.fuelCapacity) * 100 : 0;

  const table = [
    row(
      "Descent rate at contact",
      `${stats.verticalSpeed.toFixed(2)} / ${limits.maxVerticalSpeed.toFixed(1)} m/s`,
      stats.verticalSpeed <= limits.maxVerticalSpeed
    ),
    row(
      stats.surfaceMoving ? "Drift relative to deck" : "Lateral drift",
      `${stats.horizontalSpeed.toFixed(2)} / ${limits.maxHorizontalSpeed.toFixed(1)} m/s`,
      stats.horizontalSpeed <= limits.maxHorizontalSpeed
    ),
    stats.surfaceMoving && Number.isFinite(stats.groundSpeed)
      ? row("Ground speed at contact", `${stats.groundSpeed.toFixed(2)} m/s`, null)
      : "",
    row(
      "Attitude",
      `${stats.tilt.toFixed(1)} / ${limits.maxTilt}°`,
      stats.tilt <= limits.maxTilt
    ),
    row(
      "Distance from pad centre",
      `${stats.padDistance.toFixed(1)} m`,
      stats.onPad
    ),
    row("Pads in contact", `${stats.legsDown} of 4`, stats.legsDown >= 3),
    row(
      "Propellant remaining",
      `${stats.fuelRemaining.toFixed(0)} kg · ${fuelPct.toFixed(0)}%`,
      stats.fuelRemaining > 0
    ),
    row("RCS remaining", `${stats.rcsRemaining.toFixed(0)} kg`, null),
    row("Time of descent", `${stats.time.toFixed(1)} s`, null),
    config.flightDifficulty
      ? row("Flown on", DIFFICULTIES[config.flightDifficulty]?.label ?? config.flightDifficulty, null)
      : "",
  ].join("");

  document.getElementById("result-table").innerHTML = table;

  const score = Math.round(stats.score ?? 0);
  document.getElementById("result-score").textContent = score;
  const arc = document.getElementById("score-arc");
  // Re-trigger the sweep animation from zero each time.
  arc.style.transition = "none";
  arc.style.strokeDashoffset = ARC_LENGTH;
  requestAnimationFrame(() => {
    arc.style.transition = "";
    arc.style.strokeDashoffset = String(ARC_LENGTH * (1 - score / 100));
  });

  const bestEl = document.getElementById("result-best");
  const best = bestInfo.best;
  if (bestInfo.improved && best) {
    bestEl.textContent = "NEW PERSONAL BEST · previous records superseded";
  } else if (best) {
    // Records come from local storage and may have been written by an older
    // build with a different shape — never let stored data crash the report.
    const detail =
      Number.isFinite(best.fuelPercent) && Number.isFinite(best.padDistance)
        ? ` (${best.fuelPercent}% prop, ${best.padDistance} m off centre)`
        : "";
    bestEl.textContent = `Personal best for this site: ${best.score ?? "—"}${detail}`;
  } else {
    bestEl.textContent = "";
  }

  document.getElementById("btn-next").classList.toggle(
    "hidden",
    !(hasNext && result.outcome === "landed")
  );
}
