/**
 * @file ParticleSystem.js
 * @description Airborne dust and work sparks.
 *
 * Both systems are simulated entirely on the GPU. The CPU never touches a
 * particle position: each point carries a seed and a birth time, and the vertex
 * shader derives where it is from the current clock. That means twelve thousand
 * dust motes cost one draw call and essentially no JavaScript, which matters
 * enormously when every frame is rendered twice for stereo.
 *
 * Dust does more than decorate. It is the medium that makes the volumetric
 * light shafts legible, and it gives the eye thousands of small parallax
 * references at close range — one of the strongest depth cues available in a
 * stereoscopic scene.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { Glow } from '../effects/Glow.js';
import { createRandom, damp, saturate } from '../engine/Utils.js';

/**
 * A volume of slowly drifting dust motes.
 * @class
 */
export class DustField {
  /**
   * @param {object} options Configuration.
   * @param {import('three').Texture} options.sprite Point sprite texture.
   * @param {number} [options.count] Number of motes.
   * @param {Vector3} [options.size] Volume dimensions in metres.
   * @param {Vector3} [options.centre] Volume centre.
   * @param {number|string} [options.color] Mote colour.
   * @param {number} [options.seed] RNG seed.
   * @param {number} [options.maxSize] Ceiling on point size in pixels. A point
   *   sprite costs its own area in fill rate, so a handful of large motes near
   *   the eye is far more expensive than a great many small ones — capping the
   *   size is worth more on a mobile GPU than reducing the count.
   */
  constructor(options) {
    const {
      sprite,
      count = 4200,
      size = new Vector3(46, 14, 52),
      centre = new Vector3(0, 7, 0),
      color = 0xbcd8f5,
      seed = 0x51f3a2,
      maxSize = 64,
    } = options;

    const random = createRandom(seed);

    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const scales = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (random() - 0.5) * size.x;
      positions[i * 3 + 1] = (random() - 0.5) * size.y;
      positions[i * 3 + 2] = (random() - 0.5) * size.z;
      seeds[i] = random() * 1000;
      // A heavy bias toward small motes; a few large ones catch the light and
      // read as the specks you actually notice in a shaft of light.
      scales[i] = 0.35 + Math.pow(random(), 3.2) * 2.6;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.setAttribute('aScale', new BufferAttribute(scales, 1));
    geometry.boundingSphere = null;

    /** @type {ShaderMaterial} */
    this.material = Glow.register(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uSprite: { value: sprite },
        uColor: { value: new Color(color) },
        uOpacity: { value: 0 },
        uSize: { value: size.clone() },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uMaxSize: { value: maxSize },
        /** Extra turbulence, raised when something disturbs the air. */
        uAgitation: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        attribute float aScale;

        uniform float uTime;
        uniform vec3  uSize;
        uniform float uPixelRatio;
        uniform float uMaxSize;
        uniform float uAgitation;

        varying float vFade;

        void main() {
          vec3 p = position;

          // Convection: a slow rise with lateral wander, unique per mote.
          float t = uTime * 0.06 + aSeed;
          p.x += sin(t * 1.7 + aSeed) * (0.9 + uAgitation * 2.2);
          p.z += cos(t * 1.3 + aSeed * 0.7) * (0.9 + uAgitation * 2.2);
          p.y += mod(uTime * (0.05 + fract(aSeed) * 0.09) + aSeed, uSize.y);

          // Wrap inside the volume so the field never empties out.
          p.y = mod(p.y + uSize.y * 0.5, uSize.y) - uSize.y * 0.5;

          vec4 world = modelMatrix * vec4(p, 1.0);
          vec4 view = viewMatrix * world;

          // Fade motes that come very close to the eye; a mote filling the
          // frame is a distraction, and in stereo it is uncomfortable.
          float dist = -view.z;
          vFade = smoothstep(0.35, 1.6, dist) * (1.0 - smoothstep(28.0, 44.0, dist));

          gl_Position = projectionMatrix * view;
          gl_PointSize = min(aScale * uPixelRatio * (14.0 / max(dist, 0.1)), uMaxSize);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSprite;
        uniform vec3  uColor;
        uniform float uOpacity;
        varying float vFade;

        void main() {
          vec4 sprite = texture2D(uSprite, gl_PointCoord);
          float a = sprite.a * vFade * uOpacity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    }));

    /** @type {Points} */
    this.points = new Points(geometry, this.material);
    this.points.name = 'DustField';
    this.points.position.copy(centre);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;

    /** @type {number} Opacity the field eases toward. */
    this.targetOpacity = 0;
    /** @type {number} Agitation the field eases toward. */
    this.targetAgitation = 0;
  }

  /**
   * Fades the dust in or out.
   * @param {number} value Opacity, 0–1.
   */
  setOpacity(value) {
    this.targetOpacity = saturate(value);
  }

  /**
   * Disturbs the air — used when the fan spools or a panel materialises.
   * @param {number} value Agitation, 0–1.
   */
  setAgitation(value) {
    this.targetAgitation = saturate(value);
  }

  /**
   * Advances the fade envelopes. Motion itself is computed on the GPU.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    const u = this.material.uniforms;
    u.uOpacity.value = damp(u.uOpacity.value, this.targetOpacity, 1.4, dt);
    u.uAgitation.value = damp(u.uAgitation.value, this.targetAgitation, 1.0, dt);
    this.points.visible = u.uOpacity.value > 0.003;
  }

  /** Releases GPU resources. */
  dispose() {
    this.points.geometry.dispose();
    Glow.unregister(this.material);
    this.material.dispose();
  }
}

