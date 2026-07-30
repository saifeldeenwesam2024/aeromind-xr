/**
 * @file AssetManager.js
 * @description Central asset registry, loader and lifecycle owner.
 *
 * AeroMind XR authors its world procedurally. Textures are painted with the
 * Canvas 2D API, the environment map is baked at runtime from a synthetic
 * lighting room, and every mesh is generated from parametric geometry. The
 * result is a demo that starts instantly, weighs almost nothing, and runs with
 * no network connection at all — which matters when a competition venue's
 * Wi-Fi is saturated.
 *
 * Loaders for external content (glTF, Draco-compressed meshes, HDR
 * environments) are fully wired so the same scene can be dressed with studio
 * assets by dropping files into `src/assets/`. When those files are absent the
 * procedural equivalents are used and the experience is unaffected.
 */

import {
  EquirectangularReflectionMapping,
  PMREMGenerator,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  createBrushedMetal,
  createHangarFloor,
  createSoftSprite,
  createStreakSprite,
  createThermalRamp,
} from './TextureFactory.js';

/**
 * Paths to optional external assets. Every one of these is a graceful
 * enhancement: if the file is missing, a procedural stand-in is used instead.
 * @type {{hdri: string, engineModel: string, dracoDecoder: string}}
 */
export const OptionalAssets = {
  hdri: './src/assets/hdri/hangar.hdr',
  engineModel: './src/assets/models/turbofan.glb',
  dracoDecoder: './vendor/three/addons/libs/draco/gltf/',
};

/**
 * Loads, generates and owns every shared resource in the experience.
 * @class
 */
export class AssetManager {
  /**
   * @param {import('three').WebGLRenderer} renderer Renderer used to bake the
   *   environment map. Must be created before assets are requested.
   */
  constructor(renderer) {
    /** @type {import('three').WebGLRenderer} */
    this.renderer = renderer;
    /** @type {Map<string, *>} Named resource registry. */
    this.registry = new Map();
    /** @type {function(number, string): void} Progress observer. */
    this.onProgress = () => {};
    /** @type {boolean} */
    this.ready = false;
  }

  /**
   * Retrieves a previously registered resource.
   * @param {string} name Resource key.
   * @returns {*} The resource, or `undefined` if absent.
   */
  get(name) {
    return this.registry.get(name);
  }

  /**
   * Registers a resource under a key.
   * @param {string} name Resource key.
   * @param {*} value Resource value.
   * @returns {*} The stored value.
   */
  set(name, value) {
    this.registry.set(name, value);
    return value;
  }

