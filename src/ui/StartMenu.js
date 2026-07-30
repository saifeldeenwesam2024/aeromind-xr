/**
 * @file StartMenu.js
 * @description Controller for the entry menu and the in-experience control bar.
 *
 * The menu's job is to make one decision honest: what "Enter VR" will actually
 * do on *this* device. A phone with a WebXR runtime, a phone with only motion
 * sensors, and a laptop are three genuinely different experiences, and the
 * button label says which one the viewer is about to get rather than promising
 * something the hardware cannot deliver.
 *
 * The entry buttons are also where audio is unlocked and where iOS motion
 * permission is requested — both require a real user gesture, and this is the
 * only guaranteed one in the whole session.
 */

/**
 * Drives the start menu, the control bar and the rotate prompt.
 * @class
 */
export class StartMenu {
  constructor() {
    /** @type {?HTMLElement} */
    this.root = document.querySelector('#start-menu');
    /** @type {?HTMLButtonElement} */
    this.vrButton = document.querySelector('#btn-vr');
    /** @type {?HTMLButtonElement} */
    this.desktopButton = document.querySelector('#btn-desktop');
    /** @type {?HTMLElement} */
    this.vrTitle = document.querySelector('#btn-vr-title');
    /** @type {?HTMLElement} */
    this.vrSub = document.querySelector('#btn-vr-sub');
    /** @type {?HTMLElement} */
    this.desktopSub = document.querySelector('#btn-desktop-sub');
    /** @type {?HTMLElement} */
    this.note = document.querySelector('#menu-note');
    /** @type {?HTMLElement} */
    this.rotatePrompt = document.querySelector('#rotate-prompt');

    /* ------------------------------------------------------- control bar */

    /** @type {?HTMLElement} */
    this.bar = document.querySelector('#control-bar');
    /** @type {?HTMLElement} */
    this.playButton = document.querySelector('#cb-play');
    /** @type {?HTMLElement} */
    this.scrub = document.querySelector('#cb-scrub');
    /** @type {?HTMLElement} */
    this.scrubFill = document.querySelector('#cb-scrub-fill');
    /** @type {?HTMLElement} */
    this.markers = document.querySelector('#cb-markers');
    /** @type {?HTMLElement} */
    this.chapterLabel = document.querySelector('#cb-chapter');
    /** @type {?HTMLElement} */
    this.vrToggle = document.querySelector('#cb-vr');

    /** @type {Map<string, Function>} Registered callbacks. */
    this.handlers = new Map();

    /** @type {number} Seconds since the pointer last moved. */
    this._idleTimer = 0;

    this.#bind();
  }

  /**
   * Registers a callback.
   * @param {'vr'|'desktop'|'play'|'seek'|'toggleVR'} action Action name.
   * @param {Function} handler Callback.
   * @returns {StartMenu} This menu, for chaining.
   */
  on(action, handler) {
    this.handlers.set(action, handler);
    return this;
  }

