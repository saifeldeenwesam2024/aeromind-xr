/**
 * @file InputManager.js
 * @description Unified head-tracking and interaction layer.
 *
 * Three control schemes feed a single output — a smoothed head orientation
 * quaternion plus an interaction ray:
 *
 *   • **Device orientation** — phones in a Cardboard viewer, and hand-held
 *     "magic window" mode. Fused sensor data is converted to a quaternion,
 *     compensated for screen rotation, and slerped toward, which is what keeps
 *     the horizon stable and eliminates the classic 0°/360° compass snap that
 *     Euler-based implementations suffer from.
 *   • **Pointer / touch drag** — desktop preview and phones without sensors.
 *   • **WebXR** — when an immersive session is running the runtime supplies the
 *     pose directly and this manager steps aside for orientation, while still
 *     serving gaze interaction.
 *
 * Recentring is applied as a yaw-only offset quaternion, so it never introduces
 * roll or pitch error no matter which way the viewer is facing.
 */

import { Euler, Quaternion, Vector2, Vector3 } from 'three';
import { clamp, damp, isIOS, isTouchDevice, TAU } from './Utils.js';

/** Reusable scratch objects — the update path allocates nothing. */
const _euler = new Euler();
const _q0 = new Quaternion();
const _q1 = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // −90° about X
const _qDevice = new Quaternion();
const _qScreen = new Quaternion();
const _qYaw = new Quaternion();
const _qPointer = new Quaternion();
const _qTemp = new Quaternion();
const _forward = new Vector3();
const _ZEE = new Vector3(0, 0, 1);
const _UP = new Vector3(0, 1, 0);

/**
 * Head-tracking and interaction manager.
 * @class
 */
export class InputManager {
  /**
   * @param {HTMLElement} domElement Element that receives pointer events.
   * @param {object} [options] Configuration.
   * @param {number} [options.smoothing] Orientation convergence rate; higher
   *   tracks more tightly, lower is smoother. 12–20 is a comfortable window.
   * @param {number} [options.pointerSensitivity] Radians per pixel dragged.
   * @param {number} [options.dwellTime] Seconds of gaze needed to activate.
   */
  constructor(domElement, options = {}) {
    const {
      smoothing = 16,
      pointerSensitivity = 0.0035,
      dwellTime = 1.15,
    } = options;

    /** @type {HTMLElement} */
    this.dom = domElement;
    /** @type {number} */
    this.smoothing = smoothing;
    /** @type {number} */
    this.pointerSensitivity = pointerSensitivity;
    /** @type {number} */
    this.dwellTime = dwellTime;

    /** @type {'pointer'|'device'|'xr'} Active orientation source. */
    this.mode = 'pointer';
    /** @type {boolean} Whether sensor events are currently arriving. */
    this.hasDeviceData = false;
    /** @type {boolean} Whether sensor permission has been granted. */
    this.devicePermission = false;

    /** @type {Quaternion} Latest sensor orientation, before recentring. */
    this._rawDevice = new Quaternion();
    /** @type {Quaternion} Raw target orientation for the current frame. */
    this.targetQuaternion = new Quaternion();
    /** @type {Quaternion} Smoothed orientation consumed by the camera rig. */
    this.quaternion = new Quaternion();

    /** @type {number} Recentring yaw offset in radians. */
    this.yawOffset = 0;
    /**
     * Roll suppression, 0–1. Zero preserves head roll exactly, which is correct
     * inside a viewer where the phone *is* the head. Values above zero damp the
     * roll axis, which is more comfortable for hand-held magic-window viewing.
     * @type {number}
     */
    this.horizonStability = 0;

    /** @type {{yaw: number, pitch: number}} Pointer-driven look angles. */
    this.look = { yaw: 0, pitch: 0 };
    /** @type {{yaw: number, pitch: number}} Smoothed pointer look angles. */
    this.lookSmoothed = { yaw: 0, pitch: 0 };

    /** @type {boolean} */
    this.dragging = false;
    /** @type {Vector2} Last pointer position in CSS pixels. */
    this.pointerLast = new Vector2();
    /** @type {Vector2} Normalised device coordinates of the pointer. */
    this.pointerNDC = new Vector2();
    /** @type {boolean} Whether the pointer has moved since the last frame. */
    this.pointerActive = false;

    /** @type {number} Screen rotation in radians. */
    this.screenAngle = 0;

    /** @type {Map<string, Set<Function>>} Event listeners. */
    this._listeners = new Map();

    /** @type {number} Accumulated gaze dwell time on the current target. */
    this.dwell = 0;
    /** @type {*} Object currently under the gaze reticle. */
    this.gazeTarget = null;

    /** @type {boolean} */
    this.enabled = true;

    this.#bindHandlers();
    this.#attachPointer();
    this.#attachKeyboard();
    this.#updateScreenAngle();
  }

