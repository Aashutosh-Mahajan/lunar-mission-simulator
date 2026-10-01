import * as THREE from "three";
import * as CANNON from "cannon-es";

import { buildAssets } from "./materials/assets.js";
import Environment from "./entities/Environment.js";
import ParticleSystem from "./fx/particles.js";
import LevelRuntime from "./levels/levelLoader.js";
import { LEVELS, getLevelById } from "./levels/levelConfig.js";

import RenderPipeline from "./core/RenderPipeline.js";
import CameraRig, { CAMERA_LABELS } from "./core/CameraRig.js";
import AscentCamera, { ASCENT_CAMERA_LABELS } from "./core/AscentCamera.js";
import Input from "./core/Input.js";
import AudioEngine from "./core/AudioEngine.js";

import Screens from "./ui/screens.js";
import Hud from "./ui/hud.js";
import Coach from "./ui/coach.js";
import AscentHud from "./ui/ascentHud.js";
import { renderLevelSelect } from "./ui/levelSelect.js";
import { renderDebrief } from "./ui/debrief.js";
import { renderAscentDebrief } from "./ui/ascentDebrief.js";
import {
  recordResult,
  getBest,
  unlockLevel,
  recordAscentResult,
  getAscentBest,
} from "./ui/leaderboard.js";
import { loadSettings, saveSettings, bindSettingsUi, detectQuality } from "./ui/settings.js";
import { bindDifficultyPicker } from "./ui/difficultyPicker.js";
import Autoplay, { descentControls as autoplayDescentControls } from "./levels/autoplay.js";

// Phase 2. Imported lazily inside startAscent so that deleting the ascent
// files cannot break the descent trainer at module-load time.
import AscentRuntime from "./levels/ascentRuntime.js";
import { pressureRatio } from "./levels/ascentConfig.js";

// Phase 3.
import CoastRuntime from "./levels/coastRuntime.js";
import CoastCamera, { COAST_CAMERA_LABELS } from "./core/CoastCamera.js";
import CoastHud from "./ui/coastHud.js";
import { renderCoastDebrief } from "./ui/coastDebrief.js";
import Campaign from "./ui/campaign.js";

import { MAX_DT } from "./constants.js";

// ---------------------------------------------------------------------------
// Game shell: owns the renderer, the physics world, the state machine and the
// frame loop. Level-specific behaviour lives in LevelRuntime; this file only
// wires systems together and moves between screens.
// ---------------------------------------------------------------------------

const RESULT_DELAY = 1.5; // seconds of watching the outcome before the debrief

// Daylight white balance: the unfiltered sun, as on the Moon and in space.
const NEUTRAL_BALANCE = new THREE.Color(1, 1, 1);
// While watching the whole mission on autoplay, how long each debrief stays up
// before the next phase starts by itself.
const AUTOPLAY_CONTINUE_DELAY = 5;
const AUTOPLAY_BLOCKED_ACTIONS = new Set([
  "stage", "insert", "throttleFull", "throttleCut", "rateHold",
  "toggleStabiliser", "warpUp", "warpDown", "skip",
]);

class Game {
  constructor() {
    this.canvas = document.getElementById("scene");
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.4, 22000);
    this._viewDir = new THREE.Vector3();
    // Autoplay: `autoplay.active` while the computer is flying; `chain` when
    // watching the whole mission, so each phase hands on to the next.
    this.autoplay = new Autoplay();
    this.autoplayChain = false;
    this._autoplayUsed = false;
    this._chainTimer = 0;
    // The main menu's Autoplay switch. Deliberately not persisted: a player
    // who comes back tomorrow should not find the game flying itself.
    this.menuAutoplay = false;

    this.settings = loadSettings();
    if (!localStorage.getItem("lunar-sim.settings.v1")) {
      this.settings.quality = detectQuality();
    }

    this.pipeline = new RenderPipeline(this.canvas, this.scene, this.camera, this.settings);
    this.cameraRig = new CameraRig(this.camera);
    this.ascentCamera = new AscentCamera(this.camera);
    this.coastCamera = new CoastCamera(this.camera);
    this.input = new Input(this.canvas);
    this.audio = new AudioEngine();
    this.screens = new Screens();
    this.hud = new Hud();
    this.coach = new Coach(this.hud);
    this.ascentHud = new AscentHud();
    this.coastHud = new CoastHud();
    this.campaign = new Campaign();

    this.state = "loading";
    // Which phase is loaded: 'descent' (1), 'ascent' (2) or 'coast' (3).
    this.mode = "descent";
    this.runtime = null;
    this.ascent = null;
    this.coast = null;
    this.currentLevelId = 1;
    this.resultTimer = 0;
    this.elapsed = 0;
    this.lastTime = performance.now();
    this._prevRcsMagnitude = 0;
    this._hintsShown = new Set();

    // --- Physics world -------------------------------------------------
    // Gravity is zero here on purpose: all gravitational and thrust
    // acceleration is integrated by hand in physics/landerPhysics.js. Cannon
    // is used strictly for contact detection.
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
    this.world.broadphase = new CANNON.NaiveBroadphase();
    this.world.allowSleep = false;

