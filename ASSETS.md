# Assets

Every asset in AeroMind XR is **generated at run time**. Nothing is downloaded,
nothing is sampled from a third party, and there is no art, audio or font file
to license, ship or lose.

That is a deliberate engineering choice rather than a shortcut. A competition
venue's network cannot be relied on, a USB stick is a realistic delivery
mechanism, and a demo that fails because one texture 404'd in front of a jury is
a demo that failed. The entire payload is under 3 MB, and almost all of that is
the Three.js runtime itself.

---

## What ships

| Path | Size | Notes |
|------|------|-------|
| `vendor/three/` | ~2.2 MB | Three.js runtime and the addons actually imported |
| `src/` | ~460 KB | Application source |
| `styles/`, `index.html` | ~24 KB | Pre-flight interface |

Regenerate the vendored runtime with `npm run vendor` after changing the
Three.js version. `tools/vendor.mjs` holds the explicit file list; copying only
what is imported keeps the payload at 2.2 MB rather than 40 MB.

---

## What is generated, and where

### Textures — `src/engine/TextureFactory.js`

| Asset | Function | Used by |
|-------|----------|---------|
| Brushed metal albedo + roughness | `createBrushedMetal` | Nacelle, fan blades, structural steel |
| Worn concrete floor + roughness | `createHangarFloor` | Hangar slab, with painted safety markings |
| Soft radial sprite | `createSoftSprite` | Dust motes, sparks, light points |
| Anamorphic streak | `createStreakSprite` | Lens glints |
| Thermal gradient ramp | `createThermalRamp` | Heat-map and stress-map overlays |
| Headline typography | `createHeadline` | Title cards |

Panel content, HUD elements, the bay signage, the spinner's anti-icing spiral
and the fatigue-crack glyph are painted per-object with the same Canvas 2D
helpers.

### Geometry

| Asset | File | Method |
|-------|------|--------|
| Turbofan nacelle | `objects/AircraftEngine.js` | Single closed lathe profile — inlet lip, bypass duct, fan cowl, outer skin |
| Fan blades | `objects/AircraftEngine.js` | `createFanBladeGeometry` — stacked NACA-style aerofoil sections, lofted with twist, taper and sweep |
| Outlet guide vanes | `objects/AircraftEngine.js` | Same generator, thinner and cambered the other way |
| Hangar shell, trusses, platform, equipment | `objects/Hangar.js` | Parametric primitives, merged and instanced |
| Engineers | `objects/Engineer.js` | Capsule-and-box skeleton with hierarchical joints |

### Lighting

The image-based lighting probe is baked at startup by
`AssetManager.#buildEnvironment`: Three.js's `RoomEnvironment` — a synthetic set
of emissive boxes — is pre-filtered through `PMREMGenerator` into a physically
plausible probe with soft area highlights. It is what gives the brushed metal
its believable sheen without shipping a megabyte of HDR data.

### Audio — `src/engine/AudioEngine.js`

Every sound is synthesised with the Web Audio API. There are no samples, so
there is no licensing question and nothing to preload.

| Cue | Construction |
|-----|--------------|
| Hangar ambience | Brown noise through a slowly modulated low-pass, plus three detuned low oscillators that beat against each other |
| Turbine hum | Resonant band-pass noise with a sawtooth harmonic |
| Inspection sweep | Band-pass noise swept 400 Hz → 5.2 kHz over four seconds |
| Interface tick | Short sine with a high noise transient |
| Panel materialise | Rising filtered noise plus a sine glide |
| Confirmation | Rising major third |
| Anomaly alert | Tense minor interval — deliberately not alarming |
| Resolution | Ascending arpeggio |

A convolution reverb gives the bay its size; the impulse response is generated
from decaying noise with early reflections.

---

## Optional drop-in assets

The experience is complete without them, but studio assets can be dropped into
`src/assets/` and will be picked up automatically. If a file is absent the
procedural equivalent is used and nothing else changes — the loaders fail
silently by design.

| Slot | Path | Effect |
|------|------|--------|
| HDR environment | `src/assets/hdri/hangar.hdr` | Replaces the baked probe. Equirectangular `.hdr`, 2k is plenty. |
| Turbofan model | `src/assets/models/turbofan.glb` | Loaded into `assets.get('model.turbofan')`. Draco compression supported. |

Paths are declared in `OptionalAssets` at the top of
`src/engine/AssetManager.js`.

### Adding a model

1. Export as `.glb`, Y-up, metres, origin at the fan centre, engine axis along
   −Z.
2. Draco-compress if you like — the decoder is already vendored at
   `vendor/three/addons/libs/draco/gltf/`.
3. Drop it at `src/assets/models/turbofan.glb` and reload.

Note that the analytical overlays — the digital twin wireframe, the thermal and
stress maps, the per-blade highlight — are driven by the procedural engine's
per-instance blade attributes. A replacement model renders correctly but will
need equivalent attributes wired up to participate in the analysis sequence.

### Adding audio

`src/assets/audio/` is reserved. To use recorded sound instead of synthesis,
load buffers in `AudioEngine.unlock()` and route them to `fxBus` or
`ambienceBus`; the cue names in `AudioEngine.play()` are the integration points.
Only use material you have the rights to distribute.

### Fonts

Typography uses the platform UI stack (`-apple-system`, `Inter`, `Segoe UI`,
`Roboto`, …) so it resolves offline everywhere without a webfont. A `.woff2`
placed in `src/assets/fonts/` and declared with `@font-face` in
`styles/main.css` would be picked up by both the DOM and the canvas-rendered
panels, since both reference the same font stack constants in
`src/engine/TextureFactory.js`.
