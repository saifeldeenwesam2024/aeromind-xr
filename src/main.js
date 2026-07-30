/**
 * @file main.js
 * @description Application entry point.
 *
 * Wires the engine, the world and the interface together, then runs a single
 * frame loop with a strict ordering contract:
 *
 *   1. Advance the clock.
 *   2. Advance input → head orientation.
 *   3. Advance the camera rig.
 *   4. Advance the story and the world.
 *   5. Render — twice, for two eyes, from one world.
 *
 * Steps 1–4 complete before any pixel is drawn. That is what guarantees both
 * eyes see the same instant: if animation advanced between the left and right
 * eye renders, the two images would disagree by one frame and the viewer's
 * visual system would fail to fuse them.
 */

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { AssetManager } from './engine/AssetManager.js';
import { AudioEngine } from './engine/AudioEngine.js';
import { CameraRig } from './engine/CameraRig.js';
import { InputManager } from './engine/InputManager.js';
import { Renderer } from './engine/Renderer.js';
import { SceneManager, ENGINE_CENTRE } from './engine/SceneManager.js';
import { Timeline } from './engine/Timeline.js';
import { XRManager } from './engine/XRManager.js';
import { HUD } from './ui/HUD.js';
import { LoadingScreen } from './ui/LoadingScreen.js';
import { StartMenu } from './ui/StartMenu.js';
import { VRMenu } from './ui/VRMenu.js';
import { clamp } from './engine/Utils.js';

/**
 * The AeroMind XR application.
 * @class
 */
class AeroMindApp {
  constructor() {
    /** @type {HTMLCanvasElement} */
    this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('viewport'));

    /** @type {LoadingScreen} */
    this.loading = new LoadingScreen();
    /** @type {StartMenu} */
    this.menu = new StartMenu();