    this._bindUi();
    window.addEventListener("resize", () => {
      this.pipeline.resize();
      this.particles?.setViewport(this.pipeline.renderer);
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async init() {
    const fill = document.getElementById("load-fill");
    const status = document.getElementById("load-status");

    // Dev builds keep per-stage timings of the bake (window.__loadTimings).
    const timings = [];
    let stageStart = performance.now();
    let stageName = "start";
    this.assets = await buildAssets((progress, message) => {
      fill.style.width = `${progress * 100}%`;
      status.textContent = message;
      const now = performance.now();
      timings.push([stageName, Math.round(now - stageStart)]);
      stageStart = now;
      stageName = message;
    }, this.pipeline.renderer);
    if (import.meta.env.DEV) window.__loadTimings = timings;

    this.world.addContactMaterial(this.assets.contactMaterial);
    // Scenes bake their own image-based lighting, which needs the renderer.
    this.assets.renderer = this.pipeline.renderer;

    this.environment = new Environment(
      this.scene,
      LEVELS[0].sun
        ? {
            sunAzimuthDeg: LEVELS[0].sun.azimuthDeg,
            sunElevationDeg: LEVELS[0].sun.elevationDeg,
            earthAzimuthDeg: LEVELS[0].earth.azimuthDeg,
            earthElevationDeg: LEVELS[0].earth.elevationDeg,
          }
        : {},
      this.assets
    );

    this.particles = new ParticleSystem(this.scene, this.assets);
    this.particles.setViewport(this.pipeline.renderer);
    this.pipeline.onResolutionChange = () => this.particles.setViewport(this.pipeline.renderer);

    this.applySettings();
    bindSettingsUi(this.settings, () => this.applySettings());
    bindDifficultyPicker(this.settings, () => saveSettings(this.settings));

    // Level 1 is always available.
    unlockLevel(1);

    this.screens.show("menu");
    this.state = "menu";
    requestAnimationFrame((t) => this.loop(t));
  }

  applySettings() {
    this.pipeline.applySettings(this.settings);
    this.environment?.setQuality(this.settings.quality);
    this.ascent?.earth.setQuality(this.settings.quality);
    this.particles?.setQuality(this.settings.particles);
    // Quality changes the render scale, which changes the buffer height.
    if (this.particles) this.particles.setViewport(this.pipeline.renderer);
    saveSettings(this.settings);
  }

  // -------------------------------------------------------------------------
  // UI wiring
  // -------------------------------------------------------------------------

  _bindUi() {
    const click = (id, fn) => {
      const node = document.getElementById(id);
      node.addEventListener("click", () => {
        // Browsers only allow audio to start from a user gesture.
        this.audio.init();
        this.audio.click();
        fn();
      });
    };

    // The three missions. The menu's Autoplay switch applies to all of them.
    click("btn-campaign", () => {
      if (this.menuAutoplay) {
        this.watchMission();
      } else {
        this.campaign.start();
        this.startAscent();
      }
    });
    click("autoplay-switch", () => this.setMenuAutoplay(!this.menuAutoplay));
    click("btn-pause-autoplay", () => {
      this.toggleAutoplay();
      if (this.autoplay.active) this.setPaused(false);
    });
    click("btn-launch", () => {
      this.campaign.reset();
      this.startAscent({ autoplay: this.menuAutoplay });
    });
    click("btn-fly", () => {
      this.campaign.reset();
      this.openBoard();
    });
    click("btn-controls", () => this.screens.show("help"));
    click("btn-settings", () => this.screens.show("settings"));
    // Must go through quitToMenu, not screens.show: showing the menu without
    // clearing `state` left the game believing it was still on the board, so
    // the next overlay close redirected back to the board.
    click("btn-sites-back", () => this.quitToMenu());
    click("btn-help-close", () => this.closeOverlay());
    click("btn-settings-close", () => this.closeOverlay());

    click("btn-resume", () => this.setPaused(false));
    click("btn-pause-restart", () => this.restartCurrentFlight());
    click("btn-pause-controls", () => this.screens.show("help"));
    click("btn-pause-quit", () => this.abortFlight());
    click("btn-pause-menu", () => this.abortFlight(true));

    click("btn-retry", () => this.startLevel(this.currentLevelId));
    click("btn-next", () => this.startLevel(Math.min(LEVELS.length, this.currentLevelId + 1)));
    click("btn-result-board", () => this.quitToBoard());

    // Phase 2 buttons. A good orbit hands off to the trans-lunar coast.
    click("btn-asc-retry", () => this.startAscent());
    click("btn-asc-descent", () => this.startCoast());
    click("btn-asc-menu", () => this.quitToMenu());

    // Phase 3 buttons. Arriving in lunar orbit hands off to the descent.
    click("btn-coast-descend", () => this.startLevel(1));
    click("btn-coast-retry", () => this.startCoast());
    click("btn-coast-menu", () => this.quitToMenu());

    this.input.onAction((action) => this.onAction(action));
  }

  onAction(action) {
    // While autoplay flies, the player's flight inputs are ignored — only the
    // camera, pause, help, mute, restart and the hand-over key still work.
    if (this.autoplay.active && AUTOPLAY_BLOCKED_ACTIONS.has(action)) return;

    switch (action) {
      case "autoplay":
        this.toggleAutoplay();
        break;

      case "pause":
        if (this.state === "flight") this.setPaused(true);
        else if (this.state === "paused") this.setPaused(false);
        else if (this.screens.current === "help" || this.screens.current === "settings") {
          this.closeOverlay();
        }
        break;

      case "help":
        if (this.state === "flight") this.setPaused(true);
        this.screens.show("help");
        break;

      case "restart":
        if (this.state === "flight" || this.state === "paused" || this.state === "result") {
          if (this.mode === "ascent") this.startAscent();
          else if (this.mode === "coast") this.startCoast();
          else this.startLevel(this.currentLevelId);
        }
        break;

      case "cameraNext":
      case "cameraPrev": {
        const dir = action === "cameraNext" ? 1 : -1;
        if (this.mode === "coast" && this.coast) {
          const mode = this.coastCamera.cycleMode(dir);
          this.coastHud.showHint(COAST_CAMERA_LABELS[mode], 1.6);
          this.audio.click();
        } else if (this.mode === "ascent" && this.ascent) {
          const mode = this.ascentCamera.cycleMode(dir);
          this.ascentHud.setCameraMode(ASCENT_CAMERA_LABELS[mode]);
          this.audio.click();
        } else if (this.runtime) {
          const mode = this.cameraRig.cycleMode(dir);
          this.hud.setCameraMode(CAMERA_LABELS[mode]);
          this.audio.click();
        }
        break;
      }

      case "rateHold": {
        if (this.mode !== "descent" || !this.runtime || this.state !== "flight") break;
        const assist = this.runtime.assist;
        if (assist.mode === "full") {
          this.hud.showHint("Autopilot owns the descent rate — Shift hovers, Ctrl descends faster");
          break;
        }
        const on = assist.toggleRateHold();
        this.hud.showHint(on ? "Descent-rate hold ON — engine throttled for you, Space overrides" : "Descent-rate hold OFF — manual throttle");
        this.audio.beep(on ? 1180 : 640, 0.08, 0.07);
        break;
      }

      case "toggleStabiliser": {
        if (this.mode !== "descent" || !this.runtime) break;
        const s = this.runtime.lander.state;
        s.stabiliser = !s.stabiliser;
        this.hud.showHint(s.stabiliser ? "Attitude hold ENGAGED" : "Attitude hold OFF — free drift");
        this.audio.beep(s.stabiliser ? 1180 : 640, 0.08, 0.07);
        break;
      }

      // ---- Phase 2 -------------------------------------------------------
      case "stage": {
        if (this.mode !== "ascent" || this.state !== "flight" || !this.ascent) break;
        if (!this.ascent.stage()) {
          this.ascentHud.showHint("No stage left to drop — this is the last one", 2.4);
        }
        break;
      }

      case "insert": {
        if (this.state !== "flight") break;
        if (this.mode === "coast" && this.coast) {
          // Same key cuts off a coast burn.
          this.coast.cutoff();
          this.audio.stopLaunchEngine();
        } else if (this.mode === "ascent" && this.ascent) {
          this.ascent.attemptInsertion();
        }
        break;
      }

      case "warpUp":
      case "warpDown": {
        const dir = action === "warpUp" ? 1 : -1;
        if (this.mode === "coast" && this.coast) {
          const scale = this.coast.cycleTimeScale(dir);
          this.audio.beep(dir > 0 ? 1240 : 780, 0.06, 0.05);
          void scale;
        } else if (this.mode === "ascent" && this.ascent) {
          const scale = this.ascent.cycleTimeScale(dir);
          this.ascentHud.setTimeScale(scale);
          this.audio.beep(dir > 0 ? 1240 : 780, 0.06, 0.05);
        }
        break;
      }

      case "skip": {
        if (this.mode !== "coast" || this.state !== "flight" || !this.coast) break;
        if (this.coast.skipCruise()) this.audio.click();
        break;
      }

      case "mute": {
        const muted = this.audio.toggleMute();
        this.settings.muted = muted;
        saveSettings(this.settings);
        if (this.state === "flight") this.hud.showHint(muted ? "Audio muted" : "Audio on");
        break;
      }

      default:
        break;
    }
  }

  /** Closes help/settings, returning to whatever was underneath. */
  closeOverlay() {
    if (this.state === "paused") this.screens.show("pause");
    else if (this.state === "result") {
      const screen =
        this.mode === "ascent" ? "ascentResult" : this.mode === "coast" ? "coastResult" : "result";
      this.screens.show(screen);
    } else if (this.state === "flight") this.screens.showFlight();
    // The board is a screen in its own right, not a sub-page of the menu —
    // without this, opening Controls from the site list and closing it dumped
    // the player back at the main menu.
    else if (this.state === "board") this.screens.show("sites");
    else this.screens.show("menu");
  }

  openBoard() {
    this._stopAutoplay();
    this._disposeRuntimes();
    renderLevelSelect(
      (id) => this.startLevel(id, { autoplay: this.menuAutoplay }),
      (id) => this.startLevel(id, { autoplay: true }),
      this.menuAutoplay
    );
    this.screens.setHud(null);
    this.screens.show("sites");
    this.state = "board";
  }

  quitToMenu() {
    this._stopAutoplay();
    this._disposeRuntimes();
    this.campaign.reset();
    this.screens.setHud(null);
    this.screens.show("menu");
    this.state = "menu";
  }

  /** Tears down whichever phase is loaded and returns the scene to neutral. */
  _disposeRuntimes() {
    if (this.runtime) {
      this.runtime.dispose();
      this.runtime = null;
    }
    if (this.ascent) {
      this.ascent.dispose();
      this.ascent = null;
      // The ascent brings its own sky and lighting; restore the lunar one.
      this.environment.setEnabled(true);
    }
    if (this.coast) {
      this.coast.dispose();
      this.coast = null;
      this.environment.setEnabled(true);
    }
    // Every start* method sets its own mode straight after calling this, so
    // clearing it here is safe and stops an abandoned phase's mode leaking
    // into menu screens that key off it.
    this.mode = "descent";
    this.screens.setCountdownVisible(false);
    this.audio.setEngine(0);
    this.audio.stopLaunchEngine();
    this.audio.setAlarm(false);
    this.particles.reset();
  }

  // -------------------------------------------------------------------------
  // Level lifecycle
  // -------------------------------------------------------------------------

  startLevel(levelId, { autoplay = false } = {}) {
    if (autoplay) this.autoplay.active = true;
    this.audio.init();
    this._disposeRuntimes();

    this.mode = "descent";
    this.currentLevelId = levelId;
    const config = getLevelById(levelId);

    this.environment.setEnabled(true);
    this.environment.configure(config);

    this.runtime = new LevelRuntime({
      scene: this.scene,
      world: this.world,
      levelId,
      particles: this.particles,
      assets: this.assets,
      audio: this.audio,
      difficulty: this.settings.difficulty,
    });

    this.runtime.onTouchdownEffect = (energy) => {
      this.cameraRig.kick(0.35 + energy * 0.35);
      this.audio.touchdown(energy);
    };
    this.runtime.onCrashEffect = (energy) => {
      this.cameraRig.kick(1.4 + energy * 0.5);
      this.pipeline.flash(0.55);
      this.audio.crash(Math.min(1.4, energy));
      this.audio.setEngine(0);
    };
    this.runtime.onLandedEffect = (onTarget) => {
      this.audio.setEngine(0);
      this.audio.beep(onTarget ? 1320 : 880, 0.22, 0.1, "sine");
    };

    // The HUD and coach work from the runtime's config: it carries the
    // difficulty's limits, which are what the gauges should mark.
    this.hud.setLevel(this.runtime.config);
    this.hud.reset();
    this.coach.setLevel(this.runtime.config);
    this.cameraRig.reset();
    this.cameraRig.setMode("chase");
    this.cameraRig.distance = 26;
    this.hud.setCameraMode(CAMERA_LABELS.chase);

    this.resultTimer = 0;
    this.state = "flight";
    this.input.setEnabled(true);
    this.screens.setHud("descent");
    this.screens.showFlight();

    this._showOpeningHints(config);
    this._beginFlightAutoplay(this.runtime, this.hud);
  }

  /**
   * One-off briefing for a level's gimmick. Levels 1-2 additionally get the
   * running coach in ui/coach.js, which reacts to how the flight is going.
   */
  _showOpeningHints(config) {
    if (config.pad.moving && !this._hintsShown.has("moving")) {
      this._hintsShown.add("moving");
      this.hud.showHint("The pad is moving — match its drift before you touch down", 6);
    } else if (config.vents && !this._hintsShown.has("vents")) {
      this._hintsShown.add("vents");
      this.hud.showHint("Outgassing vents ahead — expect sudden lateral pushes", 6);
    } else if (config.fuel.descent < 200 && !this._hintsShown.has("lowfuel")) {
      this._hintsShown.add("lowfuel");
      this.hud.showHint("Minimal propellant load — brake late and brake once", 6);
    }
  }

  quitToBoard() {
    this.openBoard();
  }

  // -------------------------------------------------------------------------
  // Phase 2 — launch
  // -------------------------------------------------------------------------

  startAscent({ autoplay = false } = {}) {
    if (autoplay) this.autoplay.active = true;
    this.audio.init();
    this._disposeRuntimes();

    this.mode = "ascent";
    // The lunar sky steps aside; the Earth scene brings its own.
    this.environment.setEnabled(false);

    this.ascent = new AscentRuntime({
      scene: this.scene,
      particles: this.particles,
      assets: this.assets,
      audio: this.audio,
      difficulty: this.settings.difficulty,
    });
    this._directorHintTimer = 0;
    this._windowHintShown = false;
    this.ascent.earth.setQuality(this.settings.quality);

    this.ascent.onEvent = (text) => {
      this.ascentHud.pushLogEntry(this.ascent.state.missionTime, text);
    };
    this.ascent.onIgnition = () => this.ascentCamera.kick(0.9);
    this.ascent.onLiftoff = () => {
      this.ascentCamera.kick(1.6);
      const a = this.ascent.assists;
      this.ascentHud.showHint(
        a.autoGuidance
          ? "Autopilot is flying the ascent — staging and cut-off are automatic. C changes camera, . speeds up time"
          : a.autoStage
            ? "Pitch program engaged. Later, steer CMD onto the magenta FD bracket with W/S"
            : "Pitch program engaged — stage with SPACE at each burnout",
        6
      );
    };
    this.ascent.onStageReady = () => {
      this.ascentHud.showHint(
        this.ascent.assists.autoStage ? "Burnout — staging" : "Burnout — press SPACE to stage",
        this.ascent.assists.autoStage ? 2 : 5
      );
      this.audio.beep(980, 0.12, 0.09);
    };
    // Effects live here rather than on the key handler, so a separation the
    // autopilot commands looks and sounds exactly like one the player does.
    this.ascent.onStaging = () => {
      this.ascentCamera.kick(1.5);
      this.audio.stagingBang();
    };
    this.ascent.onFailure = () => {
      this.pipeline.flash(0.7);
      this.ascentCamera.kick(3);
      this.audio.stopLaunchEngine();
      this.audio.crash(1.3);
    };
    this.ascent.onInsertion = (ok) => {
      this.audio.stopLaunchEngine();
      this.audio.beep(ok ? 1320 : 660, 0.3, 0.11, "sine");
    };

    this.ascentHud.reset();
    this.ascentHud.setTimeScale(1);
    this.ascentCamera.reset();
    this.ascentHud.setCameraMode(ASCENT_CAMERA_LABELS.pad);

    this.resultTimer = 0;
    this.state = "flight";
    this.input.setEnabled(true);
    this.screens.setHud("ascent");
    this.screens.showFlight();
    this._beginFlightAutoplay(this.ascent, this.ascentHud);
  }

  _finishAscent() {
    const result = this.ascent.result;
    // The banner is normally hidden by the flight loop; the debrief must not
    // depend on that having run since the count ended.
    this.screens.setCountdownVisible(false);
    const bestInfo = this._autoplayUsed
      ? { best: getAscentBest(), improved: false }
      : recordAscentResult(result.outcome, result.stats, this.settings.difficulty);

    renderAscentDebrief(
      result,
      { best: bestInfo.best ?? getAscentBest(), improved: bestInfo.improved },
      this.ascent.mission
    );

    this._applyCampaignUi("screen-ascent-result", "ascent", result.outcome === "orbit", {
      button: "btn-asc-descent",
      campaignLabel: "Continue to Trans-Lunar Injection",
      defaultLabel: "Continue to Descent",
    });

    this.state = "result";
    this.input.setEnabled(false);
    this.audio.setAlarm(false);
    this.screens.show("ascentResult");
    this.screens.setHud("ascent");
    this._markAutoplayDebrief("asc-result-tag");
  }

  // -------------------------------------------------------------------------
  // Phase 3 — trans-lunar coast
  // -------------------------------------------------------------------------

  startCoast({ autoplay = false } = {}) {
    if (autoplay) this.autoplay.active = true;
    this.audio.init();
    this._disposeRuntimes();

    this.mode = "coast";
    this.environment.setEnabled(false);

    this.coast = new CoastRuntime({
      difficulty: this.settings.difficulty,
      scene: this.scene,
      assets: this.assets,
      audio: this.audio,
    });

    this.coast.onEvent = (text) => this.coastHud.pushLogEntry(this.coast.elapsed, text);
    this.coast.onBurnWindow = (which) => {
      const tli = which === "tli";
      this.coastHud.showHint(
        this.autoplay.active
          ? (tli ? "Autoplay: trans-lunar injection burn" : "Autoplay: lunar orbit insertion burn")
          : tli
            ? "Hold SPACE to burn. Cut off with I when ΔV is inside the green gates."
            : "Retrograde burn to capture. Same again — hold SPACE, cut off inside the band.",
        7
      );
      this.audio.beep(1180, 0.16, 0.09);
    };
    this.coast.onBurnResult = (which, ok) => {
      this.audio.stopLaunchEngine();
      this.audio.beep(ok ? 1320 : 620, 0.28, 0.11, "sine");
      if (!ok) this.pipeline.flash(0.4);
      if (ok && which === "tli") {
        this.coastHud.showHint("Outbound. Time-warp the coast with , and . — or skip with K.", 6);
      }
    };
    this.coast.onWarpCancelled = () => {
      this.coastHud.showHint("Approaching the band — time warp cancelled", 2.6);
      this.audio.beep(880, 0.08, 0.06);
    };

    this.coastHud.reset();
    this.coastCamera.reset();

    this.resultTimer = 0;
    this.state = "flight";
    this.input.setEnabled(true);
    this.screens.setHud("coast");
    this.screens.showFlight();
    this._beginFlightAutoplay(this.coast, this.coastHud);
  }

  _finishCoast() {
    renderCoastDebrief(this.coast.result);

    this._applyCampaignUi(
      "screen-coast-result",
      "coast",
      this.coast.result.outcome === "arrived",
      {
        button: "btn-coast-descend",
        campaignLabel: "Undock & Land at Tranquility",
        defaultLabel: "Undock & Descend",
      }
    );

    this.state = "result";
    this.input.setEnabled(false);
    this.audio.setAlarm(false);
    this.screens.show("coastResult");
    this.screens.setHud("coast");
    this._markAutoplayDebrief("coast-result-tag");
  }

  _updateCoast(dt, controls, mouse) {
    const simulating = this.state === "flight";
    if (simulating) {
      const burn = this.autoplay.active ? this.autoplay.coastControls(this.coast).burn : controls.burn;
      this.coast.update(dt, { burn });
    }

    this.coastCamera.drag(mouse.dx, mouse.dy);
    if (mouse.wheel) this.coastCamera.zoom(mouse.wheel);
    this.coastCamera.update(dt, this.coast.craft, this.coast.space, this.elapsed);
    this.coast.space.update(this.camera, this.coast.journey, dt);

    this.particles.update(dt);
    this.coastHud.update(this.coast, dt);

    // The SPS is a small engine on a big stack: felt, not heard.
    this.audio.setLaunchEngine(simulating ? this.coast.throttle * 0.5 : 0, 0);

    if (this.state === "flight" && this.coast.result) {
      this.resultTimer += dt;
      if (this.resultTimer >= RESULT_DELAY) this._finishCoast();
    }
  }

  /**
   * Banks (or ends) a campaign leg and updates that debrief's chrome. Safe to
   * call outside a campaign — it strips the progress bar and restores the
   * button's normal label, so a later one-off flight isn't left wearing
   * campaign UI.
   *
   * @param {string} screenId debrief screen to decorate
   * @param {string} legId which leg just finished
   * @param {boolean} succeeded whether the leg was passed
   * @param {object} [btn] { button, campaignLabel, defaultLabel }
   */
  _applyCampaignUi(screenId, legId, succeeded, btn) {
    if (this.campaign.active) {
      if (succeeded) this.campaign.complete(legId, this._legScore(legId));
      else this.campaign.fail();
    }
    this.campaign.renderStrip(screenId, legId);

    if (btn) {
      const node = document.getElementById(btn.button);
      if (node) {
        node.textContent = this.campaign.active ? btn.campaignLabel : btn.defaultLabel;
      }
    }
  }

  _legScore(legId) {
    if (legId === "ascent") return this.ascent?.result?.stats?.score ?? 0;
    if (legId === "coast") return this.coast?.result?.stats?.score ?? 0;
    return this.runtime?.result?.stats?.score ?? 0;
  }

  /** Maps the raw key state onto the ascent's control demands. */
  _ascentControls(controls) {
    return {
      throttleUp: controls.throttleUp,
      throttleDown: controls.throttleDown,
      // W/S bias the pitch program: nose up is a higher pitch angle.
      pitchUp: Math.max(0, controls.pitch),
      pitchDown: Math.max(0, -controls.pitch),
    };
  }

  setPaused(paused) {
    if (paused && this.state === "flight") {
      this.state = "paused";
      this.input.setEnabled(false);
      this.audio.setEngine(0);
      this.audio.stopLaunchEngine();
      this.audio.setAlarm(false);
      this.screens.show("pause");
      this.screens.setHud(this.mode);
      // The countdown banner is only refreshed from the ascent update loop,
      // which does not run while held — hide it explicitly or it stays frozen
      // on screen underneath the pause panel.
      this.screens.setCountdownVisible(false);
      this._syncPauseMenu();
    } else if (!paused && this.state === "paused") {
      this.state = "flight";
      this.input.setEnabled(true);
      this.screens.showFlight();
    }
    this._syncAutoplayBadge();
  }

  /**
   * Labels the pause menu for the phase actually being flown. Only the descent
   * has a mission board behind it, so the other two phases route home instead.
   */
  _syncPauseMenu() {
    const restart = { descent: "Restart Site", ascent: "Restart Launch", coast: "Restart Coast" };
    const restartBtn = document.getElementById("btn-pause-restart");
    const boardBtn = document.getElementById("btn-pause-quit");
    if (restartBtn) restartBtn.textContent = restart[this.mode] ?? "Restart";
    const autoBtn = document.getElementById("btn-pause-autoplay");
    if (autoBtn) autoBtn.textContent = this.autoplay.active ? "Take Control" : "Autoplay";
    if (boardBtn) boardBtn.classList.toggle("hidden", this.mode !== "descent");
  }

  /** Restarts whichever phase is loaded — never a different one. */
  restartCurrentFlight() {
    if (this.mode === "ascent") this.startAscent();
    else if (this.mode === "coast") this.startCoast();
    else this.startLevel(this.currentLevelId);
  }

  /**
   * Leaves a flight. Abandoning a leg ends a campaign run, so the next flight
   * is never left wearing campaign chrome or banking a score against it.
   * @param {boolean} toMenu force the main menu rather than the mission board
   */
  abortFlight(toMenu = false) {
    this.campaign.fail();
    if (!toMenu && this.mode === "descent") this.quitToBoard();
    else this.quitToMenu();
  }

  _finishMission() {
    const runtime = this.runtime;
    const result = runtime.result;
    // A flight the computer flew any part of is not the player's record, and
    // does not unlock the next site.
    const bestInfo = this._autoplayUsed
      ? { best: getBest(this.currentLevelId), improved: false }
      : recordResult(this.currentLevelId, result.outcome, result.stats, this.settings.difficulty);

    renderDebrief(
      result,
      runtime.config,
      { best: bestInfo.best ?? getBest(this.currentLevelId), improved: bestInfo.improved },
      this.currentLevelId < LEVELS.length
    );

    // The landing is the campaign's last leg, so the mission score lands here.
    const wasCampaign = this.campaign.active;
    this._applyCampaignUi("screen-result", "descent", result.outcome === "landed");
    if (wasCampaign) {
      this.campaign.renderTotal("screen-result");
      if (this.campaign.isComplete) {
        document.getElementById("result-tag").textContent = "Mission Complete";
        document.getElementById("btn-next").classList.add("hidden");
      }
    }

    this.state = "result";
    this.input.setEnabled(false);
    this.audio.setAlarm(false);
    this.screens.show("result");
    this.screens.setHud("descent");
    // The landing is the last leg: watching the mission ends here.
    this.autoplayChain = false;
    this._markAutoplayDebrief("result-tag");
  }

  // -------------------------------------------------------------------------
  // Autoplay
  // -------------------------------------------------------------------------

  /** Called by each start* method once its runtime exists. */
  _beginFlightAutoplay(runtime, hud) {
    this._autoplayUsed = false;
    this._chainTimer = 0;
    if (this.autoplay.active) {
      this.autoplay.engage(this.mode, runtime);
      this._autoplayUsed = true;
      hud.showHint("Autoplay is flying — press O to take control", 4);
    }
    this._syncAutoplayBadge();
  }

  /** O / pause menu: hand control to the computer, or take it back. */
  toggleAutoplay() {
    if (this.state !== "flight" && this.state !== "paused") return;
    const runtime = this.mode === "ascent" ? this.ascent : this.mode === "coast" ? this.coast : this.runtime;
    if (!runtime) return;
    const hud = this.mode === "ascent" ? this.ascentHud : this.mode === "coast" ? this.coastHud : this.hud;
    if (this.autoplay.active) {
      this.autoplay.release(this.mode, runtime);
      this.autoplayChain = false;
      if (this.mode === "ascent") this.ascentHud.setTimeScale(1);
      hud.showHint("You have control", 2.5);
    } else {
      this.autoplay.engage(this.mode, runtime);
      this._autoplayUsed = true;
      hud.showHint("Autoplay is flying — press O to take control", 3);
    }
    this.audio.beep(this.autoplay.active ? 1180 : 640, 0.08, 0.07);
    this._syncAutoplayBadge();
    this._syncPauseMenu();
  }

  /**
   * The main menu's Autoplay switch, which applies to all three missions:
   * the full mission, the launch, and the descent (every site on the board).
   */
  setMenuAutoplay(on) {
    this.menuAutoplay = on;
    const sw = document.getElementById("autoplay-switch");
    sw?.setAttribute("aria-checked", String(on));
    sw?.classList.toggle("on", on);
    const state = document.getElementById("autoplay-switch-state");
    if (state) state.textContent = on ? "On — the computer flies every mission" : "Off — you fly";
    const labels = on
      ? { "btn-campaign": "▶ Watch the Full Mission", "btn-launch": "▶ Watch the Launch", "btn-fly": "▶ Watch a Landing" }
      : { "btn-campaign": "Fly the Full Mission", "btn-launch": "Launch Only", "btn-fly": "Lunar Descent" };
    for (const [id, text] of Object.entries(labels)) {
      const btn = document.getElementById(id);
      if (btn) btn.textContent = text;
    }
    this.audio.click?.();
  }

  /** Watch the whole mission, pad to surface, flown by the computer. */
  watchMission() {
    this.campaign.start();
    this.autoplayChain = true;
    this.startAscent({ autoplay: true });
  }

  _stopAutoplay() {
    this.autoplay.active = false;
    this.autoplayChain = false;
    this._syncAutoplayBadge();
  }

  _syncAutoplayBadge() {
    const badge = document.getElementById("autoplay-badge");
    const flying = this.state === "flight" || this.state === "paused";
    if (badge) badge.classList.toggle("hidden", !(this.autoplay.active && flying));
  }

  _markAutoplayDebrief(tagId) {
    // Autoplay started on one flight covers that flight only, so the
    // debrief's "Fly it again" is the player's. Watching the whole mission
    // carries it on to the next phase.
    if (!this.autoplayChain) this.autoplay.active = false;
    this._syncAutoplayBadge();
    if (!this._autoplayUsed) return;
    const tag = document.getElementById(tagId);
    if (tag) tag.textContent = `${tag.textContent} · Autoplay — not recorded`;
  }

  /**
   * While watching the mission, move on from a successful debrief by itself.
   * Uses the debrief's own button, so the hand-off is exactly what a click
   * would do.
   */
  _advanceAutoplayChain(dt) {
    if (!this.autoplayChain || this.state !== "result") return;
    const next =
      this.mode === "ascent" && this.ascent?.result?.outcome === "orbit" ? "btn-asc-descent" :
      this.mode === "coast" && this.coast?.result?.outcome === "arrived" ? "btn-coast-descend" :
      null;
    if (!next) {
      // A leg failed: the watched mission is over, and a retry is the player's.
      this.autoplayChain = false;
      this.autoplay.active = false;
      return;
    }
    this._chainTimer += dt;
    if (this._chainTimer >= AUTOPLAY_CONTINUE_DELAY) {
      this._chainTimer = 0;
      document.getElementById(next)?.click();
    }
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));

    const raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = Math.min(Math.max(raw, 0.0001), MAX_DT);
    this.elapsed += dt;

    const controls = this.input.update();
    const mouse = this.input.consumeMouse();

    if (this.coast) {
      this._updateCoast(dt, controls, mouse);
    } else if (this.ascent) {
      this._updateAscent(dt, controls, mouse);
    } else if (this.runtime) {
      const simulating = this.state === "flight" || this.state === "result";

      if (simulating) {
        // The camera's heading, flattened onto the ground plane. Full assist
        // steers relative to it, so W always means "away from me".
        this.camera.getWorldDirection(this._viewDir);
        const len = Math.hypot(this._viewDir.x, this._viewDir.z) || 1;
        const view = { x: this._viewDir.x / len, z: this._viewDir.z / len };
        this._lastView = view;
        let flown;
        if (this.state !== "flight") flown = this._neutralControls();
        else if (this.autoplay.active) flown = autoplayDescentControls(this.runtime, this._neutralControls(), view);
        else flown = controls;
        flown.view = view;
        this.runtime.update(dt, flown);
      }

      // Camera controls work in every state so the player can look around
      // while paused or reviewing an outcome.
      this.cameraRig.drag(mouse.dx, mouse.dy);
      if (mouse.wheel) this.cameraRig.zoom(mouse.wheel);

      this.cameraRig.update(dt, this.runtime.lander, this.runtime.terrain, this.elapsed);
      this.environment.update(this.camera, this.runtime.lander.state.position, dt);

      this.particles.update(dt);
      this.hud.update(this.runtime, this.camera, dt);
      // No coaching while the computer is flying — it would tell the player
      // to press keys that are being ignored.
      if (this.state === "flight" && !this.autoplay.active) {
        this.coach.update(this.runtime, dt, this._lastView);
      }

      this._updateAudio(dt, controls);

      // Delay the debrief so the touchdown or the wreck can be seen.
      if (this.state === "flight" && this.runtime.result) {
        this.resultTimer += dt;
        if (this.resultTimer >= RESULT_DELAY) this._finishMission();
      }
    } else {
      // Menus: slowly drift the camera through empty space for a backdrop.
      this.camera.position.set(
        Math.sin(this.elapsed * 0.06) * 40,
        14,
        Math.cos(this.elapsed * 0.06) * 40
      );
      this.camera.lookAt(0, 12, 0);
      this.environment?.update(this.camera, null, dt);
      this.particles?.update(dt);
    }

    this._advanceAutoplayChain(dt);
    this.audio.update(dt);
    // Each phase is exposed like a photograph of its own scene: a sunlit
    // regolith plain, a launch under a blue sky, and sunlit hardware in space
    // all need different gain.
    const lit = this.coast?.space ?? this.ascent?.earth ?? this.environment;
    if (lit?.exposure) this.pipeline.setSceneExposure(lit.exposure, dt);
    this.pipeline.setWhiteBalance(lit?.whiteBalance ?? NEUTRAL_BALANCE, dt);
    this.pipeline.render(dt, this.elapsed, raw);
  }

