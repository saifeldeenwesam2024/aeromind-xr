/**
 * @file HUD.js
 * @description The mixed-reality glasses interface.
 *
 * This is the layer that puts the viewer *inside* the equipment rather than in
 * front of a screen. It is built from real geometry parented to the camera rig,
 * never from DOM elements — which is what allows it to exist correctly in
 * stereo, where a DOM overlay would appear once across both eyes and destroy
 * the illusion instantly.
 *
 * Two details do most of the work:
 *
 *   • **Spring lag.** The HUD does not rigidly follow the head. It eases toward
 *     the head's orientation over about 90 ms, so a quick glance leaves the
 *     interface trailing for a moment before it settles. Every good MR headset
 *     does this; without it, head-locked content feels glued to your eyeballs.
 *
 *   • **A comfortable focal distance.** Everything sits 1.4 m out. Head-locked
 *     content much closer than a metre forces the eyes to converge harder than
 *     they can comfortably sustain, and is the usual reason cheap VR demos give
 *     people headaches.
 *
 * The narration strip carries the story's dialogue. The brief calls for the
 * experience to be understood without a spoken word, so the AI states what it
 * is doing, in the viewer's line of sight, at every step.
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  NormalBlending,
  Group,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
} from 'three';
import {
  canvasTexture, createCanvas, MONO_FONT, roundRect, trackedText, UI_FONT, wrapText,
} from '../engine/TextureFactory.js';
import { Glow } from '../effects/Glow.js';
import { clamp, damp, pad, saturate } from '../engine/Utils.js';

/** Distance from the eyes at which head-locked content is placed, in metres. */
const HUD_DISTANCE = 1.4;

/**
 * The head-locked mixed-reality interface.
 * @class
 */
export class HUD {
  constructor() {
    /** @type {Group} Root, parented to the camera rig. */
    this.group = new Group();
    this.group.name = 'HUD';
    this.group.renderOrder = 40;

    /** @type {Quaternion} Lagging orientation. */
    this.smoothed = new Quaternion();
    /** @type {number} Orientation convergence rate. */
    this.lagLambda = 11;

    /** @type {number} Master opacity, 0–1. */
    this.opacity = 0;
    /** @type {number} Opacity the HUD eases toward. */
    this.targetOpacity = 0;
    /** @type {number} Boot progress, 0–1. */
    this.boot = 0;
    /** @type {number} Boot progress the HUD eases toward. */
    this.targetBoot = 0;

    /** @type {number} Internal clock. */
    this.time = 0;

    /** @type {?import('../engine/CameraRig.js').CameraRig} */
    this.rig = null;

    /** @type {Set<import('three').Material>} */
    this._materials = new Set();

    this.#createReticle();
    this.#createFrame();
    this.#createStatusBar();
    this.#createNarration();
    this.#createToast();

    this.group.visible = false;
  }

  /**
   * Parents the HUD to a camera rig.
   * @param {import('../engine/CameraRig.js').CameraRig} rig Camera rig.
   */
  attach(rig) {
    this.rig = rig;
    rig.rig.add(this.group);
  }

  /* ------------------------------------------------------------ elements */

  /**
   * The gaze reticle: a static ring, a centre dot and a dwell arc that fills
   * while the viewer holds their gaze on something interactive.
   * @private
   */
  #createReticle() {
    /** @type {ShaderMaterial} */
    this.reticleMaterial = this.#track(Glow.register(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(0x7ad9ff) },
        uOpacity: { value: 1 },
        /** Dwell fill, 0–1. */
        uDwell: { value: 0 },
        /** 1 when the reticle is over an interactive target. */
        uActive: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3  uColor;
        uniform float uOpacity;
        uniform float uDwell;
        uniform float uActive;
        varying vec2 vUv;

        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          float angle = fract(atan(p.y, p.x) / 6.2831853 + 0.25);

          // Centre dot.
          float dot_ = smoothstep(0.14, 0.06, r);

          // Static ring, thickening when a target is acquired.
          float ringR = 0.62;
          float thickness = 0.035 + uActive * 0.02;
          float ring = smoothstep(thickness, 0.0, abs(r - ringR)) * (0.35 + uActive * 0.45);

          // Dwell arc sweeping clockwise from the top.
          float arc = step(angle, uDwell) *
                      smoothstep(0.055, 0.0, abs(r - ringR)) * 1.6;

          // Four tick marks at the cardinal points.
          float ticks = step(0.96, abs(sin(angle * 12.566))) *
                        smoothstep(0.09, 0.0, abs(r - 0.82)) * 0.5;