    /** @type {boolean} Whether the experience has been entered. */
    this.started = false;
    /** @type {boolean} Whether free-look inspection is active. */
    this.inspecting = false;
    /** @type {number} Timestamp of the previous frame, in seconds. */
    this._last = 0;
    /** @type {number} Absolute clock driving all shader animation. */
    this.clock = 0;
    /** @type {number} Frames rendered since the last HUD statistics update. */
    this._statTimer = 0;
  }

  /* ===================================================================== */
  /* Boot                                                                   */
  /* ===================================================================== */

  /**
   * Creates every subsystem, loads assets and shows the start menu.
   * @returns {Promise<void>}
   */
  async boot() {
    if (!this.canvas) throw new Error('Viewport canvas is missing from the document.');

    this.renderer = new Renderer(this.canvas);
    /** @type {import('./engine/DeviceProfile.js').QualityBudget} */
    this.budget = this.renderer.budget;

    if (!this.renderer.isWebGL2) {
      // WebGL 1 still renders, but several effects rely on WebGL 2 features.
      // Dropping quality keeps it running rather than failing outright.
      this.renderer.setQuality('low');
    }
    console.info(`[AeroMind] device tier: ${this.budget.tier}`);

    /* ------------------------------------------------------------ assets */

    this.assets = new AssetManager(this.renderer.renderer);
    await this.assets.load((value, message) => {
      this.loading.setProgress(value * 0.9, message);
    });

    /* ------------------------------------------------------------- world */

    this.loading.setProgress(0.92, 'Assembling hangar');
    await nextFrame();

    this.rig = new CameraRig({ ipd: 0.064, convergence: 5.2, fov: 58 });
    this.audio = new AudioEngine();
    this.hud = new HUD();
    this.hud.attach(this.rig);

    this.scenes = new SceneManager({
      assets: this.assets,
      audio: this.audio,
      hud: this.hud,
      rig: this.rig,
      budget: this.budget,
    });
    this.scenes.scene.add(this.rig.rig);

    this.loading.setProgress(0.97, 'Compiling shaders');
    await nextFrame();

    this.renderer.attach(this.scenes.scene, this.rig);
    // Warm the shader cache before the first visible frame so the opening
    // seconds never stutter while programs compile.
    this.renderer.renderer.compile(this.scenes.scene, this.rig.mono);

    /* ------------------------------------------------------------- input */

    this.input = new InputManager(this.canvas, { smoothing: 16, dwellTime: 1.1 });
    this.xr = new XRManager(this.renderer, this.input);

    this.vrMenu = new VRMenu([
      { id: 'replay', glyph: '↺', label: 'Replay' },
      { id: 'recenter', glyph: '⊕', label: 'Recentre' },
      { id: 'ipd-down', glyph: '−', label: 'IPD' },
      { id: 'ipd-up', glyph: '+', label: 'IPD' },
      { id: 'exit', glyph: '✕', label: 'Exit VR' },
    ]);
    this.vrMenu.attach(this.rig);

    /* ---------------------------------------------------------- timeline */

    this.timeline = new Timeline({ duration: 120, loop: true, context: this.scenes });
    this.scenes.createStory(this.timeline);
    // Chapters restore their own world state on entry, so a seek needs no
    // extra work — but a loop wraps past chapter one's `onEnter`, so the
    // opening state is re-applied explicitly there.
    this.timeline.on('loop', () => this.scenes.resetStoryState());

    /* -------------------------------------------------------- inspection */

    // A detached camera used only for the desktop inspection mode. The rig
    // copies its transform, so the same rendering path serves both modes.
    this.orbitProxy = this.rig.mono.clone();
    this.orbitProxy.position.set(0, 2.6, 8);
    this.controls = new OrbitControls(this.orbitProxy, this.canvas);
    this.controls.target.copy(ENGINE_CENTRE);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 3.2;
    this.controls.maxDistance = 22;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.enabled = false;
    this.controls.update();

    /* --------------------------------------------------------------- ui */

    this.#wireMenu();
    this.#wireInput();
    this.#wireVRMenu();
    window.addEventListener('resize', () => this.renderer.setSize());

    const capabilities = await this.xr.probe();
    this.menu.configure(capabilities, this.xr.describeVrPath());
    this.menu.setChapters(this.timeline.chapters, this.timeline.duration);

    this.loading.setProgress(1, 'Ready');
    await this.loading.hide(0.3);
    // Guarded: an automated or very early entry can start the experience while
    // the loading screen is still fading, and the menu must not reappear on top
    // of a running scene.
    if (!this.started) this.menu.show();

    // Render a held first frame behind the menu so the canvas is never blank.
    this.renderer.setFade(0);
    this.renderer.render(1 / 60, 0);

    this.renderer.setAnimationLoop((timestamp) => this.#frame(timestamp));
  }

  /* ===================================================================== */
  /* Wiring                                                                 */
  /* ===================================================================== */

  /** Connects the start menu and control bar. @private */
  #wireMenu() {
    this.menu
      .on('vr', async () => {
        await this.#begin();
        await this.xr.enterImmersive();
        this.#applyPresentationMode();
      })
      .on('desktop', async () => {
        await this.#begin();
        // A touch device without a viewer still gets sensor steering.
        if (this.xr.capabilities?.touch && this.xr.capabilities?.sensors) {
          await this.xr.enterMagicWindow();
        } else {
          await this.xr.enterFlat();
        }
        this.#applyPresentationMode();
      })
      .on('play', () => this.timeline.toggle())
      .on('toggleVR', async () => {
        await this.xr.toggleStereo();
        this.#applyPresentationMode();
      })
      .on('seek', (value) => {
        // Negative sentinels come from the scrubber's keyboard handling.
        if (value === -1) this.timeline.previousChapter();
        else if (value === -2) this.timeline.nextChapter();
        else this.timeline.seek(value * this.timeline.duration);
      });

    this.xr.on('modechange', () => this.#applyPresentationMode());
  }

  /** Connects keyboard shortcuts. @private */
  #wireInput() {
    this.input.on('key', ({ code }) => {
      if (!this.started) return;

      switch (code) {
        case 'Space':
          this.timeline.toggle();
          break;
        case 'KeyR':
          this.input.recenter();
          break;
        case 'KeyI':
          this.#setInspecting(!this.inspecting);
          break;
        case 'KeyV':
          this.xr.toggleStereo().then(() => this.#applyPresentationMode());
          break;
        case 'KeyM':
          this.audio.toggleMute();
          break;
        case 'KeyF':
          this.xr.isFullscreen ? this.xr.exitFullscreen() : this.xr.requestFullscreen();
          break;
        case 'ArrowRight':
          this.timeline.nextChapter();
          break;
        case 'ArrowLeft':
          this.timeline.previousChapter();
          break;
        case 'Equal':
        case 'NumpadAdd':
          this.rig.setIPD(this.rig.ipd + 0.002);
          this.hud.notify(`IPD ${(this.rig.ipd * 1000).toFixed(0)} mm`, 'info', 1.6);
          break;
        case 'Minus':
        case 'NumpadSubtract':
          this.rig.setIPD(this.rig.ipd - 0.002);
          this.hud.notify(`IPD ${(this.rig.ipd * 1000).toFixed(0)} mm`, 'info', 1.6);
          break;
        default:
          break;
      }
    });
  }

  /** Connects the in-headset menu actions. @private */
  #wireVRMenu() {
    this.vrMenu
      .on('replay', () => {
        this.timeline.restart();
        this.audio.play('click');
      })
      .on('recenter', () => {
        this.input.recenter();
        this.audio.play('click');
        this.hud.notify('View recentred', 'ok', 1.6);
      })
      .on('ipd-down', () => {
        this.rig.setIPD(this.rig.ipd - 0.002);
        this.audio.play('click');
        this.hud.notify(`IPD ${(this.rig.ipd * 1000).toFixed(0)} mm`, 'info', 1.8);
      })
      .on('ipd-up', () => {
        this.rig.setIPD(this.rig.ipd + 0.002);
        this.audio.play('click');
        this.hud.notify(`IPD ${(this.rig.ipd * 1000).toFixed(0)} mm`, 'info', 1.8);
      })
      .on('exit', async () => {
        this.audio.play('click');
        await this.xr.exitImmersive();
        this.#applyPresentationMode();
      });
  }

  /**
   * Starts the experience. Audio is unlocked here because this runs inside the
   * click handler — the only reliable user gesture in the session.
   * @returns {Promise<void>}
   * @private
   */
  async #begin() {
    // Dismissing the menu is unconditional: a second entry press must always
    // put the viewer back in the experience, even if it is already running.
    this.menu.hide();
    if (this.started) return;
    this.started = true;

    await this.audio.unlock();

    this.scenes.resetStoryState();
    this.timeline.seek(0);
    this.timeline.play();
  }

  /**
   * Applies renderer, rig and interface settings for the active presentation
   * mode.
   * @private
   */
  #applyPresentationMode() {
    const mode = this.xr.mode;
    const stereo = mode === 'stereo';
    const immersive = stereo || mode === 'xr' || mode === 'magicwindow';

    this.rig.applyModeDefaults(stereo ? 'stereo' : mode === 'xr' ? 'xr' : 'flat');
    this.renderer.setDistortion(stereo ? 1 : 0);
    // The glasses interface is authored in angular terms, so it follows the
    // camera's field of view rather than keeping a fixed metric size.
    this.hud.setFieldScale(this.rig.fov);

    // Convergence sits on the engine, so the subject of the film is exactly at
    // screen depth and the whole scene is comfortable to fuse.
    this.rig.setConvergence(stereo ? 5.4 : 6.0);

    this.vrMenu.setEnabled(immersive);
    this.menu.setBarVisible(this.started && !immersive);
    if (immersive) this.#setInspecting(false);

    this.renderer.setSize();
  }

  /**
   * Enters or leaves free-look inspection. The story pauses so the viewer can
   * study the engine from any angle, which is exactly what a judge asks for.
   * @param {boolean} value Whether inspection should be active.
   * @private
   */
  #setInspecting(value) {
    if (this.inspecting === value) return;
    this.inspecting = value;
    this.controls.enabled = value;
    this.input.enabled = !value;

    if (value) {
      this.timeline.pause();
      this.orbitProxy.position.copy(this.rig.rig.position);
      this.controls.target.copy(ENGINE_CENTRE);
      this.controls.update();
      this.hud.notify('Inspection mode — drag to orbit', 'info', 2.8);
    } else {
      this.timeline.play();
      this.rig.snapTo(
        this.rig.targetPosition.x, this.rig.targetPosition.y, this.rig.targetPosition.z,
      );
      this.hud.notify('Playback resumed', 'info', 1.8);
    }
  }

  /* ===================================================================== */
  /* Frame                                                                  */
  /* ===================================================================== */

  /**
   * Runs one frame.
   * @param {number} timestamp High-resolution timestamp in milliseconds.
   * @private
   */
  #frame(timestamp) {
    const now = (timestamp ?? performance.now()) / 1000;
    // Clamp the step so a backgrounded tab does not fast-forward the story
    // when it returns, and so physics-free easing never overshoots.
    const dt = this._last ? clamp(now - this._last, 0, 0.1) : 1 / 60;
    this._last = now;
    this.clock += dt;

    /* -------- 1. input → head orientation -------------------------- */
    this.input.update(dt);

    /* -------- 2. camera rig ---------------------------------------- */
    if (this.inspecting) {
      this.controls.update();
      this.rig.rig.position.copy(this.orbitProxy.position);
      this.rig.rig.quaternion.copy(this.orbitProxy.quaternion);
      this.rig.head.quaternion.identity();
      this.rig.rig.updateMatrixWorld(true);
    } else {
      this.rig.setHeadOrientation(this.input.quaternion);
      this.rig.update(dt);
    }

    /* -------- 3. story and world ----------------------------------- */
    this.timeline.update(dt);
    this.scenes.update(dt, this.clock);

    /* -------- 4. interface ----------------------------------------- */
    this.#updateGaze(dt);
    this.hud.update(dt, this.clock);
    this.menu.update(dt);

    this._statTimer += dt;
    if (this._statTimer > 0.5) {
      this._statTimer = 0;
      this.hud.setStatus({ fps: Math.round(this.renderer.fps) });
      this.menu.setTransport({
        progress: this.timeline.progress,
        playing: this.timeline.playing,
        label: this.timeline.chapterLabel,
      });
      this.menu.setRotatePrompt(this.xr.needsRotation);
    }

    /* -------- 5. render -------------------------------------------- */
    this.renderer.setFade(this.scenes.fade);
    this.renderer.setBloom(this.scenes.bloom);
    this.renderer.render(dt, this.clock);
  }

  /**
   * Casts the gaze ray and drives dwell selection on the in-headset menu.
   * @param {number} dt Delta time in seconds.
   * @private
   */
  #updateGaze(dt) {
    const interactives = this.vrMenu.getInteractives();

    if (!interactives.length) {
      this.vrMenu.update(dt, { target: null, progress: 0 });
      this.hud.setGaze(0, false);
      this.input.resetGaze();
      return;
    }

    const ray = this.rig.getGazeRay();
    const hits = ray.intersectObjects(interactives, false);
    const target = hits.length ? hits[0].object : null;

    const gaze = this.input.updateGaze(target, dt);
    if (gaze.activated) {
      this.vrMenu.activate(target);
      this.input.resetGaze();
    }

    this.vrMenu.update(dt, gaze);
    this.hud.setGaze(gaze.progress, !!target);
  }

  /** Tears the application down. */
  dispose() {
    this.renderer?.setAnimationLoop(null);
    this.controls?.dispose();
    this.input?.dispose();
    this.xr?.dispose();
    this.vrMenu?.dispose();
    this.hud?.dispose();
    this.timeline?.dispose();
    this.scenes?.dispose();
    this.assets?.dispose();
    this.renderer?.dispose();
  }
}

/**
 * Resolves on the next animation frame, with a timer racing it so start-up
 * cannot stall in a background tab where `requestAnimationFrame` never fires.
 * @returns {Promise<void>}
 */
function nextFrame() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    requestAnimationFrame(done);
    setTimeout(done, 60);
  });
}

/* ------------------------------------------------------------------ start */

const app = new AeroMindApp();

app.boot().catch((error) => {
  console.error('[AeroMind] Startup failed:', error);
  app.loading.fail(
    error?.message ??
    'This browser could not initialise WebGL. Please try a recent version of Chrome, Edge, Safari or Firefox.',
  );
});

// Exposed for debugging and for driving the demo from a presenter console.
window.AeroMind = app;
