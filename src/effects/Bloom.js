/**
 * @file Bloom.js
 * @description Post-processing chain factory.
 *
 * Stereoscopic rendering makes post-processing subtle: bloom is a screen-space
 * effect, so if both eyes shared one buffer, light from the left eye would
 * bleed into the right and destroy the stereo illusion. Each eye therefore owns
 * a completely independent chain writing into its own render target, and the
 * compositor draws those two targets side by side. This factory produces one
 * such chain.
 */

import {
  LinearFilter,
  RGBAFormat,
  HalfFloatType,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CinematicGradeShader } from './Glow.js';

/**
 * A self-contained render → bloom → grade pipeline for a single camera.
 * @class
 */
export class PostChain {
  /**
   * @param {import('three').WebGLRenderer} renderer Shared renderer.
   * @param {import('three').Scene} scene Scene to render.
   * @param {import('three').Camera} camera Camera to render from.
   * @param {object} [options] Pipeline configuration.
   * @param {number} [options.width] Initial buffer width in pixels.
   * @param {number} [options.height] Initial buffer height in pixels.
   * @param {number} [options.strength] Bloom strength.
   * @param {number} [options.radius] Bloom radius.
   * @param {number} [options.threshold] Bloom luminance threshold.
   * @param {number} [options.bloomScale] Bloom buffer scale (0–1); lower is faster.
   * @param {number} [options.samples] Multisample count for the scene buffer.
   * @param {boolean} [options.grade] Append the cinematic grade pass.
   * @param {boolean} [options.renderToScreen] Present directly instead of to a target.
   */
  constructor(renderer, scene, camera, options = {}) {
    const {
      width = 1280,
      height = 720,
      strength = 0.62,
      radius = 0.72,
      threshold = 0.82,
      bloomScale = 0.5,
      samples = 4,
      grade = true,
      renderToScreen = false,
    } = options;

    /** @type {import('three').WebGLRenderer} */
    this.renderer = renderer;
    /** @type {import('three').Camera} */
    this.camera = camera;
    /** @type {boolean} */
    this.presentsToScreen = renderToScreen;
    /** @type {number} */
    this.bloomScale = bloomScale;
    /** @type {number} */
    this.width = Math.max(2, Math.round(width));
    /** @type {number} */
    this.height = Math.max(2, Math.round(height));

    // Half-float keeps highlights above 1.0 intact so bloom has real energy to
    // work with instead of clipped white.
    const target = new WebGLRenderTarget(this.width, this.height, {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      format: RGBAFormat,
      type: HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: renderer.capabilities.isWebGL2 ? samples : 0,
    });
    target.texture.name = 'PostChain.target';

    /** @type {EffectComposer} */
    this.composer = new EffectComposer(renderer, target);
    this.composer.renderToScreen = renderToScreen;

    // Both ping-pong buffers keep their depth buffer and multisampling.
    //
    // It is tempting to strip them from `renderTarget2` on the grounds that only
    // the render pass draws geometry — but the composer *swaps* the buffers
    // after every pass that sets `needsSwap`, so which target the render pass
    // draws into alternates from frame to frame. Both buffers therefore receive
    // scene geometry on alternating frames, and a buffer without a depth
    // attachment renders that frame with no depth testing at all.
    //
    /** @type {RenderPass} */
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    /** @type {UnrealBloomPass} */
    this.bloomPass = new UnrealBloomPass(
      new Vector2(this.width * bloomScale, this.height * bloomScale),
      strength, radius, threshold,
    );
    this.composer.addPass(this.bloomPass);

    /** @type {ShaderPass|null} */
    this.gradePass = null;
    if (grade) {
      this.gradePass = new ShaderPass(CinematicGradeShader);
      this.gradePass.renderToScreen = renderToScreen;
      this.composer.addPass(this.gradePass);
    }

    // The composer only swaps buffers after passes that declare `needsSwap`.
    // The grade pass does, so the finished frame ends up in `readBuffer`.
    // Without a grade pass we add a no-op copy to guarantee the same invariant.
    if (!grade) {
      const copy = new ShaderPass(CinematicGradeShader);
      copy.uniforms.uGrain.value = 0;
      copy.uniforms.uVignette.value = 0;
      copy.uniforms.uAberration.value = 0;
      copy.renderToScreen = renderToScreen;
      this.gradePass = copy;
      this.composer.addPass(copy);
    }
  }

  /**
   * The texture holding the most recently rendered frame. Valid only when the
   * chain does not present directly to the screen.
   * @returns {import('three').Texture}
   */
  get outputTexture() {
    return this.composer.readBuffer.texture;
  }

  /**
   * Global fade multiplier applied after grading, used for cinematic cuts.
   * @param {number} value 0 = black, 1 = full image.
   */
  setFade(value) {
    if (this.gradePass) this.gradePass.uniforms.uFade.value = value;
  }

  /**
   * Updates the animated grain seed.
   * @param {number} time Absolute time in seconds.
   */
  setTime(time) {
    if (this.gradePass) this.gradePass.uniforms.uTime.value = time;
  }

  /**
   * Adjusts bloom characteristics at runtime — the story dials this up during
   * the AI reasoning sequence and back down for the calm title cards.
   * @param {object} params Bloom parameters.
   * @param {number} [params.strength] Bloom strength.
   * @param {number} [params.radius] Bloom radius.
   * @param {number} [params.threshold] Luminance threshold.
   */
  setBloom({ strength, radius, threshold }) {
    if (strength !== undefined) this.bloomPass.strength = strength;
    if (radius !== undefined) this.bloomPass.radius = radius;
    if (threshold !== undefined) this.bloomPass.threshold = threshold;
  }

  /**
   * Resizes every buffer in the chain.
   * @param {number} width New width in pixels.
   * @param {number} height New height in pixels.
   */
  setSize(width, height) {
    this.width = Math.max(2, Math.round(width));
    this.height = Math.max(2, Math.round(height));
    this.composer.setSize(this.width, this.height);
    this.bloomPass.setSize(this.width * this.bloomScale, this.height * this.bloomScale);
  }

  /** Renders one frame through the chain. */
  render() {
    this.composer.render();
  }

  /** Releases every GPU resource owned by the chain. */
  dispose() {
    this.composer.renderTarget1?.dispose();
    this.composer.renderTarget2?.dispose();
    this.bloomPass.dispose?.();
    this.gradePass?.dispose?.();
  }
}

/**
 * Quality presets. The renderer selects one based on measured performance so a
 * mid-range phone in a Cardboard viewer still holds a comfortable frame rate.
 * @type {Object<string, {bloomScale: number, strength: number, radius: number, threshold: number, samples: number}>}
 */
export const BloomPresets = {
  ultra:  { bloomScale: 0.6,  strength: 0.52, radius: 0.72, threshold: 0.82, samples: 4 },
  high:   { bloomScale: 0.5,  strength: 0.46, radius: 0.68, threshold: 0.84, samples: 4 },
  medium: { bloomScale: 0.4,  strength: 0.40, radius: 0.62, threshold: 0.86, samples: 2 },
  low:    { bloomScale: 0.3,  strength: 0.34, radius: 0.58, threshold: 0.88, samples: 0 },
};