  /**
   * Coaching for the settings where the player flies the late ascent: the
   * flight director's recommendation as a nudge, and a call when the stack is
   * inside the insertion window.
   */
  _ascentCues(dt) {
    const a = this.ascent;
    if (a.status !== "flying") return;

    if (!a.assists.autoGuidance && a.guidanceBias !== null) {
      this._directorHintTimer -= dt;
      const error = a.guidanceBias - a.state.pitchBias;
      if (Math.abs(error) > 4 && this._directorHintTimer <= 0) {
        this.ascentHud.showHint(
          error < 0 ? "Flight director: nose DOWN — hold S" : "Flight director: nose UP — hold W",
          2.4
        );
        this._directorHintTimer = 4;
      }
    }

    if (!a.assists.autoInsert) {
      const inWindow = a.inWindow;
      if (inWindow && !this._windowHintShown) {
        this.ascentHud.showHint("Inside the insertion window — press I to cut off", 8);
        this.audio.beep(1480, 0.14, 0.1, "sine");
      }
      this._windowHintShown = inWindow;
    }
  }

  _neutralControls() {
    return {
      pitch: 0,
      roll: 0,
      yaw: 0,
      translateX: 0,
      translateZ: 0,
      throttleUp: 0,
      throttleDown: 0,
      throttleFull: false,
      throttleCut: false,
      burn: false,
    };
  }

