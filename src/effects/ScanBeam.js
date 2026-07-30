/**
 * @file ScanBeam.js
 * @description The AI inspection sweep.
 *
 * A single travelling plane of light passes through the engine along its axis.
 * The beam itself is only half the effect: as it advances it publishes its
 * world-space position, and every surface that opts in (the digital twin
 * overlay, the fan blades, the nacelle) responds by igniting exactly where the
 * beam touches it. That coupling is what makes the scan feel like measurement
 * rather than decoration.
 */

import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
} from 'three';
import { clamp, lerp, saturate } from '../engine/Utils.js';
import { Glow } from './Glow.js';

/**
 * Travelling inspection beam with a leading edge, a bright core and a
 * dissipating wake.
 * @class
 */
export class ScanBeam {
  /**
   * @param {object} [options] Configuration.
   * @param {number} [options.width] Beam curtain width in metres.
   * @param {number} [options.height] Beam curtain height in metres.
   * @param {number|string} [options.color] Beam colour.
   * @param {number} [options.from] Start position along the sweep axis.
   * @param {number} [options.to] End position along the sweep axis.
   * @param {number} [options.thickness] Half-width of the illuminated band.
   */
  constructor(options = {}) {
    const {
      width = 9,
      height = 8,
      color = 0x6fe0ff,
      from = 3.4,
      to = -3.4,
      thickness = 0.22,
    } = options;

    /** @type {Group} Scene graph node for the beam. */
    this.group = new Group();
    this.group.name = 'ScanBeam';
    this.group.visible = false;

    /** @type {number} Sweep start coordinate (world Z). */
    this.from = from;
    /** @type {number} Sweep end coordinate (world Z). */
    this.to = to;
    /** @type {number} Half-width of the illuminated band, in metres. */
    this.thickness = thickness;
    /** @type {number} Normalised sweep progress, 0–1. */
    this.progress = 0;
    /** @type {number} Current world-space Z of the beam plane. */
    this.z = from;
    /** @type {number} Master intensity, faded in and out by the story. */
    this.intensity = 0;

    /** @type {ShaderMaterial} */
    this.curtainMaterial = this.#createCurtainMaterial(color);
    const curtain = new Mesh(new PlaneGeometry(width, height, 1, 1), this.curtainMaterial);
    curtain.frustumCulled = false;
    this.group.add(curtain);
    /** @type {Mesh} */
    this.curtain = curtain;

    /** @type {ShaderMaterial} */
    this.ringMaterial = this.#createRingMaterial(color);
    const ring = new Mesh(new RingGeometry(0.4, 2.9, 96, 1), this.ringMaterial);
    ring.frustumCulled = false;
    this.group.add(ring);
    /** @type {Mesh} */
    this.ring = ring;

    /**
     * Materials that track the beam. Each must expose `uScanZ`, `uScanWidth`
     * and `uScanEnergy` uniforms.
     * @type {Set<ShaderMaterial>}
     */
    this.subscribers = new Set();
  }

  /**
   * The bright vertical sheet of light.
   * @param {number|string} color Beam colour.
   * @returns {ShaderMaterial}
   * @private
   */
  #createCurtainMaterial(color) {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(color) },
        uIntensity: { value: 1 },
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
        uniform float uIntensity;
        varying vec2 vUv;

        void main() {
          // A soft elliptical falloff keeps the sheet from showing its edges.
          vec2 c = (vUv - 0.5) * vec2(1.0, 1.25);
          float radial = 1.0 - smoothstep(0.12, 0.5, length(c));

          // Horizontal scan striping travelling upward.
          float stripes = 0.6 + 0.4 * sin(vUv.y * 120.0 - uTime * 9.0);
          float band = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.65, vUv.y);

          float a = radial * (0.35 + band * 0.65) * stripes * uIntensity * 0.5;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * a * 1.6, a);
        }
      `,
    });
    return Glow.register(material);
  }

  /**
   * The leading measurement ring that expands and contracts with the nacelle.
   * @param {number|string} color Ring colour.
   * @returns {ShaderMaterial}
   * @private
   */
  #createRingMaterial(color) {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(color) },
        uIntensity: { value: 1 },
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
        uniform float uIntensity;
        varying vec2 vUv;

        void main() {
          // RingGeometry maps uv.y across the radial band.
          float edge = smoothstep(0.0, 0.14, vUv.y) * smoothstep(1.0, 0.86, vUv.y);
          float inner = smoothstep(0.28, 0.0, vUv.y) * 1.4;

          // Rotating measurement ticks around the circumference.
          float ticks = step(0.86, fract(vUv.x * 48.0 + uTime * 0.12));
          float a = (edge * 0.55 + inner * 0.5 + ticks * edge * 0.9) * uIntensity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * a * 1.8, a);
        }
      `,
    });
    return Glow.register(material);
  }

  /**
   * Registers a material that should ignite where the beam crosses it. The
   * material must declare `uScanZ`, `uScanWidth` and `uScanEnergy` uniforms.
   * @param {ShaderMaterial} material Subscriber material.
   */
  subscribe(material) {
    if (material?.uniforms?.uScanZ) this.subscribers.add(material);
  }

  /**
   * Stops driving a previously registered material.
   * @param {ShaderMaterial} material Subscriber material.
   */
  unsubscribe(material) {
    this.subscribers.delete(material);
  }

  /**
   * Positions the beam along its sweep.
   * @param {number} progress Normalised position, 0 = start, 1 = end.
   */
  setProgress(progress) {
    this.progress = saturate(progress);
    this.z = lerp(this.from, this.to, this.progress);
  }

  /**
   * Sets the master intensity. The beam hides itself entirely at zero so it
   * costs nothing when inactive.
   * @param {number} value Intensity multiplier, 0–1.
   */
  setIntensity(value) {
    this.intensity = clamp(value, 0, 1);
    this.group.visible = this.intensity > 0.001;
  }

  /**
   * Scales the leading ring — the story widens it over the fan and narrows it
   * over the exhaust cone so it hugs the engine silhouette.
   * @param {number} scale Uniform scale factor.
   */
  setRingScale(scale) {
    this.ring.scale.setScalar(scale);
  }

  /**
   * Advances the beam and pushes its state to every subscriber.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    this.group.position.z = this.z;
    this.curtainMaterial.uniforms.uIntensity.value = this.intensity;
    this.ringMaterial.uniforms.uIntensity.value = this.intensity;

    // A slow roll on the ring reads as an active instrument.
    this.ring.rotation.z += dt * 0.35;

    for (const m of this.subscribers) {
      m.uniforms.uScanZ.value = this.z;
      m.uniforms.uScanWidth.value = this.thickness;
      m.uniforms.uScanEnergy.value = this.intensity;
    }
  }

  /** Releases GPU resources. */
  dispose() {
    this.curtain.geometry.dispose();
    this.ring.geometry.dispose();
    Glow.unregister(this.curtainMaterial);
    Glow.unregister(this.ringMaterial);
    this.curtainMaterial.dispose();
    this.ringMaterial.dispose();
    this.subscribers.clear();
  }
}
