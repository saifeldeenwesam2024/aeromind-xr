/**
 * @file Renderer.js
 * @description Rendering back-end and stereoscopic compositor.
 *
 * ### How stereo is actually produced
 *
 * The world is built **once**. Nothing in the scene graph, and nothing in the
 * DOM, is duplicated for the second eye. Instead the same scene is rendered
 * twice per frame, from two independent cameras, into two independent render
 * targets:
 *
 * ```
 *   scene ──► eyeLeft  ──► PostChain L ──► rtLeft  ─┐
 *         └─► eyeRight ──► PostChain R ──► rtRight ─┴─► compositor ──► canvas
 * ```
 *
 * Each eye owns its own post-processing chain because bloom is a screen-space
 * effect: sharing one buffer would let light from the left eye bleed into the
 * right, which the visual system reads as a smeared, unfusable image.
 *
 * The compositor is a single full-screen pass drawing two quads — one per half
 * of the canvas — through a barrel-distortion shader that pre-compensates for
 * the pincushion distortion of a Cardboard-class lens.
 *
 * ### Three presentation modes
 *
 * | Mode     | Path                                                      |
 * |----------|-----------------------------------------------------------|
 * | `flat`   | One chain, full canvas — desktop preview                   |
 * | `stereo` | Two chains + compositor — Cardboard / mobile VR            |
 * | `xr`     | Direct render; the WebXR runtime owns the stereo layers    |
 *
 * WebXR bypasses the composer deliberately: an immersive session drives its own
 * multiview framebuffer and per-eye viewports, and interposing a screen-space
 * chain there would break reprojection and cost frame rate that a headset
 * cannot spare.
 */

import {
  ACESFilmicToneMapping,
  Mesh,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UniformsUtils,
  WebGLRenderer,
} from 'three';
import { PostChain, BloomPresets } from '../effects/Bloom.js';
import { LensDistortionShader } from '../effects/Glow.js';
import { clamp } from './Utils.js';

