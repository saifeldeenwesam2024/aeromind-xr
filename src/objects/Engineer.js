/**
 * @file Engineer.js
 * @description Procedural maintenance engineers.
 *
 * Three figures populate the bay. They are built from capsules and boxes rather
 * than imported rigs, which keeps the project self-contained — but the value is
 * not in the geometry, it is in the motion. A still human figure reads as a
 * mannequin instantly, and a mannequin drains the credibility out of everything
 * around it. So every engineer breathes, shifts their weight from one leg to
 * the other on an irregular cycle, makes small head corrections, and lets their
 * arms hang with a little counter-sway.
 *
 * Nothing is keyframed. Every joint angle is a function of time built from
 * layered noise at incommensurate frequencies, so no two engineers ever fall
 * into step with each other and the loop never becomes visible.
 */

import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { clamp, damp, dampAngle, lerp, noise1D, saturate, TAU } from '../engine/Utils.js';

/**
 * Shared geometry, created once and reused by every engineer.
 * @type {?object}
 */
let GEOMETRY_CACHE = null;

/**
 * Builds (or returns) the shared geometry set.
 * @returns {object} Named geometries.
 */
function getGeometry() {
  if (GEOMETRY_CACHE) return GEOMETRY_CACHE;

  GEOMETRY_CACHE = {
    pelvis: new CapsuleGeometry(0.155, 0.12, 4, 12),
    torso: new CapsuleGeometry(0.17, 0.26, 4, 14),
    chest: new CapsuleGeometry(0.185, 0.16, 4, 14),
    neck: new CylinderGeometry(0.055, 0.062, 0.09, 10),
    head: new CapsuleGeometry(0.098, 0.085, 6, 14),
    upperArm: new CapsuleGeometry(0.055, 0.19, 4, 10),
    foreArm: new CapsuleGeometry(0.046, 0.19, 4, 10),
    hand: new CapsuleGeometry(0.042, 0.05, 4, 8),
    thigh: new CapsuleGeometry(0.078, 0.24, 4, 10),
    shin: new CapsuleGeometry(0.062, 0.26, 4, 10),
    foot: new BoxGeometry(0.11, 0.075, 0.27),
    visor: new BoxGeometry(0.185, 0.055, 0.02),
    temple: new BoxGeometry(0.012, 0.014, 0.14),
    tablet: new BoxGeometry(0.24, 0.015, 0.33),
    screen: new PlaneGeometry(0.21, 0.3),
    helmetDot: new SphereGeometry(0.012, 6, 6),
  };
  return GEOMETRY_CACHE;
}

/** Disposes the shared geometry set. Call once, at teardown. */
export function disposeEngineerGeometry() {
  if (!GEOMETRY_CACHE) return;
  for (const g of Object.values(GEOMETRY_CACHE)) g.dispose();
  GEOMETRY_CACHE = null;
}

/**
 * Crew colourways. Distinct uniforms let a viewer tell the three engineers
 * apart at a glance, which is what makes the choreography readable.
 * @type {Object<string, {suit: number, trim: number, skin: number}>}
 */
export const CREW_UNIFORMS = {
  lead:       { suit: 0x35577f, trim: 0xdfe85c, skin: 0xb98a68 },
  technician: { suit: 0x46566b, trim: 0xef7a45, skin: 0x8d5f43 },
  inspector:  { suit: 0x515b69, trim: 0x6fd2ff, skin: 0xd6a883 },
};

/**
 * A single procedurally animated maintenance engineer.
 * @class
 */
