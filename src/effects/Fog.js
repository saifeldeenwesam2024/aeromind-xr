/**
 * @file Fog.js
 * @description Atmospheric depth for the hangar.
 *
 * Three layers combine to sell a large, dark, dusty volume:
 *   1. Exponential distance fog, which hides the far wall and separates depth.
 *   2. Ground haze — a stack of very soft, slowly rotating planes near the
 *      floor that catch the practical lights.
 *   3. Light shafts, contributed by {@link LightRig} through this system.
 *
 * The fog is animated by the story: it is heaviest during the reveal and thins
 * out as the AI takes control, which reads as clarity replacing uncertainty.
 */

import {
  AdditiveBlending,
  Color,
  FogExp2,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import { damp } from '../engine/Utils.js';
import { Glow } from './Glow.js';

/**
 * Manages scene fog and the ground haze layers.
 * @class
 */
export class FogSystem {
  /**
   * @param {import('three').Scene} scene Scene to attach fog to.
   * @param {object} [options] Configuration.
   * @param {number|string} [options.color] Fog colour.
   * @param {number} [options.density] Initial exponential density.
   * @param {number} [options.layers] Number of ground haze planes.
   * @param {number} [options.radius] Radius of the haze planes.
   * @param {number} [options.height] Height the haze stack occupies.
   */
  constructor(scene, options = {}) {
    const {
      color = 0x0a1523,
      density = 0.021,
      layers = 7,
      radius = 34,
      height = 7,
    } = options;

    /** @type {import('three').Scene} */
    this.scene = scene;
    /** @type {FogExp2} */
    this.fog = new FogExp2(new Color(color).getHex(), density);
    scene.fog = this.fog;

    /** @type {number} Density the system eases toward. */
    this.targetDensity = density;
    /** @type {number} Ground haze opacity the system eases toward. */
    this.targetHaze = 1.0;
    /** @type {number} Current ground haze opacity. */
    this.haze = 1.0;

    /** @type {Group} Container for the haze planes. */
    this.group = new Group();
    this.group.name = 'GroundHaze';
    this.group.renderOrder = 5;
    scene.add(this.group);

    /** @type {ShaderMaterial[]} */
    this.materials = [];

    const geometry = new PlaneGeometry(radius * 2, radius * 2, 1, 1);

    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1);
      const material = this.#createHazeMaterial(color, t);
      const mesh = new Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.35 + t * height;
      mesh.rotation.z = t * 2.1;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.materials.push(material);
    }
  }

  /**
   * Builds one soft haze plane. Each layer gets a different noise phase and
   * scale so the stack never shows visible repetition.
   * @param {number|string} color Base colour.
   * @param {number} t Normalised height of this layer, 0 = floor.
   * @returns {ShaderMaterial}
   * @private
   */
  #createHazeMaterial(color, t) {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(color).multiplyScalar(3.2) },
        uOpacity: { value: (0.09 - t * 0.055) },
        uScale: { value: 1.4 + t * 2.3 },
        uPhase: { value: t * 37.1 },
        uGlobal: { value: 1.0 },
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
        uniform float uScale;
        uniform float uPhase;
        uniform float uGlobal;
        varying vec2 vUv;

        /** Two octaves of cheap sine-based turbulence — plenty at this softness. */
        float turbulence(vec2 p) {
          float a = sin(p.x * 1.7 + uPhase) * cos(p.y * 1.3 - uPhase * 0.7);
          float b = sin(p.x * 3.9 - uPhase * 0.4) * cos(p.y * 4.4 + uPhase * 0.2);
          return a * 0.6 + b * 0.4;
        }

        void main() {
          vec2 p = (vUv - 0.5) * uScale;
          float drift = uTime * 0.028;
          float n = turbulence(p * 3.0 + vec2(drift, -drift * 0.6));
          n = n * 0.5 + 0.5;

          // Radial fade keeps the plane's square silhouette invisible.
          float radial = 1.0 - smoothstep(0.18, 0.5, length(vUv - 0.5));

          float a = n * radial * uOpacity * uGlobal;
          if (a < 0.002) discard;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });

    Glow.register(material);
    return material;
  }

  /**
   * Sets the distance-fog density the system eases toward.
   * @param {number} density Target exponential density.
   */
  setDensity(density) {
    this.targetDensity = density;
  }

  /**
   * Sets the ground haze opacity multiplier the system eases toward.
   * @param {number} value 0 = clear air, 1 = full haze.
   */
  setHaze(value) {
    this.targetHaze = value;
  }

  /**
   * Immediately snaps fog to the given values, skipping easing.
   * @param {number} density Fog density.
   * @param {number} haze Haze opacity.
   */
  snap(density, haze) {
    this.targetDensity = this.fog.density = density;
    this.targetHaze = this.haze = haze;
    for (const m of this.materials) m.uniforms.uGlobal.value = haze;
  }

  /**
   * Advances fog animation.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    this.fog.density = damp(this.fog.density, this.targetDensity, 1.1, dt);
    this.haze = damp(this.haze, this.targetHaze, 1.4, dt);
    for (const m of this.materials) m.uniforms.uGlobal.value = this.haze;
  }

  /** Releases GPU resources. */
  dispose() {
    for (const m of this.materials) { Glow.unregister(m); m.dispose(); }
    this.group.children[0]?.geometry.dispose();
    this.scene.remove(this.group);
    this.scene.fog = null;
  }
}
