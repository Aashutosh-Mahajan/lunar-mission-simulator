// Phase 3 flight report: how accurate the two burns were.

const ARC_LENGTH = 327;

function row(label, value, verdict) {
  const cls = verdict === true ? "pass" : verdict === false ? "fail" : "";
  return `<dt>${label}</dt><dd class="${cls}">${value}</dd>`;
}

export function renderCoastDebrief(result) {
  const s = result.stats;

  const titleEl = document.getElementById("coast-result-title");
  titleEl.textContent = result.title;
  titleEl.className = `heading ${result.outcome === "arrived" ? "landed" : "crashed"}`;

  document.getElementById("coast-result-tag").textContent =
    result.outcome === "arrived" ? "Lunar Orbit Established" : "Translunar Report";
  document.getElementById("coast-result-reason").textContent = result.reason;

  const rows = [
    row(
      "TLI burn",
      `${s.tliDeltaV.toFixed(0)} m/s · target ${s.tliBand[0]}–${s.tliBand[1]}`,
      s.tliInBand
    ),
  ];

  // The insertion burn only happened if the crossing was actually made.
  if (s.loiDeltaV > 0 || s.tliInBand) {
    rows.push(
      row(
        "Lunar orbit insertion",
        s.loiDeltaV > 0
          ? `${s.loiDeltaV.toFixed(0)} m/s · target ${s.loiBand[0]}–${s.loiBand[1]}`
          : "not attempted",
        s.loiDeltaV > 0 ? s.loiInBand : null
      )
    );
  }

  rows.push(
    row("Crossing completed", `${(s.journey * 100).toFixed(0)}%`, s.journey >= 1),
    row("Elapsed", `${s.elapsed.toFixed(0)} s`, null)
  );

  document.getElementById("coast-result-table").innerHTML = rows.join("");

  const score = Math.round(s.score ?? 0);
  document.getElementById("coast-result-score").textContent = score;
  const arc = document.getElementById("coast-score-arc");
  arc.style.transition = "none";
  arc.style.strokeDashoffset = ARC_LENGTH;
  requestAnimationFrame(() => {
    arc.style.transition = "";
    arc.style.strokeDashoffset = String(ARC_LENGTH * (1 - score / 100));
  });

  // Only offer the descent when the stack is actually in lunar orbit.
  document
    .getElementById("btn-coast-descend")
    .classList.toggle("hidden", result.outcome !== "arrived");
}