/**
 * A pooled burst emitter for work sparks and holographic particle effects.
 *
 * Particles are recycled from a fixed pool. Each carries an origin, a velocity
 * and a birth time; the shader integrates ballistic motion from those, so an
 * emission costs only a handful of attribute writes.
 * @class
 */
export class SparkBurst {
  /**
   * @param {object} options Configuration.
   * @param {import('three').Texture} options.sprite Point sprite texture.
   * @param {number} [options.count] Pool size.
   * @param {number|string} [options.color] Spark colour.
   * @param {number} [options.life] Particle lifetime in seconds.
   * @param {number} [options.gravity] Downward acceleration in m/s².
   */
  constructor(options) {
    const {
      sprite,
      count = 320,
      color = 0xffb45a,
      life = 1.15,
      gravity = 7.5,
    } = options;

    /** @type {number} Pool size. */
    this.count = count;
    /** @type {number} Next slot to overwrite. */
    this.cursor = 0;
    /** @type {number} Shared clock, advanced by {@link update}. */
    this.time = 0;

    const origins = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const births = new Float32Array(count).fill(-1000);
    const scales = new Float32Array(count).fill(1);

    const geometry = new BufferGeometry();
    // `position` is required by three even though the shader ignores it.
    geometry.setAttribute('position', new BufferAttribute(origins, 3));
    geometry.setAttribute('aVelocity', new BufferAttribute(velocities, 3));
    geometry.setAttribute('aBirth', new BufferAttribute(births, 1));
    geometry.setAttribute('aScale', new BufferAttribute(scales, 1));
    geometry.boundingSphere = null;

    /** @type {BufferAttribute} */
    this.originAttr = geometry.getAttribute('position');
    /** @type {BufferAttribute} */
    this.velocityAttr = geometry.getAttribute('aVelocity');
    /** @type {BufferAttribute} */
    this.birthAttr = geometry.getAttribute('aBirth');
    /** @type {BufferAttribute} */
    this.scaleAttr = geometry.getAttribute('aScale');

    // Deliberately *not* registered with the shared Glow clock: this system
    // owns its own `uTime`, because particle birth times are recorded against
    // it and must not be rewritten by the global clock.
    /** @type {ShaderMaterial} */
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uSprite: { value: sprite },
        uColor: { value: new Color(color) },
        uLife: { value: life },
        uGravity: { value: gravity },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: /* glsl */ `
        attribute vec3  aVelocity;
        attribute float aBirth;
        attribute float aScale;

        uniform float uTime;
        uniform float uLife;
        uniform float uGravity;
        uniform float uPixelRatio;

        varying float vLife;

        void main() {
          float age = uTime - aBirth;
          vLife = 1.0 - clamp(age / uLife, 0.0, 1.0);

          if (age < 0.0 || age > uLife) {
            // Park dead particles behind the camera and give them no size.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            return;
          }

          // Ballistic integration with light air drag.
          float drag = 1.0 - 0.35 * clamp(age / uLife, 0.0, 1.0);
          vec3 p = position + aVelocity * age * drag;
          p.y -= 0.5 * uGravity * age * age;

          vec4 view = viewMatrix * modelMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = aScale * uPixelRatio * vLife * (26.0 / max(-view.z, 0.1));
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSprite;
        uniform vec3 uColor;
        varying float vLife;

        void main() {
          vec4 sprite = texture2D(uSprite, gl_PointCoord);
          // Sparks cool as they fall: white hot, then amber, then out.
          vec3 col = mix(uColor, vec3(1.0, 0.98, 0.9), pow(vLife, 3.0));
          float a = sprite.a * vLife * vLife;
          if (a < 0.004) discard;
          gl_FragColor = vec4(col * a * 2.4, a);
        }
      `,
    });

    /** @type {Points} */
    this.points = new Points(geometry, this.material);
    this.points.name = 'SparkBurst';
    this.points.frustumCulled = false;
    this.points.renderOrder = 16;
  }

  /**
   * Emits a burst.
   * @param {Vector3} origin World-space emission point.
   * @param {object} [options] Burst shape.
   * @param {number} [options.count] Particles to emit.
   * @param {number} [options.speed] Base ejection speed in m/s.
   * @param {number} [options.spread] Cone half-angle scale, 0–1.
   * @param {Vector3} [options.direction] Preferred ejection direction.
   * @param {number} [options.scale] Size multiplier.
   */
  emit(origin, options = {}) {
    const {
      count = 26,
      speed = 2.6,
      spread = 1,
      direction = null,
      scale = 1,
    } = options;

    for (let i = 0; i < count; i++) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;

      this.originAttr.setXYZ(index, origin.x, origin.y, origin.z);

      // Random direction on a sphere, then biased toward `direction`.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      let vx = Math.sin(phi) * Math.cos(theta);
      let vy = Math.cos(phi);
      let vz = Math.sin(phi) * Math.sin(theta);

      if (direction) {
        vx = vx * spread + direction.x;
        vy = vy * spread + direction.y;
        vz = vz * spread + direction.z;
      }

      const magnitude = speed * (0.5 + Math.random());
      this.velocityAttr.setXYZ(index, vx * magnitude, vy * magnitude, vz * magnitude);
      this.birthAttr.setX(index, this.time);
      this.scaleAttr.setX(index, scale * (0.6 + Math.random() * 0.9));
    }

    this.originAttr.needsUpdate = true;
    this.velocityAttr.needsUpdate = true;
    this.birthAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
  }

  /**
   * Advances the shared clock.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
  }

  /** Releases GPU resources. */
  dispose() {
    this.points.geometry.dispose();
    Glow.unregister(this.material);
    this.material.dispose();
  }
}