/**
 * Owns the WebGL context, the post-processing chains and the stereo
 * compositor.
 * @class
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas Target canvas.
   * @param {object} [options] Configuration.
   * @param {number} [options.maxPixelRatio] Ceiling on device pixel ratio.
   * @param {string} [options.quality] Initial quality preset name.
   */
  constructor(canvas, options = {}) {
    const { maxPixelRatio = 2, quality = 'high' } = options;

    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    /** @type {WebGLRenderer} */
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.88;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = true;
    // Reset the statistics once per frame rather than after every internal
    // render call, so the diagnostics read-out reports the whole frame's cost
    // instead of just the last post-processing quad.
    this.renderer.info.autoReset = false;

    /** @type {boolean} True when a WebGL2 context was obtained. */
    this.isWebGL2 = this.renderer.capabilities.isWebGL2 !== false;

    /** @type {number} */
    this.maxPixelRatio = maxPixelRatio;
    /** @type {string} Active quality preset. */
    this.quality = quality;
    /** @type {'flat'|'stereo'|'xr'} */
    this.mode = 'flat';

    /** @type {number} Adaptive resolution multiplier, 0.55–1.0. */
    this.renderScale = 1;
    /** @type {number} Smoothed frame time in milliseconds. */
    this.frameTimeMs = 16.7;
    /** @type {number} Frames since the last adaptive adjustment. */
    this._sinceAdjust = 0;
    /** @type {boolean} Whether adaptive resolution is permitted. */
    this.adaptive = true;

    /** @type {import('three').Scene|null} */
    this.scene = null;
    /** @type {import('./CameraRig.js').CameraRig|null} */
    this.rig = null;

    /** @type {PostChain|null} Flat-preview chain. */
    this.chainMono = null;
    /** @type {PostChain|null} Left-eye chain. */
    this.chainLeft = null;
    /** @type {PostChain|null} Right-eye chain. */
    this.chainRight = null;

    /** @type {number} Global fade multiplier, 0 = black. */
    this.fade = 1;

    /** @type {{width: number, height: number, dpr: number}} */
    this.size = { width: 1, height: 1, dpr: 1 };

    this.#buildCompositor();
  }

  /* -------------------------------------------------------------- lifecycle */

  /**
   * Binds the scene and camera rig, then builds the chain for the current mode.
   * @param {import('three').Scene} scene Scene to render.
   * @param {import('./CameraRig.js').CameraRig} rig Camera rig.
   */
  attach(scene, rig) {
    this.scene = scene;
    this.rig = rig;
    this.setSize();
    this.#rebuildChains();
  }

  /**
   * Builds the compositor: an orthographic pass with one quad per eye.
   *
   * The quads live in clip space (x ∈ [−1, 1], y ∈ [−1, 1]), each covering
   * exactly half the canvas, and each samples its own eye's finished frame
   * through an independent copy of the lens-distortion shader.
   * @private
   */
  #buildCompositor() {
    /** @type {Scene} */
    this.compositeScene = new Scene();
    /** @type {OrthographicCamera} */
    this.compositeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const geometry = new PlaneGeometry(1, 2);

    /**
     * Creates one eye quad.
     * @param {number} x Centre X in clip space.
     * @returns {Mesh}
     */
    const makeQuad = (x) => {
      const material = new ShaderMaterial({
        uniforms: UniformsUtils.clone(LensDistortionShader.uniforms),
        vertexShader: LensDistortionShader.vertexShader,
        fragmentShader: LensDistortionShader.fragmentShader,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new Mesh(geometry, material);
      mesh.position.x = x;
      mesh.frustumCulled = false;
      return mesh;
    };

    /** @type {Mesh} */
    this.quadLeft = makeQuad(-0.5);
    /** @type {Mesh} */
    this.quadRight = makeQuad(0.5);
    this.compositeScene.add(this.quadLeft, this.quadRight);

    /** @type {number} Lens distortion strength, 0 disables it. */
    this.distortion = 1;
    /**
     * Horizontal lens-centre offset in UV units. Cardboard-class viewers place
     * the lens axes slightly inboard of each half-image centre; positive values
     * shift each eye's optical centre outward.
     * @type {number}
     */
    this.lensCenterOffset = 0;
  }

  /**
   * Creates the post-processing chains required by the active mode and
   * disposes the ones that are not.
   * @private
   */
  #rebuildChains() {
    if (!this.scene || !this.rig) return;

    const preset = BloomPresets[this.quality] ?? BloomPresets.high;
    const { width, height, dpr } = this.size;
    const bufferW = Math.max(2, Math.round(width * dpr * this.renderScale));
    const bufferH = Math.max(2, Math.round(height * dpr * this.renderScale));

    if (this.mode === 'stereo') {
      this.#disposeChain('chainMono');
      const eyeW = Math.max(2, Math.round(bufferW / 2));

      // Each eye is already half-width, and a viewer's lens magnifies the image
      // enough that fine bloom detail is lost anyway — so the bloom buffer runs
      // proportionally smaller in stereo than it does on a flat screen.
      const eyePreset = { ...preset, bloomScale: preset.bloomScale * 0.8 };

      if (!this.chainLeft) {
        this.chainLeft = new PostChain(this.renderer, this.scene, this.rig.eyeLeft, {
          width: eyeW, height: bufferH, ...eyePreset, renderToScreen: false,
        });
      }
      if (!this.chainRight) {
        this.chainRight = new PostChain(this.renderer, this.scene, this.rig.eyeRight, {
          width: eyeW, height: bufferH, ...eyePreset, renderToScreen: false,
        });
      }
      this.chainLeft.setSize(eyeW, bufferH);
      this.chainRight.setSize(eyeW, bufferH);
      this.quadLeft.material.uniforms.tDiffuse.value = this.chainLeft.outputTexture;
      this.quadRight.material.uniforms.tDiffuse.value = this.chainRight.outputTexture;
    } else if (this.mode === 'flat') {
      this.#disposeChain('chainLeft');
      this.#disposeChain('chainRight');
      if (!this.chainMono) {
        this.chainMono = new PostChain(this.renderer, this.scene, this.rig.mono, {
          width: bufferW, height: bufferH, ...preset, renderToScreen: true,
        });
      }
      this.chainMono.setSize(bufferW, bufferH);
    } else {
      // WebXR renders directly; no chains are needed.
      this.#disposeChain('chainMono');
      this.#disposeChain('chainLeft');
      this.#disposeChain('chainRight');
    }

    this.#applyQualityToChains(preset);
  }

  /**
   * @param {'chainMono'|'chainLeft'|'chainRight'} key Chain field name.
   * @private
   */
  #disposeChain(key) {
    if (this[key]) {
      this[key].dispose();
      this[key] = null;
    }
  }

  /**
   * @param {object} preset Bloom preset values.
   * @private
   */
  #applyQualityToChains(preset) {
    for (const chain of this.#chains()) {
      chain.setBloom(preset);
      chain.setFade(this.fade);
    }
  }

  /**
   * Iterates the chains that are currently live.
   * @returns {PostChain[]}
   * @private
   */
  #chains() {
    return [this.chainMono, this.chainLeft, this.chainRight].filter(Boolean);
  }

  /* ------------------------------------------------------------------ mode */

  /**
   * Switches presentation mode and rebuilds the pipeline for it.
   * @param {'flat'|'stereo'|'xr'} mode Presentation mode.
   */
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.renderer.xr.enabled = mode === 'xr';
    this.setSize();
    this.#rebuildChains();
  }

  /**
   * Selects a quality preset and applies it to every live chain.
   * @param {'ultra'|'high'|'medium'|'low'} name Preset name.
   */
  setQuality(name) {
    if (!BloomPresets[name] || this.quality === name) return;
    this.quality = name;
    // Bloom buffer scale is baked into each chain at construction, so the
    // chains are rebuilt rather than patched.
    this.#disposeChain('chainMono');
    this.#disposeChain('chainLeft');
    this.#disposeChain('chainRight');
    this.#rebuildChains();
  }

  /**
   * Sets the global fade-to-black multiplier.
   * @param {number} value 0 = black, 1 = full image.
   */
  setFade(value) {
    this.fade = clamp(value, 0, 1);
    for (const chain of this.#chains()) chain.setFade(this.fade);
  }

  /**
   * Adjusts bloom on every live chain — used by the story to lift the
   * holographic layer during the AI reasoning sequence.
   * @param {{strength?: number, radius?: number, threshold?: number}} params Bloom parameters.
   */
  setBloom(params) {
    for (const chain of this.#chains()) chain.setBloom(params);
  }

  /**
   * Enables or disables lens barrel distortion.
   * @param {number} strength 0 = off, 1 = full Cardboard compensation.
   */
  setDistortion(strength) {
    this.distortion = clamp(strength, 0, 2);
  }

  /* ------------------------------------------------------------------ size */

  /**
   * Resizes the canvas, buffers and camera projections to the viewport.
   *
   * In stereo mode each eye receives half the canvas width, so the per-eye
   * aspect ratio is `(width / 2) / height` — getting this wrong is the single
   * most common cause of the "squashed" look in home-made Cardboard demos.
   */
  setSize() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);

    // Stereo halves the horizontal resolution per eye, so a lower device pixel
    // ratio keeps the pixel budget sane on high-DPI phones.
    const cap = this.mode === 'stereo' ? Math.min(this.maxPixelRatio, 1.75) : this.maxPixelRatio;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);

    this.size = { width, height, dpr };
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);

    if (this.rig) {
      const aspect = this.mode === 'stereo'
        ? (width * 0.5) / height
        : width / height;
      this.rig.updateProjection(aspect);
    }

    const bufferW = Math.max(2, Math.round(width * dpr * this.renderScale));
    const bufferH = Math.max(2, Math.round(height * dpr * this.renderScale));

    if (this.mode === 'stereo') {
      const eyeW = Math.max(2, Math.round(bufferW / 2));
      this.chainLeft?.setSize(eyeW, bufferH);
      this.chainRight?.setSize(eyeW, bufferH);
      if (this.chainLeft) this.quadLeft.material.uniforms.tDiffuse.value = this.chainLeft.outputTexture;
      if (this.chainRight) this.quadRight.material.uniforms.tDiffuse.value = this.chainRight.outputTexture;
    } else {
      this.chainMono?.setSize(bufferW, bufferH);
    }
  }

  /* ---------------------------------------------------------------- render */

  /**
   * Renders one frame.
   *
   * Both eyes are rendered from the same world state — animation is advanced by
   * the application *before* this call, never between the two eye renders. A
   * mismatch there would present each eye a slightly different moment in time,
   * which reads as shimmering and is deeply uncomfortable.
   *
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   */
  render(dt, time) {
    if (!this.scene || !this.rig) return;

    this.renderer.info.reset();
    for (const chain of this.#chains()) chain.setTime(time);

    if (this.mode === 'xr') {
      this.renderer.render(this.scene, this.rig.mono);
    } else if (this.mode === 'stereo') {
      this.#renderStereo();
    } else if (this.chainMono) {
      this.chainMono.render();
    }

    if (this.adaptive) this.#updateAdaptiveScale(dt);
  }

  /**
   * Renders both eyes and composites them side by side.
   * @private
   */
  #renderStereo() {
    if (!this.chainLeft || !this.chainRight) return;

    this.chainLeft.render();
    this.chainRight.render();

    // The composer ping-pongs between two targets, so the finished texture can
    // change identity between frames. Re-binding is cheap and keeps the
    // compositor pointed at whichever buffer holds the current frame.
    this.quadLeft.material.uniforms.tDiffuse.value = this.chainLeft.outputTexture;
    this.quadRight.material.uniforms.tDiffuse.value = this.chainRight.outputTexture;

    const offset = this.lensCenterOffset;
    const uL = this.quadLeft.material.uniforms;
    const uR = this.quadRight.material.uniforms;
    uL.uStrength.value = this.distortion;
    uR.uStrength.value = this.distortion;
    uL.uCenter.value.set(0.5 + offset, 0.5);
    uR.uCenter.value.set(0.5 - offset, 0.5);

    // `setViewport` takes CSS pixels; the renderer multiplies by pixel ratio.
    const { width, height } = this.size;
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.render(this.compositeScene, this.compositeCamera);
  }

  /**
   * Adaptive resolution.
   *
   * Frame time is smoothed heavily and adjustments are rate-limited, so the
   * resolution creeps rather than pumps — a visibly oscillating render scale is
   * worse than a consistently lower one.
   * @param {number} dt Delta time in seconds.
   * @private
   */
  #updateAdaptiveScale(dt) {
    this.frameTimeMs = this.frameTimeMs * 0.94 + (dt * 1000) * 0.06;
    this._sinceAdjust++;
    if (this._sinceAdjust < 90) return;

    const before = this.renderScale;

    if (this.frameTimeMs > 21 && this.renderScale > 0.55) {
      this.renderScale = Math.max(0.55, this.renderScale - 0.1);
    } else if (this.frameTimeMs < 13.5 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.05);
    }

    if (before !== this.renderScale) {
      this._sinceAdjust = 0;
      this.setSize();
    } else {
      this._sinceAdjust = 60;
    }
  }

  /**
   * The measured frame rate, for the diagnostics read-out.
   * @returns {number} Frames per second.
   */
  get fps() {
    return this.frameTimeMs > 0 ? 1000 / this.frameTimeMs : 0;
  }

  /**
   * Renderer statistics for the diagnostics read-out.
   * @returns {{calls: number, triangles: number, programs: number}}
   */
  get stats() {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
    };
  }

  /**
   * The animation loop driver. `WebGLRenderer.setAnimationLoop` is used rather
   * than `requestAnimationFrame` because it is the only loop a WebXR session
   * will drive at the headset's refresh rate.
   * @param {?function(number): void} callback Frame callback, or null to stop.
   */
  setAnimationLoop(callback) {
    this.renderer.setAnimationLoop(callback);
  }

  /** Releases every GPU resource. */
  dispose() {
    this.setAnimationLoop(null);
    this.#disposeChain('chainMono');
    this.#disposeChain('chainLeft');
    this.#disposeChain('chainRight');
    this.quadLeft.geometry.dispose();
    this.quadLeft.material.dispose();
    this.quadRight.material.dispose();
    this.renderer.dispose();
  }
}