          float a = (dot_ + ring + arc + ticks) * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * a * 1.6, a);
        }
      `,
    })));

    /** @type {Mesh} */
    this.reticle = new Mesh(new PlaneGeometry(0.062, 0.062), this.reticleMaterial);
    this.reticle.position.set(0, 0, -HUD_DISTANCE);
    this.reticle.renderOrder = 46;
    this.group.add(this.reticle);
  }

  /**
   * Corner brackets marking the glasses' field of view.
   * @private
   */
  #createFrame() {
    const { canvas, ctx } = createCanvas(1024, 576);
    const inset = 40;
    const arm = 96;

    ctx.strokeStyle = 'rgba(122,217,255,0.55)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'square';

    /**
     * Draws one corner bracket.
     * @param {number} x Corner X.
     * @param {number} y Corner Y.
     * @param {number} sx Horizontal direction.
     * @param {number} sy Vertical direction.
     */
    const corner = (x, y, sx, sy) => {
      ctx.beginPath();
      ctx.moveTo(x + sx * arm, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * arm);
      ctx.stroke();
    };

    corner(inset, inset, 1, 1);
    corner(1024 - inset, inset, -1, 1);
    corner(inset, 576 - inset, 1, -1);
    corner(1024 - inset, 576 - inset, -1, -1);

    // Edge tick scale along the top, like a viewfinder.
    ctx.strokeStyle = 'rgba(122,217,255,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 21; i++) {
      const x = 220 + i * 29;
      const h = i % 5 === 0 ? 16 : 8;
      ctx.beginPath();
      ctx.moveTo(x, inset);
      ctx.lineTo(x, inset + h);
      ctx.stroke();
    }

    /** @type {import('three').Texture} */
    this.frameTexture = canvasTexture(canvas);
    /** @type {ShaderMaterial} */
    this.frameMaterial = this.#track(this.#createOverlayMaterial(this.frameTexture, 1.0));

    /** @type {Mesh} */
    this.frame = new Mesh(new PlaneGeometry(1.42, 0.80), this.frameMaterial);
    this.frame.position.set(0, 0, -HUD_DISTANCE);
    this.frame.renderOrder = 41;
    this.group.add(this.frame);
  }

  /**
   * A material for a texture-driven HUD element.
   *
   * Most of the interface is additive, which is what makes it read as light
   * projected onto the world. The narration strip is the exception: additive
   * text vanishes against a bright background, and the narration is the one
   * element that must stay readable at every moment because it carries the
   * story. It composites normally over a dark plate instead.
   *
   * @param {import('three').Texture} map Content texture.
   * @param {number} intensity Brightness multiplier.
   * @param {boolean} [legible] Composite normally rather than additively.
   * @returns {ShaderMaterial}
   * @private
   */
  #createOverlayMaterial(map, intensity, legible = false) {
    return Glow.register(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: legible ? NormalBlending : AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: map },
        uOpacity: { value: 1 },
        uIntensity: { value: intensity },
        /** Horizontal wipe used by the boot animation. */
        uBoot: { value: 1 },
        /** 1 when the element composites normally over a dark plate. */
        uLegible: { value: legible ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform sampler2D uMap;
        uniform float uOpacity;
        uniform float uIntensity;
        uniform float uBoot;
        uniform float uLegible;
        varying vec2 vUv;

        void main() {
          vec4 tex = texture2D(uMap, vUv);
          if (tex.a < 0.003) discard;

          // Boot wipe: content resolves outward from the centre line. The
          // threshold sweeps from just past the far edge (nothing revealed) to
          // past the near edge (everything revealed), so a booted interface is
          // fully opaque rather than merely mostly there.
          float centreness = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float reveal = smoothstep(1.0 - uBoot * 1.25, 1.15 - uBoot * 1.25, centreness);

          // Interlace shimmer, strongest during boot.
          float scan = 0.94 + 0.06 * sin(vUv.y * 620.0 - uTime * 14.0);
          float glitch = mix(0.55 + 0.45 * step(0.35, fract(vUv.y * 40.0 + uTime * 9.0)), 1.0, uBoot);

          float a = tex.a * uOpacity * reveal;
          vec3 col = tex.rgb * uIntensity * scan * glitch;

          // Additive output is premultiplied; normal blending is not.
          gl_FragColor = uLegible > 0.5 ? vec4(col, a) : vec4(col * a, a);
        }
      `,
    }));
  }

  /**
   * Registers a material for disposal.
   * @template {import('three').Material} T
   * @param {T} material Material.
   * @returns {T}
   * @private
   */
  #track(material) {
    this._materials.add(material);
    return material;
  }

  /**
   * The system status strip across the top of the field of view.
   * @private
   */
  #createStatusBar() {
    const surface = createCanvas(1400, 120);
    /** @type {HTMLCanvasElement} */
    this.statusCanvas = surface.canvas;
    /** @type {CanvasRenderingContext2D} */
    this.statusCtx = surface.ctx;
    /** @type {import('three').Texture} */
    this.statusTexture = canvasTexture(this.statusCanvas);
    /** @type {ShaderMaterial} */
    this.statusMaterial = this.#track(this.#createOverlayMaterial(this.statusTexture, 1.0));

    /** @type {Mesh} */
    this.statusBar = new Mesh(new PlaneGeometry(1.12, 0.096), this.statusMaterial);
    this.statusBar.position.set(0, 0.345, -HUD_DISTANCE);
    this.statusBar.renderOrder = 42;
    this.group.add(this.statusBar);

    /** @type {{system: string, mode: string, link: string, fps: number}} */
    this.status = { system: 'AEROMIND OS 4.2', mode: 'STANDBY', link: 'SYNCED', fps: 60 };
    this.#paintStatus();
  }

  /**
   * The narration strip, low in the field of view.
   * @private
   */
  #createNarration() {
    const surface = createCanvas(1400, 220);
    /** @type {HTMLCanvasElement} */
    this.narrationCanvas = surface.canvas;
    /** @type {CanvasRenderingContext2D} */
    this.narrationCtx = surface.ctx;
    /** @type {import('three').Texture} */
    this.narrationTexture = canvasTexture(this.narrationCanvas);
    /** @type {ShaderMaterial} */
    this.narrationMaterial = this.#track(this.#createOverlayMaterial(this.narrationTexture, 1.0, true));

    /** @type {Mesh} */
    // Placed 8.5° below the eye line rather than 13°.
    //
    // This strip is the only thing in the experience that *speaks*, so it has to
    // sit where the viewer is already looking. A Cardboard lens vignettes and
    // smears badly toward the edge of its circle, and 13° down put the text into
    // exactly that region — legible on a flat screen, hard to read in a viewer.
    // Just under 9° keeps it in the clear centre of the lens while still leaving
    // the engine itself unobstructed.
    this.narrationBar = new Mesh(new PlaneGeometry(1.30, 0.205), this.narrationMaterial);
    this.narrationBar.position.set(0, -0.209, -HUD_DISTANCE);
    this.narrationBar.renderOrder = 43;
    this.group.add(this.narrationBar);

    /** @type {string} Current narration line. */
    this.narrationText = '';
    /** @type {string} Speaker label. */
    this.narrationSpeaker = 'AEROMIND';
    /** @type {number} Characters revealed so far. */
    this._narrationChars = 0;
    this.#paintNarration();
  }

  /**
   * The notification toast, which slides in above the narration strip.
   * @private
   */
  #createToast() {
    const surface = createCanvas(900, 150);
    /** @type {HTMLCanvasElement} */
    this.toastCanvas = surface.canvas;
    /** @type {CanvasRenderingContext2D} */
    this.toastCtx = surface.ctx;
    /** @type {import('three').Texture} */
    this.toastTexture = canvasTexture(this.toastCanvas);
    /** @type {ShaderMaterial} */
    this.toastMaterial = this.#track(this.#createOverlayMaterial(this.toastTexture, 1.0));

    /** @type {Mesh} */
    this.toast = new Mesh(new PlaneGeometry(0.68, 0.113), this.toastMaterial);
    this.toast.position.set(0, 0.215, -HUD_DISTANCE * 0.98);
    this.toast.renderOrder = 44;
    this.toast.visible = false;
    this.group.add(this.toast);

    /** @type {number} Seconds the toast remains visible. */
    this._toastTimer = 0;
    /** @type {number} Toast opacity. */
    this._toastAlpha = 0;
  }

  /* ------------------------------------------------------------- painting */

  /**
   * Repaints the status strip.
   * @private
   */
  #paintStatus() {
    const ctx = this.statusCtx;
    const W = this.statusCanvas.width;
    const H = this.statusCanvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#7ad9ff';
    ctx.font = `600 40px ${MONO_FONT}`;
    trackedText(ctx, this.status.system, 12, 60, 5, 'left');

    // Health pips.
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < 4 ? 'rgba(122,217,255,0.85)' : 'rgba(122,217,255,0.25)';
      ctx.fillRect(470 + i * 16, 34, 8, 26);
    }

    ctx.fillStyle = 'rgba(150,195,235,0.8)';
    ctx.font = `600 38px ${MONO_FONT}`;
    trackedText(ctx, this.status.mode, W / 2, 58, 5, 'center');

    ctx.fillStyle = 'rgba(122,217,255,0.75)';
    ctx.font = `500 32px ${MONO_FONT}`;
    trackedText(ctx, `${this.status.link}  ·  ${pad(this.status.fps, 2)} FPS`, W - 12, 58, 4, 'right');

    // Underline.
    ctx.fillStyle = 'rgba(122,217,255,0.28)';
    ctx.fillRect(12, 84, W - 24, 2);

    this.statusTexture.needsUpdate = true;
  }

  /**
   * Repaints the narration strip.
   * @private
   */
  #paintNarration() {
    const ctx = this.narrationCtx;
    const W = this.narrationCanvas.width;
    const H = this.narrationCanvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!this.narrationText) {
      this.narrationTexture.needsUpdate = true;
      return;
    }

    // Dark plate. Subtitles have to survive being read against a white-hot
    // engine, so the strip carries its own background rather than relying on
    // whatever happens to be behind it.
    ctx.fillStyle = 'rgba(5, 12, 22, 0.66)';
    roundRect(ctx, 40, 62, W - 80, H - 74, 26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(122,217,255,0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Speaker chip.
    ctx.font = `600 30px ${MONO_FONT}`;
    let chipW = 0;
    for (const c of this.narrationSpeaker) chipW += ctx.measureText(c).width + 4;
    chipW += 34;

    ctx.strokeStyle = 'rgba(122,217,255,0.5)';
    ctx.fillStyle = 'rgba(30,90,140,0.35)';
    ctx.lineWidth = 2;
    roundRect(ctx, W / 2 - chipW / 2, 6, chipW, 46, 23);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#7ad9ff';
    trackedText(ctx, this.narrationSpeaker, W / 2, 39, 4, 'center');

    // Body copy, revealed progressively.
    ctx.font = `500 58px ${UI_FONT}`;
    const shown = this.narrationText.slice(0, Math.floor(this._narrationChars));
    const lines = wrapText(ctx, shown, W - 150);

    ctx.fillStyle = 'rgba(226,240,252,0.97)';
    ctx.textAlign = 'center';
    lines.slice(-2).forEach((line, i) => {
      ctx.fillText(line, W / 2, 126 + i * 66);
    });
    ctx.textAlign = 'left';

    this.narrationTexture.needsUpdate = true;
  }

  /**
   * Repaints the toast.
   * @param {string} text Message.
   * @param {'info'|'warn'|'fault'|'ok'} level Severity.
   * @private
   */
  #paintToast(text, level) {
    const ctx = this.toastCtx;
    const W = this.toastCanvas.width;
    const H = this.toastCanvas.height;
    ctx.clearRect(0, 0, W, H);

    const color = level === 'fault' ? '#ff5f68' : level === 'warn' ? '#ffb44a'
      : level === 'ok' ? '#4ce6a6' : '#7ad9ff';

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    roundRect(ctx, 6, 6, W - 12, H - 12, 22);
    ctx.stroke();

    // Severity flash on the leading edge.
    ctx.fillStyle = color;
    roundRect(ctx, 6, 6, 12, H - 12, 6);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.font = `600 46px ${MONO_FONT}`;
    trackedText(ctx, text.toUpperCase(), W / 2, H / 2 + 16, 5, 'center');

    this.toastTexture.needsUpdate = true;
  }

  /* -------------------------------------------------------------- control */

  /**
   * Scales the interface so it occupies the same fraction of the field of view
   * regardless of the camera's field of view.
   *
   * The layout is authored for the flat preview's 58° vertical field. A viewer
   * headset runs much wider, and without this compensation the interface would
   * shrink into a small island in the middle of the lenses.
   * @param {number} fovDegrees Vertical field of view in degrees.
   */
  setFieldScale(fovDegrees) {
    // The reference is wider than the flat preview's own field, which shrinks
    // the interface to roughly 80% of the frame and leaves the scene room to
    // breathe behind it.
    const reference = Math.tan((70 * Math.PI) / 360);
    const actual = Math.tan((clamp(fovDegrees, 20, 120) * Math.PI) / 360);
    this.group.scale.setScalar(actual / reference);
  }

  /**
   * Fades the whole interface in or out.
   * @param {number} value Opacity, 0–1.
   */
  setOpacity(value) {
    this.targetOpacity = saturate(value);
    if (this.targetOpacity > 0) this.group.visible = true;
  }

  /**
   * Runs the glasses boot animation.
   * @param {boolean} on Whether the glasses are powering up.
   */
  setBoot(on) {
    this.targetBoot = on ? 1 : 0;
  }

  /**
   * Updates the status strip.
   * @param {object} fields Fields to change.
   * @param {string} [fields.system] System name.
   * @param {string} [fields.mode] Current operating mode.
   * @param {string} [fields.link] Link state.
   * @param {number} [fields.fps] Measured frame rate.
   */
  setStatus(fields) {
    let changed = false;
    for (const key of ['system', 'mode', 'link', 'fps']) {
      if (fields[key] !== undefined && fields[key] !== this.status[key]) {
        this.status[key] = fields[key];
        changed = true;
      }
    }
    if (changed) this.#paintStatus();
  }

  /**
   * Sets the narration line. The text types itself in.
   * @param {string} text Line to display; empty clears the strip.
   * @param {string} [speaker] Speaker label.
   */
  say(text, speaker = 'AEROMIND') {
    if (this.narrationText === text && this.narrationSpeaker === speaker) return;
    this.narrationText = text;
    this.narrationSpeaker = speaker;
    this._narrationChars = 0;
    this.#paintNarration();
  }

  /** Clears the narration strip. */
  clearNarration() {
    this.say('');
  }

  /**
   * Shows a notification toast.
   * @param {string} text Message.
   * @param {'info'|'warn'|'fault'|'ok'} [level] Severity.
   * @param {number} [duration] Seconds to remain visible.
   */
  notify(text, level = 'info', duration = 3.2) {
    this.#paintToast(text, level);
    this._toastTimer = duration;
    this.toast.visible = true;
  }

  /**
   * Updates the gaze reticle.
   * @param {number} dwell Dwell progress, 0–1.
   * @param {boolean} active Whether an interactive target is acquired.
   */
  setGaze(dwell, active) {
    this.reticleMaterial.uniforms.uDwell.value = clamp(dwell, 0, 1);
    this.reticleMaterial.uniforms.uActive.value = active ? 1 : 0;
  }

  /* --------------------------------------------------------------- update */

  /**
   * Advances the HUD.
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   */
  update(dt, time) {
    this.time = time;

    this.opacity = damp(this.opacity, this.targetOpacity, 2.6, dt);
    this.boot = damp(this.boot, this.targetBoot, 1.9, dt);

    this.group.visible = this.opacity > 0.004;
    if (!this.group.visible) return;

    // Spring lag toward the head's orientation.
    if (this.rig) {
      this.smoothed.slerp(this.rig.head.quaternion, 1 - Math.exp(-this.lagLambda * dt));
      this.group.quaternion.copy(this.smoothed);
    }

    for (const material of this._materials) {
      if (material.uniforms?.uOpacity) material.uniforms.uOpacity.value = this.opacity;
      if (material.uniforms?.uBoot) material.uniforms.uBoot.value = this.boot;
    }
    // The reticle is not part of the boot wipe; it appears with the frame.
    this.reticleMaterial.uniforms.uOpacity.value = this.opacity * this.boot;

    // Narration typewriter.
    if (this.narrationText && this._narrationChars < this.narrationText.length) {
      this._narrationChars = Math.min(
        this.narrationText.length, this._narrationChars + dt * 42,
      );
      this.#paintNarration();
    }

    // Toast lifetime and slide.
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      this._toastAlpha = damp(this._toastAlpha, 1, 6, dt);
    } else {
      this._toastAlpha = damp(this._toastAlpha, 0, 5, dt);
      if (this._toastAlpha < 0.01) this.toast.visible = false;
    }
    this.toastMaterial.uniforms.uOpacity.value = this.opacity * this._toastAlpha;
    this.toast.position.y = 0.215 - (1 - this._toastAlpha) * 0.04;
  }

  /** Releases GPU resources. */
  dispose() {
    for (const material of this._materials) {
      Glow.unregister(material);
      material.dispose();
    }
    this._materials.clear();
    this.frameTexture.dispose();
    this.statusTexture.dispose();
    this.narrationTexture.dispose();
    this.toastTexture.dispose();
    this.reticle.geometry.dispose();
    this.frame.geometry.dispose();
    this.statusBar.geometry.dispose();
    this.narrationBar.geometry.dispose();
    this.toast.geometry.dispose();
  }
}

/** Exported so other head-locked surfaces can share the focal distance. */
export { HUD_DISTANCE };