  /* ------------------------------------------------------------- events */

  /**
   * Subscribes to a named event.
   * @param {string} type Event name.
   * @param {Function} handler Callback.
   * @returns {function(): void} Unsubscribe function.
   */
  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  /**
   * Removes a subscription.
   * @param {string} type Event name.
   * @param {Function} handler Callback.
   */
  off(type, handler) {
    this._listeners.get(type)?.delete(handler);
  }

  /**
   * Dispatches an event to subscribers.
   * @param {string} type Event name.
   * @param {*} [payload] Event payload.
   */
  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const handler of set) handler(payload);
  }

  /* ------------------------------------------------------------- binding */

  /** Creates bound handler references so they can be removed cleanly. @private */
  #bindHandlers() {
    this._onPointerDown = this.#onPointerDown.bind(this);
    this._onPointerMove = this.#onPointerMove.bind(this);
    this._onPointerUp = this.#onPointerUp.bind(this);
    this._onKeyDown = this.#onKeyDown.bind(this);
    this._onDeviceOrientation = this.#onDeviceOrientation.bind(this);
    this._onScreenChange = this.#updateScreenAngle.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
  }

  /** @private */
  #attachPointer() {
    const dom = this.dom;
    dom.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    window.addEventListener('pointermove', this._onPointerMove, { passive: false });
    window.addEventListener('pointerup', this._onPointerUp, { passive: true });
    window.addEventListener('pointercancel', this._onPointerUp, { passive: true });
    dom.addEventListener('contextmenu', this._onContextMenu);
  }

  /** @private */
  #attachKeyboard() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('orientationchange', this._onScreenChange);
    screen.orientation?.addEventListener?.('change', this._onScreenChange);
  }

  /* ------------------------------------------------------- device sensors */

  /**
   * Requests device-orientation access and switches to sensor tracking.
   *
   * iOS 13+ requires this to be called from a user gesture and shows a system
   * prompt. Other platforms grant access implicitly. If no sensor data arrives
   * within a short window the manager silently stays on pointer control, so a
   * desktop browser or a sensorless phone still gets a usable experience.
   *
   * @returns {Promise<boolean>} Whether sensor tracking became active.
   */
  async enableDeviceOrientation() {
    if (typeof window.DeviceOrientationEvent === 'undefined') return false;

    try {
      const requestPermission = window.DeviceOrientationEvent.requestPermission;
      if (typeof requestPermission === 'function') {
        const response = await requestPermission();
        if (response !== 'granted') return false;
      }
      this.devicePermission = true;
    } catch {
      // Permission call rejected (typically: not triggered by a user gesture).
      return false;
    }

    window.addEventListener('deviceorientation', this._onDeviceOrientation, true);

    // Wait briefly for the first event before committing to sensor mode.
    const arrived = await new Promise((resolve) => {
      const started = performance.now();
      const poll = () => {
        if (this.hasDeviceData) return resolve(true);
        if (performance.now() - started > 900) return resolve(false);
        requestAnimationFrame(poll);
      };
      poll();
    });

    if (arrived) {
      this.mode = 'device';
      this.recenter();
    } else {
      window.removeEventListener('deviceorientation', this._onDeviceOrientation, true);
    }
    return arrived;
  }

  /** Stops sensor tracking and returns to pointer control. */
  disableDeviceOrientation() {
    window.removeEventListener('deviceorientation', this._onDeviceOrientation, true);
    this.hasDeviceData = false;
    if (this.mode === 'device') this.mode = 'pointer';
  }

  /**
   * Converts a device-orientation event into a world-space quaternion.
   * @param {DeviceOrientationEvent} event Sensor event.
   * @private
   */
  #onDeviceOrientation(event) {
    if (event.alpha === null && event.beta === null && event.gamma === null) return;

    if (!this.hasDeviceData) {
      this.hasDeviceData = true;
      this.emit('deviceorientation:start');
    }

    const alpha = (event.alpha ?? 0) * (Math.PI / 180); // Z — compass heading
    const beta = (event.beta ?? 0) * (Math.PI / 180);   // X — front/back tilt
    const gamma = (event.gamma ?? 0) * (Math.PI / 180); // Y — left/right tilt

    // The canonical sensor-to-world transform: YXZ Euler ordering, rotated so
    // that "screen up" maps to world up, then counter-rotated by the current
    // screen orientation.
    _euler.set(beta, alpha, -gamma, 'YXZ');
    _qDevice.setFromEuler(_euler);
    _qDevice.multiply(_q1);
    _qDevice.multiply(_qScreen.setFromAxisAngle(_ZEE, -this.screenAngle));

    // Copy rather than clone: the update path must never allocate.
    this._rawDevice.copy(_qDevice);
  }

  /** Reads the current screen rotation. @private */
  #updateScreenAngle() {
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    this.screenAngle = (Number(angle) || 0) * (Math.PI / 180);
    this.emit('screenchange', { angle: this.screenAngle });
  }

  /* -------------------------------------------------------------- pointer */

  /**
   * @param {PointerEvent} event Pointer event.
   * @private
   */
  #onPointerDown(event) {
    if (!this.enabled) return;
    this.dragging = true;
    this.pointerLast.set(event.clientX, event.clientY);
    this.dom.setPointerCapture?.(event.pointerId);
    this.#updateNDC(event);
    this.emit('pointerdown', { event, ndc: this.pointerNDC });
  }

  /**
   * @param {PointerEvent} event Pointer event.
   * @private
   */
  #onPointerMove(event) {
    if (!this.enabled) return;
    this.#updateNDC(event);
    this.pointerActive = true;
    if (!this.dragging) return;

    const dx = event.clientX - this.pointerLast.x;
    const dy = event.clientY - this.pointerLast.y;
    this.pointerLast.set(event.clientX, event.clientY);

    // In sensor mode a drag nudges the recentring offset rather than fighting
    // the gyroscope, which would feel like the world was slipping.
    if (this.mode === 'device') {
      this.yawOffset -= dx * this.pointerSensitivity * 0.6;
      return;
    }

    this.look.yaw -= dx * this.pointerSensitivity;
    this.look.pitch = clamp(
      this.look.pitch - dy * this.pointerSensitivity,
      -Math.PI * 0.48,
      Math.PI * 0.48,
    );
  }

  /**
   * @param {PointerEvent} event Pointer event.
   * @private
   */
  #onPointerUp(event) {
    if (!this.dragging) return;
    this.dragging = false;
    this.dom.releasePointerCapture?.(event.pointerId);
    this.emit('pointerup', { event, ndc: this.pointerNDC });
  }

  /**
   * @param {PointerEvent} event Pointer event.
   * @private
   */
  #updateNDC(event) {
    const rect = this.dom.getBoundingClientRect();
    this.pointerNDC.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /**
   * @param {KeyboardEvent} event Keyboard event.
   * @private
   */
  #onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    this.emit('key', { code: event.code, key: event.key, event });
  }

  /* ------------------------------------------------------------ recentring */

  /**
   * Re-aligns the viewer's forward direction with the scene's forward
   * direction. Only yaw is adjusted; pitch and roll come from gravity and must
   * never be overridden, or the horizon would tilt.
   */
  recenter() {
    if (this.mode === 'device' && this.hasDeviceData) {
      // Extract the raw sensor yaw by projecting its forward vector onto the
      // ground plane. Working with the vector rather than an Euler angle is
      // what makes this stable at every pole and across the 0°/360° seam.
      _forward.set(0, 0, -1).applyQuaternion(this._rawDevice);
      _forward.y = 0;
      if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
      _forward.normalize();
      this.yawOffset = -Math.atan2(_forward.x, -_forward.z);
    } else {
      this.look.yaw = 0;
      this.look.pitch = 0;
      this.lookSmoothed.yaw = 0;
      this.lookSmoothed.pitch = 0;
    }
    this.emit('recenter');
  }

  /**
   * Adds a yaw bias, used when the story wants to gently guide attention.
   * @param {number} radians Offset to add.
   */
  addYawOffset(radians) {
    this.yawOffset = (this.yawOffset + radians) % TAU;
  }

  /* --------------------------------------------------------------- update */

  /**
   * Advances orientation smoothing. Must be called exactly once per frame,
   * before either eye is rendered, so both eyes agree on head pose.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    if (this.mode === 'xr') return;

    if (this.mode === 'device' && this.hasDeviceData) {
      _qTemp.copy(this._rawDevice);

      // Recentring: a pure yaw rotation applied in world space.
      _qYaw.setFromAxisAngle(_UP, this.yawOffset);
      this.targetQuaternion.copy(_qYaw).multiply(_qTemp);

      if (this.horizonStability > 0) this.#suppressRoll(this.targetQuaternion);
    } else {
      // Pointer look, smoothed independently so the response curve is the same
      // whether the input is a mouse or a thumb.
      this.lookSmoothed.yaw = damp(this.lookSmoothed.yaw, this.look.yaw, 14, dt);
      this.lookSmoothed.pitch = damp(this.lookSmoothed.pitch, this.look.pitch, 14, dt);
      _euler.set(this.lookSmoothed.pitch, this.lookSmoothed.yaw, 0, 'YXZ');
      this.targetQuaternion.setFromEuler(_euler);
    }

    // Frame-rate independent slerp. Quaternion interpolation always takes the
    // shortest arc, which is precisely why the heading cannot jump when the
    // compass wraps from 359° to 1°.
    const alpha = 1 - Math.exp(-this.smoothing * dt);
    this.quaternion.slerp(this.targetQuaternion, alpha);
    this.quaternion.normalize();
  }

  /**
   * Reduces roll about the view axis while preserving yaw and pitch.
   * @param {Quaternion} q Quaternion to modify in place.
   * @private
   */
  #suppressRoll(q) {
    _euler.setFromQuaternion(q, 'YXZ');
    _euler.z *= 1 - clamp(this.horizonStability, 0, 1);
    q.setFromEuler(_euler);
  }

  /* ----------------------------------------------------------------- gaze */

  /**
   * Advances gaze dwell selection. The reticle fills over {@link dwellTime}
   * seconds while it rests on an interactive object, then fires once.
   * @param {*} target Object currently under the reticle, or `null`.
   * @param {number} dt Delta time in seconds.
   * @returns {{target: *, progress: number, activated: boolean}} Gaze state.
   */
  updateGaze(target, dt) {
    let activated = false;

    if (target !== this.gazeTarget) {
      this.gazeTarget = target;
      this.dwell = 0;
      if (target) this.emit('gaze:enter', target);
    } else if (target) {
      const before = this.dwell;
      this.dwell = Math.min(this.dwellTime, this.dwell + dt);
      if (before < this.dwellTime && this.dwell >= this.dwellTime) {
        activated = true;
        this.emit('gaze:activate', target);
      }
    }

    return {
      target: this.gazeTarget,
      progress: this.dwellTime > 0 ? this.dwell / this.dwellTime : 0,
      activated,
    };
  }

  /** Resets dwell progress, e.g. after a menu action consumes the gaze. */
  resetGaze() {
    this.dwell = 0;
    this.gazeTarget = null;
  }

  /* ---------------------------------------------------------- capabilities */

  /**
   * Reports what this device can do, used to choose sensible defaults.
   * @returns {{touch: boolean, ios: boolean, orientationEvents: boolean, needsPermission: boolean}}
   */
  static capabilities() {
    const hasOrientation = typeof window !== 'undefined' &&
      typeof window.DeviceOrientationEvent !== 'undefined';
    return {
      touch: isTouchDevice(),
      ios: isIOS(),
      orientationEvents: hasOrientation,
      needsPermission: hasOrientation &&
        typeof window.DeviceOrientationEvent.requestPermission === 'function',
    };
  }

  /** Detaches every listener. */
  dispose() {
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    this.dom.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('orientationchange', this._onScreenChange);
    screen.orientation?.removeEventListener?.('change', this._onScreenChange);
    this.disableDeviceOrientation();
    this._listeners.clear();
  }
}