  /** Per-frame update for a launch. */
  _updateAscent(dt, controls, mouse) {
    const simulating = this.state === "flight" || this.state === "result";
    const live = this.state === "flight";

    if (simulating) {
      this.ascent.update(
        dt,
        !live ? this._ascentControls(this._neutralControls()) :
          this.autoplay.active ? this.autoplay.ascentControls(this.ascent) :
          this._ascentControls(controls)
      );
    }

    // The countdown banner lives outside the HUD so it can sit centre-screen.
    this.screens.setCountdownVisible(
      this.ascent.status === "countdown" && this.state === "flight"
    );

    this.ascentCamera.drag(mouse.dx, mouse.dy);
    if (mouse.wheel) this.ascentCamera.zoom(mouse.wheel);

    // Range camera hand-off, mirroring how a launch is actually covered.
    const handoff = this.ascentCamera.autoHandoff(this.ascent.telemetry.altitude);
    if (handoff) this.ascentHud.setCameraMode(ASCENT_CAMERA_LABELS[handoff]);

    this.ascentCamera.setDynamicPressure(this.ascent.telemetry.dynamicPressure);
    this.ascentCamera.update(
      dt,
      this.ascent.state,
      this.ascent.vehicleWorldPosition,
      this.ascent.vehicleHeight,
      this.elapsed
    );

    this.ascent.earth.update(
      this.camera,
      this.ascent.telemetry.altitude,
      this.ascent.vehicleWorldPosition,
      dt
    );

    this.particles.update(dt);
    this.ascentHud.update(this.ascent, dt);
    if (live) this._ascentCues(dt);

    // Audio thins out with the air, leaving only structure-borne rumble.
    const density = pressureRatio(this.ascent.telemetry.altitude);
    this.audio.setLaunchEngine(live ? this.ascent.state.throttle : 0, density);
    this.audio.setAlarm(live && this.ascentHud.alarmActive);

    if (this.state === "flight" && this.ascent.result) {
      this.resultTimer += dt;
      if (this.resultTimer >= RESULT_DELAY) this._finishAscent();
    }
  }