  /**
   * @param {string} action Action name.
   * @param {*} [payload] Payload.
   * @private
   */
  #emit(action, payload) {
    this.handlers.get(action)?.(payload);
  }

  /** Wires DOM listeners. @private */
  #bind() {
    this.vrButton?.addEventListener('click', () => this.#emit('vr'));
    this.desktopButton?.addEventListener('click', () => this.#emit('desktop'));
    this.playButton?.addEventListener('click', () => this.#emit('play'));
    this.vrToggle?.addEventListener('click', () => this.#emit('toggleVR'));

    // Scrubbing: pointer and keyboard, because a presenter may be driving this
    // from a laptop with no mouse to hand.
    const seekFromEvent = (event) => {
      if (!this.scrub) return;
      const rect = this.scrub.getBoundingClientRect();
      const t = (event.clientX - rect.left) / rect.width;
      this.#emit('seek', Math.max(0, Math.min(1, t)));
    };

    this.scrub?.addEventListener('pointerdown', (event) => {
      seekFromEvent(event);
      this.scrub.setPointerCapture(event.pointerId);
      this._scrubbing = true;
    });
    this.scrub?.addEventListener('pointermove', (event) => {
      if (this._scrubbing) seekFromEvent(event);
    });
    this.scrub?.addEventListener('pointerup', (event) => {
      this._scrubbing = false;
      this.scrub.releasePointerCapture(event.pointerId);
    });
    this.scrub?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') this.#emit('seek', -2);
      if (event.key === 'ArrowLeft') this.#emit('seek', -1);
    });

    // The bar dims when the pointer is still, so it never competes with the
    // scene during a live demonstration.
    window.addEventListener('pointermove', () => {
      this._idleTimer = 0;
      this.bar?.setAttribute('data-idle', 'false');
    });
  }

  /**
   * Tailors the menu copy to the device's real capabilities.
   * @param {{xr: boolean, sensors: boolean, touch: boolean, needsPermission: boolean}} caps Capabilities.
   * @param {string} vrPathLabel Human-readable description of the VR path.
   */
  configure(caps, vrPathLabel) {
    if (this.vrSub) this.vrSub.textContent = vrPathLabel;
    if (this.vrTitle) this.vrTitle.textContent = caps.xr ? 'Enter VR' : 'Enter VR';

    if (this.desktopSub) {
      this.desktopSub.textContent = caps.touch
        ? 'Touch & motion — single view'
        : 'Mouse & keyboard — flat screen';
    }

    if (this.note) {
      if (caps.xr) {
        this.note.textContent = 'A WebXR headset was detected. Put it on, then select Enter VR.';
      } else if (caps.sensors && caps.touch) {
        this.note.textContent =
          'Place your phone in a Cardboard viewer and hold it in landscape. ' +
          (caps.needsPermission ? 'Your browser will ask permission to use motion sensors.' : '');
      } else if (caps.touch) {
        this.note.textContent = 'Split-screen stereo is available. Hold your device in landscape.';
      } else {
        this.note.textContent =
          'Drag to look around. Press I to inspect the engine, Space to pause, R to recentre.';
      }
    }
  }

  /** Reveals the menu. */
  show() {
    this.root?.setAttribute('data-visible', 'true');
    this.root?.removeAttribute('aria-hidden');
  }

  /** Hides the menu. */
  hide() {
    this.root?.setAttribute('data-visible', 'false');
    this.root?.setAttribute('aria-hidden', 'true');
  }

  /**
   * Shows or hides the in-experience control bar.
   * @param {boolean} visible Whether the bar should be shown.
   */
  setBarVisible(visible) {
    this.bar?.setAttribute('data-visible', visible ? 'true' : 'false');
  }

  /**
   * Renders chapter tick marks on the scrubber.
   * @param {Array<{start: number}>} chapters Chapter list.
   * @param {number} duration Total duration in seconds.
   */
  setChapters(chapters, duration) {
    if (!this.markers) return;
    this.markers.textContent = '';
    for (const chapter of chapters) {
      const tick = document.createElement('div');
      tick.className = 'cb-marker';
      tick.style.left = `${(chapter.start / duration) * 100}%`;
      this.markers.appendChild(tick);
    }
  }

  /**
   * Reflects the timeline's state in the control bar.
   * @param {object} state Transport state.
   * @param {number} state.progress Normalised play-head position.
   * @param {boolean} state.playing Whether playback is running.
   * @param {string} state.label Chapter label.
   */
  setTransport({ progress, playing, label }) {
    if (this.scrubFill) this.scrubFill.style.width = `${(progress * 100).toFixed(2)}%`;
    if (this.chapterLabel && this.chapterLabel.textContent !== label) {
      this.chapterLabel.textContent = label;
    }
    this.bar?.setAttribute('data-playing', playing ? 'true' : 'false');
    this.scrub?.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  }

  /**
   * Shows or hides the "rotate your device" prompt.
   * @param {boolean} visible Whether the prompt should be shown.
   */
  setRotatePrompt(visible) {
    this.rotatePrompt?.setAttribute('data-visible', visible ? 'true' : 'false');
  }

  /**
   * Advances the idle-dimming timer for the control bar.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    this._idleTimer += dt;
    if (this._idleTimer > 3.5) this.bar?.setAttribute('data-idle', 'true');
  }
}
