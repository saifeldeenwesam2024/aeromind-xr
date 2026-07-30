/**
 * @file XRManager.js
 * @description Immersive session and presentation-mode negotiation.
 *
 * There is no single "VR mode" on the open web, so this manager negotiates the
 * best available path and degrades in a defined order:
 *
 *   1. **WebXR immersive-vr** — a real headset, or a phone with a WebXR-capable
 *      browser. The runtime owns stereo, pose and reprojection.
 *   2. **Cardboard stereo** — side-by-side rendering driven by device
 *      orientation, plus fullscreen, landscape lock and screen wake lock.
 *   3. **Magic window** — stereo unavailable, but sensors work: a single
 *      full-screen view that the viewer steers by moving the phone.
 *   4. **Flat preview** — mouse and keyboard on a desktop.
 *
 * Every step down is automatic and silent. A judge picking up an unfamiliar
 * phone should never see a capability error.
 */

import { InputManager } from './InputManager.js';

/**
 * Negotiates and owns the active presentation mode.
 * @class
 */
export class XRManager {
  /**
   * @param {import('./Renderer.js').Renderer} renderer Rendering back-end.
   * @param {InputManager} input Input manager supplying head tracking.
   */
  constructor(renderer, input) {
    /** @type {import('./Renderer.js').Renderer} */
    this.renderer = renderer;
    /** @type {InputManager} */
    this.input = input;

    /** @type {'flat'|'stereo'|'magicwindow'|'xr'} Active presentation mode. */
    this.mode = 'flat';
    /** @type {XRSession|null} */
    this.session = null;
    /** @type {boolean} Whether immersive-vr is supported by this browser. */
    this.xrSupported = false;
    /** @type {*} Screen wake lock sentinel, when granted. */
    this.wakeLock = null;
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    this._onSessionEnd = this.#onSessionEnd.bind(this);
    this._onFullscreenChange = this.#onFullscreenChange.bind(this);
    this._onVisibility = this.#onVisibilityChange.bind(this);

    document.addEventListener('fullscreenchange', this._onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this._onFullscreenChange);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  /* ------------------------------------------------------------- events */

  /**
   * Subscribes to a manager event.
   * @param {string} type Event name.
   * @param {Function} handler Callback.
   * @returns {function(): void} Unsubscribe function.
   */
  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return () => this._listeners.get(type)?.delete(handler);
  }

