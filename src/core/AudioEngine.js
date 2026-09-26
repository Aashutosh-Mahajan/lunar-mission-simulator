// ---------------------------------------------------------------------------
// Procedural audio. Every sound here is synthesised with the Web Audio API —
// the project ships no audio files.
//
// A note on realism: vacuum carries no sound, so nothing outside the vehicle
// could actually be heard. What the Apollo crews did hear was structure-borne
// vibration conducted through the hull — the descent engine as a low rumble,
// the RCS as sharp bangs — plus cabin fans and the caution/warning tones.
// That is exactly what this mixes: hull vibration and cockpit electronics,
// not "space explosions".
// ---------------------------------------------------------------------------

export default class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.ready = false;
    this._alarmOn = false;
    this._alarmTimer = 0;
    this._contactChimePlayed = false;
  }

  /** Must be called from a user gesture; browsers block audio before one. */
  init() {
    // Dev-only: `?silent` in the URL keeps the audio graph from ever starting,
    // so automated test runs in a browser make no sound. Every audio method
    // already tolerates a null context, so the game runs normally otherwise.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("silent")) return;

    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    this.master.connect(ctx.destination);

    // Gentle limiter so the crash and the alarms can't clip the mix.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.master);

    this._buildNoise();
    this._buildEngine();
    this._buildCabin();

    this.ready = true;
  }

  _buildNoise() {
    const ctx = this.ctx;
    const seconds = 2;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Brown-ish noise: integrated white noise, which has the low-frequency
    // weighting that structural rumble actually has.
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    this.noiseBuffer = buffer;

    // Also keep a white buffer for transients (bangs, sparks).
    const white = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    this.whiteBuffer = white;
  }

  _buildEngine() {
    const ctx = this.ctx;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.limiter);

    // Rumble: filtered brown noise.
    this.engineNoise = ctx.createBufferSource();
    this.engineNoise.buffer = this.noiseBuffer;
    this.engineNoise.loop = true;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 220;
    this.engineFilter.Q.value = 1.1;

    // A resonant peak gives the rumble a sense of a big chamber.
    this.enginePeak = ctx.createBiquadFilter();
    this.enginePeak.type = "peaking";
    this.enginePeak.frequency.value = 74;
    this.enginePeak.Q.value = 1.6;
    this.enginePeak.gain.value = 9;

    this.engineNoise.connect(this.engineFilter);
    this.engineFilter.connect(this.enginePeak);
    this.enginePeak.connect(this.engineGain);
    this.engineNoise.start();

    // Sub-bass body, slightly detuned pair for beating.
    this.engineOscGain = ctx.createGain();
    this.engineOscGain.gain.value = 0;
    this.engineOscGain.connect(this.engineGain);
    this.engineOscs = [];
    for (const freq of [31, 38.5]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(this.engineOscGain);
      osc.start();
      this.engineOscs.push(osc);
    }
  }

  /**
   * The launch bus. A Saturn V is a fundamentally different sound object from
   * a lunar descent engine: ~200 dB of mostly sub-100 Hz energy, felt as much
   * as heard. It is built here as heavily low-passed noise with a deep
   * resonant peak, plus a sub-bass pair — and it thins out as the vehicle
   * climbs, because above the atmosphere only structure-borne vibration is
   * left to carry it.
   */
  _buildLaunchBus() {
    if (this.launchGain) return;
    const ctx = this.ctx;

    this.launchGain = ctx.createGain();
    this.launchGain.gain.value = 0;
    this.launchGain.connect(this.limiter);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    this.launchLow = ctx.createBiquadFilter();
    this.launchLow.type = "lowpass";
    this.launchLow.frequency.value = 320;
    this.launchLow.Q.value = 0.9;

    // Deep chamber resonance — the part that rattles windows.
    this.launchPeak = ctx.createBiquadFilter();
    this.launchPeak.type = "peaking";
    this.launchPeak.frequency.value = 42;
    this.launchPeak.Q.value = 1.1;
    this.launchPeak.gain.value = 15;

    // Crackle: the nonlinear "tearing" component of a big liquid engine.
    this.launchCrackle = ctx.createBiquadFilter();
    this.launchCrackle.type = "bandpass";
    this.launchCrackle.frequency.value = 1400;
    this.launchCrackle.Q.value = 0.55;
    this.launchCrackleGain = ctx.createGain();
    this.launchCrackleGain.gain.value = 0.1;

    src.connect(this.launchLow);
    this.launchLow.connect(this.launchPeak);
    this.launchPeak.connect(this.launchGain);
    src.connect(this.launchCrackle);
    this.launchCrackle.connect(this.launchCrackleGain);
    this.launchCrackleGain.connect(this.launchGain);
    src.start();

    this.launchSubGain = ctx.createGain();
    this.launchSubGain.gain.value = 0;
    this.launchSubGain.connect(this.launchGain);
    this.launchSubs = [];
    for (const f of [22, 27.5]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(this.launchSubGain);
      osc.start();
      this.launchSubs.push(osc);
    }
  }

  startLaunchRumble() {
    if (!this.ready) return;
    this._buildLaunchBus();
  }

  /**
   * @param {number} throttle 0..1
   * @param {number} densityRatio 1 at sea level, 0 in vacuum
   */
  setLaunchEngine(throttle, densityRatio = 1) {
    if (!this.ready || !this.launchGain) return;
    const now = this.ctx.currentTime;
    // Airborne sound dies with the air; what remains is conducted through
    // the structure, so the level drops but never quite to zero.
    const carry = 0.3 + densityRatio * 0.7;
    const target = throttle > 0.01 ? (0.2 + throttle * 0.62) * carry : 0;
    this.launchGain.gain.setTargetAtTime(target, now, 0.12);
    this.launchSubGain.gain.setTargetAtTime(throttle > 0.01 ? throttle * 0.5 : 0, now, 0.15);
    // In vacuum the high end vanishes first.
    this.launchLow.frequency.setTargetAtTime(120 + densityRatio * 420, now, 0.25);
    this.launchCrackleGain.gain.setTargetAtTime(0.11 * densityRatio * throttle, now, 0.2);
  }

  stopLaunchEngine() {
    if (!this.ready || !this.launchGain) return;
    this.launchGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    this.launchSubGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
  }

  /** Pyrotechnic stage separation: a hard crack, then the next stage lighting. */
  stagingBang() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.whiteBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900, now);
    bp.frequency.exponentialRampToValueAtTime(160, now + 0.4);
    bp.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.limiter);
    src.start(now);
    src.stop(now + 0.6);

    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(78, now);
    thud.frequency.exponentialRampToValueAtTime(28, now + 0.4);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.42, now + 0.01);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    thud.connect(tg);
    tg.connect(this.limiter);
    thud.start(now);
    thud.stop(now + 0.65);
  }

  /** Constant, very quiet cabin environment: fans and avionics. */
  _buildCabin() {
    const ctx = this.ctx;
    this.cabinGain = ctx.createGain();
    this.cabinGain.gain.value = 0.05;
    this.cabinGain.connect(this.limiter);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 420;
    bp.Q.value = 0.6;
    src.connect(bp);
    bp.connect(this.cabinGain);
    src.start();

    const hum = ctx.createOscillator();
    hum.type = "sine";
    hum.frequency.value = 118;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.012;
    hum.connect(humGain);
    humGain.connect(this.limiter);
    hum.start();
  }

  // -------------------------------------------------------------------------
  // Continuous state
  // -------------------------------------------------------------------------

  setEngine(throttle) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const target = throttle > 0.01 ? 0.16 + throttle * 0.42 : 0;
    this.engineGain.gain.setTargetAtTime(target, now, 0.09);
    this.engineOscGain.gain.setTargetAtTime(throttle > 0.01 ? throttle * 0.3 : 0, now, 0.12);
    // Higher throttle opens the filter — more energy in the upper harmonics.
    this.engineFilter.frequency.setTargetAtTime(160 + throttle * 460, now, 0.15);
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  /** Sharp RCS thruster bang conducted through the structure. */
  pulseRcs(intensity = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.whiteBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 320 + Math.random() * 220;
    bp.Q.value = 1.4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.16 * intensity, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.limiter);
    src.start(now);
    src.stop(now + 0.14);
  }

  /** Footpad contact: the CONTACT light chime plus a structural thump. */
  touchdown(energy = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(96, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.28);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(Math.min(0.6, 0.28 * energy), now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    osc.connect(gain);
    gain.connect(this.limiter);
    osc.start(now);
    osc.stop(now + 0.45);

    const src = ctx.createBufferSource();
    src.buffer = this.whiteBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.22 * energy, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(this.limiter);
    src.start(now);
    src.stop(now + 0.26);
  }

  /** Structural failure. */
  crash(energy = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.setValueAtTime(1.6, now);
    src.playbackRate.exponentialRampToValueAtTime(0.35, now + 1.1);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2600, now);
    lp.frequency.exponentialRampToValueAtTime(120, now + 1.2);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.85 * energy, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);

    src.connect(lp);
    lp.connect(gain);
    gain.connect(this.limiter);
    src.start(now);
    src.stop(now + 1.6);

    // Metallic tearing on top.
    for (let i = 0; i < 5; i++) {
      const t = now + Math.random() * 0.35;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(420 + Math.random() * 900, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(g);
      g.connect(this.limiter);
      osc.start(t);
      osc.stop(t + 0.34);
    }
  }

  /** Cockpit tone — used for the contact light, caution and UI feedback. */
  beep(freq = 880, duration = 0.09, gainValue = 0.09, type = "square") {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainValue, now + 0.008);
    gain.gain.setValueAtTime(gainValue, now + duration * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(this.limiter);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  click() {
    this.beep(1500, 0.035, 0.05, "square");
  }

  contactLight() {
    this.beep(1320, 0.14, 0.12, "sine");
  }

  /** Master caution: an intermittent two-tone, as in the real cockpit. */
  setAlarm(on) {
    this._alarmOn = on;
    if (!on) this._alarmTimer = 0;
  }

  update(dt) {
    if (!this.ready) return;
    if (this._alarmOn) {
      this._alarmTimer -= dt;
      if (this._alarmTimer <= 0) {
        this._alarmTimer = 0.62;
        this.beep(740, 0.16, 0.075, "square");
      }
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }
}
