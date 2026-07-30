/**
 * @file AudioEngine.js
 * @description Fully synthesised sound design.
 *
 * Every sound in AeroMind XR is generated at runtime with the Web Audio API:
 * the hangar's room tone, the turbine's residual hum, the inspection sweep, the
 * interface clicks and the AI's alert tones. Nothing is sampled, so there is no
 * licensing question, no download, and no audio file to go missing offline.
 *
 * Browsers require a user gesture before audio may start; {@link AudioEngine#unlock}
 * is called from the start menu button, which is exactly such a gesture.
 */

import { clamp } from './Utils.js';

/**
 * Procedural audio director.
 * @class
 */
export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} Master output gain. */
    this.master = null;
    /** @type {GainNode|null} Ambience bus. */
    this.ambienceBus = null;
    /** @type {GainNode|null} Effects bus. */
    this.fxBus = null;
    /** @type {ConvolverNode|null} Shared hangar reverb. */
    this.reverb = null;
    /** @type {boolean} */
    this.enabled = true;
    /** @type {boolean} */
    this.started = false;
    /** @type {Map<string, {gain: GainNode, stop: function(): void}>} */
    this.loops = new Map();
    /** @type {AudioBuffer|null} Cached noise source buffer. */
    this._noiseBuffer = null;
  }

  /**
   * Creates the audio graph. Safe to call repeatedly; only the first call has
   * an effect. Must be invoked from within a user-gesture handler.
   * @returns {Promise<boolean>} Whether audio is available.
   */
  async unlock() {
    if (this.started) return true;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      this.enabled = false;
      return false;
    }

    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.0001;
      this.master.connect(this.ctx.destination);

      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this.#createImpulseResponse(3.4, 2.6);
      const reverbGain = this.ctx.createGain();
      reverbGain.gain.value = 0.32;
      this.reverb.connect(reverbGain);
      reverbGain.connect(this.master);

      this.ambienceBus = this.ctx.createGain();
      this.ambienceBus.gain.value = 1;
      this.ambienceBus.connect(this.master);
      this.ambienceBus.connect(this.reverb);

      this.fxBus = this.ctx.createGain();
      this.fxBus.gain.value = 1;
      this.fxBus.connect(this.master);
      this.fxBus.connect(this.reverb);

      this.started = true;
      this.fadeMaster(0.85, 2.5);
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  /**
   * Eases the master volume.
   * @param {number} value Target gain, 0–1.
   * @param {number} [seconds] Ramp duration.
   */
  fadeMaster(value, seconds = 1) {
    if (!this.started) return;
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.exponentialRampToValueAtTime(Math.max(0.0001, clamp(value, 0, 1)), now + seconds);
  }

  /** Toggles all output without tearing down the graph. */
  toggleMute() {
    this.enabled = !this.enabled;
    this.fadeMaster(this.enabled ? 0.85 : 0.0001, 0.4);
    return this.enabled;
  }

  /* ------------------------------------------------------------ primitives */

  /**
   * Returns a cached 4-second buffer of white noise.
   * @returns {AudioBuffer}
   * @private
   */
  #noise() {
    if (this._noiseBuffer) return this._noiseBuffer;
    const length = this.ctx.sampleRate * 4;
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Brown-ish noise: integrating white noise tilts the spectrum downward,
    // which reads as air movement rather than hiss.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    this._noiseBuffer = buffer;
    return buffer;
  }

  /**
   * Synthesises a decaying-noise impulse response for the hangar reverb.
   * @param {number} seconds Tail length.
   * @param {number} decay Decay exponent; higher is tighter.
   * @returns {AudioBuffer}
   * @private
   */
  #createImpulseResponse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const channel = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Early reflections then a smooth exponential tail.
        const early = i < rate * 0.06 ? (Math.random() * 2 - 1) * 0.6 : 0;
        channel[i] = ((Math.random() * 2 - 1) * 0.5 + early) * Math.pow(1 - t, decay);
      }
    }
    return impulse;
  }

  /**
   * Creates and starts an oscillator with an envelope.
   * @param {object} spec Tone description.
   * @param {number} spec.freq Starting frequency in Hz.
   * @param {number} [spec.toFreq] Frequency to glide to.
   * @param {OscillatorType} [spec.type] Waveform.
   * @param {number} [spec.duration] Total length in seconds.
   * @param {number} [spec.attack] Attack time in seconds.
   * @param {number} [spec.gain] Peak gain.
   * @param {number} [spec.delay] Start offset in seconds.
   * @param {AudioNode} [spec.destination] Output node.
   * @private
   */
  #tone(spec) {
    const {
      freq, toFreq = null, type = 'sine', duration = 0.4,
      attack = 0.006, gain = 0.2, delay = 0, destination = this.fxBus,
    } = spec;

    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (toFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, toFreq), now + duration);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env);
    env.connect(destination);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  /**
   * Creates a filtered burst of noise.
   * @param {object} spec Burst description.
   * @param {number} [spec.freq] Filter start frequency.
   * @param {number} [spec.toFreq] Filter end frequency.
   * @param {number} [spec.q] Filter resonance.
   * @param {number} [spec.duration] Length in seconds.
   * @param {number} [spec.gain] Peak gain.
   * @param {number} [spec.delay] Start offset.
   * @param {BiquadFilterType} [spec.filter] Filter type.
   * @private
   */
  #noiseBurst(spec) {
    const {
      freq = 800, toFreq = null, q = 1.2, duration = 0.4,
      gain = 0.2, delay = 0, filter = 'bandpass',
    } = spec;

    const now = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.#noise();
    src.loop = true;

    const biquad = this.ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.setValueAtTime(freq, now);
    biquad.Q.value = q;
    if (toFreq !== null) biquad.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), now + duration);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + duration * 0.15);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    src.connect(biquad);
    biquad.connect(env);
    env.connect(this.fxBus);
    src.start(now);
    src.stop(now + duration + 0.05);
  }

  /* -------------------------------------------------------------- ambience */

  /**
   * Starts the hangar room tone: a wide bed of filtered air movement, a deep
   * structural drone, and a slow breathing modulation.
   * @param {number} [level] Bed level, 0–1.
   */
  startAmbience(level = 0.5) {
    if (!this.started || this.loops.has('ambience')) return;

    const now = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(level, now + 4);
    out.connect(this.ambienceBus);

    // Air bed.
    const air = this.ctx.createBufferSource();
    air.buffer = this.#noise();
    air.loop = true;
    const airFilter = this.ctx.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = 420;
    airFilter.Q.value = 0.6;
    const airGain = this.ctx.createGain();
    airGain.gain.value = 0.5;
    air.connect(airFilter); airFilter.connect(airGain); airGain.connect(out);

    // Structural drone: two slightly detuned low sines beat against each other,
    // producing a slow pulse that a single oscillator cannot.
    const droneGain = this.ctx.createGain();
    droneGain.gain.value = 0.09;
    droneGain.connect(out);
    const droneOscs = [43.65, 44.1, 87.3].map((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.value = i === 2 ? 0.25 : 1;
      o.connect(g); g.connect(droneGain);
      o.start(now);
      return o;
    });

    // Breathing modulation on the air bed's cutoff.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 130;
    lfo.connect(lfoGain);
    lfoGain.connect(airFilter.frequency);
    lfo.start(now);

    air.start(now);

    this.loops.set('ambience', {
      gain: out,
      stop: () => {
        air.stop();
        lfo.stop();
        droneOscs.forEach((o) => o.stop());
      },
    });
  }

  /**
   * Starts the turbine's residual whine — a resonant band that the story lifts
   * when the engine spools and drops when it is shut down for inspection.
   * @param {number} [level] Level, 0–1.
   */
  startTurbine(level = 0.22) {
    if (!this.started || this.loops.has('turbine')) return;

    const now = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), now + 3);
    out.connect(this.ambienceBus);

    const src = this.ctx.createBufferSource();
    src.buffer = this.#noise();
    src.loop = true;

    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1180;
    band.Q.value = 7.5;

    const harmonic = this.ctx.createOscillator();
    harmonic.type = 'sawtooth';
    harmonic.frequency.value = 196;
    const harmonicGain = this.ctx.createGain();
    harmonicGain.gain.value = 0.012;

    src.connect(band); band.connect(out);
    harmonic.connect(harmonicGain); harmonicGain.connect(out);

    src.start(now);
    harmonic.start(now);

    this.loops.set('turbine', {
      gain: out,
      stop: () => { src.stop(); harmonic.stop(); },
    });
  }

  /**
   * Sets the level of a running loop.
   * @param {string} name Loop identifier.
   * @param {number} level Target gain.
   * @param {number} [seconds] Ramp duration.
   */
  setLoopLevel(name, level, seconds = 1.5) {
    const loop = this.loops.get(name);
    if (!loop) return;
    const now = this.ctx.currentTime;
    loop.gain.gain.cancelScheduledValues(now);
    loop.gain.gain.setValueAtTime(Math.max(0.0001, loop.gain.gain.value), now);
    loop.gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), now + seconds);
  }

  /**
   * Stops and discards a running loop.
   * @param {string} name Loop identifier.
   */
  stopLoop(name) {
    const loop = this.loops.get(name);
    if (!loop) return;
    this.setLoopLevel(name, 0.0001, 1.2);
    setTimeout(() => { try { loop.stop(); } catch { /* already stopped */ } }, 1400);
    this.loops.delete(name);
  }

  /* ----------------------------------------------------------------- cues */

  /**
   * Plays a named one-shot. Unknown names are ignored, so the story can cue
   * sounds freely without defensive checks at every call site.
   * @param {string} name Cue identifier.
   * @param {object} [options] Cue options.
   * @param {number} [options.delay] Start offset in seconds.
   * @param {number} [options.gain] Level multiplier.
   */
  play(name, options = {}) {
    if (!this.started || !this.enabled) return;
    const { delay = 0, gain = 1 } = options;

    switch (name) {
      // A soft, wide swell used under the title cards.
      case 'riser':
        this.#noiseBurst({ freq: 120, toFreq: 2600, q: 0.9, duration: 3.2, gain: 0.13 * gain, delay });
        this.#tone({ freq: 110, toFreq: 220, type: 'sine', duration: 3.4, attack: 1.6, gain: 0.10 * gain, delay });
        break;

      // Glasses power-on: a rising two-tone with a bright confirmation tick.
      case 'boot':
        this.#tone({ freq: 220, toFreq: 660, type: 'sine', duration: 0.65, gain: 0.16 * gain, delay });
        this.#tone({ freq: 330, toFreq: 990, type: 'triangle', duration: 0.5, gain: 0.09 * gain, delay: delay + 0.08 });
        this.#noiseBurst({ freq: 3000, toFreq: 7000, q: 2.2, duration: 0.3, gain: 0.06 * gain, delay: delay + 0.5 });
        break;

      // Interface tick.
      case 'click':
        this.#tone({ freq: 1400, toFreq: 900, type: 'sine', duration: 0.09, gain: 0.10 * gain, delay });
        this.#noiseBurst({ freq: 5200, q: 3.5, duration: 0.05, gain: 0.05 * gain, delay });
        break;

      // Panel materialisation.
      case 'panel':
        this.#noiseBurst({ freq: 900, toFreq: 3400, q: 1.6, duration: 0.42, gain: 0.055 * gain, delay });
        this.#tone({ freq: 520, toFreq: 780, type: 'sine', duration: 0.36, gain: 0.055 * gain, delay });
        break;

      // Inspection sweep: a long filtered pass with a Doppler-like glide.
      case 'scan':
        this.#noiseBurst({ freq: 400, toFreq: 5200, q: 3.2, duration: 4.2, gain: 0.10 * gain, delay });
        this.#tone({ freq: 880, toFreq: 1760, type: 'sine', duration: 4.2, attack: 1.2, gain: 0.05 * gain, delay });
        break;

      // Positive confirmation — a clean rising major third.
      case 'confirm':
        this.#tone({ freq: 660, type: 'sine', duration: 0.26, gain: 0.13 * gain, delay });
        this.#tone({ freq: 880, type: 'sine', duration: 0.34, gain: 0.11 * gain, delay: delay + 0.09 });
        this.#tone({ freq: 1320, type: 'sine', duration: 0.5, gain: 0.06 * gain, delay: delay + 0.18 });
        break;

      // Anomaly detected — a tense minor interval, deliberately not alarming.
      case 'alert':
        this.#tone({ freq: 494, type: 'triangle', duration: 0.4, gain: 0.13 * gain, delay });
        this.#tone({ freq: 587, type: 'triangle', duration: 0.55, gain: 0.10 * gain, delay: delay + 0.14 });
        this.#noiseBurst({ freq: 1800, q: 4.0, duration: 0.5, gain: 0.05 * gain, delay });
        break;

      // The AI has something to say.
      case 'notify':
        this.#tone({ freq: 1046, type: 'sine', duration: 0.3, gain: 0.09 * gain, delay });
        this.#tone({ freq: 1568, type: 'sine', duration: 0.42, gain: 0.055 * gain, delay: delay + 0.11 });
        break;

      // Air movement as something large passes or resolves.
      case 'whoosh':
        this.#noiseBurst({ freq: 260, toFreq: 1900, q: 0.8, duration: 1.1, gain: 0.10 * gain, delay });
        break;

      // Task complete / everything green.
      case 'resolve':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          this.#tone({ freq: f, type: 'sine', duration: 1.4 - i * 0.12, attack: 0.02, gain: (0.12 - i * 0.02) * gain, delay: delay + i * 0.13 });
        });
        break;

      default:
        break;
    }
  }

  /** Stops everything and releases the audio context. */
  dispose() {
    for (const name of [...this.loops.keys()]) this.stopLoop(name);
    if (this.ctx) {
      setTimeout(() => this.ctx?.close().catch(() => {}), 1600);
    }
    this.started = false;
  }
}
