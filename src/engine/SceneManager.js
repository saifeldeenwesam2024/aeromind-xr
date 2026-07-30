/**
 * @file SceneManager.js
 * @description World composition and story direction.
 *
 * This module does two jobs that are deliberately kept together, because they
 * are two views of the same thing: it builds the world, and it directs what
 * that world does over 120 seconds.
 *
 * The story is authored as nine chapters registered on a {@link Timeline}.
 * Each chapter owns an `onEnter` hook for state changes that should happen
 * once, and an `onUpdate` hook that is a pure function of chapter-local time —
 * no accumulating state, no "has this happened yet" flags. That purity is what
 * makes the timeline scrubbable: a presenter can drag straight to the scan
 * sequence and everything is exactly where it should be, because every value is
 * derived from the clock rather than remembered.
 *
 * The narrative beats follow the brief:
 *   1. Title            2. Hangar reveal     3. Glasses online
 *   4. Digital twin     5. AI inspection     6. AI reasoning
 *   7. Guided repair    8. Business impact   9. Closing
 */

import { Mesh, PlaneGeometry, Scene, Vector3 } from 'three';

import { AircraftEngine, BLADE_COUNT, FAULT_BLADE } from '../objects/AircraftEngine.js';
import { CREW_UNIFORMS, Engineer, disposeEngineerGeometry } from '../objects/Engineer.js';
import { DigitalTwin } from '../objects/DigitalTwin.js';
import { FloorGrid } from '../objects/FloorGrid.js';
import { Hangar } from '../objects/Hangar.js';
import { Hologram, TitleCard } from '../objects/Hologram.js';
import { LightRig } from '../objects/LightRig.js';
import { Panel } from '../objects/Panel.js';
import { DustField, SparkBurst } from '../objects/ParticleSystem.js';
import { FogSystem } from '../effects/Fog.js';
import { Glow, createGroundGlowMaterial } from '../effects/Glow.js';
import { ScanBeam } from '../effects/ScanBeam.js';
import { Ease, clamp, damp, envelope, lerp, progress, saturate } from './Utils.js';

/** World position of the engine's centre. */
const ENGINE_CENTRE = new Vector3(0, 2.6, 0);
/** Where the viewer nominally stands; panels are aimed here. */
const STATION = new Vector3(0, 1.68, 7.4);

/** Chapter boundaries, in seconds. The total run time is 120 s. */
const CH = {
  title:      [0, 11],
  hangar:     [11, 24],
  glasses:    [24, 37],
  twin:       [37, 50],
  inspection: [50, 68],
  reasoning:  [68, 86],
  repair:     [86, 100],
  impact:     [100, 112],
  closing:    [112, 120],
};

/**
 * Builds the world and directs the story.
 * @class
 */
export class SceneManager {
  /**
   * @param {object} context Shared services.
   * @param {import('./AssetManager.js').AssetManager} context.assets Asset registry.
   * @param {import('./AudioEngine.js').AudioEngine} context.audio Audio director.
   * @param {import('../ui/HUD.js').HUD} context.hud Glasses interface.
   * @param {import('./CameraRig.js').CameraRig} context.rig Camera rig.
   */
  constructor({ assets, audio, hud, rig }) {
    /** @type {import('./AssetManager.js').AssetManager} */
    this.assets = assets;
    /** @type {import('./AudioEngine.js').AudioEngine} */
    this.audio = audio;
    /** @type {import('../ui/HUD.js').HUD} */
    this.hud = hud;
    /** @type {import('./CameraRig.js').CameraRig} */
    this.rig = rig;

    /** @type {Scene} */
    this.scene = new Scene();
    this.scene.name = 'AeroMindWorld';

    /** @type {number} Global fade multiplier the renderer applies. */
    this.fade = 0;
    /** @type {{strength: number, radius: number, threshold: number}} */
    this.bloom = { strength: 0.45, radius: 0.7, threshold: 0.8 };

    this.#buildEnvironment();
    this.#buildEngine();
    this.#buildCrew();
    this.#buildHolograms();
    this.#buildImpactBoard();
    this.#buildTitleCards();
    this.#collectLitMaterials();
    // The world starts dark and empty; chapter one re-applies this on entry.
    this.#applyBaseline({ hud: 0, boot: false });
  }

  /**
   * Indexes every image-based-lit material so the light rig can dim the
   * environment probe along with the lights.
   *
   * The probe's contribution is not a light in the scene graph, so a preset
   * that zeroes every lamp would otherwise leave the hangar softly but
   * stubbornly visible. Each material's authored `envMapIntensity` is kept as
   * its baseline and scaled by the rig's master value each frame.
   * @private
   */
  #collectLitMaterials() {
    /** @type {Array<{material: import('three').Material, base: number}>} */
    this.litMaterials = [];
    const seen = new Set();

