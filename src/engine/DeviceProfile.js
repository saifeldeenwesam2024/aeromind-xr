/**
 * @file DeviceProfile.js
 * @description Device classification and the quality budget that follows from it.
 *
 * A phone in a Cardboard viewer is the hardest target this project has: it
 * renders the scene twice, at high resolution, on a tile-based mobile GPU, while
 * the handset is sealed inside a plastic box and thermally throttling within a
 * couple of minutes.
 *
 * The binding constraint on that hardware is **fill rate**, not geometry. A
 * mobile GPU will happily push the ~200 000 triangles this scene uses, but it
 * will fall over on large additive transparent surfaces — the ground haze, the
 * volumetric light shafts and the dust field — because every one of those layers
 * re-shades pixels that are already shaded. So the mobile budget cuts overdraw
 * first and geometry last, which is the opposite of the usual instinct.
 *
 * Everything here is a *budget*, not a switch: the experience is visually
 * complete at every tier, and {@link Renderer}'s adaptive resolution still sits
 * underneath as a safety net if a particular handset is slower than its class
 * suggests.
 */

/**
 * @typedef {object} QualityBudget
 * @property {'desktop'|'mobile'|'mobile-low'} tier Device class.
 * @property {boolean} isMobile Whether this is a handheld device.
 * @property {number} maxPixelRatio Ceiling on device pixel ratio, flat mode.
 * @property {number} maxEyePixels Ceiling on pixels per eye in stereo mode.
 * @property {number} msaaSamples Multisample count for the scene buffer.
 * @property {boolean} shadows Whether the key light casts shadows.
 * @property {number} shadowMapSize Shadow map resolution.
 * @property {number} dustCount Number of dust motes.
 * @property {number} dustMaxSize Ceiling on dust point size, in pixels.
 * @property {number} crewCount Number of animated engineers.
 * @property {number} hazeLayers Ground haze planes — the biggest overdraw cost.
 * @property {number} shaftCount Volumetric light shafts.
 * @property {number} panelHz Panel canvas repaint rate.
 * @property {number} panelResolution Panel texture pixels per metre.
 * @property {number} bloomScale Bloom buffer scale multiplier.
 * @property {number} minRenderScale Floor for adaptive resolution.
 * @property {string} bloomPreset Named preset from `BloomPresets`.
 */

/**
 * Budgets by device class.
 * @type {Object<string, QualityBudget>}
 */
const BUDGETS = {
  desktop: {
    tier: 'desktop',
    isMobile: false,
    maxPixelRatio: 2,
    maxEyePixels: 2_600_000,
    msaaSamples: 4,
    shadows: true,
    shadowMapSize: 1024,
    dustCount: 4200,
    dustMaxSize: 64,
    crewCount: 3,
    hazeLayers: 7,
    shaftCount: 6,
    panelHz: 12,
    panelResolution: 620,
    bloomScale: 1,
    minRenderScale: 0.55,
    bloomPreset: 'high',
  },

  mobile: {
    tier: 'mobile',
    isMobile: true,
    // A modern Android handset reports a pixel ratio of 2.6–3.5. Honouring it
    // in stereo would mean shading well over four million pixels twice per
    // frame; the lens blurs far more detail than that anyway.
    maxPixelRatio: 1.5,
    maxEyePixels: 1_150_000,
    // Mobile GPUs resolve multisampled buffers through main memory, which is
    // exactly the bandwidth the two eye buffers already saturate.
    msaaSamples: 0,
    shadows: true,
    shadowMapSize: 512,
    dustCount: 1400,
    dustMaxSize: 26,
    crewCount: 3,
    hazeLayers: 3,
    shaftCount: 3,
    panelHz: 8,
    panelResolution: 460,
    bloomScale: 0.75,
    minRenderScale: 0.5,
    bloomPreset: 'medium',
  },

  'mobile-low': {
    tier: 'mobile-low',
    isMobile: true,
    maxPixelRatio: 1.25,
    maxEyePixels: 750_000,
    msaaSamples: 0,
    shadows: false,
    shadowMapSize: 512,
    dustCount: 700,
    dustMaxSize: 18,
    crewCount: 2,
    hazeLayers: 2,
    shaftCount: 2,
    panelHz: 6,
    panelResolution: 380,
    bloomScale: 0.6,
    minRenderScale: 0.45,
    bloomPreset: 'low',
  },
};

/**
 * Classifies the current device and returns its quality budget.
 *
 * Detection is deliberately coarse. There is no reliable way to identify a GPU
 * from a browser, and user-agent sniffing for specific handsets ages badly, so
 * this splits on the two signals that actually correlate with rendering
 * capability — whether the device is handheld, and how much memory and how many
 * cores it admits to — then lets adaptive resolution handle the rest at run
 * time.
 *
 * @returns {QualityBudget} The budget for this device.
 */
export function detectProfile() {
  if (typeof navigator === 'undefined') return BUDGETS.desktop;

  // An explicit override always wins. This exists so a tier can be previewed
  // from a desktop during development, and — more usefully — so a specific
  // handset that struggles can be pinned to a lower tier at the venue without
  // rebuilding anything: append `?tier=mobile-low` to the URL.
  const forced = new URLSearchParams(location.search).get('tier');
  if (forced && BUDGETS[forced]) return BUDGETS[forced];

  const ua = navigator.userAgent || '';
  const touch = (navigator.maxTouchPoints ?? 0) > 1;
  const handheld = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) ||
    (touch && /Macintosh/.test(ua)); // iPadOS reports itself as a Mac

  if (!handheld) return BUDGETS.desktop;

  // `deviceMemory` is Chromium-only and reports in gibibytes, capped at 8.
  // `hardwareConcurrency` is near-universal. Either one being low is a good
  // signal for a budget handset.
  const memory = navigator.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;

  return (memory <= 3 || cores <= 4) ? BUDGETS['mobile-low'] : BUDGETS.mobile;
}

/**
 * Looks up a budget by name, for the diagnostics overlay and manual overrides.
 * @param {string} tier Tier name.
 * @returns {QualityBudget}
 */
export function getBudget(tier) {
  return BUDGETS[tier] ?? BUDGETS.desktop;
}

/**
 * The pixel ratio to use for a given presentation mode, respecting both the
 * ratio ceiling and the absolute per-eye pixel ceiling.
 *
 * The pixel ceiling is what actually protects a phone: two handsets can report
 * the same device pixel ratio while having wildly different screen areas, and
 * it is the total shaded pixel count — not the ratio — that costs frame time.
 *
 * @param {QualityBudget} budget Active budget.
 * @param {number} width Viewport width in CSS pixels.
 * @param {number} height Viewport height in CSS pixels.
 * @param {boolean} stereo Whether both eyes are being rendered.
 * @returns {number} Device pixel ratio to apply.
 */
export function resolvePixelRatio(budget, width, height, stereo) {
  const native = Math.min(window.devicePixelRatio || 1, budget.maxPixelRatio);

  // Stereo shades each eye at half the canvas width, so the per-eye pixel count
  // is half the canvas area.
  const areaPerEye = (dpr) => width * height * dpr * dpr / (stereo ? 2 : 1);
  if (areaPerEye(native) <= budget.maxEyePixels) return native;

  const scaled = Math.sqrt(
    budget.maxEyePixels * (stereo ? 2 : 1) / (width * height),
  );
  return Math.max(0.75, Math.min(native, scaled));
}