export class Engineer {
  /**
   * @param {object} [options] Configuration.
   * @param {number|string} [options.suit] Coverall colour.
   * @param {number|string} [options.trim] High-visibility trim colour.
   * @param {number|string} [options.skin] Skin tone.
   * @param {number} [options.height] Overall height in metres.
   * @param {number} [options.seed] Phase seed; keeps figures out of step.
   * @param {'idle'|'work'|'tablet'|'walk'} [options.pose] Starting behaviour.
   * @param {boolean} [options.glasses] Fit mixed-reality glasses.
   * @param {boolean} [options.tablet] Carry a rugged tablet.
   */
  constructor(options = {}) {
    const {
      suit = 0x1d3350,
      trim = 0xd8e24a,
      skin = 0xb98a68,
      height = 1.78,
      seed = 0,
      pose = 'idle',
      glasses = true,
      tablet = false,
    } = options;

    /** @type {Group} Scene graph root; position and rotate this. */
    this.group = new Group();
    this.group.name = 'Engineer';

    /** @type {number} Phase offset so no two figures share a rhythm. */
    this.seed = seed;
    /** @type {number} Internal clock. */
    this.time = seed * 7.31;
    /** @type {'idle'|'work'|'tablet'|'walk'} */
    this.pose = pose;
    /** @type {number} Scale relative to the 1.78 m reference build. */
    this.scale = height / 1.78;

    /** @type {?Vector3} World point the head turns toward. */
    this.lookTarget = null;
    /** @type {number} Glasses power state, 0–1. */
    this.glassesPower = 0;
    /** @type {number} Glasses power the engineer eases toward. */
    this.targetGlassesPower = 0;

    /** @type {Vector3[]} Waypoints for the walk behaviour. */
    this.path = [];
    /** @type {number} Index of the waypoint being approached. */
    this.pathIndex = 0;
    /** @type {number} Walking speed in metres per second. */
    this.speed = 1.15;
    /** @type {number} Gait phase in radians. */
    this.gait = seed * 2.1;
    /** @type {number} How strongly the walk cycle is applied, 0–1. */
    this.walkBlend = 0;
    /** @type {number} Reaching-into-the-engine blend, 0–1. */
    this.workBlend = 0;
    /** @type {number} Tablet-holding blend, 0–1. */
    this.tabletBlend = 0;

    /** @type {Set<import('three').Material>} */
    this._materials = new Set();

    this.#createMaterials({ suit, trim, skin });
    this.#createBody();
    if (glasses) this.#createGlasses();
    if (tablet) this.#createTablet();

    this.group.scale.setScalar(this.scale);
    this.setPose(pose);
  }

