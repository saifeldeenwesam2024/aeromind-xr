/**
 * @file LightRig.js
 * @description Cinematic lighting for the hangar.
 *
 * The lighting follows a film convention rather than an architectural one:
 * a cool key from high camera-left, a dim warm fill from the opposite side to
 * keep shadows from going dead, a hard rim from behind to separate the engine
 * from the darkness, and a set of practicals — the hangar's own ceiling
 * fixtures — that motivate everything else.
 *
 * Volumetric shafts hang beneath the practicals. They are geometry, not a
 * post-process, which means they behave correctly in stereo: each eye sees the
 * cone from its own position and the parallax reads as real volume.
 */

import {
  AmbientLight,
  ConeGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PointLight,
  SpotLight,
  Vector3,
} from 'three';
import { createLightShaftMaterial } from '../effects/Glow.js';
import { damp, noise1D } from '../engine/Utils.js';

/**
 * Owns every light in the scene plus their volumetric contributions.
 * @class
 */
export class LightRig {
  /**
   * @param {object} [options] Configuration.
   * @param {Vector3} [options.focus] World point the key light aims at.
   * @param {number} [options.shaftCount] Number of volumetric ceiling shafts.
   * @param {boolean} [options.shadows] Whether the key light casts shadows.
   * @param {number} [options.shadowMapSize] Shadow map resolution.
   */
  constructor(options = {}) {
    const {
      focus = new Vector3(0, 2.6, 0),
      shaftCount = 6,
      shadows = true,
      shadowMapSize = 1024,
    } = options;

    /** @type {Group} Scene graph node holding every light. */
    this.group = new Group();
    this.group.name = 'LightRig';

    /** @type {Vector3} */
    this.focus = focus.clone();

    /* ------------------------------------------------------------ ambient */

    /** @type {HemisphereLight} Sky/ground bounce. */
    this.hemi = new HemisphereLight(0x2a4a70, 0x0a0e14, 0.42);
    this.group.add(this.hemi);

    /** @type {AmbientLight} Floor of the exposure, keeps blacks from crushing. */
    this.ambient = new AmbientLight(0x14233a, 0.35);
    this.group.add(this.ambient);

    /* ---------------------------------------------------------------- key */

    /** @type {SpotLight} Primary shaping light. */
    this.key = new SpotLight(0xbfe0ff, 26, 42, Math.PI / 7, 0.45, 1.5);
    this.key.position.set(-7.5, 11.5, 8.5);
    this.key.target.position.copy(this.focus);
    this.key.castShadow = shadows;
    this.key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.key.shadow.camera.near = 2;
    this.key.shadow.camera.far = 34;
    this.key.shadow.bias = -0.0016;
    this.key.shadow.normalBias = 0.035;
    this.group.add(this.key, this.key.target);

    /* --------------------------------------------------------------- fill */

    /** @type {DirectionalLight} Cool wide fill from camera right. */
    this.fill = new DirectionalLight(0x5f86b8, 0.6);
    this.fill.position.set(9, 6, 7);
    this.group.add(this.fill);

    /* ---------------------------------------------------------------- rim */

    /** @type {SpotLight} Hard back-light separating the engine from the dark. */
    this.rim = new SpotLight(0x9fd4ff, 34, 40, Math.PI / 8, 0.6, 1.7);
    this.rim.position.set(5.5, 7.5, -13);
    this.rim.target.position.copy(this.focus);
    this.group.add(this.rim, this.rim.target);

    /** @type {PointLight} Warm bounce off the floor, sells the metal. */
    this.bounce = new PointLight(0xffb37a, 4, 13, 2);
    this.bounce.position.set(3.6, 0.6, 4.6);
    this.group.add(this.bounce);

    /** @type {PointLight} Holographic spill — brightens as the AI takes over. */
    this.holoSpill = new PointLight(0x4fc3ff, 0, 20, 2);
    this.holoSpill.position.set(0, 3.2, 2.4);
    this.group.add(this.holoSpill);

    /* --------------------------------------------------------- practicals */

    /** @type {Array<{light: PointLight, base: number, phase: number}>} */
    this.practicals = [];
    /** @type {Group} Volumetric shafts. */
    this.shafts = new Group();
    this.shafts.name = 'LightShafts';
    this.group.add(this.shafts);

    const shaftGeometry = new ConeGeometry(3.4, 11.5, 20, 1, true);
    /** @type {import('three').ShaderMaterial} */
    this.shaftMaterial = createLightShaftMaterial({
      color: 0x9ecfff,
      intensity: 0.0,
      falloff: 2.1,
    });

    for (let i = 0; i < shaftCount; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      const x = side * (7.5 + row * 1.2);
      const z = -12 + row * 12;

      const cone = new Mesh(shaftGeometry, this.shaftMaterial);
      // ConeGeometry points +Y; flip it so the apex sits at the fixture.
      cone.rotation.x = Math.PI;
      cone.position.set(x, 6.4, z);
      cone.renderOrder = 6;
      cone.frustumCulled = true;
      this.shafts.add(cone);

      const light = new PointLight(0xcfe6ff, 6, 24, 2);
      light.position.set(x, 11.6, z);
      this.group.add(light);
      this.practicals.push({ light, base: 9, phase: i * 12.7 });
    }

    /** @type {ConeGeometry} Retained for disposal. */
    this._shaftGeometry = shaftGeometry;

    /* ------------------------------------------------------------- targets */

    /** @type {object} Values the rig eases toward, set by the story. */
    this.target = {
      key: 0,
      fill: 0,
      rim: 0,
      ambient: 0.35,
      hemi: 0.42,
      practicals: 0,
      shafts: 0,
      bounce: 0,
      holoSpill: 0,
      env: 0,
    };

    /**
     * Global multiplier on image-based lighting.
     *
     * Every physically based surface in the hangar is lit partly by the
     * pre-filtered environment probe, and that contribution is completely
     * independent of the lights in this rig. Without a master control here, a
     * "lights out" preset would still leave the whole bay softly lit by the
     * probe — so the environment is dimmed alongside everything else, and the
     * opening really is black.
     * @type {number}
     */
    this.envScale = 0;

    /** @type {number} Internal clock for flicker. */
    this._time = 0;

    // Start in darkness: the experience opens on black.
    this.key.intensity = 0;
    this.fill.intensity = 0;
    this.rim.intensity = 0;
    this.bounce.intensity = 0;
    this.ambient.intensity = 0;
    this.hemi.intensity = 0;
    for (const p of this.practicals) p.light.intensity = 0;
  }

