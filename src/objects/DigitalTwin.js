/**
 * @file DigitalTwin.js
 * @description The digital-twin alignment sequence.
 *
 * This is the moment the audience is told, without a word, that the machine and
 * its model are the same object. Eight corner brackets fly in from beyond the
 * engine and converge on its bounding volume; a wireframe skin resolves out of
 * the fog; a registration read-out counts up through its confidence steps and
 * finally reads **LOCKED**.
 *
 * The alignment percentage is not decorative. It drives the wireframe's spatial
 * offset in {@link AircraftEngine}'s overlay shader, so the twin visibly hunts
 * for its fit and then snaps home — the misalignment resolving *is* the
 * animation.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTexture, createCanvas, MONO_FONT, trackedText, UI_FONT } from '../engine/TextureFactory.js';
import { Glow } from '../effects/Glow.js';
import { clamp, damp, lerp, saturate } from '../engine/Utils.js';

/** Registration confidence steps the read-out counts through. */
export const LOCK_STEPS = [24, 53, 81, 96, 100];

/**
 * Alignment brackets and registration read-out for the digital twin.
 * @class
 */
export class DigitalTwin {
  /**
   * @param {object} [options] Configuration.
   * @param {Vector3} [options.size] Half-extents of the volume to bracket.
   * @param {Vector3} [options.centre] Centre of the volume, in local space.
   * @param {number|string} [options.color] Bracket colour.
   */
  constructor(options = {}) {
    const {
      size = new Vector3(2.15, 2.15, 2.95),
      centre = new Vector3(0, 0, -0.2),
      color = 0x6fd2ff,
    } = options;

    /** @type {Group} Scene graph node. */
    this.group = new Group();
    this.group.name = 'DigitalTwinAlignment';
    this.group.visible = false;

    /** @type {Vector3} */
    this.size = size.clone();
    /** @type {Vector3} */
    this.centre = centre.clone();

    /** @type {number} Alignment progress, 0–1. */
    this.progress = 0;
    /** @type {number} Progress the twin eases toward. */
    this.targetProgress = 0;
    /** @type {number} Master opacity. */
    this.opacity = 0;
    /** @type {number} Opacity the twin eases toward. */
    this.targetOpacity = 0;
    /** @type {boolean} Whether registration has completed. */
    this.locked = false;

    /** @type {number} Percentage currently displayed. */
    this.displayPercent = 0;
    /** @type {number} Read-out opacity relative to the rig, 0–1. */
    this.readoutScale = 1;

    this.#createBrackets(color);
    this.#createReadout();
  }

  /**
   * Builds the eight corner brackets. One L-shaped corner is generated and
   * mirrored across all three axes, so the whole cage is eight copies of a
   * single merged geometry.
   * @param {number|string} color Bracket colour.
   * @private
   */
  #createBrackets(color) {
    const arm = 0.62;
    const thickness = 0.035;

    const parts = [
      new BoxGeometry(arm, thickness, thickness),
      new BoxGeometry(thickness, arm, thickness),
      new BoxGeometry(thickness, thickness, arm),
    ];
    parts[0].translate(arm / 2, 0, 0);
    parts[1].translate(0, arm / 2, 0);
    parts[2].translate(0, 0, arm / 2);

