import { ASCENT_MISSION } from "../levels/ascentConfig.js";

// Flight report for a launch attempt: how the insertion measured up against
// the target band, and what the vehicle went through on the way.

const ARC_LENGTH = 327;

function row(label, value, verdict) {
  const cls = verdict === true ? "pass" : verdict === false ? "fail" : "";
  return `<dt>${label}</dt><dd class="${cls}">${value}</dd>`;
}

/**
 * @param {object} result from AscentRuntime
 * @param {object} bestInfo { best, improved }
 */
export function renderAscentDebrief(result, bestInfo) {
  const stats = result.stats;
  const limits = ASCENT_MISSION.limits;
  const evaluation = result.evaluation;

  const titleEl = document.getElementById("asc-result-title");
  titleEl.textContent = result.title;
  titleEl.className = `heading ${result.outcome === "orbit" ? "landed" : result.outcome === "badOrbit" ? "offTarget" : "crashed"}`;

  document.getElementById("asc-result-tag").textContent =
    result.outcome === "orbit" ? "Insertion Confirmed" : "Flight Report";
  document.getElementById("asc-result-reason").textContent = result.reason;

  const rows = [];

  // Insertion criteria, as measured against the band.
  if (evaluation) {
    for (const check of Object.values(evaluation.checks)) {
      rows.push(
        row(
          check.label,
          `${check.format(check.value)} · target ${check.bandFormat(check.band)}`,
          check.pass
        )
      );
    }
  }

  rows.push(
    row("Stage reached", stats.stageReached, null),
    row("Apogee", `${(stats.maxAltitude / 1000).toFixed(1)} km`, null),
    row("Downrange", `${(stats.downrange / 1000).toFixed(1)} km`, null),
    row(
      "Peak dynamic pressure",
      `${(stats.maxQ / 1000).toFixed(1)} / ${(limits.maxDynamicPressure / 1000).toFixed(0)} kPa`,
      stats.maxQ <= limits.maxDynamicPressure
    ),
    row(
      "Peak acceleration",
      `${stats.maxG.toFixed(2)} / ${limits.maxAcceleration.toFixed(1)} g`,
      stats.maxG <= limits.maxAcceleration
    ),
    row(
      "Propellant remaining",
      `${(stats.propellantRemaining / 1000).toFixed(1)} t`,
      stats.propellantRemaining > 0
    ),
    row("Time to insertion", `${stats.missionTime.toFixed(0)} s`, null)
  );

  document.getElementById("asc-result-table").innerHTML = rows.join("");

  const score = Math.round(stats.score ?? 0);
  document.getElementById("asc-result-score").textContent = score;
  const arc = document.getElementById("asc-score-arc");
  arc.style.transition = "none";
  arc.style.strokeDashoffset = ARC_LENGTH;
  requestAnimationFrame(() => {
    arc.style.transition = "";
    arc.style.strokeDashoffset = String(ARC_LENGTH * (1 - score / 100));
  });

  const bestEl = document.getElementById("asc-result-best");
  const best = bestInfo.best;
  if (bestInfo.improved && best) {
    bestEl.textContent = "NEW PERSONAL BEST · previous ascent record superseded";
  } else if (best) {
    // Records come from local storage and may have been written by an older
    // build with a different shape — never let stored data crash the report.
    const detail =
      Number.isFinite(best.altitude) && Number.isFinite(best.horizontalSpeed)
        ? ` (${(best.altitude / 1000).toFixed(0)} km, ${best.horizontalSpeed.toFixed(0)} m/s)`
        : "";
    bestEl.textContent = `Best ascent: ${best.score ?? "—"}${detail}`;
  } else {
    bestEl.textContent = "";
  }

  // Only offer the hand-off to the descent when the orbit is actually good.
  document
    .getElementById("btn-asc-descent")
    .classList.toggle("hidden", result.outcome !== "orbit");
}