  /**
   * Applies a named lighting state. Each preset is a complete look, so the
   * story can call one line and get a coherent change across nine sources.
   * @param {'black'|'reveal'|'working'|'analysis'|'resolved'|'finale'} name Preset.
   */
  setPreset(name) {
    switch (name) {
      case 'black':
        Object.assign(this.target, {
          key: 0, fill: 0, rim: 0, ambient: 0, hemi: 0,
          practicals: 0, shafts: 0, bounce: 0, holoSpill: 0, env: 0,
        });
        break;

      // The hangar emerges: practicals first, then shape.
      case 'reveal':
        Object.assign(this.target, {
          key: 11, fill: 0.28, rim: 17, ambient: 0.22, hemi: 0.26,
          practicals: 4.6, shafts: 0.5, bounce: 2.0, holoSpill: 0, env: 0.5,
        });
        break;

      // Engineers at work under full hangar lighting.
      case 'working':
        Object.assign(this.target, {
          key: 19, fill: 0.44, rim: 24, ambient: 0.28, hemi: 0.34,
          practicals: 6.2, shafts: 0.36, bounce: 3.2, holoSpill: 0.6, env: 0.85,
        });
        break;

      // The AI dominates: practicals dim, holographic spill takes over.
      case 'analysis':
        Object.assign(this.target, {
          key: 13, fill: 0.3, rim: 26, ambient: 0.24, hemi: 0.28,
          practicals: 3.4, shafts: 0.28, bounce: 2.0, holoSpill: 4.5, env: 0.68,
        });
        break;

      // Everything green and clear — the fault is closed out.
      case 'resolved':
        Object.assign(this.target, {
          key: 21, fill: 0.5, rim: 28, ambient: 0.32, hemi: 0.38,
          practicals: 7.0, shafts: 0.42, bounce: 3.6, holoSpill: 2.6, env: 1.0,
        });
        break;

      // Title-card lighting: dark, with just enough rim to read silhouettes.
      case 'finale':
        Object.assign(this.target, {
          key: 4, fill: 0.14, rim: 12, ambient: 0.11, hemi: 0.15,
          practicals: 1.6, shafts: 0.5, bounce: 0.7, holoSpill: 1.3, env: 0.3,
        });
        break;

      default:
        break;
    }
  }

  /**
   * Tints the holographic spill light — used to turn the room amber when the
   * anomaly is found and green when it is resolved.
   * @param {number|string} color Colour value.
   */
  setHoloColor(color) {
    this.holoSpill.color = new Color(color);
  }

  /**
   * Advances easing and practical-light flicker.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    this._time += dt;
    const k = 1.1;

    this.key.intensity = damp(this.key.intensity, this.target.key, k, dt);
    this.fill.intensity = damp(this.fill.intensity, this.target.fill, k, dt);
    this.rim.intensity = damp(this.rim.intensity, this.target.rim, k, dt);
    this.bounce.intensity = damp(this.bounce.intensity, this.target.bounce, k, dt);
    this.ambient.intensity = damp(this.ambient.intensity, this.target.ambient, k, dt);
    this.hemi.intensity = damp(this.hemi.intensity, this.target.hemi, k, dt);
    this.holoSpill.intensity = damp(this.holoSpill.intensity, this.target.holoSpill, 1.6, dt);

    this.envScale = damp(this.envScale, this.target.env, k, dt);

    this.shaftMaterial.uniforms.uIntensity.value = damp(
      this.shaftMaterial.uniforms.uIntensity.value, this.target.shafts, 1.0, dt,
    );
    this.shafts.visible = this.shaftMaterial.uniforms.uIntensity.value > 0.004;

    // Industrial fixtures are never perfectly steady. A slow, per-fixture
    // flicker is one of those details nobody consciously notices but everybody
    // feels the absence of.
    for (const p of this.practicals) {
      const flicker = 1 + noise1D(this._time * 1.7 + p.phase) * 0.045;
      p.light.intensity = damp(p.light.intensity, this.target.practicals * flicker, 1.4, dt);
    }
  }

  /** Releases GPU resources. */
  dispose() {
    this._shaftGeometry.dispose();
    this.shaftMaterial.dispose();
  }
}
