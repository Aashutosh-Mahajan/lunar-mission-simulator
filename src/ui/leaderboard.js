import { LOCAL_STORAGE_LEADERBOARD_KEY, LOCAL_STORAGE_UNLOCKED_KEY } from "../constants.js";
import { DIFFICULTY_ORDER, getDifficulty } from "../levels/difficulty.js";

// Local-storage progress and personal bests. No accounts, no backend — per the
// project constraints, everything stays on the machine.

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode / quota). Progress simply won't
    // persist; the game itself keeps working.
  }
}

// ---------------------------------------------------------------------------
// Records are ranked by difficulty first, then score: a landing flown by hand
// on Commander always outranks one the autopilot flew on Cadet, however the
// scores compare. Records written before difficulty existed were flown under
// what is now Commander, so that is what they count as.
// ---------------------------------------------------------------------------

/** 'bronze' | 'silver' | 'gold' for the difficulty an entry was flown on. */
export const MEDALS = { cadet: "bronze", pilot: "silver", commander: "gold" };

export function recordDifficulty(entry) {
  return entry ? getDifficulty(entry.difficulty ?? "commander").id : null;
}

function rank(entry) {
  if (!entry) return -1;
  return DIFFICULTY_ORDER.indexOf(recordDifficulty(entry)) * 1000 + (entry.score ?? 0);
}

export function medalFor(entry) {
  return entry ? MEDALS[recordDifficulty(entry)] : null;
}

export function getBest(levelId) {
  const board = readJson(LOCAL_STORAGE_LEADERBOARD_KEY, {});
  return board[levelId] ?? null;
}

export function getAllBests() {
  return readJson(LOCAL_STORAGE_LEADERBOARD_KEY, {});
}

/**
 * Records a completed descent. Only successful landings on the pad count
 * toward the personal best and unlock the next site.
 * @returns {{ best: object|null, improved: boolean }}
 */
export function recordResult(levelId, outcome, stats, difficulty = "commander") {
  if (outcome !== "landed") return { best: getBest(levelId), improved: false };

  const board = readJson(LOCAL_STORAGE_LEADERBOARD_KEY, {});
  const existing = board[levelId];
  const entry = {
    score: Math.round(stats.score),
    fuelRemaining: Math.round(stats.fuelRemaining * 10) / 10,
    fuelPercent: stats.fuelCapacity ? Math.round((stats.fuelRemaining / stats.fuelCapacity) * 100) : 0,
    padDistance: Math.round(stats.padDistance * 10) / 10,
    verticalSpeed: Math.round(stats.verticalSpeed * 100) / 100,
    horizontalSpeed: Math.round(stats.horizontalSpeed * 100) / 100,
    time: Math.round(stats.time * 10) / 10,
    difficulty: getDifficulty(difficulty).id,
    date: new Date().toISOString(),
  };

  const improved = rank(entry) > rank(existing);
  if (improved) {
    board[levelId] = entry;
    writeJson(LOCAL_STORAGE_LEADERBOARD_KEY, board);
  }

  unlockLevel(levelId + 1);
  return { best: board[levelId] ?? existing, improved };
}

export function getUnlockedLevels() {
  return readJson(LOCAL_STORAGE_UNLOCKED_KEY, [1]);
}

export function unlockLevel(levelId) {
  const unlocked = getUnlockedLevels();
  if (!unlocked.includes(levelId)) {
    unlocked.push(levelId);
    writeJson(LOCAL_STORAGE_UNLOCKED_KEY, unlocked);
  }
}

export function isLevelUnlocked(levelId) {
  return getUnlockedLevels().includes(levelId);
}

/**
 * How many *landing sites* have been completed. The ascent record shares the
 * leaderboard object under a non-numeric key, so it must not be counted here
 * or the mission board reports more sites landed than exist.
 */
export function landedCount() {
  return Object.keys(getAllBests()).filter((key) => /^\d+$/.test(key)).length;
}

// ---------------------------------------------------------------------------
// Phase 2 — ascent record. Stored under the same leaderboard key so a single
// clear wipes all progress.
// ---------------------------------------------------------------------------

const ASCENT_KEY = "ascent";

export function getAscentBest() {
  const board = readJson(LOCAL_STORAGE_LEADERBOARD_KEY, {});
  return board[ASCENT_KEY] ?? null;
}

/** Only a successful orbit insertion sets a record. */
export function recordAscentResult(outcome, stats, difficulty = "commander") {
  if (outcome !== "orbit") return { best: getAscentBest(), improved: false };

  const board = readJson(LOCAL_STORAGE_LEADERBOARD_KEY, {});
  const existing = board[ASCENT_KEY];
  const entry = {
    score: Math.round(stats.score),
    altitude: Math.round(stats.altitude),
    horizontalSpeed: Math.round(stats.horizontalSpeed),
    propellantRemaining: Math.round(stats.propellantRemaining),
    maxQ: Math.round(stats.maxQ),
    missionTime: Math.round(stats.missionTime),
    difficulty: getDifficulty(difficulty).id,
    date: new Date().toISOString(),
  };

  const improved = rank(entry) > rank(existing);
  if (improved) {
    board[ASCENT_KEY] = entry;
    writeJson(LOCAL_STORAGE_LEADERBOARD_KEY, board);
  }
  return { best: board[ASCENT_KEY] ?? existing, improved };
}