  _updateAudio(dt, controls) {
    const s = this.runtime.lander.state;
    const flying = this.state === "flight";

    this.audio.setEngine(flying ? s.throttle : 0);
    this.audio.setAlarm(flying && this.hud.alarmActive);

    // RCS jets bang audibly through the structure when they fire.
    const rcsMag = flying
      ? Math.abs(controls.pitch) + Math.abs(controls.roll) + Math.abs(controls.yaw) +
        Math.abs(controls.translateX) + Math.abs(controls.translateZ)
      : 0;
    if (rcsMag > 0.01 && this._prevRcsMagnitude <= 0.01 && s.rcsFuel > 0) {
      this.audio.pulseRcs(0.9);
    }
    // Sustained input keeps popping at a low rate, as pulsed jets do.
    if (rcsMag > 0.01 && s.rcsFuel > 0) {
      this._rcsTimer = (this._rcsTimer ?? 0) - dt;
      if (this._rcsTimer <= 0) {
        this._rcsTimer = 0.14 + Math.random() * 0.12;
        this.audio.pulseRcs(0.4);
      }
    }
    this._prevRcsMagnitude = rcsMag;
  }
}

const game = new Game();
if (import.meta.env.DEV) {
  window.__game = game;
  // Dynamic import inside a DEV guard: Vite drops the whole branch, and the
  // harness with it, from production builds.
  import("./dev/harness.js").then((m) => m.installHarness(game));
}
game.init().catch((err) => {
  console.error(err);
  const status = document.getElementById("load-status");
  if (status) status.textContent = `Failed to start: ${err.message}`;
});