    /** @type {import('three').BufferGeometry} */
    this.bracketGeometry = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());

    /** @type {MeshBasicMaterial} */
    this.bracketMaterial = new MeshBasicMaterial({
      color: new Color(color),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });

    /** @type {Array<{mesh: Mesh, sign: Vector3}>} */
    this.brackets = [];

    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const mesh = new Mesh(this.bracketGeometry, this.bracketMaterial);
          mesh.scale.set(-sx, -sy, -sz);
          mesh.renderOrder = 14;
          this.group.add(mesh);
          this.brackets.push({ mesh, sign: new Vector3(sx, sy, sz) });
        }
      }
    }

    // A faint registration cage drawn between the brackets once they are close.
    /** @type {ShaderMaterial} */
    this.cageMaterial = Glow.register(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(color) },
        uOpacity: { value: 0 },
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
        varying vec2 vUv;
        void main() {
          // Only the outer 3% of each face is drawn, producing a wire cage.
          vec2 d = min(vUv, 1.0 - vUv);
          float edge = 1.0 - smoothstep(0.0, 0.012, min(d.x, d.y));
          float ticks = step(0.7, fract((vUv.x + vUv.y) * 26.0 - uTime * 0.5)) * 0.5;
          float a = edge * (0.5 + ticks) * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * a * 1.6, a);
        }
      `,
    }));

    const faceGeo = new PlaneGeometry(1, 1);
    /** @type {PlaneGeometry} */
    this._faceGeometry = faceGeo;
    /** @type {Mesh[]} */
    this.cageFaces = [];

    const faces = [
      { pos: [0, 0, 1], rot: [0, 0, 0], dim: [0, 1] },
      { pos: [0, 0, -1], rot: [0, Math.PI, 0], dim: [0, 1] },
      { pos: [1, 0, 0], rot: [0, Math.PI / 2, 0], dim: [2, 1] },
      { pos: [-1, 0, 0], rot: [0, -Math.PI / 2, 0], dim: [2, 1] },
      { pos: [0, 1, 0], rot: [-Math.PI / 2, 0, 0], dim: [0, 2] },
      { pos: [0, -1, 0], rot: [Math.PI / 2, 0, 0], dim: [0, 2] },
    ];

    for (const face of faces) {
      const mesh = new Mesh(faceGeo, this.cageMaterial);
      mesh.userData.face = face;
      mesh.renderOrder = 13;
      this.group.add(mesh);
      this.cageFaces.push(mesh);
    }
  }

  /**
   * Builds the registration read-out that floats beneath the engine.
   * @private
   */
  #createReadout() {
    const surface = createCanvas(768, 288);
    /** @type {HTMLCanvasElement} */
    this.readoutCanvas = surface.canvas;
    /** @type {CanvasRenderingContext2D} */
    this.readoutCtx = surface.ctx;
    /** @type {import('three').Texture} */
    this.readoutTexture = canvasTexture(this.readoutCanvas);

    /** @type {ShaderMaterial} */
    this.readoutMaterial = Glow.register(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: this.readoutTexture },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          float a = tex.a * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(tex.rgb * a * 1.5, a);
        }
      `,
    }));

    /** @type {Mesh} */
    this.readout = new Mesh(new PlaneGeometry(1.6, 0.6), this.readoutMaterial);
    // Forward of the inlet lip and below the axis, so the stand never masks it.
    this.readout.position.set(0, -1.75, 3.5);
    this.readout.renderOrder = 15;
    this.group.add(this.readout);

    this.#paintReadout();
  }

  /**
   * Repaints the registration read-out.
   * @private
   */
  #paintReadout() {
    const ctx = this.readoutCtx;
    const W = this.readoutCanvas.width;
    const H = this.readoutCanvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(150,190,225,0.8)';
    ctx.font = `500 34px ${MONO_FONT}`;
    trackedText(ctx, 'DIGITAL TWIN REGISTRATION', W / 2, 52, 6, 'center');

    if (this.locked) {
      ctx.fillStyle = '#4ce6a6';
      ctx.shadowColor = '#4ce6a6';
      ctx.shadowBlur = 46;
      ctx.font = `300 132px ${UI_FONT}`;
      trackedText(ctx, 'LOCKED', W / 2, 176, 14, 'center');
      ctx.shadowBlur = 0;

      ctx.fillStyle = 'rgba(120,220,180,0.75)';
      ctx.font = `500 26px ${MONO_FONT}`;
      trackedText(ctx, 'GEOMETRY MATCH  ·  4 812 FEATURES', W / 2, 236, 3, 'center');
    } else {
      const percent = Math.round(this.displayPercent);
      ctx.fillStyle = '#dceaf8';
      ctx.shadowColor = '#7ad9ff';
      ctx.shadowBlur = 38;
      ctx.font = `200 132px ${UI_FONT}`;
      trackedText(ctx, `${percent}%`, W / 2, 176, 8, 'center');
      ctx.shadowBlur = 0;

      // Progress track.
      const trackW = W * 0.66;
      const trackX = (W - trackW) / 2;
      ctx.fillStyle = 'rgba(110,190,240,0.18)';
      ctx.fillRect(trackX, 214, trackW, 6);
      ctx.fillStyle = '#7ad9ff';
      ctx.shadowColor = '#7ad9ff';
      ctx.shadowBlur = 20;
      ctx.fillRect(trackX, 214, trackW * (percent / 100), 6);
      ctx.shadowBlur = 0;

      ctx.fillStyle = 'rgba(140,180,215,0.65)';
      ctx.font = `500 24px ${MONO_FONT}`;
      trackedText(ctx, 'MATCHING FEATURE CLOUD', W / 2, 262, 3, 'center');
    }

    this.readoutTexture.needsUpdate = true;
  }

  /* ------------------------------------------------------------ transport */

  /**
   * Fades the alignment rig in or out.
   * @param {number} value Opacity, 0–1.
   * @param {number} [readout] Opacity of the registration read-out relative to
   *   the rig. The read-out is a chapter-four instrument: once registration has
   *   locked, the brackets stay as a faint reference but the large percentage
   *   panel would only compete with the narration.
   */
  setOpacity(value, readout = 1) {
    this.targetOpacity = saturate(value);
    this.readoutScale = saturate(readout);
    if (this.targetOpacity > 0) this.group.visible = true;
  }

  /**
   * Sets the alignment progress the rig eases toward.
   * @param {number} value Progress, 0–1.
   */
  setProgress(value) {
    this.targetProgress = saturate(value);
    if (this.targetProgress < 1) this.locked = false;
  }

  /**
   * Snaps registration to complete and switches the read-out to `LOCKED`.
   */
  lock() {
    this.targetProgress = 1;
    this.locked = true;
    this.displayPercent = 100;
    this.#paintReadout();
  }

  /** Resets the rig to its unregistered state. */
  reset() {
    this.locked = false;
    this.progress = 0;
    this.targetProgress = 0;
    this.displayPercent = 0;
    this.#paintReadout();
  }

  /* --------------------------------------------------------------- update */

  /**
   * Advances bracket convergence and the read-out.
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   */
  update(dt, time) {
    this.opacity = damp(this.opacity, this.targetOpacity, 2.4, dt);
    this.progress = damp(this.progress, this.targetProgress, 1.5, dt);

    this.group.visible = this.opacity > 0.004;
    if (!this.group.visible) return;

    this.bracketMaterial.opacity = this.opacity;
    this.cageMaterial.uniforms.uOpacity.value =
      this.opacity * clamp((this.progress - 0.45) / 0.4, 0, 1) * 0.8;
    this.readoutMaterial.uniforms.uOpacity.value = this.opacity * (this.readoutScale ?? 1);

    // Brackets fly in from 2.4× the target volume down to a snug fit, with a
    // slight overshoot so the lock lands with authority.
    const eased = this.progress;
    const overshoot = eased > 0.92 ? 1 - (eased - 0.92) * 0.9 : 1;
    const spread = lerp(2.5, 1.0, eased) * overshoot;

    // A residual search jitter that vanishes as confidence rises.
    const jitter = (1 - eased) * 0.06;

    for (const { mesh, sign } of this.brackets) {
      mesh.position.set(
        this.centre.x + sign.x * this.size.x * spread + Math.sin(time * 7 + sign.y) * jitter,
        this.centre.y + sign.y * this.size.y * spread + Math.cos(time * 6 + sign.z) * jitter,
        this.centre.z + sign.z * this.size.z * spread + Math.sin(time * 5 + sign.x) * jitter,
      );
    }

    for (const mesh of this.cageFaces) {
      const { pos, rot } = mesh.userData.face;
      mesh.position.set(
        this.centre.x + pos[0] * this.size.x,
        this.centre.y + pos[1] * this.size.y,
        this.centre.z + pos[2] * this.size.z,
      );
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      // Each face is sized from the two axes it spans.
      const sx = pos[0] !== 0 ? this.size.z * 2 : this.size.x * 2;
      const sy = pos[1] !== 0 ? this.size.z * 2 : this.size.y * 2;
      mesh.scale.set(sx, sy, 1);
    }

    // Read-out counts through the confidence steps rather than sliding
    // continuously — measurement is discrete, and stepping reads as rigour.
    if (!this.locked) {
      const targetPercent = this.#stepPercent(this.progress);
      if (Math.abs(targetPercent - this.displayPercent) > 0.4) {
        this.displayPercent = damp(this.displayPercent, targetPercent, 9, dt);
        this.#paintReadout();
      }
    }
  }

  /**
   * Quantises continuous progress onto the registration confidence steps.
   * @param {number} progress Continuous progress, 0–1.
   * @returns {number} The percentage to display.
   * @private
   */
  #stepPercent(progress) {
    const index = Math.min(
      LOCK_STEPS.length - 1,
      Math.floor(progress * LOCK_STEPS.length),
    );
    return LOCK_STEPS[index];
  }

  /** Releases GPU resources. */
  dispose() {
    this.bracketGeometry.dispose();
    this.bracketMaterial.dispose();
    this._faceGeometry.dispose();
    Glow.unregister(this.cageMaterial);
    this.cageMaterial.dispose();
    this.readout.geometry.dispose();
    Glow.unregister(this.readoutMaterial);
    this.readoutMaterial.dispose();
    this.readoutTexture.dispose();
  }
}
