import { LEVELS } from "../levels/levelConfig.js";
import { getBest, isLevelUnlocked, landedCount, recordDifficulty, MEDALS } from "./leaderboard.js";
import { DIFFICULTIES, DIFFICULTY_ORDER } from "../levels/difficulty.js";
import { makeSimplex2, fbm, ridged } from "../materials/noise.js";

// ---------------------------------------------------------------------------
// Mission board. Each card carries a cross-section of that site's terrain,
// sampled from the same noise parameters the real height field uses, so the
// thumbnail actually previews the ground you'll be flying over.
// ---------------------------------------------------------------------------

const PROFILE_WIDTH = 320;
const PROFILE_HEIGHT = 96;
const SAMPLES = 96;

/** Samples a representative terrain cross-section for the card graphic. */
function buildProfilePath(level) {
  const t = level.terrain;
  const noise = makeSimplex2(level.seed);
  const noiseB = makeSimplex2(level.seed + 5171);
  const s = 1 / t.baseScale;

  // Run the section through the pad so the prepared area shows up.
  const zLine = level.pad.z;
  const heights = [];
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < SAMPLES; i++) {
    const x = -t.size / 2 + (i / (SAMPLES - 1)) * t.size;
    let h = fbm(noise, x * s, zLine * s, 5) * t.baseRoughness;
    h += ridged(noiseB, x * s * 3.1, zLine * s * 3.1, 4) * t.ridgeRoughness;

    // Approximate the geometry craters with a deterministic scattering.
    for (let c = 0; c < 5; c++) {
      const cx = -t.size / 2 + ((c * 197 + level.seed) % t.size);
      const dia = t.craterMin + ((c * 53 + level.seed) % (t.craterMax - t.craterMin));
      const d = Math.abs(x - cx);
      if (d < dia / 2) {
        const u = d / (dia / 2);
        h -= dia * 0.2 * (1 - u * u) * 0.7;
      }
    }

    // Rille and mesa features.
    if (t.rille) {
      const d = Math.abs(x - t.rille.offset * 0.5);
      if (d < t.rille.width / 2) h -= t.rille.depth * (1 - d / (t.rille.width / 2));
    }

    const padD = Math.abs(x - level.pad.x);
    if (padD < level.pad.radius + (level.pad.flatMargin ?? 6)) {
      h = level.pad.plateau ? level.pad.plateau.height : 0;
    }

    heights.push(h);
    if (h < min) min = h;
    if (h > max) max = h;
  }

  const span = Math.max(max - min, 12);
  const pad = 14;
  const points = heights.map((h, i) => {
    const x = (i / (SAMPLES - 1)) * PROFILE_WIDTH;
    const y = PROFILE_HEIGHT - pad - ((h - min) / span) * (PROFILE_HEIGHT - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M ${points.join(" L ")}`;
  const fill = `${line} L ${PROFILE_WIDTH},${PROFILE_HEIGHT} L 0,${PROFILE_HEIGHT} Z`;

  // Where to draw the pad marker.
  const padIndex = Math.round(((level.pad.x + t.size / 2) / t.size) * (SAMPLES - 1));
  const clamped = Math.min(SAMPLES - 1, Math.max(0, padIndex));
  const padPx = (clamped / (SAMPLES - 1)) * PROFILE_WIDTH;
  const padPy =
    PROFILE_HEIGHT - pad - ((heights[clamped] - min) / span) * (PROFILE_HEIGHT - pad * 2);

  return { line, fill, padPx, padPy };
}

function profileSvg(level) {
  const { line, fill, padPx, padPy } = buildProfilePath(level);
  return `
    <svg viewBox="0 0 ${PROFILE_WIDTH} ${PROFILE_HEIGHT}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="terr${level.id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(124,231,208,0.16)" />
          <stop offset="100%" stop-color="rgba(124,231,208,0.02)" />
        </linearGradient>
      </defs>
      <path d="${fill}" fill="url(#terr${level.id})" />
      <path d="${line}" fill="none" stroke="rgba(124,231,208,0.7)" stroke-width="1.4" />
      <line x1="${padPx.toFixed(1)}" y1="${(padPy - 12).toFixed(1)}"
            x2="${padPx.toFixed(1)}" y2="${padPy.toFixed(1)}"
            stroke="#6fb8ff" stroke-width="1.4" />
      <circle cx="${padPx.toFixed(1)}" cy="${(padPy - 13).toFixed(1)}" r="2.6" fill="#6fb8ff" />
    </svg>
  `;
}

/**
 * Renders the mission board.
 * @param {(levelId:number)=>void} onChoose fly the site
 * @param {(levelId:number)=>void} [onAutoplay] watch the computer fly it
 */
export function renderLevelSelect(onChoose, onAutoplay, autoplayAll = false) {
  const grid = document.getElementById("site-grid");
  const progress = document.getElementById("sites-progress");
  grid.innerHTML = "";
  progress.textContent = `${landedCount()} / ${LEVELS.length}`;
  document.getElementById("sites-autoplay")?.classList.toggle("hidden", !autoplayAll);

  for (const level of LEVELS) {
    const unlocked = isLevelUnlocked(level.id);
    const best = getBest(level.id);

    const card = document.createElement("article");
    card.className = `site-card${unlocked ? "" : " locked"}`;

    const difficultyClass = level.difficulty.toLowerCase();
    card.innerHTML = `
      <div class="site-profile">${unlocked ? profileSvg(level) : ""}</div>
      <div class="site-body">
        <div class="site-index">${unlocked ? `SITE ${String(level.id).padStart(2, "0")}` : "LOCKED"}</div>
        <div class="site-name">${unlocked ? level.name : "———"}</div>
        <div class="site-coords">${unlocked ? level.site : "Land the previous site to unlock"}</div>
        <div class="site-desc">${unlocked ? level.description : ""}</div>
        <div class="site-meta">
          <span class="badge ${difficultyClass}">${level.difficulty}</span>
          ${unlocked ? `<span class="badge">${level.fuel.descent} kg prop</span>` : ""}
          ${best ? `<span class="badge best">Best ${best.score}</span>` : ""}
        </div>
        <div class="site-medals${unlocked ? "" : " hidden"}" title="Land this site on each difficulty to earn its medal">
          ${DIFFICULTY_ORDER.map((d) => {
            const earned = best && DIFFICULTY_ORDER.indexOf(recordDifficulty(best)) >= DIFFICULTY_ORDER.indexOf(d);
            return `<span class="medal ${MEDALS[d]}${earned ? " earned" : ""}" aria-label="${MEDALS[d]} medal${earned ? " earned" : ""}">${DIFFICULTIES[d].label}</span>`;
          }).join("")}
        </div>
      </div>
    `;

    if (unlocked) {
      card.addEventListener("click", () => onChoose(level.id));
      // With the menu's Autoplay switch on, the whole card already autoplays.
      if (onAutoplay && !autoplayAll) {
        const auto = document.createElement("button");
        auto.type = "button";
        auto.className = "site-autoplay";
        auto.textContent = "▶ Autoplay";
        auto.title = "Watch the computer land this site";
        // Its own action, not a click through to flying the site.
        auto.addEventListener("click", (e) => {
          e.stopPropagation();
          onAutoplay(level.id);
        });
        card.querySelector(".site-body").appendChild(auto);
      }
    }
    grid.appendChild(card);
  }
}
