/**
 * @file Utils.js
 * @description Small, dependency-free numeric and timing helpers shared across
 * the whole application. Keeping them in one place guarantees that easing and
 * frame-rate-independent smoothing behave identically in every subsystem.
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;

/**
 * Constrains a value to an inclusive range.
 * @param {number} v Value to clamp.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number}
 */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Clamps to the 0..1 range. @param {number} v @returns {number} */
export function saturate(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Linear interpolation.
 * @param {number} a Start value.
 * @param {number} b End value.
 * @param {number} t Normalised blend factor.
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Hermite interpolation between two edges — the GLSL `smoothstep`.
 * @param {number} edge0 Lower edge.
 * @param {number} edge1 Upper edge.
 * @param {number} x Sample position.
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  const t = saturate((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing. `lambda` is the rate of
 * approach expressed in units per second; higher values converge faster.
 * @param {number} current Current value.
 * @param {number} target Target value.
 * @param {number} lambda Convergence rate.
 * @param {number} dt Delta time in seconds.
 * @returns {number}
 */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Shortest signed angular difference between two angles, in radians. This is
 * the primitive that keeps the compass heading from jumping at the 0°/360°
 * boundary.
 * @param {number} a Source angle.
 * @param {number} b Destination angle.
 * @returns {number} Difference in the range (-PI, PI].
 */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Frame-rate independent smoothing across the angular wrap-around point.
 * @param {number} current Current angle in radians.
 * @param {number} target Target angle in radians.
 * @param {number} lambda Convergence rate.
 * @param {number} dt Delta time in seconds.
 * @returns {number}
 */
export function dampAngle(current, target, lambda, dt) {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/* ------------------------------------------------------------------ easing */

/** @type {Object<string, function(number): number>} Named easing curves. */
export const Ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5
      ? Math.pow(2, 20 * t - 10) / 2
      : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1
      : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  /** Symmetric 0→1→0 pulse, useful for one-shot flashes. */
  pulse: (t) => Math.sin(saturate(t) * Math.PI),
};

/* --------------------------------------------------------------- sequencing */

/**
 * Normalised progress of `t` inside the window [start, end], optionally eased.
 * Returns 0 before the window and 1 after it, which makes it safe to call every
 * frame regardless of where the play-head is.
 * @param {number} t Current time.
 * @param {number} start Window start.
 * @param {number} end Window end.
 * @param {function(number): number} [ease] Easing curve.
 * @returns {number}
 */
export function progress(t, start, end, ease = Ease.linear) {
  return ease(saturate((t - start) / (end - start || 1e-6)));
}

/**
 * A 0→1→0 envelope: rises over `fadeIn`, holds, then falls over `fadeOut`.
 * @param {number} t Current time.
 * @param {number} start Window start.
 * @param {number} end Window end.
 * @param {number} [fadeIn] Rise duration in seconds.
 * @param {number} [fadeOut] Fall duration in seconds.
 * @returns {number}
 */
export function envelope(t, start, end, fadeIn = 0.6, fadeOut = 0.6) {
  if (t <= start || t >= end) return 0;
  const rise = smoothstep(start, start + fadeIn, t);
  const fall = 1 - smoothstep(end - fadeOut, end, t);
  return Math.min(rise, fall);
}

/* ----------------------------------------------------------------- rng/noise */

/**
 * Deterministic pseudo-random generator (mulberry32). Determinism matters here:
 * the hangar, the dust field and the idle animation phases must look identical
 * on every run so the demo is reproducible in front of a jury.
 * @param {number} seed Integer seed.
 * @returns {function(): number} Generator returning values in [0, 1).
 */
export function createRandom(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cheap 1-D value noise built from smoothed hashed integers. Used for organic
 * idle motion (breathing, weight shifting, light flicker).
 * @param {number} x Sample position.
 * @returns {number} Value in the -1..1 range.
 */
export function noise1D(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u) * 2 - 1;
}

/**
 * Integer hash producing a stable value in [0, 1).
 * @param {number} n Integer input.
 * @returns {number}
 */
export function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/* ------------------------------------------------------------ formatting */

/**
 * Formats a number with a fixed decimal count and thousands separators.
 * @param {number} v Value.
 * @param {number} [decimals] Decimal places.
 * @returns {string}
 */
export function formatNumber(v, decimals = 0) {
  const fixed = Number.isFinite(v) ? v.toFixed(decimals) : '—';
  const [int, dec] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return dec ? `${grouped}.${dec}` : grouped;
}

/**
 * Pads an integer with leading zeroes.
 * @param {number} v Value.
 * @param {number} [size] Target length.
 * @returns {string}
 */
export function pad(v, size = 2) {
  return String(Math.floor(v)).padStart(size, '0');
}

/* --------------------------------------------------------- device queries */

/**
 * Detects touch-first devices. Used to pick default control schemes rather
 * than to gate features — every capability degrades gracefully.
 * @returns {boolean}
 */
export function isTouchDevice() {
  return (
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0)
  );
}

/**
 * Detects iOS/iPadOS, which requires an explicit user gesture before device
 * orientation events are delivered.
 * @returns {boolean}
 */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes('Macintosh') && (navigator.maxTouchPoints ?? 0) > 1);
}
