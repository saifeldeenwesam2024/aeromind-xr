# AeroMind XR

**An immersive mixed-reality demonstration of AI-driven predictive aircraft maintenance.**

AeroMind XR puts the viewer inside a maintenance hangar wearing mixed-reality
glasses. Over 120 seconds, and without a word of narration, it shows an AI
monitoring a turbofan engine, aligning a digital twin to it, finding a crack in
fan blade 07 before it fails, reasoning across eleven sources of evidence,
guiding an engineer through the repair, and closing with what that difference is
worth to an airline.

It runs in any modern browser, works completely offline, and renders in **real
stereoscopic 3D** for Google Cardboard and WebXR headsets.

---

## Quick start

```bash
python3 tools/serve.py
```

Then open **http://localhost:8137**.

Any static file server works — `python3 -m http.server` will do — but
`tools/serve.py` disables caching, which makes editing source files and
reloading behave predictably. No build step is required at any point.

On a phone, connect to the same network and open `http://<your-computer-ip>:8137`.
Motion sensors need a secure context on most mobile browsers, so for the full
Cardboard experience serve over HTTPS or from `localhost` — see
[Deployment](#deployment).

---

## What you are looking at

| # | Chapter | What happens |
|---|---------|--------------|
| 1 | **Title** | Black. The brand resolves out of nothing. |
| 2 | **The Hangar** | Practical lights strike; fog, dust and the engine emerge. |
| 3 | **Glasses Online** | The interface boots and the AI maps the bay with a survey grid. |
| 4 | **Digital Twin** | Alignment brackets converge; registration counts 24 → 53 → 81 → 96 → 100 → **LOCKED**. |
| 5 | **AI Inspection** | A beam sweeps the engine, every blade is checked in turn, blade 07 goes amber then red, and the crack draws itself. |
| 6 | **AI Reasoning** | Eleven analysis panels materialise around the viewer and the AI shows its work. |
| 7 | **Guided Repair** | The engineer works to a holographic checklist; the tasks close out and the engine returns to 100% health. |
| 8 | **Business Impact** | 18 hours of unplanned downtime becomes 6 hours, planned. |
| 9 | **Closing** | *Predict. Assist. Prevent.* |

The story loops automatically.

---

## Controls

### Flat preview (desktop)

| Input | Action |
|-------|--------|
| **Drag** | Look around |
| **Space** | Play / pause |
| **←** / **→** | Previous / next chapter |
| **R** | Recentre the view |
| **I** | Inspection mode — pauses the story and orbits the engine freely |
| **V** | Toggle stereoscopic mode |
| **F** | Fullscreen |
| **M** | Mute |
| **+** / **−** | Adjust interpupillary distance |

A control bar at the bottom of the screen scrubs the timeline and marks each
chapter — useful when a judge asks to see a particular moment again.

### In a viewer

There is no keyboard in a Cardboard headset, so the controls come to you: **look
down** and a menu rises into view. Rest the gaze reticle on a control until its
dwell ring completes to activate it — replay, recentre, IPD adjustment, or exit.

---

## How the stereo actually works

This is not two copies of the page side by side, and not a CSS trick. The world
is built **once**; nothing in the scene graph or the DOM is duplicated. Each
frame it is rendered twice, from two independent cameras, into two independent
buffers:

```
  scene ──► eyeLeft  ──► post-processing L ──► rtLeft  ─┐
        └─► eyeRight ──► post-processing R ──► rtRight ─┴─► compositor ──► canvas
```

Three decisions carry the quality of the result:

**Parallel cameras with asymmetric frusta.** Stereo depth is produced by
shifting each eye's projection horizontally, not by rotating the cameras inward.
Toe-in is the common shortcut and it is wrong: converging the optical axes
introduces vertical parallax toward the frame corners, which the visual system
cannot fuse and which is the usual reason home-made VR demos cause eye strain.
An asymmetric frustum leaves only horizontal disparity — exactly what human
stereopsis expects. See `src/engine/CameraRig.js`.

**A post-processing chain per eye.** Bloom is a screen-space effect. If both
eyes shared one buffer, light from the left eye would bleed into the right and
the image would refuse to fuse. Each eye owns its own chain writing to its own
render target. See `src/engine/Renderer.js` and `src/effects/Bloom.js`.

**One world state per frame.** Input, the camera rig, the story and every
animated system are advanced *before* either eye is drawn. If animation
advanced between the two eye renders, each eye would see a slightly different
moment and the result would shimmer. See the frame contract in `src/main.js`.

Head tracking is quaternion-based throughout, and recentring is applied as a
yaw-only offset. That is what keeps the horizon level and eliminates the
0°/360° compass snap that Euler-based implementations suffer from. See
`src/engine/InputManager.js`.

The compositor applies barrel distortion and chromatic aberration to
pre-compensate for a Cardboard lens, so straight lines in the world stay
straight through the optics.

### Presentation modes

The application negotiates the best available path and degrades in a defined
order, silently:

1. **WebXR `immersive-vr`** — a real headset. The runtime owns stereo and pose;
   the post-processing chain is deliberately bypassed so reprojection is not
   broken.
2. **Cardboard stereo** — side-by-side rendering driven by device orientation,
   with fullscreen, landscape lock and a screen wake lock.
3. **Magic window** — stereo unavailable but sensors work: one full-screen view
   steered by moving the phone.
4. **Flat preview** — mouse and keyboard.

---

## Architecture

```
index.html               Import map, DOM shell (loading, menu, control bar)
styles/main.css          Pre-flight interface only — the DOM is never used in-experience
tools/serve.py           No-cache static server for development
tools/vendor.mjs         Copies the Three.js modules used into vendor/
vendor/three/            Vendored runtime — the app never reaches the network

src/
  main.js                Entry point and the frame loop

  engine/
    Renderer.js          WebGL back-end, per-eye chains, stereo compositor
    CameraRig.js         Two eye cameras, IPD, convergence, asymmetric frusta
    XRManager.js         WebXR session, mode negotiation, fullscreen, wake lock
    InputManager.js      Device orientation, pointer, gaze dwell, recentring
    SceneManager.js      World composition and the nine-chapter story
    Timeline.js          Chapter clock with cues and exact scrubbing
    AssetManager.js      Procedural asset generation, optional external loaders
    AudioEngine.js       Fully synthesised sound design
    TextureFactory.js    Canvas-authored textures and typography
    Utils.js             Easing, frame-rate independent damping, deterministic RNG

  objects/
    Hangar.js            The bay: shell, trusses, fixtures, platform, equipment
    AircraftEngine.js    Parametric turbofan with per-blade analytical state
    DigitalTwin.js       Alignment brackets and registration read-out
    Engineer.js          Procedurally animated maintenance crew
    Hologram.js          Panel constellation, data tethers, title cards
    Panel.js             A single world-space holographic panel
    ParticleSystem.js    GPU-simulated dust and work sparks
    FloorGrid.js         Holographic survey grid
    LightRig.js          Cinematic lighting and volumetric shafts

  effects/
    Glow.js              Shader library and the shared holographic clock
    Bloom.js             Post-processing chain factory
    Fog.js               Distance fog and ground haze
    ScanBeam.js          The travelling inspection beam

  ui/
    HUD.js               Head-locked glasses interface (world-space geometry)
    VRMenu.js            Gaze-operated in-headset menu
    LoadingScreen.js     Pre-flight loading surface
    StartMenu.js         Entry menu and transport controls

  assets/                Optional drop-in slots — see ASSETS.md
```

### Design notes

**Everything is procedural.** Textures are painted with the Canvas 2D API, the
environment probe is baked at runtime from a synthetic lighting room, the engine
and the hangar are parametric geometry, and every sound is synthesised with the
Web Audio API. There is nothing to download, nothing to license, and nothing
that can fail on a saturated venue network. Total payload is under 3 MB, almost
all of it the Three.js runtime.

**The DOM stops at the door.** Only three surfaces are HTML — the loading
screen, the start menu, and the desktop control bar — and all three are hidden
before stereo rendering begins. Everything inside the experience, including the
glasses interface, is geometry in the scene. A DOM overlay drawn once across a
side-by-side image would appear in the wrong place for both eyes.

**The story is scrubbable.** Each chapter's `onEnter` declares the complete
world state it expects, and each `onUpdate` is a pure function of chapter-local
time. Nothing accumulates. Jumping straight to the scan sequence produces
exactly the same world as watching up to it.

**Panels orbit the viewer, not the engine.** An arc centred on the engine looks
even on a plan drawing, but the viewer stands outside it, so panels at wide
bearings collapse toward the centre of vision and pile up. Centring the arc on
the eyes means every panel is equidistant — comfortable to fuse in stereo — and
a panel's bearing is exactly how far the viewer must turn to look at it.

**Text is sized in degrees, not metres.** Panels sit 3.4–4.0 m out and are
1.5 m wide, so each subtends about 23° and its title lands near 1.6° of visual
angle. Below roughly 1.5°, text in a viewer is uncomfortable to read however
crisp the render is — which is why the panels are close and large rather than
distant and numerous. The forward ±22° stays clear so the engine is never
masked, and nothing world-space sits below the eye line at close range, because
the head-locked narration strip already lives there.

---

## Performance

The target is a steady 60 fps, and the budget is spent deliberately:

- **Instancing** — the 24 fan blades are one draw call carrying per-instance
  highlight and stress attributes, which is how blade 07 can glow red while its
  neighbours stay cold at no extra cost. Roof trusses, stator vanes, ceiling
  fixtures and safety cones are instanced too.
- **Merged static geometry** — walls, railings, the hangar door and the tool
  chest each collapse to a single buffer.
- **GPU particle simulation** — 4 200 dust motes and the spark pool are animated
  entirely in the vertex shader; the CPU never touches a particle.
- **Throttled canvas repaints** — panels ease their values every frame but
  repaint their textures at about 12 Hz, so thirteen live panels cost very
  little.
- **Adaptive resolution** — frame time is smoothed heavily and the render scale
  creeps between 0.55 and 1.0 rather than pumping, because a visibly oscillating
  resolution is worse than a consistently lower one.
- **Reduced pixel ratio in stereo** — each eye gets half the width, so the
  device pixel ratio is capped lower when rendering side by side.

Quality presets (`ultra` / `high` / `medium` / `low`) control bloom buffer scale
and MSAA sample count; the renderer selects one and adapts from there.

### Device budgets

`src/engine/DeviceProfile.js` classifies the device once at startup and hands
every subsystem a budget. The binding constraint on a phone is **fill rate**,
not geometry — a mobile GPU pushes this scene's triangles easily but chokes on
large additive transparent layers — so the mobile budget cuts overdraw first:

| | Desktop | Mobile | Mobile-low |
|---|---:|---:|---:|
| Pixels per eye (ceiling) | 2.6 M | 1.15 M | 0.75 M |
| Scene MSAA | 4× | off | off |
| Ground haze layers | 7 | 3 | 2 |
| Volumetric shafts | 6 | 3 | 2 |
| Dust motes / max size | 4200 / 64 px | 1400 / 26 px | 700 / 18 px |
| Shadows | on, 1024 | on, 512 | off |
| Panel repaints | 12 Hz | 8 Hz | 6 Hz |
| Engineers | 3 | 3 | 2 |

Detection is coarse on purpose — a browser cannot identify a GPU, and
user-agent sniffing for handsets ages badly — so it splits on whether the
device is handheld plus its reported memory and core count, then lets adaptive
resolution absorb the rest.

Append `?tier=mobile` or `?tier=mobile-low` to the URL to force a tier. That is
useful for previewing the mobile look from a desktop, and for pinning a
struggling handset at a venue without rebuilding anything.

`?assist=<degrees>` moves the narration strip relative to the eye line —
positive is below, negative above, and the default is 0 (on the lens axis, over
the fan). Where that strip feels comfortable depends on how the handset sits in
its holder and on the wearer, and tuning it by eye needs a viewer on a head, so
it is adjustable on the device rather than only in the source.

Measured in the busiest chapter, with all eleven analysis panels present:

| Mode | Draw calls | Triangles |
|------|-----------:|----------:|
| Flat (mobile budget) | 162 | 84 k |
| Stereo, both eyes + composite (mobile budget) | 322 | 168 k |
| Stereo, both eyes + composite (desktop budget) | 420 | 226 k |

Stereo costs well under twice a flat frame: the shadow pass is shared between
eyes and the composite is two quads.

---

## Deployment

The application is a static site. Copy these to any web server:

```
index.html
styles/
src/
vendor/
```

`node_modules/`, `tools/` and `package.json` are development conveniences and
are not needed at run time.

**Offline / USB stick.** Copy the same files to a folder and serve it with any
local server — `python3 tools/serve.py` is included for exactly this. Opening
`index.html` directly with a `file://` URL will **not** work: browsers refuse to
load ES modules over `file://`. A local server is required, and once it is
running no internet connection is used at any point.

**HTTPS.** Motion sensors, WebXR, fullscreen and the wake lock all require a
secure context. `localhost` counts as secure; any other host needs a
certificate. For a venue demonstration, the most reliable setup is a laptop
running the server with the phone joined to the laptop's hotspot, using a
self-signed certificate or a tunnelling service.

**iOS.** Safari asks permission before delivering motion data. The prompt is
triggered by the *Enter VR* button, which is the required user gesture. If
permission is declined the experience falls back to touch steering rather than
failing.

---

## Development

```bash
npm install          # optional — only needed to re-vendor Three.js
npm run vendor       # copy the Three.js modules used into vendor/
npm run check        # resolve every import and check syntax (no bundle emitted)
npm start            # serve on http://localhost:8137
```

`npm run check` is the fast correctness gate: it resolves the whole module graph
against the vendored runtime and fails on any missing file, bad path or syntax
error.

### Browser support

| Browser | Flat | Cardboard stereo | WebXR |
|---------|------|------------------|-------|
| Chrome / Edge (desktop) | ✅ | ✅ | ✅ with a headset |
| Chrome (Android) | ✅ | ✅ | ✅ |
| Safari (macOS) | ✅ | ✅ | — |
| Safari (iOS 13+) | ✅ | ✅ after the motion prompt | — |
| Firefox | ✅ | ✅ | — |

WebGL 2 is used where available; a WebGL 1 context still renders, with the
quality preset dropped automatically.

---

## Licence

MIT. Three.js is included under its own MIT licence. No third-party art, audio
or fonts are used — every asset in the experience is generated at run time.