  /**
   * Builds every shared resource, reporting progress as it goes.
   *
   * Generation is broken into discrete steps separated by a yield to the event
   * loop. That keeps the loading screen's animation perfectly smooth instead of
   * freezing on a single long synchronous block — the first thing a judge sees
   * should never stutter.
   *
   * @param {function(number, string): void} [onProgress] Receives normalised
   *   progress (0–1) and a human-readable status line.
   * @returns {Promise<AssetManager>} Resolves once every resource is ready.
   */
  async load(onProgress = () => {}) {
    this.onProgress = onProgress;

    /** @type {Array<[string, function(): void|Promise<void>]>} */
    const steps = [
      ['Calibrating optics', () => this.#buildSprites()],
      ['Generating alloy surfaces', () => this.#buildMetals()],
      ['Pouring hangar floor', () => this.#buildFloor()],
      ['Baking thermal response', () => this.#buildRamps()],
      ['Resolving light probes', () => this.#buildEnvironment()],
      ['Linking external assets', () => this.#loadOptional()],
    ];

    for (let i = 0; i < steps.length; i++) {
      const [label, task] = steps[i];
      this.onProgress(i / steps.length, label);
      // Yield twice: once to let the DOM paint the new status, once to let the
      // browser run its animation frame before the next heavy step.
      await nextFrame();
      await task();
      await nextFrame();
    }

    this.onProgress(1, 'Systems nominal');
    this.ready = true;
    return this;
  }

  /**
   * Point sprites for dust, sparks and lens glints.
   * @private
   */
  #buildSprites() {
    this.set('sprite.dust', createSoftSprite(96, 0.12));
    this.set('sprite.glow', createSoftSprite(128, 0.3));
    this.set('sprite.spark', createSoftSprite(64, 0.6));
    this.set('sprite.streak', createStreakSprite(256, 64));
  }

  /**
   * Brushed-metal map sets for the engine and the hangar structure.
   * @private
   */
  #buildMetals() {
    const cowling = createBrushedMetal({ size: 512, base: '#8a939f', streaks: 1100 });
    this.set('metal.cowling.map', cowling.map);
    this.set('metal.cowling.roughness', cowling.roughnessMap);

    const structure = createBrushedMetal({ size: 256, base: '#4a525d', streaks: 420 });
    this.set('metal.structure.map', structure.map);
    this.set('metal.structure.roughness', structure.roughnessMap);

    const blade = createBrushedMetal({ size: 256, base: '#9aa4b2', streaks: 700 });
    this.set('metal.blade.map', blade.map);
    this.set('metal.blade.roughness', blade.roughnessMap);
  }

  /**
   * Hangar floor maps, tiled across the slab.
   * @private
   */
  #buildFloor() {
    const floor = createHangarFloor(1024);
    floor.map.repeat.set(8, 10);
    floor.roughnessMap.repeat.set(8, 10);
    this.set('floor.map', floor.map);
    this.set('floor.roughness', floor.roughnessMap);
  }

  /**
   * Colour ramps sampled by the analytical overlays.
   * @private
   */
  #buildRamps() {
    this.set('ramp.thermal', createThermalRamp(256));
  }

  /**
   * Bakes the image-based lighting environment.
   *
   * `RoomEnvironment` is a synthetic set of emissive boxes; pre-filtering it
   * through `PMREMGenerator` produces a physically plausible probe with soft
   * area highlights. It is what gives the brushed metal its believable
   * anisotropic sheen without shipping a single megabyte of HDR data.
   * @private
   */
  #buildEnvironment() {
    const pmrem = new PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();

    const room = new RoomEnvironment();
    const envRT = pmrem.fromScene(room, 0.04);

    this.set('env.default', envRT.texture);
    this.set('env.renderTarget', envRT);

    room.dispose?.();
    pmrem.dispose();
  }

  /**
   * Attempts to load optional external assets. Failures are expected and
   * silent by design — the procedural pipeline is the primary path.
   * @returns {Promise<void>}
   * @private
   */
  async #loadOptional() {
    await Promise.all([this.#tryLoadHDRI(), this.#tryLoadEngineModel()]);
  }

  /**
   * Replaces the baked environment with a real HDR probe when one is present.
   * @returns {Promise<void>}
   * @private
   */
  async #tryLoadHDRI() {
    try {
      const loader = new RGBELoader();
      const texture = await loader.loadAsync(OptionalAssets.hdri);
      texture.mapping = EquirectangularReflectionMapping;

      const pmrem = new PMREMGenerator(this.renderer);
      const envRT = pmrem.fromEquirectangular(texture);
      this.get('env.renderTarget')?.dispose();
      this.set('env.default', envRT.texture);
      this.set('env.renderTarget', envRT);
      this.set('env.source', 'hdri');
      texture.dispose();
      pmrem.dispose();
    } catch {
      this.set('env.source', 'procedural');
    }
  }

  /**
   * Loads a studio turbofan model when one has been supplied. The procedural
   * engine remains the default; {@link AircraftEngine} checks this slot and
   * substitutes the loaded geometry if it is populated.
   * @returns {Promise<void>}
   * @private
   */
  async #tryLoadEngineModel() {
    try {
      const draco = new DRACOLoader();
      draco.setDecoderPath(OptionalAssets.dracoDecoder);
      draco.setDecoderConfig({ type: 'js' });

      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);

      const gltf = await loader.loadAsync(OptionalAssets.engineModel);
      this.set('model.turbofan', gltf.scene);
      draco.dispose();
    } catch {
      this.set('model.turbofan', null);
    }
  }

  /** Disposes every owned GPU resource. */
  dispose() {
    for (const value of this.registry.values()) {
      value?.dispose?.();
    }
    this.registry.clear();
    this.ready = false;
  }
}

/**
 * Resolves on the next animation frame, letting the browser paint.
 *
 * A timer races the animation frame because `requestAnimationFrame` does not
 * fire in a background tab — without the race, loading would stall forever if
 * the viewer switched away mid-load and never come back when they returned.
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