    this.scene.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material || seen.has(material)) continue;
        if (material.envMap === undefined || material.envMapIntensity === undefined) continue;
        seen.add(material);
        this.litMaterials.push({ material, base: material.envMapIntensity });
        material.envMapIntensity = 0;
      }
    });
  }

  /* ===================================================================== */
  /* Construction                                                           */
  /* ===================================================================== */

  /**
   * Hangar shell, lighting, fog, dust and the holographic floor grid.
   * @private
   */
  #buildEnvironment() {
    /** @type {Hangar} */
    this.hangar = new Hangar(this.assets);
    this.scene.add(this.hangar.group);

    /** @type {LightRig} */
    this.lights = new LightRig({ focus: ENGINE_CENTRE, shaftCount: 6 });
    this.scene.add(this.lights.group);

    /** @type {FogSystem} */
    this.fog = new FogSystem(this.scene, {
      color: 0x0a1523, density: 0.03, layers: 7, radius: 34, height: 8,
    });
    this.fog.snap(0.03, 0);

    /** @type {DustField} */
    this.dust = new DustField({
      sprite: this.assets.get('sprite.dust'),
      count: 4200,
      size: new Vector3(44, 13, 50),
      centre: new Vector3(0, 6.6, 0),
    });
    this.scene.add(this.dust.points);

    /** @type {SparkBurst} */
    this.sparks = new SparkBurst({
      sprite: this.assets.get('sprite.spark'),
      count: 360,
      color: 0xffb45a,
    });
    this.scene.add(this.sparks.points);

    /** @type {FloorGrid} */
    this.grid = new FloorGrid({ size: 90, cell: 1, section: 5, radius: 24 });
    this.scene.add(this.grid.mesh);

    // A pool of holographic light on the slab beneath the engine. It anchors
    // the engine to the floor — without it, a dark object over a dark floor
    // reads as floating, and the whole sense of scale goes with it.
    /** @type {import('three').ShaderMaterial} */
    this.poolMaterial = createGroundGlowMaterial({
      color: 0x4fc3ff, intensity: 0.55, rings: 4,
    });
    /** @type {import('three').Mesh} */
    this.enginePool = new Mesh(new PlaneGeometry(11, 11), this.poolMaterial);
    this.enginePool.rotation.x = -Math.PI / 2;
    this.enginePool.position.set(ENGINE_CENTRE.x, 0.02, ENGINE_CENTRE.z);
    this.enginePool.renderOrder = 4;
    this.scene.add(this.enginePool);
  }

  /**
   * The turbofan, its analytical overlay, the alignment rig and the scan beam.
   * @private
   */
  #buildEngine() {
    /** @type {AircraftEngine} */
    this.engine = new AircraftEngine(this.assets);
    this.engine.group.position.copy(ENGINE_CENTRE);
    this.scene.add(this.engine.group);

    /** @type {DigitalTwin} */
    this.twin = new DigitalTwin({
      size: new Vector3(2.2, 2.2, 3.0),
      centre: new Vector3(0, 0, -0.15),
    });
    this.engine.group.add(this.twin.group);

    /** @type {ScanBeam} */
    this.scanBeam = new ScanBeam({
      width: 9, height: 8, from: 3.8, to: -3.8, thickness: 0.24,
    });
    this.scanBeam.group.position.set(ENGINE_CENTRE.x, ENGINE_CENTRE.y, 0);
    this.scene.add(this.scanBeam.group);
    this.engine.connectScanBeam(this.scanBeam);

    /** @type {Vector3} Scratch vector for the fault position. */
    this._faultPosition = new Vector3();
  }

  /**
   * The three engineers. Their roles are visually distinct so the choreography
   * reads instantly: one working, one reviewing data, one moving through.
   * @private
   */
  #buildCrew() {
    /** @type {Engineer} Engineer A — working at the fan case. */
    this.engineerA = new Engineer({
      ...CREW_UNIFORMS.lead, height: 1.79, seed: 1, pose: 'idle', glasses: true,
    }).placeAt(-2.05, 0, 1.55, 1.32);

    /** @type {Engineer} Engineer B — reviewing the tablet. */
    this.engineerB = new Engineer({
      ...CREW_UNIFORMS.technician, height: 1.71, seed: 2, pose: 'tablet',
      glasses: true, tablet: true,
    }).placeAt(2.35, 0, 2.9, -0.62);

    /** @type {Engineer} Engineer C — walking through the bay behind. */
    this.engineerC = new Engineer({
      ...CREW_UNIFORMS.inspector, height: 1.83, seed: 3, pose: 'idle', glasses: false,
    }).placeAt(-7.5, 0, -5.5, 0);

    /** @type {Engineer[]} */
    this.crew = [this.engineerA, this.engineerB, this.engineerC];
    for (const engineer of this.crew) this.scene.add(engineer.group);
  }

  /**
   * The eleven analysis panels, arranged on an arc around the engine.
   * @private
   */
  #buildHolograms() {
    /** @type {Hologram} */
    this.holograms = new Hologram({ anchor: ENGINE_CENTRE, station: STATION });
    this.scene.add(this.holograms.group);

    /**
     * Creates and places one panel.
     * @param {string} id Identifier.
     * @param {object} data Panel content.
     * @param {object} slot Arc placement.
     * @param {object} [size] Panel dimensions.
     * @returns {Panel}
     */
    const place = (id, data, slot, size = {}) => {
      const panel = new Panel({
        data,
        width: size.width ?? 1.12,
        height: size.height ?? 0.72,
        typewriter: size.typewriter ?? false,
      });
      return this.holograms.place(id, panel, slot);
    };

    /* ------------------------------------------------ upper row (6 + 1) */

    place('digitaltwin', {
      title: 'Digital Twin', badge: 'LOCKED', status: 'ok', kind: 'metrics',
      rows: [
        { label: 'Registration', value: 0, target: 100, unit: '%', decimals: 1, bar: 0, barTarget: 1, state: 'ok' },
        { label: 'Features matched', value: 0, target: 4812, bar: 0, barTarget: 0.97 },
        { label: 'Mean deviation', value: 0.9, target: 0.14, unit: ' mm', decimals: 2, bar: 0.6, barTarget: 0.08, state: 'ok' },
      ],
      footer: 'GT-7841 · rev 12',
    }, { angle: 0, radius: 5.0, height: 0.92, tilt: 0 }, { width: 1.24, height: 0.76 });

    place('life', {
      title: 'Remaining Life', badge: 'RUL', status: 'warn', kind: 'metrics',
      rows: [
        { label: 'Fan blade 07', value: 900, target: 118, unit: ' cyc', bar: 0.9, barTarget: 0.11, state: 'fault' },
        { label: 'Fan module', value: 6000, target: 4260, unit: ' cyc', bar: 0.9, barTarget: 0.62, state: 'ok' },
        { label: 'HP compressor', value: 9000, target: 7810, unit: ' cyc', bar: 0.95, barTarget: 0.83, state: 'ok' },
      ],
      footer: 'Prognostic model v9',
    }, { angle: -44, radius: 5.4, height: 3.34 });

    place('telemetry', {
      title: 'Live Telemetry', badge: 'STREAM', status: 'warn', kind: 'graph',
      series: [], rows: [
        { label: 'Vib N1', value: 0, target: 3.9, unit: ' IPS', decimals: 2, state: 'warn' },
        { label: 'EGT', value: 0, target: 706, unit: '°C', state: 'ok' },
        { label: 'N1', value: 0, target: 0, unit: '%', state: 'idle' },
      ],
      footer: 'ACARS · 4 Hz',
    }, { angle: -34, radius: 5.7, height: 2.30 }, { width: 1.26, height: 0.8 });

    place('health', {
      title: 'Engine Health', badge: 'INDEX', status: 'warn', kind: 'gauge',
      gauge: { value: 0.98, target: 0.62, label: 'Health Index', caption: 'Fan section degraded' },
      footer: 'Fleet percentile 12',
    }, { angle: -23, radius: 5.9, height: 3.40 }, { width: 1.08, height: 0.82 });

    place('confidence', {
      title: 'Confidence', badge: 'AI', status: 'ok', kind: 'gauge',
      gauge: { value: 0, target: 0.964, label: 'Diagnosis', caption: '3 independent models agree' },
      footer: 'Ensemble · 3 models',
    }, { angle: 23, radius: 5.9, height: 3.40 }, { width: 1.08, height: 0.82 });

    place('recommendation', {
      title: 'Recommendation', badge: 'ACTION', status: 'ok', kind: 'text',
      text: 'Replace fan blade 07 and its dynamic balance pair. Estimated 6 hours. '
          + 'Aircraft returns to service before the 14:20 rotation.',
      footer: 'Approved by AeroMind',
    }, { angle: 34, radius: 5.7, height: 2.30 }, { width: 1.26, height: 0.8, typewriter: true });

    place('checklist', {
      title: 'Repair Checklist', badge: '0 / 5', status: 'warn', kind: 'checklist',
      checklist: [
        { label: 'Isolate engine · safety tags', done: false },
        { label: 'Open fan cowl · access blade 07', done: false },
        { label: 'Remove blade 07 · log serial', done: false },
        { label: 'Install replacement · torque 84 Nm', done: false },
        { label: 'Dynamic balance · verify vibration', done: false },
      ],
      footer: 'AMM 72-31-11',
    }, { angle: 44, radius: 5.4, height: 3.34 }, { width: 1.2, height: 0.82 });

    /* ---------------------------------------------------- lower row (4) */

    place('fleet', {
      title: 'Fleet Status', badge: 'LIVE', status: 'ok', kind: 'stack',
      rows: [
        { label: 'A-3391  ·  in service', display: 'NOMINAL', state: 'ok' },
        { label: 'A-3392  ·  bay 04', display: 'IN WORK', state: 'warn' },
        { label: 'A-3407  ·  in service', display: 'NOMINAL', state: 'ok' },
        { label: 'A-3410  ·  watch item', display: 'MONITOR', state: 'warn' },
        { label: 'A-3415  ·  in service', display: 'NOMINAL', state: 'ok' },
      ],
      footer: '48 aircraft monitored',
    }, { angle: -47, radius: 5.2, height: 1.22 });

    place('history', {
      title: 'Maintenance History', badge: 'GT-7841', status: 'ok', kind: 'stack',
      rows: [
        { label: '2026-02-11  ·  borescope', display: 'PASS', state: 'ok' },
        { label: '2025-11-04  ·  fan balance', display: 'PASS', state: 'ok' },
        { label: '2025-06-22  ·  blade 07 FOD', display: 'BLEND', state: 'warn' },
        { label: '2024-12-18  ·  overhaul', display: 'PASS', state: 'ok' },
      ],
      footer: '11 240 cycles total',
    }, { angle: -29, radius: 5.8, height: 1.10 });

    place('amm', {
      title: 'AMM Reference', badge: '72-31-11', status: 'ok', kind: 'text',
      text: 'Fan blade removal and installation. Blades must be replaced as a '
          + 'moment-weight pair. Torque blade root retainer to 84 Nm.',
      footer: 'Revision 2026-04',
    }, { angle: 29, radius: 5.8, height: 1.10 }, { typewriter: true });

    place('inventory', {
      title: 'Parts Inventory', badge: 'STOCK', status: 'ok', kind: 'stack',
      rows: [
        { label: 'Fan blade PN 331-70-07', display: '4 ON HAND', state: 'ok' },
        { label: 'Retainer kit', display: '12 ON HAND', state: 'ok' },
        { label: 'Balance weights', display: 'IN STOCK', state: 'ok' },
        { label: 'Delivery to bay 04', display: '9 MIN', state: 'ok' },
      ],
      footer: 'Store 2 · aisle D',
    }, { angle: 47, radius: 5.2, height: 1.22 });
  }

  /**
   * The business-impact board shown in chapter eight. It stands in front of
   * the engine as a single composed layout rather than an arc, because this
   * chapter is an argument and an argument wants to be read left to right.
   * @private
   */
  #buildImpactBoard() {
    /** @type {Panel[]} Panels belonging to the impact board. */
    this.impactPanels = [];

    /**
     * Creates a board panel at an explicit position.
     * @param {object} data Panel content.
     * @param {[number, number, number]} position World position.
     * @param {number} width Width in metres.
     * @param {number} height Height in metres.
     * @param {object} [options] Extra panel options.
     * @returns {Panel}
     */
    const board = (data, position, width, height, options = {}) => {
      const panel = new Panel({ data, width, height, ...options });
      panel.setPosition(...position);
      panel.faceTowards(new Vector3(0, 1.9, 12));
      this.scene.add(panel.group);
      this.impactPanels.push(panel);
      return panel;
    };

    /** @type {Panel} */
    this.impactWithout = board({
      title: 'Without AeroMind', badge: 'TODAY', status: 'fault', kind: 'metrics',
      rows: [
        { label: 'Unplanned downtime', display: '18 HOURS', state: 'fault', bar: 0, barTarget: 1 },
        { label: 'Flights disrupted', display: '6', state: 'fault', bar: 0, barTarget: 0.85 },
        { label: 'Passengers affected', display: '1 140', state: 'fault', bar: 0, barTarget: 0.9 },
      ],
      footer: 'Reactive maintenance',
    }, [-2.35, 3.3, 5.0], 2.0, 1.18);

    /** @type {Panel} */
    this.impactWith = board({
      title: 'With AeroMind', badge: 'PREDICTED', status: 'ok', kind: 'metrics',
      rows: [
        { label: 'Planned downtime', display: '6 HOURS', state: 'ok', bar: 0, barTarget: 0.33 },
        { label: 'Flights disrupted', display: '0', state: 'ok', bar: 0, barTarget: 0.02 },
        { label: 'Passengers affected', display: '0', state: 'ok', bar: 0, barTarget: 0.02 },
      ],
      footer: 'Predictive maintenance',
    }, [2.35, 3.3, 5.0], 2.0, 1.18);

    /** @type {Panel} */
    this.impactMetrics = board({
      title: 'Operational Impact', badge: 'PER EVENT', status: 'ok', kind: 'stack',
      rows: [
        { label: 'Flight delays', display: '↓  REDUCED', state: 'ok' },
        { label: 'Maintenance cost', display: '↓  REDUCED', state: 'ok' },
        { label: 'Carbon emissions', display: '↓  REDUCED', state: 'ok' },
        { label: 'Passenger disruption', display: '↓  REDUCED', state: 'ok' },
        { label: 'Safety margin', display: '↑  IMPROVED', state: 'ok' },
        { label: 'Fleet availability', display: '↑  IMPROVED', state: 'ok' },
      ],
      footer: 'Modelled across 48 aircraft',
    }, [0, 1.62, 5.0], 4.6, 1.5);

    for (const panel of this.impactPanels) panel.group.visible = false;
  }

  /**
   * The opening and closing typographic cards.
   * @private
   */
  #buildTitleCards() {
    const facing = new Vector3(0, 1.7, 14);

    /** @type {TitleCard} */
    this.cardOpen = new TitleCard({
      title: 'AeroMind',
      subtitle: 'AI Operating System for Aircraft Maintenance',
      width: 7.6, aspect: 2.4,
    }).place(0, 2.95, 3.2, facing);

    /** @type {TitleCard} */
    this.cardImpact = new TitleCard({
      eyebrow: 'Business Impact',
      title: 'Six Hours, Not Eighteen',
      subtitle: 'One prediction, made before the failure',
      width: 5.8, aspect: 3.0,
    }).place(0, 4.62, 5.0, new Vector3(0, 1.9, 12));

    /** @type {TitleCard} */
    this.cardClose = new TitleCard({
      title: 'AeroMind',
      bullets: ['Predict', 'Assist', 'Prevent'],
      width: 6.8, aspect: 2.4,
    }).place(0, 2.95, 8.2, facing);

    /** @type {TitleCard} */
    this.cardFinal = new TitleCard({
      eyebrow: 'Making Aviation',
      title: 'Safer. Smarter.',
      subtitle: 'More Sustainable.',
      width: 6.8, aspect: 2.6,
    }).place(0, 2.95, 8.2, facing);

    /** @type {TitleCard[]} */
    this.cards = [this.cardOpen, this.cardImpact, this.cardClose, this.cardFinal];
    for (const card of this.cards) this.scene.add(card.group);
  }

  /* ===================================================================== */
  /* Story                                                                  */
  /* ===================================================================== */

  /**
   * Registers all nine chapters and their audio cues on a timeline.
   * @param {import('./Timeline.js').Timeline} timeline Timeline to author into.
   * @returns {import('./Timeline.js').Timeline} The same timeline.
   */
  createStory(timeline) {
    timeline.duration = CH.closing[1];

    timeline.addChapters([
      this.#chapterTitle(),
      this.#chapterHangar(),
      this.#chapterGlasses(),
      this.#chapterTwin(),
      this.#chapterInspection(),
      this.#chapterReasoning(),
      this.#chapterRepair(),
      this.#chapterImpact(),
      this.#chapterClosing(),
    ]);

    const play = (name, options) => () => this.audio.play(name, options);

    timeline.addCues([
      [0.4, play('riser'), 'open'],
      [11.2, play('whoosh'), 'hangar'],
      [26.0, play('boot'), 'glasses-on'],
      [28.4, play('notify'), 'link'],
      [37.4, play('panel'), 'twin-in'],
      [47.6, play('confirm'), 'twin-lock'],
      [50.4, play('scan'), 'scan'],
      [59.6, play('alert'), 'anomaly'],
      [63.2, play('notify'), 'crack'],
      [68.3, play('whoosh'), 'panels'],
      [69.0, play('panel'), 'panel-1'],
      [70.2, play('panel', { gain: 0.8 }), 'panel-2'],
      [71.4, play('panel', { gain: 0.7 }), 'panel-3'],
      [79.5, play('notify'), 'diagnosis'],
      [86.4, play('click'), 'task-1'],
      [89.0, play('click'), 'task-2'],
      [91.6, play('click'), 'task-3'],
      [94.2, play('click'), 'task-4'],
      [96.8, play('confirm'), 'task-5'],
      [98.6, play('resolve'), 'restored'],
      [100.4, play('whoosh'), 'impact'],
      [112.4, play('riser', { gain: 0.7 }), 'closing'],
    ]);

    return timeline;
  }

  /* ------------------------------------------------------------ chapter 1 */

  /**
   * Chapter 1 — Title. Black, a swell of sound, the brand resolving out of
   * nothing.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterTitle() {
    const [start, end] = CH.title;
    return {
      id: 'title', title: 'Title', start, end,
      onEnter: () => {
        this.#applyBaseline({ hud: 0, boot: false });
        this.lights.setPreset('black');
        this.fog.snap(0.05, 0);
        this.grid.setOpacity(0);
        this.dust.setOpacity(0);
        this.engine.setSpin(0);
        this.engine.setOverlayOpacity(0);
        this.scanBeam.setIntensity(0);
        for (const card of this.cards) card.hide();
        this.rig.snapTo(0, 1.68, 7.6, 0);
        this.bloom = { strength: 0.62, radius: 0.85, threshold: 0.62 };
      },
      onUpdate: (t) => {
        // A slow fade up from black, a hold, then back down.
        this.fade = envelope(t, 0.6, 10.6, 1.8, 1.6);
        if (t > 1.6 && t < 9.4) this.cardOpen.show(1);
        else this.cardOpen.hide();
      },
    };
  }

  /* ------------------------------------------------------------ chapter 2 */

  /**
   * Chapter 2 — The hangar. Practical lights strike, fog and dust reveal the
   * volume, and the engine emerges as a silhouette before it resolves.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterHangar() {
    const [start, end] = CH.hangar;
    return {
      id: 'hangar', title: 'The Hangar', start, end,
      onEnter: () => {
        this.#applyBaseline({ hud: 0, boot: false });
        this.cardOpen.hide();
        this.grid.setOpacity(0);
        this.engine.setOverlayOpacity(0);
        this.scanBeam.setIntensity(0);
        this.lights.setPreset('reveal');
        this.fog.setDensity(0.036);
        this.fog.setHaze(1);
        this.dust.setOpacity(1);
        this.dust.setAgitation(0.15);
        // A stopped engine still windmills gently in a draughty hangar.
        this.engine.setSpin(11);
        this.audio.startAmbience(0.55);
        this.audio.startTurbine(0.12);
        this.bloom = { strength: 0.42, radius: 0.75, threshold: 0.85 };
        for (const engineer of this.crew) engineer.setPose('idle');
        this.engineerB.setPose('tablet');
        this.engineerC.walkRoute(
          [[-9.5, 0, -7.5], [-6.5, 0, -1.5], [-4.5, 0, 5.0], [-6.0, 0, 10.0]],
          { speed: 0.92 },
        );
      },
      onUpdate: (t, p) => {
        this.fade = progress(t, 0, 2.2, Ease.outCubic);

        // A slow push in, so the space opens up around the viewer.
        const push = Ease.inOutCubic(p);
        this.rig.moveTo(lerp(2.6, 0.9, push), 1.68, lerp(13.4, 9.2, push));
        this.rig.faceTo(lerp(-0.16, -0.05, push));

        // Fog thins as the eye adapts.
        this.fog.setDensity(lerp(0.05, 0.026, push));
      },
    };
  }

  /* ------------------------------------------------------------ chapter 3 */

  /**
   * Chapter 3 — The glasses come online. The interface boots, the AI maps the
   * bay, and the survey grid writes itself across the floor.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterGlasses() {
    const [start, end] = CH.glasses;
    return {
      id: 'glasses', title: 'Glasses Online', start, end,
      onEnter: () => {
        this.#applyBaseline({ hud: 0, boot: false });
        this.engine.setOverlayOpacity(0);
        this.scanBeam.setIntensity(0);
        this.dust.setOpacity(1);
        this.lights.setPreset('working');
        this.engineerA.setPose('idle');
        this.engineerA.lookAt(ENGINE_CENTRE);
        this.engineerB.setPose('tablet');
        this.hud.setStatus({ mode: 'INITIALISING', link: 'LINKING' });
        this.bloom = { strength: 0.44, radius: 0.74, threshold: 0.84 };
      },
      onUpdate: (t, p) => {
        this.fade = 1;
        this.rig.moveTo(lerp(0.9, 0.2, Ease.inOutCubic(p)), 1.68, lerp(9.2, 8.2, Ease.inOutCubic(p)));
        this.rig.faceTo(-0.03);

        // Glasses power up.
        const power = t > 1.6;
        for (const engineer of this.crew) engineer.setGlasses(power && engineer !== this.engineerC);
        this.hud.setOpacity(t > 1.8 ? 1 : 0);
        this.hud.setBoot(t > 2.2);

        // The floor grid writes itself outward from the engine.
        this.grid.setOpacity(progress(t, 4.5, 6.5));
        this.grid.setBuild(progress(t, 4.8, 9.5, Ease.outCubic));

        if (t > 3.0 && t < 5.2) this.hud.setStatus({ mode: 'MAPPING BAY', link: 'LINKING' });
        else if (t >= 5.2 && t < 9.0) this.hud.setStatus({ mode: 'SURFACES MAPPED', link: 'SYNCED' });
        else if (t >= 9.0) this.hud.setStatus({ mode: 'READING ENGINE', link: 'SYNCED' });

        if (t > 3.2 && t < 7.4) {
          this.hud.say('Mixed reality link established. Bay 04, engine GT-7841.');
        } else if (t >= 7.4 && t < 12.6) {
          this.hud.say('11 240 cycles since overhaul. Loading digital twin.');
        }
      },
      onExit: () => this.grid.pulse(),
    };
  }

  /* ------------------------------------------------------------ chapter 4 */

  /**
   * Chapter 4 — Digital twin alignment. Brackets converge, the wireframe
   * resolves, registration counts up and locks.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterTwin() {
    const [start, end] = CH.twin;
    return {
      id: 'twin', title: 'Digital Twin', start, end,
      onEnter: () => {
        this.#applyBaseline({ twin: 1, readout: 1 });
        // Declared, not inherited from chapter three: seeking straight into
        // this chapter must light the bay exactly as playing into it would.
        this.lights.setPreset('working');
        this.grid.setOpacity(1);
        this.grid.setBuild(1);
        this.dust.setOpacity(1);
        this.scanBeam.setIntensity(0);
        this.engine.setOverlayMode('twin');
        this.engine.setSpin(0);
        this.dust.setAgitation(0.05);
        this.hud.setStatus({ mode: 'ALIGNING TWIN', link: 'SYNCED' });
        this.bloom = { strength: 0.46, radius: 0.76, threshold: 0.82 };
      },
      onUpdate: (t, p) => {
        this.fade = 1;
        this.rig.moveTo(lerp(0.2, -0.15, Ease.inOutCubic(p)), 1.68, lerp(8.2, 7.5, Ease.inOutCubic(p)));

        // Registration climbs over eight seconds, then locks.
        const align = progress(t, 1.2, 9.6, Ease.inOutQuart);
        this.twin.setProgress(align);
        this.engine.setTwinLock(align);
        this.engine.setOverlayOpacity(progress(t, 0.8, 3.2) * 0.95);

        if (t > 10.4 && !this.twin.locked) {
          this.twin.lock();
          this.hud.notify('Digital twin locked', 'ok', 2.6);
          this.holograms.show('digitaltwin', 0.1);
        }

        if (t > 1.0 && t < 6.0) {
          this.hud.say('Aligning digital twin to physical geometry.');
        } else if (t >= 6.0 && t < 10.4) {
          this.hud.say('Matching feature cloud — 4 812 points.');
        } else if (t >= 10.4) {
          this.hud.say('Twin locked. Mean deviation 0.14 millimetres.');
        }
      },
    };
  }

  /* ------------------------------------------------------------ chapter 5 */

  /**
   * Chapter 5 — AI inspection. The beam sweeps the engine, every blade is
   * checked in turn, and blade 07 fails.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterInspection() {
    const [start, end] = CH.inspection;
    return {
      id: 'inspection', title: 'AI Inspection', start, end,
      onEnter: () => {
        this.#applyBaseline({ twin: 0.5, locked: true });
        this.grid.setOpacity(1);
        this.grid.setBuild(1);
        this.dust.setOpacity(1);
        this.engine.setOverlayMode('twin');
        this.engine.setOverlayOpacity(0.85);
        this.hud.setStatus({ mode: 'SCANNING', link: 'SYNCED' });
        this.lights.setPreset('analysis');
        this.holograms.show('telemetry', 0.4);
        this.bloom = { strength: 0.5, radius: 0.78, threshold: 0.8 };
        this.engineerA.setPose('idle');
        this.engineerA.lookAt(ENGINE_CENTRE);
      },
      onUpdate: (t, p) => {
        this.fade = 1;
        this.rig.moveTo(lerp(-0.15, -0.55, Ease.inOutCubic(p)), 1.70, lerp(7.5, 6.9, Ease.inOutCubic(p)));

        /* -------- the sweep ------------------------------------------- */
        const sweep = progress(t, 0.6, 10.5, Ease.inOutQuad);
        this.scanBeam.setProgress(sweep);
        this.scanBeam.setIntensity(envelope(t, 0.4, 11.4, 0.6, 1.0));
        // The measurement ring hugs the engine's changing radius.
        this.scanBeam.setRingScale(lerp(1.0, 0.42, Ease.inQuad(sweep)));

        /* -------- blade-by-blade check --------------------------------- */
        this.engine.sweepBlades(progress(t, 1.4, 9.8), 5);

        /* -------- the anomaly ------------------------------------------ */
        // Blade 07 first reads as caution, then resolves to a hard fault.
        const caution = progress(t, 9.2, 10.6);
        const fault = progress(t, 12.4, 14.2);
        this.engine.setBladeStress(FAULT_BLADE, clamp(0.1 + caution * 0.62 + fault * 0.35, 0, 1));

        if (t > 10.6) this.engine.clearBlades(true);

        // The crack draws itself.
        this.engine.setFaultReveal(progress(t, 13.0, 15.6, Ease.outCubic));

        /* -------- analytical overlays ---------------------------------- */
        if (t < 12.0) this.engine.setOverlayMode('twin');
        else if (t < 15.4) this.engine.setOverlayMode('thermal');
        else this.engine.setOverlayMode('stress');

        /* -------- notifications ---------------------------------------- */
        if (t > 9.4 && t < 9.6) this.hud.notify('Anomaly — fan blade 07', 'warn', 3.0);
        if (t > 13.0 && t < 13.2) this.hud.notify('Crack indication confirmed', 'fault', 3.4);

        if (t < 4.0) {
          this.hud.say('Scanning fan section. 24 blades, 4 800 measurement points.');
        } else if (t < 9.4) {
          this.hud.say('Comparing every blade against its own service history.');
        } else if (t < 13.0) {
          this.hud.say('Blade 07 — vibration signature outside tolerance.');
        } else if (t < 15.6) {
          this.hud.say('Sub-surface crack detected at the blade root. 4.2 millimetres.');
        } else {
          this.hud.say('Thermal and stress maps confirm the indication.');
        }

        // Engineer A leans in to look at what the AI has found.
        if (t > 12.0) {
          this.engine.getFaultPosition(this._faultPosition);
          this.engineerA.lookAt(this._faultPosition);
        }
      },
      onExit: () => {
        this.scanBeam.setIntensity(0);
        this.engine.setOverlayMode('stress');
      },
    };
  }

  /* ------------------------------------------------------------ chapter 6 */

  /**
   * Chapter 6 — AI reasoning. Eleven sources of evidence materialise around
   * the engine and the AI shows its work.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterReasoning() {
    const [start, end] = CH.reasoning;
    return {
      id: 'reasoning', title: 'AI Reasoning', start, end,
      onEnter: () => {
        this.#applyBaseline({ fault: 1, crack: 1, panels: true });
        this.grid.setOpacity(1);
        this.grid.setBuild(1);
        this.dust.setOpacity(1);
        this.scanBeam.setIntensity(0);
        this.engine.setOverlayMode('stress');
        this.holograms.reveal(
          ['digitaltwin', 'telemetry', 'health', 'life', 'history',
            'fleet', 'inventory', 'amm', 'confidence', 'recommendation', 'checklist'],
          0.34, 0.15,
        );
        this.holograms.setTetherOpacity(1);
        this.lights.setPreset('analysis');
        this.lights.setHoloColor(0x4fc3ff);
        this.engine.setOverlayOpacity(0.6);
        this.hud.setStatus({ mode: 'REASONING', link: 'SYNCED' });
        this.dust.setAgitation(0.35);
        this.bloom = { strength: 0.56, radius: 0.82, threshold: 0.74 };
        this._telemetryClock = 0;
      },
      onUpdate: (t, p) => {
        this.fade = 1;
        this.rig.moveTo(lerp(-0.55, 0, Ease.inOutCubic(p)), lerp(1.70, 1.80, Ease.inOutCubic(p)), lerp(6.9, 7.6, Ease.inOutCubic(p)));

        // The panels the AI is currently citing brighten in turn.
        if (t < 4) this.holograms.focus('telemetry');
        else if (t < 7) this.holograms.focus('history');
        else if (t < 10) this.holograms.focus('life');
        else if (t < 13) this.holograms.focus('confidence');
        else this.holograms.focus('recommendation');

        if (t < 4.2) {
          this.hud.say('Cross-referencing telemetry from 11 240 flight cycles.');
        } else if (t < 8.0) {
          this.hud.say('This blade was blended after a bird strike in June 2025.');
        } else if (t < 11.5) {
          this.hud.say('Root cause: high-cycle fatigue initiating at the blend repair.');
        } else if (t < 14.5) {
          this.hud.say('Diagnosis confidence 96.4 per cent. Three models agree.');
        } else {
          this.hud.say('Recommended action prepared. Parts reserved and en route.');
        }
      },
      onExit: () => this.holograms.focus(null),
    };
  }

  /* ------------------------------------------------------------ chapter 7 */

  /**
   * Chapter 7 — Guided repair. The engineer works to the holographic
   * checklist, the tasks close out, and the engine returns to full health.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterRepair() {
    const [start, end] = CH.repair;
    const checklist = this.holograms.byId.get('checklist');
    const health = this.holograms.byId.get('health');

    return {
      id: 'repair', title: 'Guided Repair', start, end,
      onEnter: () => {
        this.#applyBaseline({ fault: 1, crack: 1, panels: true });
        this.holograms.reveal(null, 0.05, 0);
        this.grid.setOpacity(1);
        this.grid.setBuild(1);
        this.dust.setOpacity(1);
        this.scanBeam.setIntensity(0);
        this.engineerA.setPose('work');
        this.engineerA.lookAt(this.engine.getFaultPosition(new Vector3()));
        this.holograms.focus('checklist');
        this.engine.setOverlayMode('twin');
        this.engine.setOverlayOpacity(0.5);
        this.hud.setStatus({ mode: 'GUIDED REPAIR', link: 'SYNCED' });
        this.lights.setPreset('working');
        this.bloom = { strength: 0.48, radius: 0.78, threshold: 0.8 };

        // The chapter opens with the work still to do, whatever came before.
        for (let i = 0; i < 5; i++) checklist?.setChecklistItem(i, false);
        if (checklist) { checklist.data.badge = '0 / 5'; checklist.data.status = 'warn'; }
        this.#resetTint();
      },
      onUpdate: (t, p) => {
        this.fade = 1;
        this.rig.moveTo(lerp(0, -0.95, Ease.inOutCubic(p)), 1.70, lerp(7.6, 6.6, Ease.inOutCubic(p)));

        /* -------- checklist closes out --------------------------------- */
        const times = [0.4, 3.0, 5.6, 8.2, 10.8];
        let done = 0;
        times.forEach((at, index) => {
          const complete = t > at;
          checklist?.setChecklistItem(index, complete);
          if (complete) done++;
        });
        if (checklist && checklist.data.badge !== `${done} / 5`) {
          checklist.data.badge = `${done} / 5`;
          checklist.data.status = done === 5 ? 'ok' : 'warn';
          checklist.invalidate();
        }

        /* -------- sparks while the work happens ------------------------ */
        if (t > 0.8 && t < 10.4) {
          this._sparkTimer = (this._sparkTimer ?? 0) + 1;
          if (this._sparkTimer % 14 === 0) {
            this.engine.getFaultPosition(this._faultPosition);
            this.sparks.emit(this._faultPosition, {
              count: 12, speed: 2.2, spread: 0.7,
              direction: new Vector3(0.2, 0.5, 0.8),
            });
          }
        }

        /* -------- health restored -------------------------------------- */
        const recovery = progress(t, 11.4, 13.4, Ease.outCubic);
        if (health) {
          health.data.gauge.target = lerp(0.62, 1.0, recovery);
          health.data.status = recovery > 0.9 ? 'ok' : 'warn';
          if (recovery > 0.9) health.data.gauge.caption = 'All sections nominal';
        }
        this.engine.setBladeStress(FAULT_BLADE, lerp(1, 0.06, recovery));
        this.engine.setFaultReveal(1 - recovery);

        // Everything turns green as the fault is closed out.
        if (recovery > 0.02) this.#tintWorkspace(recovery);

        // The fan spins up again once the repair is verified.
        this.engine.setSpin(recovery > 0.7 ? 150 : 0);
        if (recovery > 0.7) this.dust.setAgitation(0.6);

        if (t < 3.0) {
          this.hud.say('Follow the highlighted sequence. Blade 07, root retainer first.');
        } else if (t < 7.0) {
          this.hud.say('Torque confirmed at 84 newton metres. Logged automatically.');
        } else if (t < 11.0) {
          this.hud.say('Replacement blade installed. Running dynamic balance.');
        } else {
          this.hud.say('Vibration nominal. Engine health restored to 100 per cent.');
        }
      },
      onExit: () => {
        this.engineerA.setPose('idle');
        this.engineerA.lookAt(null);
      },
    };
  }

  /* ------------------------------------------------------------ chapter 8 */

  /**
   * Chapter 8 — Business impact. The workspace clears and the argument is
   * made in numbers.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterImpact() {
    const [start, end] = CH.impact;
    return {
      id: 'impact', title: 'Business Impact', start, end,
      onEnter: () => {
        this.#applyBaseline({ repaired: true, impact: true });
        this.grid.setOpacity(0.6);
        this.grid.setBuild(1);
        this.dust.setOpacity(1);
        this.scanBeam.setIntensity(0);
        this.engine.setOverlayOpacity(0.18);
        this.engine.setSpin(210);
        this.hud.setStatus({ mode: 'IMPACT SUMMARY', link: 'SYNCED' });
        this.lights.setPreset('resolved');
        this.bloom = { strength: 0.52, radius: 0.8, threshold: 0.76 };

        for (const panel of this.impactPanels) {
          for (const row of panel.data.rows ?? []) row.bar = 0;
          panel.invalidate();
        }
        this.impactWithout.show(0.5);
        this.impactWith.show(1.1);
        this.impactMetrics.show(1.8);
      },
      onUpdate: (t, p) => {
        this.fade = 1;
        this.rig.moveTo(0, lerp(1.72, 1.95, Ease.inOutCubic(p)), lerp(6.6, 11.8, Ease.inOutCubic(p)));
        this.rig.faceTo(0);

        if (t > 0.3) this.cardImpact.show(1); else this.cardImpact.hide();

        if (t < 4.0) {
          this.hud.say('The same failure, caught before it happened.');
        } else if (t < 8.0) {
          this.hud.say('Eighteen hours of unplanned downtime becomes six, planned.');
        } else {
          this.hud.say('Fewer delays. Lower cost. Less fuel burned. Safer flights.');
        }
      },
      onExit: () => {
        this.cardImpact.hide();
        for (const panel of this.impactPanels) panel.hide();
      },
    };
  }

  /* ------------------------------------------------------------ chapter 9 */

  /**
   * Chapter 9 — Closing. Back to black, with the promise stated plainly.
   * @returns {import('./Timeline.js').Chapter}
   * @private
   */
  #chapterClosing() {
    const [start, end] = CH.closing;
    return {
      id: 'closing', title: 'Closing', start, end,
      onEnter: () => {
        this.#applyBaseline({ repaired: true });
        this.grid.setOpacity(0);
        this.scanBeam.setIntensity(0);
        this.hud.clearNarration();
        this.hud.setStatus({ mode: 'STANDBY', link: 'SYNCED' });
        this.lights.setPreset('finale');
        this.fog.setDensity(0.05);
        this.engine.setOverlayOpacity(0);
        this.twin.setOpacity(0);
        this.bloom = { strength: 0.66, radius: 0.88, threshold: 0.6 };
      },
      onUpdate: (t, p) => {
        // Fade the interface away first, then the world.
        this.hud.setOpacity(1 - progress(t, 0, 1.6));
        this.fade = 1 - progress(t, 6.4, 7.9, Ease.inOutCubic);

        this.rig.moveTo(0, 1.72, lerp(11.6, 13.4, Ease.inOutCubic(p)));

        if (t > 0.8 && t < 4.4) this.cardClose.show(1); else this.cardClose.hide();
        if (t > 4.0 && t < 7.6) this.cardFinal.show(1); else this.cardFinal.hide();
      },
      onExit: () => {
        this.cardClose.hide();
        this.cardFinal.hide();
      },
    };
  }

  /* ===================================================================== */
  /* Helpers                                                                */
  /* ===================================================================== */

  /**
   * Puts the world into a chapter's starting state.
   *
   * Every chapter calls this from `onEnter` with a complete description of the
   * world it expects. Nothing is inherited from whatever played before, which
   * is what makes the timeline exactly scrubbable: jumping straight to the
   * repair sequence produces the same world as watching up to it.
   *
   * @param {object} state Desired world state.
   * @param {number} [state.hud] Interface opacity, 0–1.
   * @param {boolean} [state.boot] Whether the glasses are booted.
   * @param {number} [state.twin] Alignment-rig opacity.
   * @param {boolean} [state.locked] Whether registration reads LOCKED.
   * @param {number} [state.readout] Registration read-out opacity, 0–1.
   * @param {number} [state.fault] Blade 07 stress, 0–1.
   * @param {number} [state.crack] Crack reveal, 0–1.
   * @param {boolean} [state.repaired] Whether the repair has been completed.
   * @param {boolean} [state.panels] Whether the analysis panels are present.
   * @param {boolean} [state.impact] Whether the impact board is present.
   * @private
   */
  #applyBaseline(state) {
    const {
      hud = 1, boot = true, twin = 0, locked = false, readout = 0,
      fault = 0.06, crack = 0, repaired = false,
      panels = false, impact = false,
    } = state;

    /* -------- interface ------------------------------------------- */
    this.hud.setOpacity(hud);
    this.hud.setBoot(boot);
    for (const engineer of this.crew) {
      engineer.setGlasses(boot && engineer !== this.engineerC);
    }

    /* -------- title cards ------------------------------------------ */
    // Cards are shown from `onUpdate`, which runs immediately after this, so
    // clearing them here guarantees a seek never leaves one stranded on screen.
    for (const card of this.cards) card.hide();

    /* -------- alignment rig --------------------------------------- */
    if (locked) this.twin.lock(); else this.twin.reset();
    this.twin.setOpacity(twin, readout);

    /* -------- engine condition ------------------------------------ */
    for (let i = 0; i < BLADE_COUNT; i++) this.engine.setBladeStress(i, 0.06);
    this.engine.setBladeStress(FAULT_BLADE, fault);
    this.engine.setFaultReveal(crack);
    this.engine.clearBlades(fault > 0.5);

    /* -------- analysis state -------------------------------------- */
    const health = this.holograms.byId.get('health');
    if (health) {
      // Both value and target are set, so a scrub lands on the right reading
      // immediately instead of easing there from whatever was on screen.
      health.data.gauge.value = repaired ? 1.0 : 0.62;
      health.data.gauge.target = repaired ? 1.0 : 0.62;
      health.data.gauge.caption = repaired ? 'All sections nominal' : 'Fan section degraded';
      health.data.status = repaired ? 'ok' : 'warn';
      health.invalidate();
    }

    const confidence = this.holograms.byId.get('confidence');
    if (confidence) {
      // Confidence is meant to be *watched* climbing, so it restarts at zero.
      confidence.data.gauge.value = 0;
      confidence.data.gauge.target = 0.964;
      confidence.invalidate();
    }

    const checklist = this.holograms.byId.get('checklist');
    if (checklist) {
      for (let i = 0; i < 5; i++) checklist.setChecklistItem(i, repaired);
      checklist.data.badge = repaired ? '5 / 5' : '0 / 5';
      checklist.data.status = repaired ? 'ok' : 'warn';
      checklist.invalidate();
    }

    if (repaired) this.#tintWorkspace(1); else this.#resetTint();

    /* -------- holographic surfaces -------------------------------- */
    if (!panels) {
      this.holograms.hideAll(0);
      this.holograms.setTetherOpacity(0);
      this.holograms.focus(null);
    }
    if (!impact) this.#hideImpact();
  }

  /**
   * Blends the holographic layer from inspection blue toward resolved green.
   * @param {number} amount Blend factor, 0–1.
   * @private
   */
  #tintWorkspace(amount) {
    const k = saturate(amount);
    // 0x6fd2ff → 0x4ce6a6
    const r = lerp(0x6f, 0x4c, k) / 255;
    const g = lerp(0xd2, 0xe6, k) / 255;
    const b = lerp(0xff, 0xa6, k) / 255;

    for (const panel of this.holograms.panels) {
      panel.material.uniforms.uBorder.value.setRGB(r, g, b);
    }
    this.lights.setHoloColor(
      (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255),
    );
  }

  /**
   * Restores the holographic layer to its inspection colour.
   * @private
   */
  #resetTint() {
    for (const panel of this.holograms.panels) {
      panel.material.uniforms.uBorder.value.setHex(0x6fd2ff);
    }
    this.lights.setHoloColor(0x4fc3ff);
  }

  /** Hides every impact-board panel immediately. @private */
  #hideImpact() {
    for (const panel of this.impactPanels ?? []) panel.hide();
    this.cardImpact?.hide();
  }

  /**
   * Restores the opening world state. Called when the timeline wraps, because a
   * loop re-enters chapter one from the far end of the story rather than from
   * a clean start.
   */
  resetStoryState() {
    this.#applyBaseline({ hud: 0, boot: false });
  }

  /* ===================================================================== */
  /* Frame update                                                           */
  /* ===================================================================== */

  /**
   * Advances every system in the world. Called once per frame, before either
   * eye is rendered — both eyes must observe the same instant.
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   */
  update(dt, time) {
    Glow.update(time);

    this.lights.update(dt);
    for (const entry of this.litMaterials) {
      entry.material.envMapIntensity = entry.base * this.lights.envScale;
    }
    // The physical fixtures burn in step with the lamps they stand for, so a
    // blackout really is a blackout.
    this.hangar.setEmissiveLevel(
      Math.min(1, this.lights.practicals[0].light.intensity / 6.2),
    );

    this.fog.update(dt);
    this.dust.update(dt);
    this.sparks.update(dt);
    this.grid.update(dt);
    // The pool tracks the survey grid: both are the AI's mark on the floor.
    this.poolMaterial.uniforms.uProgress.value = damp(
      this.poolMaterial.uniforms.uProgress.value,
      this.grid.targetOpacity * 0.9,
      1.8, dt,
    );
    this.enginePool.visible = this.poolMaterial.uniforms.uProgress.value > 0.004;

    this.engine.update(dt, time);
    this.twin.update(dt, time);
    this.scanBeam.update(dt);

    for (const engineer of this.crew) engineer.update(dt);

    this.holograms.update(dt, time);
    for (const panel of this.impactPanels) panel.update(dt, time);
    for (const card of this.cards) card.update(dt);

    // Live telemetry: a running trace with a step change when the fault is
    // found, so the graph tells the same story as the narration.
    this.#updateTelemetry(dt, time);
  }

  /**
   * Feeds the telemetry panel.
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   * @private
   */
  #updateTelemetry(dt, time) {
    const panel = this.holograms.byId.get('telemetry');
    if (!panel || panel.open < 0.4) return;

    this._telemetryClock = (this._telemetryClock ?? 0) + dt;
    if (this._telemetryClock < 0.14) return;
    this._telemetryClock = 0;

    // A calm baseline with a slowly growing 1-per-rev vibration component.
    const growth = saturate((this.engine.bladeStress[FAULT_BLADE] - 0.1) / 0.9);
    const base = 1.6 + growth * 2.4;
    const sample = base
      + Math.sin(time * 2.4) * 0.22
      + Math.sin(time * 7.1) * 0.1 * (1 + growth * 2)
      + (Math.random() - 0.5) * 0.14;

    panel.pushSample(sample);

    const vib = panel.data.rows[0];
    vib.target = sample;
    vib.state = sample > 3.0 ? 'fault' : sample > 2.4 ? 'warn' : 'ok';

    panel.data.rows[2].target = this.engine.rpm > 1 ? this.engine.rpm / 3.2 : 0;
    panel.data.rows[2].state = this.engine.rpm > 1 ? 'ok' : 'idle';
  }

  /** Releases every GPU resource in the world. */
  dispose() {
    this.hangar.dispose();
    this.lights.dispose();
    this.fog.dispose();
    this.dust.dispose();
    this.sparks.dispose();
    this.grid.dispose();
    this.enginePool.geometry.dispose();
    Glow.unregister(this.poolMaterial);
    this.poolMaterial.dispose();
    this.engine.dispose();
    this.twin.dispose();
    this.scanBeam.dispose();
    this.holograms.dispose();
    for (const panel of this.impactPanels) panel.dispose();
    for (const card of this.cards) card.dispose();
    for (const engineer of this.crew) engineer.dispose();
    disposeEngineerGeometry();
  }
}

/** The engine's world position, shared with the inspection controls. */
export { ENGINE_CENTRE };