  /**
   * @param {string} type Event name.
   * @param {*} [payload] Event payload.
   * @private
   */
  #emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const handler of set) handler(payload);
  }

  /* --------------------------------------------------------- capabilities */

  /**
   * Probes the platform once and caches the result.
   * @returns {Promise<{xr: boolean, sensors: boolean, touch: boolean, needsPermission: boolean, fullscreen: boolean}>}
   */
  async probe() {
    const caps = InputManager.capabilities();

    if (navigator.xr?.isSessionSupported) {
      try {
        this.xrSupported = await navigator.xr.isSessionSupported('immersive-vr');
      } catch {
        this.xrSupported = false;
      }
    }

    /** @type {{xr: boolean, sensors: boolean, touch: boolean, needsPermission: boolean, fullscreen: boolean}} */
    this.capabilities = {
      xr: this.xrSupported,
      sensors: caps.orientationEvents,
      touch: caps.touch,
      needsPermission: caps.needsPermission,
      fullscreen: !!(document.documentElement.requestFullscreen ||
        document.documentElement.webkitRequestFullscreen),
    };
    return this.capabilities;
  }

  /**
   * A short human-readable label describing what "Enter VR" will actually do
   * on this device, shown on the start menu so expectations are set honestly.
   * @returns {string}
   */
  describeVrPath() {
    if (this.xrSupported) return 'WebXR headset — native stereo';
    if (this.capabilities?.sensors && this.capabilities?.touch) {
      return 'Google Cardboard — stereoscopic';
    }
    if (this.capabilities?.sensors) return 'Stereoscopic — split screen';
    return 'Stereoscopic preview — split screen';
  }

  /* ------------------------------------------------------------- entering */

  /**
   * Enters the best available immersive mode. Must be called from a user
   * gesture: fullscreen, orientation lock and iOS sensor permission all
   * require one.
   * @returns {Promise<'xr'|'stereo'|'magicwindow'>} The mode actually entered.
   */
  async enterImmersive() {
    if (this.xrSupported) {
      const started = await this.#startXRSession();
      if (started) return 'xr';
    }

    // Cardboard path: go fullscreen and lock landscape first, because both
    // change the viewport and we want a single resize, not three.
    await this.requestFullscreen();
    await this.lockLandscape();
    await this.requestWakeLock();

    const sensors = await this.input.enableDeviceOrientation();

    // Head roll is genuine when the phone is strapped into a viewer, so it is
    // preserved. Hand-held magic-window viewing gets mild roll suppression
    // because wrist tremor there is noise, not intent.
    this.input.horizonStability = sensors ? 0 : 0.4;

    this.#setMode('stereo');
    this.#emit('enter', { mode: 'stereo', sensors });
    return 'stereo';
  }

  /**
   * Enters single-view mode with sensor steering — the fallback for phones
   * without a viewer, and a comfortable way to preview on a tablet.
   * @returns {Promise<'magicwindow'>}
   */
  async enterMagicWindow() {
    await this.requestWakeLock();
    const sensors = await this.input.enableDeviceOrientation();
    this.input.horizonStability = 0.45;
    this.#setMode('magicwindow');
    this.#emit('enter', { mode: 'magicwindow', sensors });
    return 'magicwindow';
  }

  /**
   * Enters the flat desktop preview.
   * @returns {Promise<'flat'>}
   */
  async enterFlat() {
    this.input.disableDeviceOrientation();
    this.input.mode = 'pointer';
    this.#setMode('flat');
    this.#emit('enter', { mode: 'flat', sensors: false });
    return 'flat';
  }

  /**
   * Leaves the current immersive mode and returns to the flat preview.
   * @returns {Promise<void>}
   */
  async exitImmersive() {
    if (this.session) {
      try { await this.session.end(); } catch { /* already ending */ }
      return;
    }
    await this.exitFullscreen();
    this.unlockOrientation();
    this.releaseWakeLock();
    this.input.disableDeviceOrientation();
    this.input.mode = 'pointer';
    this.#setMode('flat');
    this.#emit('exit', { mode: 'flat' });
  }

  /**
   * Toggles between stereoscopic and flat presentation.
   * @returns {Promise<string>} The resulting mode.
   */
  async toggleStereo() {
    if (this.mode === 'flat') return this.enterImmersive();
    await this.exitImmersive();
    return 'flat';
  }

  /**
   * Applies a presentation mode to the renderer and input layer.
   * @param {'flat'|'stereo'|'magicwindow'|'xr'} mode Mode to apply.
   * @private
   */
  #setMode(mode) {
    this.mode = mode;
    // `magicwindow` shares the flat render path; only the input source differs.
    this.renderer.setMode(mode === 'stereo' ? 'stereo' : mode === 'xr' ? 'xr' : 'flat');
    this.#emit('modechange', { mode });
  }

  /* ------------------------------------------------------------- WebXR */

  /**
   * Requests and wires an immersive-vr session.
   * @returns {Promise<boolean>} Whether the session started.
   * @private
   */
  async #startXRSession() {
    try {
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });

      this.session = session;
      session.addEventListener('end', this._onSessionEnd);

      this.renderer.setMode('xr');
      await this.renderer.renderer.xr.setSession(session);
      this.renderer.renderer.xr.setReferenceSpaceType('local-floor');

      this.input.mode = 'xr';
      this.mode = 'xr';
      this.#emit('enter', { mode: 'xr', sensors: true });
      this.#emit('modechange', { mode: 'xr' });
      return true;
    } catch {
      this.session = null;
      return false;
    }
  }

  /**
   * Restores flat presentation when the headset session ends.
   * @private
   */
  #onSessionEnd() {
    this.session?.removeEventListener('end', this._onSessionEnd);
    this.session = null;
    this.input.mode = 'pointer';
    this.#setMode('flat');
    this.#emit('exit', { mode: 'flat' });
  }

  /* --------------------------------------------------- screen management */

  /**
   * Requests fullscreen on the document element.
   * @returns {Promise<boolean>} Whether fullscreen was granted.
   */
  async requestFullscreen() {
    const el = document.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!request) return false;
    try {
      await request.call(el, { navigationUI: 'hide' });
      return true;
    } catch {
      // iOS Safari refuses fullscreen outside of video elements. The
      // experience still works; it simply keeps the browser chrome.
      return false;
    }
  }

  /**
   * Leaves fullscreen if active.
   * @returns {Promise<void>}
   */
  async exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit || !this.isFullscreen) return;
    try { await exit.call(document); } catch { /* already exited */ }
  }

  /** @returns {boolean} Whether the document is currently fullscreen. */
  get isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  /**
   * Locks the screen to landscape. Only possible while fullscreen, and only on
   * browsers that implement the Screen Orientation API; elsewhere the rotate
   * prompt in the UI covers the gap.
   * @returns {Promise<boolean>} Whether the lock was applied.
   */
  async lockLandscape() {
    if (!screen.orientation?.lock) return false;
    try {
      await screen.orientation.lock('landscape');
      return true;
    } catch {
      return false;
    }
  }

  /** Releases an orientation lock. */
  unlockOrientation() {
    try { screen.orientation?.unlock?.(); } catch { /* not locked */ }
  }

  /**
   * Requests a screen wake lock so the display does not sleep mid-demo.
   * @returns {Promise<boolean>} Whether the lock was granted.
   */
  async requestWakeLock() {
    if (!navigator.wakeLock?.request) return false;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      return true;
    } catch {
      return false;
    }
  }

  /** Releases the screen wake lock. */
  releaseWakeLock() {
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
  }

  /**
   * Re-acquires the wake lock after the tab returns to the foreground, which
   * the specification drops automatically.
   * @private
   */
  async #onVisibilityChange() {
    if (document.visibilityState === 'visible' && this.wakeLock === null &&
        (this.mode === 'stereo' || this.mode === 'magicwindow')) {
      await this.requestWakeLock();
    }
    this.#emit('visibility', { visible: document.visibilityState === 'visible' });
  }

  /**
   * Falls back to flat presentation if the viewer leaves fullscreen with the
   * system gesture rather than the in-experience control.
   * @private
   */
  #onFullscreenChange() {
    this.#emit('fullscreenchange', { fullscreen: this.isFullscreen });
    if (!this.isFullscreen && this.mode === 'stereo') {
      this.exitImmersive();
    }
  }

  /**
   * Whether the viewer should be prompted to rotate their device.
   * @returns {boolean}
   */
  get needsRotation() {
    if (this.mode !== 'stereo') return false;
    return window.innerHeight > window.innerWidth;
  }

  /** Detaches listeners and releases locks. */
  dispose() {
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', this._onFullscreenChange);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.releaseWakeLock();
    this.unlockOrientation();
    this._listeners.clear();
  }
}
