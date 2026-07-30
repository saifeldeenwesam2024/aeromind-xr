/**
 * @file FloorGrid.js
 * @description The holographic survey grid projected onto the hangar floor.
 *
 * This is the first thing the AI draws when the glasses come online, and it
 * does real narrative work: a measured grid snapping into existence tells the
 * viewer that the machine has begun to understand the space. It is a single
 * shader-driven plane — no line geometry — so it costs one draw call and stays
 * crisp at every viewing angle thanks to screen-space derivative antialiasing.
 */

import {
  AdditiveBlending,
  Color,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import { Glow } from '../effects/Glow.js';
import { damp, saturate } from '../engine/Utils.js';

/**
 * Animated holographic floor grid with expanding scan rings.
 * @class
 */
export class FloorGrid {
  /**
   * @param {object} [options] Configuration.
   * @param {number} [options.size] Side length in metres.
   * @param {number} [options.cell] Minor cell size in metres.
   * @param {number} [options.section] Major cell size in metres.
   * @param {number|string} [options.color] Line colour.
   * @param {number} [options.radius] Visible radius in metres.
   */
  constructor(options = {}) {
    const {
      size = 90,
      cell = 1,
      section = 5,
      color = 0x4fc3ff,
      radius = 26,
    } = options;

    /** @type {ShaderMaterial} */
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(color) },
        uCell: { value: cell },
        uSection: { value: section },
        uRadius: { value: radius },
        uSize: { value: size },
        /** Radius, in metres, that the grid has expanded to. */
        uBuild: { value: 0 },
        /** Master opacity. */
        uOpacity: { value: 0 },
        /** Radius of the travelling scan ring; negative hides it. */
        uPulse: { value: -1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3  uColor;
        uniform float uCell;
        uniform float uSection;
        uniform float uRadius;
        uniform float uBuild;
        uniform float uOpacity;
        uniform float uPulse;

        varying vec2 vWorld;

        /**
         * Analytically antialiased grid: the derivative of the coordinate tells
         * us how many metres a pixel spans, so lines stay one pixel wide at any
         * distance instead of aliasing into moiré.
         */
        float gridLine(vec2 p, float spacing, float thickness) {
          vec2 coord = p / spacing;
          vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
          float line = min(grid.x, grid.y);
          return 1.0 - min(line / thickness, 1.0);
        }

        void main() {
          float dist = length(vWorld);

          // Build-out: the grid expands from the origin outward.
          float built = smoothstep(uBuild, uBuild - 3.0, dist);
          if (built <= 0.001) discard;

          float minor = gridLine(vWorld, uCell, 1.0) * 0.28;
          float major = gridLine(vWorld, uSection, 1.6) * 0.75;

          // Axis lines through the engine's centre, brighter than the rest.
          vec2 axis = abs(vWorld) / fwidth(vWorld);
          float axisLine = (1.0 - min(min(axis.x, axis.y) / 2.0, 1.0)) * 0.9;

          // Concentric range rings, slowly breathing.
          float ring = smoothstep(0.92, 1.0, sin(dist * 1.2566 - uTime * 0.4)) * 0.12;

          // Travelling measurement pulse.
          float pulse = uPulse >= 0.0
            ? smoothstep(0.9, 0.0, abs(dist - uPulse)) * 0.85
            : 0.0;

          float falloff = 1.0 - smoothstep(uRadius * 0.35, uRadius, dist);
          float intensity = (minor + major + axisLine + ring + pulse) * falloff * built;

          float a = intensity * uOpacity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * intensity * 1.4, a);
        }
      `,
    });

    Glow.register(this.material);

    /** @type {Mesh} */
    this.mesh = new Mesh(new PlaneGeometry(size, size, 1, 1), this.material);
    this.mesh.name = 'FloorGrid';
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.012; // Just above the slab, to avoid z-fighting.
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;

    /** @type {number} Opacity the grid eases toward. */
    this.targetOpacity = 0;
    /** @type {number} Build radius the grid eases toward. */
    this.targetBuild = 0;
    /** @type {number} Maximum build radius. */
    this.maxRadius = radius;
    /** @type {number} Seconds since the current pulse started; -1 when idle. */
    this._pulseTime = -1;
  }

  /**
   * Fades the grid in or out.
   * @param {number} value Target opacity, 0–1.
   */
  setOpacity(value) {
    this.targetOpacity = saturate(value);
  }

  /**
   * Sets how far the grid has expanded from the origin.
   * @param {number} value Normalised build radius, 0–1.
   */
  setBuild(value) {
    this.targetBuild = saturate(value) * this.maxRadius * 1.4;
  }

  /** Launches a single expanding measurement ring from the origin. */
  pulse() {
    this._pulseTime = 0;
  }

  /**
   * Advances animation.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    const u = this.material.uniforms;
    u.uOpacity.value = damp(u.uOpacity.value, this.targetOpacity, 2.2, dt);
    u.uBuild.value = damp(u.uBuild.value, this.targetBuild, 1.6, dt);

    if (this._pulseTime >= 0) {
      this._pulseTime += dt;
      const radius = this._pulseTime * 14;
      u.uPulse.value = radius > this.maxRadius * 1.5 ? -1 : radius;
      if (u.uPulse.value < 0) this._pulseTime = -1;
    }

    this.mesh.visible = u.uOpacity.value > 0.004;
  }

  /** Releases GPU resources. */
  dispose() {
    this.mesh.geometry.dispose();
    Glow.unregister(this.material);
    this.material.dispose();
  }
}