  /**
   * @param {{suit: number|string, trim: number|string, skin: number|string}} colors Colourway.
   * @private
   */
  #createMaterials(colors) {
    /** @type {MeshStandardMaterial} */
    this.suitMaterial = this.#track(new MeshStandardMaterial({
      color: colors.suit, roughness: 0.86, metalness: 0.04,
    }));
    /** @type {MeshStandardMaterial} */
    this.trimMaterial = this.#track(new MeshStandardMaterial({
      color: colors.trim, roughness: 0.6, metalness: 0.05,
      emissive: new Color(colors.trim).multiplyScalar(0.12),
    }));
    /** @type {MeshStandardMaterial} */
    this.skinMaterial = this.#track(new MeshStandardMaterial({
      color: colors.skin, roughness: 0.78, metalness: 0.0,
    }));
    /** @type {MeshStandardMaterial} */
    this.bootMaterial = this.#track(new MeshStandardMaterial({
      color: 0x14171c, roughness: 0.9, metalness: 0.08,
    }));
    /** @type {MeshStandardMaterial} */
    this.gearMaterial = this.#track(new MeshStandardMaterial({
      color: 0x2b3038, roughness: 0.5, metalness: 0.6,
    }));
    /** @type {MeshBasicMaterial} Visor emission; driven by `glassesPower`. */
    this.visorMaterial = this.#track(new MeshBasicMaterial({
      color: 0x4fc3ff, transparent: true, opacity: 0,
    }));
  }

  /**
   * @template {import('three').Material} T
   * @param {T} material Material to track for disposal.
   * @returns {T}
   * @private
   */
  #track(material) {
    this._materials.add(material);
    return material;
  }

  /**
   * Assembles the skeleton. Every joint is a `Group`, so animation is a matter
   * of setting rotations rather than rebuilding transforms.
   * @private
   */
  #createBody() {
    const g = getGeometry();

    /**
     * Adds a mesh to a parent.
     * @param {Group} parent Parent node.
     * @param {import('three').BufferGeometry} geometry Geometry.
     * @param {import('three').Material} material Material.
     * @param {[number, number, number]} position Local position.
     * @returns {Mesh}
     */
    const add = (parent, geometry, material, position) => {
      const mesh = new Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    /* ------------------------------------------------------------- root */

    /** @type {Group} Hips; the root of the animated skeleton. */
    this.hips = new Group();
    this.hips.position.y = 0.92;
    this.group.add(this.hips);
    add(this.hips, g.pelvis, this.suitMaterial, [0, 0, 0]);

    /* ------------------------------------------------------------ spine */

    /** @type {Group} */
    this.spine = new Group();
    this.spine.position.y = 0.14;
    this.hips.add(this.spine);
    add(this.spine, g.torso, this.suitMaterial, [0, 0.16, 0]);

    /** @type {Group} Ribcage; scaled by the breathing cycle. */
    this.chest = new Group();
    this.chest.position.y = 0.34;
    this.spine.add(this.chest);
    /** @type {Mesh} */
    this.chestMesh = add(this.chest, g.chest, this.suitMaterial, [0, 0.06, 0]);

    // High-visibility trim bands across the chest and back.
    const band = new Mesh(
      new CylinderGeometry(0.192, 0.192, 0.05, 16, 1, true),
      this.trimMaterial,
    );
    band.position.y = 0.05;
    this.chest.add(band);
    this._trimBand = band;

    /* ------------------------------------------------------------- head */

    /** @type {Group} */
    this.neck = new Group();
    this.neck.position.y = 0.19;
    this.chest.add(this.neck);
    add(this.neck, g.neck, this.skinMaterial, [0, 0.02, 0]);

    /** @type {Group} */
    this.head = new Group();
    this.head.position.y = 0.11;
    this.neck.add(this.head);
    add(this.head, g.head, this.skinMaterial, [0, 0.05, 0]);

    // Ear-defender headset.
    for (const side of [-1, 1]) {
      const cup = new Mesh(g.helmetDot, this.gearMaterial);
      cup.scale.set(3.4, 4.2, 3.0);
      cup.position.set(side * 0.1, 0.05, 0);
      this.head.add(cup);
    }

    /* ------------------------------------------------------------- arms */

    /** @type {object[]} Arm chains, left then right. */
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new Group();
      shoulder.position.set(side * 0.2, 0.11, 0);
      this.chest.add(shoulder);
      add(shoulder, g.upperArm, this.suitMaterial, [0, -0.14, 0]);

      const elbow = new Group();
      elbow.position.y = -0.29;
      shoulder.add(elbow);
      add(elbow, g.foreArm, this.suitMaterial, [0, -0.14, 0]);

      const wrist = new Group();
      wrist.position.y = -0.28;
      elbow.add(wrist);
      add(wrist, g.hand, this.skinMaterial, [0, -0.04, 0]);

      this.arms.push({ side, shoulder, elbow, wrist });
    }

    /* ------------------------------------------------------------- legs */

    /** @type {object[]} Leg chains, left then right. */
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new Group();
      hip.position.set(side * 0.098, -0.06, 0);
      this.hips.add(hip);
      add(hip, g.thigh, this.suitMaterial, [0, -0.19, 0]);

      const knee = new Group();
      knee.position.y = -0.4;
      hip.add(knee);
      add(knee, g.shin, this.suitMaterial, [0, -0.19, 0]);

      const ankle = new Group();
      ankle.position.y = -0.38;
      knee.add(ankle);
      const foot = add(ankle, g.foot, this.bootMaterial, [0, -0.04, 0.05]);
      foot.castShadow = true;

      this.legs.push({ side, hip, knee, ankle });
    }
  }

  /**
   * Fits the mixed-reality glasses. The visor is a separate emissive plane so
   * the boot sequence can drive it independently of the frame.
   * @private
   */
  #createGlasses() {
    const g = getGeometry();

    /** @type {Group} */
    this.glasses = new Group();
    this.glasses.position.set(0, 0.055, 0.088);
    this.head.add(this.glasses);

    const frame = new Mesh(g.visor, this.gearMaterial);
    this.glasses.add(frame);

    for (const side of [-1, 1]) {
      const temple = new Mesh(g.temple, this.gearMaterial);
      temple.position.set(side * 0.09, 0.004, -0.07);
      this.glasses.add(temple);
    }

    /** @type {Mesh} The glowing lens surface. */
    this.visor = new Mesh(g.visor, this.visorMaterial);
    this.visor.scale.set(0.94, 0.82, 1.4);
    this.visor.position.z = 0.008;
    this.glasses.add(this.visor);
  }

  /**
   * Puts a rugged tablet in the engineer's left hand.
   * @private
   */
  #createTablet() {
    const g = getGeometry();

    /** @type {Group} */
    this.tablet = new Group();
    const shell = new Mesh(g.tablet, this.#track(new MeshStandardMaterial({
      color: 0x22262c, roughness: 0.55, metalness: 0.4,
    })));
    shell.rotation.x = -0.35;
    this.tablet.add(shell);

    /** @type {Mesh} Emissive screen; brightens with the glasses. */
    this.tabletScreen = new Mesh(g.screen, this.#track(new MeshBasicMaterial({
      color: 0x2f9fd8, transparent: true, opacity: 0.55,
    })));
    this.tabletScreen.rotation.x = -Math.PI / 2 - 0.35;
    this.tabletScreen.position.set(0, 0.012, 0);
    this.tablet.add(this.tabletScreen);

    // Held in the left hand, angled up toward the face.
    this.tablet.position.set(0, -0.1, 0.06);
    this.tablet.rotation.set(0.3, 0, 0.15);
    this.arms[0].wrist.add(this.tablet);
  }

  /* ------------------------------------------------------------- control */

  /**
   * Selects the behaviour the engineer blends toward.
   * @param {'idle'|'work'|'tablet'|'walk'} pose Behaviour name.
   */
  setPose(pose) {
    this.pose = pose;
  }

  /**
   * Places the engineer.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} [yaw] Facing angle in radians.
   * @returns {Engineer} This engineer, for chaining.
   */
  placeAt(x, y, z, yaw = 0) {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    return this;
  }

  /**
   * Sets a walking route. The engineer follows it at {@link speed}, turning to
   * face each leg of the journey, and stops at the final waypoint.
   * @param {Array<[number, number, number]>} points Waypoints.
   * @param {object} [options] Options.
   * @param {number} [options.speed] Walking speed in metres per second.
   * @param {boolean} [options.loop] Restart at the first waypoint when done.
   */
  walkRoute(points, options = {}) {
    this.path = points.map(([x, y, z]) => new Vector3(x, y, z));
    this.pathIndex = 0;
    this.speed = options.speed ?? 1.15;
    this.loopPath = options.loop ?? false;
    if (this.path.length) this.group.position.copy(this.path[0]);
    this.setPose('walk');
  }

  /**
   * Turns the head toward a world-space point.
   * @param {?Vector3} point Target, or null to release.
   */
  lookAt(point) {
    this.lookTarget = point ? point.clone() : null;
  }

  /**
   * Powers the mixed-reality glasses up or down.
   * @param {boolean} on Whether the glasses are active.
   */
  setGlasses(on) {
    this.targetGlassesPower = on ? 1 : 0;
  }

  /* -------------------------------------------------------------- update */

  /**
   * Advances every animation layer.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    this.time += dt;
    const t = this.time;
    const s = this.seed;

    // Blend weights, so behaviour changes are transitions rather than cuts.
    this.walkBlend = damp(this.walkBlend, this.pose === 'walk' ? 1 : 0, 3.2, dt);
    this.workBlend = damp(this.workBlend, this.pose === 'work' ? 1 : 0, 2.4, dt);
    this.tabletBlend = damp(this.tabletBlend, this.pose === 'tablet' ? 1 : 0, 2.4, dt);

    if (this.pose === 'walk') this.#advanceAlongPath(dt);

    this.#animateBreathing(t, s);
    this.#animateWeightShift(t, s, dt);
    this.#animateHead(t, s, dt);
    this.#animateArms(t, s);
    this.#animateLegs(t, s);
    this.#animateGlasses(t, dt);
  }

  /**
   * Moves the engineer along their route.
   * @param {number} dt Delta time in seconds.
   * @private
   */
  #advanceAlongPath(dt) {
    if (this.pathIndex >= this.path.length - 1) {
      if (this.loopPath && this.path.length > 1) this.pathIndex = 0;
      else { this.setPose('idle'); return; }
    }

    const from = this.group.position;
    const to = this.path[this.pathIndex + 1];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dz);

    if (distance < 0.06) {
      this.pathIndex++;
      return;
    }

    const step = Math.min(distance, this.speed * dt);
    from.x += (dx / distance) * step;
    from.z += (dz / distance) * step;

    // Turn to face the direction of travel, easing so the turn is not robotic.
    this.group.rotation.y = dampAngle(
      this.group.rotation.y, Math.atan2(dx, dz), 3.5, dt,
    );

    // Gait phase advances with distance covered, not with time, so the feet
    // never slide regardless of speed changes.
    this.gait += (step / 0.72) * Math.PI;

    // Vertical bob: two peaks per stride, at half the stride amplitude.
    this.group.position.y = Math.abs(Math.sin(this.gait)) * 0.022 * this.scale;
  }

  /**
   * Breathing: the chest expands and the shoulders lift very slightly.
   * @param {number} t Time.
   * @param {number} s Seed.
   * @private
   */
  #animateBreathing(t, s) {
    const rate = 0.26 + (s % 3) * 0.02;              // ~15 breaths per minute
    const cycle = Math.sin(t * TAU * rate + s);
    const depth = lerp(1, 1.6, this.walkBlend);      // deeper when moving

    this.chestMesh.scale.set(
      1 + cycle * 0.012 * depth,
      1 + cycle * 0.018 * depth,
      1 + cycle * 0.016 * depth,
    );
    this.chest.position.y = 0.34 + cycle * 0.006 * depth;
  }

  /**
   * Weight shifting: a slow, irregular transfer from one leg to the other,
   * with the pelvis dropping on the unloaded side.
   * @param {number} t Time.
   * @param {number} s Seed.
   * @param {number} dt Delta time.
   * @private
   */
  #animateWeightShift(t, s, dt) {
    const standing = 1 - this.walkBlend;

    // Layered noise at unrelated periods: the result never visibly repeats.
    const shift = (noise1D(t * 0.13 + s * 3.7) * 0.6 + noise1D(t * 0.047 + s) * 0.4) * standing;

    this.hips.position.x = damp(this.hips.position.x, shift * 0.045, 2.2, dt);
    this.hips.rotation.z = damp(this.hips.rotation.z, -shift * 0.055, 2.2, dt);
    this.hips.rotation.y = damp(this.hips.rotation.y, shift * 0.06, 1.8, dt);

    // The spine counter-rotates to keep the head over the feet.
    this.spine.rotation.z = damp(this.spine.rotation.z, shift * 0.03, 2.0, dt);
    this.spine.rotation.x = damp(
      this.spine.rotation.x,
      this.workBlend * 0.22 + this.tabletBlend * 0.1,
      2.0, dt,
    );
  }

  /**
   * Head motion: micro-corrections around a target, or idle scanning.
   * @param {number} t Time.
   * @param {number} s Seed.
   * @param {number} dt Delta time.
   * @private
   */
  #animateHead(t, s, dt) {
    let yaw = noise1D(t * 0.21 + s * 5.1) * 0.22;
    let pitch = noise1D(t * 0.17 + s * 2.3) * 0.1;

    if (this.lookTarget) {
      // Convert the world target into the chest's local frame so the neck
      // rotation stays correct however the body is turned.
      const local = this.chest.worldToLocal(this.lookTarget.clone());
      yaw = clamp(Math.atan2(local.x, local.z), -0.95, 0.95);
      pitch = clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)), -0.5, 0.5);
      // Even when locked on, a real head is never perfectly still.
      yaw += noise1D(t * 0.9 + s) * 0.02;
      pitch += noise1D(t * 1.1 + s * 2) * 0.015;
    } else if (this.pose === 'tablet') {
      pitch = 0.36 + noise1D(t * 0.4 + s) * 0.05;
      yaw *= 0.4;
    } else if (this.pose === 'work') {
      pitch = 0.2 + noise1D(t * 0.5 + s) * 0.06;
      yaw = -0.25 + noise1D(t * 0.3 + s * 4) * 0.12;
    }

    this.head.rotation.y = dampAngle(this.head.rotation.y, yaw, 3.0, dt);
    this.head.rotation.x = damp(this.head.rotation.x, pitch, 3.0, dt);
    this.head.rotation.z = damp(this.head.rotation.z, noise1D(t * 0.3 + s * 9) * 0.05, 2.0, dt);
  }

  /**
   * Arm motion: hanging sway when idle, counter-swing when walking, a reach
   * into the engine when working, and a supported hold when on the tablet.
   * @param {number} t Time.
   * @param {number} s Seed.
   * @private
   */
  #animateArms(t, s) {
    const swing = Math.sin(this.gait) * 0.55 * this.walkBlend;

    this.arms.forEach((arm, i) => {
      const side = arm.side;
      const phase = s + i * 3.3;

      // Idle: arms hang with a small outward splay and a slow drift.
      const idlePitch = noise1D(t * 0.19 + phase) * 0.09;
      const idleRoll = side * (0.09 + noise1D(t * 0.11 + phase) * 0.03);
      const idleElbow = -0.24 + noise1D(t * 0.23 + phase) * 0.07;

      // Walking: arms counter-swing against the legs.
      const walkPitch = -swing * side;

      // Working: the right arm reaches forward and up into the fan case.
      const isReaching = side > 0;
      const workPitch = isReaching ? -1.28 : -0.34;
      const workRoll = isReaching ? -0.34 : 0.16;
      const workElbow = isReaching ? -0.95 : -0.5;
      // A small circular motion, as if fastening something.
      const workDetail = isReaching ? Math.sin(t * 1.9 + s) * 0.12 : 0;

      // Tablet: left arm supports it, right arm taps.
      const isHolding = side < 0;
      const tabletPitch = isHolding ? -0.82 : -0.62;
      const tabletRoll = isHolding ? 0.26 : -0.3;
      const tabletElbow = isHolding ? -1.35 : -1.5;
      const tabletDetail = isHolding ? 0 : Math.max(0, Math.sin(t * 2.4 + s * 3)) * 0.22;

      const w = this.workBlend;
      const b = this.tabletBlend;
      const base = 1 - Math.min(1, w + b);

      arm.shoulder.rotation.x =
        base * (idlePitch + walkPitch) + w * (workPitch + workDetail) + b * (tabletPitch - tabletDetail);
      arm.shoulder.rotation.z = base * idleRoll + w * workRoll * side * -1 + b * tabletRoll * side * -1;
      arm.elbow.rotation.x = base * idleElbow + w * workElbow + b * tabletElbow;
      arm.wrist.rotation.x = base * 0.05 + w * -0.2 + b * 0.35;
    });
  }

  /**
   * Leg motion: a stride cycle when walking, a relaxed stance otherwise.
   * @param {number} t Time.
   * @param {number} s Seed.
   * @private
   */
  #animateLegs(t, s) {
    const walk = this.walkBlend;
    const stand = 1 - walk;

    this.legs.forEach((leg, i) => {
      const phase = this.gait + (i === 0 ? 0 : Math.PI);
      const swing = Math.sin(phase);
      const lift = Math.max(0, Math.sin(phase));

      // Walking: hip swings, knee bends on the recovery half of the stride.
      const walkHip = swing * 0.55;
      const walkKnee = -lift * 0.95 - 0.08;
      const walkAnkle = -swing * 0.22 + 0.1;

      // Standing: one leg carries the weight, the other is slightly bent.
      const relax = noise1D(t * 0.09 + s * 2.7 + i * 4) * 0.5 + 0.5;
      const standHip = (i === 0 ? relax : 1 - relax) * -0.1;
      const standKnee = -(i === 0 ? relax : 1 - relax) * 0.2 - 0.03;

      leg.hip.rotation.x = walk * walkHip + stand * standHip;
      leg.knee.rotation.x = walk * walkKnee + stand * standKnee;
      leg.ankle.rotation.x = walk * walkAnkle + stand * 0.03;
    });
  }

  /**
   * Glasses power-up: the visor flickers as it boots, then settles into a
   * steady glow with a slow refresh shimmer.
   * @param {number} t Time.
   * @param {number} dt Delta time.
   * @private
   */
  #animateGlasses(t, dt) {
    this.glassesPower = damp(this.glassesPower, this.targetGlassesPower, 2.6, dt);
    if (!this.visor) return;

    const p = this.glassesPower;
    // Boot flicker only while ramping; steady once powered.
    const boot = p < 0.92 ? (noise1D(t * 22) * 0.5 + 0.5) : 1;
    const shimmer = 0.86 + 0.14 * Math.sin(t * 3.1 + this.seed);

    this.visorMaterial.opacity = saturate(p * boot * shimmer * 0.92);
    if (this.tabletScreen) {
      this.tabletScreen.material.opacity = 0.35 + p * 0.45;
    }
  }

  /** Releases materials owned by this engineer. Shared geometry is not freed. */
  dispose() {
    for (const m of this._materials) m.dispose();
    this._materials.clear();
  }
}
