/**
 * @file LoadingScreen.js
 * @description Controller for the pre-flight loading surface.
 *
 * This is one of only three DOM surfaces in the project, and all three exist
 * exclusively *before* the immersive experience begins. Once stereo rendering
 * starts they are hidden, because a DOM overlay drawn once across a
 * side-by-side image appears in the wrong place for both eyes.
 */

import { clamp } from '../engine/Utils.js';

/**
 * Drives the loading overlay.
 * @class
 */
export class LoadingScreen {
  /**
   * @param {object} [selectors] Element selectors.
   * @param {string} [selectors.root] Overlay root.
   * @param {string} [selectors.bar] Progress fill element.
   * @param {string} [selectors.status] Status line element.
   */
  constructor(selectors = {}) {
    const {
      root = '#loading-screen',
      bar = '#loading-bar',
      status = '#loading-status',
    } = selectors;

    /** @type {?HTMLElement} */
    this.root = document.querySelector(root);
    /** @type {?HTMLElement} */
    this.bar = document.querySelector(bar);
    /** @type {?HTMLElement} */
    this.status = document.querySelector(status);

    /** @type {number} Progress actually shown, which only ever increases. */
    this.shown = 0;
  }

  /**
   * Updates progress and the status line.
   *
   * Displayed progress is monotonic: a bar that jumps backwards reads as a
   * fault even when it is technically accurate.
   *
   * @param {number} value Normalised progress, 0–1.
   * @param {string} [message] Status line text.
   */
  setProgress(value, message) {
    this.shown = Math.max(this.shown, clamp(value, 0, 1));
    if (this.bar) this.bar.style.width = `${(this.shown * 100).toFixed(1)}%`;
    if (message && this.status) this.status.textContent = message;
  }

  /**
   * Fades the overlay out and removes it from the accessibility tree.
   * @param {number} [delay] Seconds to wait before fading.
   * @returns {Promise<void>} Resolves once the fade has finished.
   */
  hide(delay = 0.35) {
    return new Promise((resolve) => {
      window.setTimeout(() => {
        this.root?.setAttribute('data-visible', 'false');
        this.root?.setAttribute('aria-hidden', 'true');
        window.setTimeout(resolve, 900);
      }, delay * 1000);
    });
  }

  /** Shows the overlay again, e.g. if assets are reloaded. */
  show() {
    this.root?.setAttribute('data-visible', 'true');
    this.root?.removeAttribute('aria-hidden');
  }

  /**
   * Replaces the overlay with a fatal error message.
   * @param {string} message Human-readable explanation.
   */
  fail(message) {
    if (this.status) this.status.textContent = 'Startup failed';
    const fatal = document.querySelector('#fatal');
    const text = document.querySelector('#fatal-msg');
    if (text) text.textContent = message;
    fatal?.setAttribute('data-visible', 'true');
  }
}
