/**
 * @file Hangar.js
 * @description The physical environment — a working aircraft maintenance bay.
 *
 * Everything here is parametric geometry. The building is deliberately built
 * from few, large, merged meshes: the roof trusses are one instanced draw, the
 * railings are one merged buffer, the practical fixtures are one instanced
 * draw. Draw-call discipline in the static set is what leaves headroom for the
 * holographic layer, which is the part the audience actually looks at.
 *
 * Scale is honest. The bay is 60 m × 80 m with an 18 m ceiling, the engine
 * stands 2.6 m off the floor on its stand, and the maintenance platform's
 * handrail sits at 1.1 m — so a viewer at 1.68 m eye height reads the space
 * as a real building rather than a diorama.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  ConeGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTexture, createCanvas, MONO_FONT, trackedText, UI_FONT } from '../engine/TextureFactory.js';
import { createAtmosphereMaterial } from '../effects/Glow.js';
import { createRandom } from '../engine/Utils.js';

/** Interior dimensions of the bay, in metres. */
const BAY = { width: 60, depth: 80, height: 18 };

/**
 * Builds and owns the hangar environment.
 * @class
 */
export class Hangar {
  /**
   * @param {import('../engine/AssetManager.js').AssetManager} assets Asset registry.
   */
  constructor(assets) {
    /** @type {import('../engine/AssetManager.js').AssetManager} */
    this.assets = assets;
    /** @type {Group} Scene graph node for the whole environment. */
    this.group = new Group();
    this.group.name = 'Hangar';

    /** @type {function(): number} Deterministic RNG, so the set never changes. */
    this.random = createRandom(0x4a1f77);

    /** @type {Set<import('three').BufferGeometry>} Geometries to dispose. */
    this._geometries = new Set();
    /** @type {Set<import('three').Material>} Materials to dispose. */
    this._materials = new Set();

    this.#createMaterials();
    this.#createAtmosphere();
    this.#createFloor();
    this.#createShell();
    this.#createTrusses();
    this.#createCeilingFixtures();
    this.#createHangarDoor();
    this.#createWallStrips();
    this.#createSignage();
    this.#createPlatform();
    this.#createGroundEquipment();
  }

  /**
   * Creates the shared material set. Reusing a handful of materials across
   * hundreds of meshes keeps the shader program count in single digits.
   * @private
   */
  #createMaterials() {
    const env = this.assets.get('env.default');

    /** @type {MeshStandardMaterial} Painted structural steel. */
    this.steel = this.#track(new MeshStandardMaterial({
      color: 0x39424f,
      map: this.assets.get('metal.structure.map'),
      roughnessMap: this.assets.get('metal.structure.roughness'),
      roughness: 0.72,
      metalness: 0.82,
      envMap: env,
      envMapIntensity: 0.5,
    }));

    /** @type {MeshStandardMaterial} Darker wall panelling. */
    this.panel = this.#track(new MeshStandardMaterial({
      color: 0x1b222c,
      roughness: 0.86,
      metalness: 0.35,
      envMap: env,
      envMapIntensity: 0.28,
      side: DoubleSide,
    }));

    /** @type {MeshStandardMaterial} Safety yellow. */
    this.hazard = this.#track(new MeshStandardMaterial({
      color: 0xc9a227,
      roughness: 0.62,
      metalness: 0.2,
      envMap: env,
      envMapIntensity: 0.4,
    }));

    /** @type {MeshStandardMaterial} Safety orange for cones. */
    this.cone = this.#track(new MeshStandardMaterial({
      color: 0xd2521f,
      roughness: 0.78,
      metalness: 0.05,
    }));

    /** @type {MeshStandardMaterial} Rubberised black. */
    this.rubber = this.#track(new MeshStandardMaterial({
      color: 0x0e1116,
      roughness: 0.95,
      metalness: 0.0,
    }));

    /** @type {MeshBasicMaterial} Cool emissive for fixtures and strips. */
    this.emissiveCool = this.#track(new MeshBasicMaterial({ color: 0xbcdcff }));
    /** @type {MeshBasicMaterial} Dim blue emissive for wayfinding strips. */
    this.emissiveBlue = this.#track(new MeshBasicMaterial({ color: 0x2f7db8 }));

    /**
     * Emissive materials ignore scene lighting entirely, so the fixture lenses
     * and wayfinding strips would stay lit through a blackout. They are indexed
     * here with their full-power colour so the story can dim them in step with
     * the lamps they represent.
     * @type {Array<{material: MeshBasicMaterial, base: import('three').Color}>}
     */
    this.emissives = [
      { material: this.emissiveCool, base: this.emissiveCool.color.clone() },
      { material: this.emissiveBlue, base: this.emissiveBlue.color.clone() },
    ];
    /** @type {number} Current emissive level, 0–1. */
    this.emissiveLevel = 1;
    this.setEmissiveLevel(0);
  }

  /**
   * Sets how brightly the hangar's own fixtures burn.
   * @param {number} value Level, 0 = extinguished, 1 = full power.
   */
  setEmissiveLevel(value) {
    if (Math.abs(value - this.emissiveLevel) < 1e-3) return;
    this.emissiveLevel = value;
    for (const { material, base } of this.emissives) {
      material.color.copy(base).multiplyScalar(value);
    }
  }

  /**
   * Registers a material for disposal and returns it.
   * @template {import('three').Material} T
   * @param {T} material Material to track.
   * @returns {T}
   * @private
   */
  #track(material) {
    this._materials.add(material);
    return material;
  }

  /**
   * Registers a geometry for disposal and returns it.
   * @template {import('three').BufferGeometry} T
   * @param {T} geometry Geometry to track.
   * @returns {T}
   * @private
   */
  #trackGeo(geometry) {
    this._geometries.add(geometry);
    return geometry;
  }

  /**
   * The gradient dome that the fog fades into.
   * @private
   */
  #createAtmosphere() {
    const material = createAtmosphereMaterial({ top: 0x03070d, bottom: 0x0a1826 });
    this._materials.add(material);
    const geometry = this.#trackGeo(new SphereGeometry(150, 24, 16));
    const dome = new Mesh(geometry, material);
    dome.name = 'Atmosphere';
    dome.frustumCulled = false;
    this.group.add(dome);
  }

  /**
   * The polished concrete slab. Its high `metalness` with a varied roughness
   * map is what produces the wet-looking reflections of the practicals — the
   * single most valuable pixel in the whole environment.
   * @private
   */
  #createFloor() {
    const material = this.#track(new MeshStandardMaterial({
      color: 0x1e2530,
      map: this.assets.get('floor.map'),
      roughnessMap: this.assets.get('floor.roughness'),
      roughness: 0.4,
      metalness: 0.55,
      envMap: this.assets.get('env.default'),
      envMapIntensity: 0.42,
    }));

    const geometry = this.#trackGeo(new PlaneGeometry(BAY.width * 2, BAY.depth * 2));
    /** @type {Mesh} */
    this.floor = new Mesh(geometry, material);
    this.floor.name = 'Floor';
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.group.add(this.floor);
  }

  /**
   * Walls and ceiling.
   * @private
   */
  #createShell() {
    const { width, depth, height } = BAY;
    const parts = [];

    /**
     * Adds a wall panel to the merge list.
     * @param {number} w Width.
     * @param {number} h Height.
     * @param {number} d Depth.
     * @param {number} x Centre X.
     * @param {number} y Centre Y.
     * @param {number} z Centre Z.
     */
    const wall = (w, h, d, x, y, z) => {
      const g = new BoxGeometry(w, h, d);
      g.translate(x, y, z);
      parts.push(g);
    };

    wall(0.6, height, depth, -width / 2, height / 2, 0);       // left
    wall(0.6, height, depth, width / 2, height / 2, 0);        // right
    wall(width, height, 0.6, 0, height / 2, -depth / 2);       // back
    wall(width, 0.8, depth, 0, height, 0);                      // ceiling

    const merged = this.#trackGeo(mergeGeometries(parts, false));
    parts.forEach((g) => g.dispose());

    const shell = new Mesh(merged, this.panel);
    shell.name = 'Shell';
    shell.receiveShadow = true;
    this.group.add(shell);
  }

  /**
   * Roof trusses — one instanced draw for the whole roof structure.
   * @private
   */
  #createTrusses() {
    const { width, depth, height } = BAY;
    const spans = 9;
    const membersPerSpan = 13;
    const total = spans * membersPerSpan;

    const geometry = this.#trackGeo(new BoxGeometry(1, 0.28, 0.28));
    /** @type {InstancedMesh} */
    this.trusses = new InstancedMesh(geometry, this.steel, total);
    this.trusses.name = 'RoofTrusses';
    this.trusses.frustumCulled = false;

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const axisZ = new Vector3(0, 0, 1);

    let i = 0;
    for (let s = 0; s < spans; s++) {
      const z = -depth / 2 + 6 + s * ((depth - 12) / (spans - 1));
      const y = height - 1.6;

      // Bottom chord.
      position.set(0, y, z);
      quaternion.identity();
      scale.set(width, 1, 1);
      this.trusses.setMatrixAt(i++, matrix.compose(position, quaternion, scale));

      // Top chord.
      position.set(0, y + 1.15, z);
      scale.set(width * 0.92, 0.8, 0.8);
      this.trusses.setMatrixAt(i++, matrix.compose(position, quaternion, scale));

      // Alternating diagonal web members.
      const webs = membersPerSpan - 2;
      for (let w = 0; w < webs; w++) {
        const t = w / (webs - 1);
        const x = -width / 2 + 3 + t * (width - 6);
        position.set(x, y + 0.58, z);
        quaternion.setFromAxisAngle(axisZ, (w % 2 === 0 ? 1 : -1) * 0.82);
        scale.set(1.7, 0.55, 0.55);
        this.trusses.setMatrixAt(i++, matrix.compose(position, quaternion, scale));
      }
    }

    this.trusses.count = i;
    this.trusses.instanceMatrix.needsUpdate = true;
    this.group.add(this.trusses);
  }

  /**
   * Ceiling light fixtures: an instanced housing plus an instanced emissive
   * lens. The lights themselves live in {@link LightRig}; these are the
   * physical objects that motivate them.
   * @private
   */
  #createCeilingFixtures() {
    const { depth, height } = BAY;
    const rows = 3;
    const perRow = 2;
    const count = rows * perRow;

    const housingGeo = this.#trackGeo(new BoxGeometry(2.4, 0.42, 1.1));
    const lensGeo = this.#trackGeo(new BoxGeometry(2.1, 0.08, 0.85));

    /** @type {InstancedMesh} */
    this.fixtures = new InstancedMesh(housingGeo, this.steel, count);
    /** @type {InstancedMesh} */
    this.fixtureLenses = new InstancedMesh(lensGeo, this.emissiveCool, count);
    this.fixtures.name = 'CeilingFixtures';
    this.fixtureLenses.name = 'CeilingLenses';

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);

    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < perRow; c++) {
        const x = c === 0 ? -(7.5 + r * 1.2) : (7.5 + r * 1.2);
        const z = -depth / 2 + 28 + r * 12;
        position.set(x, height - 6.2, z);
        this.fixtures.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        position.y -= 0.24;
        this.fixtureLenses.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        i++;
      }
    }

    this.fixtures.instanceMatrix.needsUpdate = true;
    this.fixtureLenses.instanceMatrix.needsUpdate = true;
    this.group.add(this.fixtures, this.fixtureLenses);
  }

  /**
   * The main hangar door: vertical slats with a faint line of daylight leaking
   * around the seal. That thin bright edge is what tells the eye the building
   * has an outside.
   * @private
   */
  #createHangarDoor() {
    const { width, depth, height } = BAY;
    const group = new Group();
    group.name = 'HangarDoor';
    group.position.set(0, 0, depth / 2 - 0.4);

    const slats = [];
    const slatCount = 26;
    for (let i = 0; i < slatCount; i++) {
      const g = new BoxGeometry(width / slatCount - 0.06, height - 0.4, 0.5);
      g.translate(-width / 2 + (i + 0.5) * (width / slatCount), (height - 0.4) / 2, 0);
      slats.push(g);
    }
    const merged = this.#trackGeo(mergeGeometries(slats, false));
    slats.forEach((g) => g.dispose());

    const door = new Mesh(merged, this.#track(new MeshStandardMaterial({
      color: 0x232c37,
      roughness: 0.78,
      metalness: 0.55,
      envMap: this.assets.get('env.default'),
      envMapIntensity: 0.3,
    })));
    door.receiveShadow = true;
    group.add(door);

    // Cold daylight bleeding through the floor seal.
    const seamGeo = this.#trackGeo(new PlaneGeometry(width - 2, 0.14));
    const seam = new Mesh(seamGeo, this.#track(new MeshBasicMaterial({
      color: 0x6d9ec9, transparent: true, opacity: 0.55,
    })));
    seam.position.set(0, 0.07, -0.3);
    group.add(seam);

    // Hazard stripe across the door's lower edge.
    const stripeGeo = this.#trackGeo(new BoxGeometry(width - 1, 0.5, 0.08));
    const stripe = new Mesh(stripeGeo, this.hazard);
    stripe.position.set(0, 1.3, -0.32);
    group.add(stripe);

    this.group.add(group);
    /** @type {Group} */
    this.door = group;
  }

  /**
   * Blue LED wayfinding strips running the length of both side walls. They
   * give the long walls a readable perspective line in near-darkness.
   * @private
   */
  #createWallStrips() {
    const { width, depth } = BAY;
    const parts = [];
    for (const side of [-1, 1]) {
      for (const y of [1.15, 4.6]) {
        const g = new BoxGeometry(0.12, 0.09, depth - 8);
        g.translate(side * (width / 2 - 0.4), y, 0);
        parts.push(g);
      }
    }
    const merged = this.#trackGeo(mergeGeometries(parts, false));
    parts.forEach((g) => g.dispose());

    const strips = new Mesh(merged, this.emissiveBlue);
    strips.name = 'WallStrips';
    this.group.add(strips);
  }

  /**
   * Wall signage. The bay designation is painted on the left wall — a small
   * piece of world-building that makes the space feel operated rather than
   * modelled.
   * @private
   */
  #createSignage() {
    const { canvas, ctx } = createCanvas(1024, 256);

    ctx.fillStyle = '#11161d';
    ctx.fillRect(0, 0, 1024, 256);
    ctx.strokeStyle = 'rgba(180,205,235,0.28)';
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, 1008, 240);

    ctx.fillStyle = '#c9d8ea';
    ctx.font = `300 92px ${UI_FONT}`;
    trackedText(ctx, 'BAY 04', 40, 122, 10, 'left');

    ctx.fillStyle = 'rgba(140,170,200,0.75)';
    ctx.font = `500 30px ${MONO_FONT}`;
    trackedText(ctx, 'WIDEBODY MAINTENANCE', 44, 182, 6, 'left');

    ctx.fillStyle = '#c9a227';
    ctx.fillRect(700, 60, 280, 8);
    ctx.font = `500 34px ${MONO_FONT}`;
    trackedText(ctx, 'EYE PROTECTION', 700, 130, 3, 'left');
    trackedText(ctx, 'REQUIRED', 700, 178, 3, 'left');

    const texture = canvasTexture(canvas);
    const material = this.#track(new MeshStandardMaterial({
      map: texture,
      roughness: 0.9,
      metalness: 0.1,
      emissive: 0x1a2634,
      emissiveIntensity: 0.35,
    }));
    this._materials.add(material);

    const geometry = this.#trackGeo(new PlaneGeometry(8, 2));
    const sign = new Mesh(geometry, material);
    sign.name = 'BaySign';
    sign.position.set(-BAY.width / 2 + 0.35, 5.6, -6);
    sign.rotation.y = Math.PI / 2;
    this.group.add(sign);

    /** @type {import('three').Texture} */
    this._signTexture = texture;
  }

  /**
   * The maintenance platform: deck, legs, stairs and railings, all merged into
   * two meshes.
   * @private
   */
  #createPlatform() {
    const group = new Group();
    group.name = 'MaintenancePlatform';
    group.position.set(-4.6, 0, 0.4);

    const deckW = 3.2;
    const deckD = 6.4;
    const deckH = 1.9;

    // Deck and structure.
    const structure = [];
    const deck = new BoxGeometry(deckW, 0.16, deckD);
    deck.translate(0, deckH, 0);
    structure.push(deck);

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new BoxGeometry(0.16, deckH, 0.16);
        leg.translate(sx * (deckW / 2 - 0.2), deckH / 2, sz * (deckD / 2 - 0.2));
        structure.push(leg);
        const brace = new BoxGeometry(0.1, 0.1, deckD - 0.6);
        brace.translate(sx * (deckW / 2 - 0.2), 0.6, 0);
        structure.push(brace);
      }
    }

    // Stairs on the near end.
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const step = new BoxGeometry(1.1, 0.08, 0.3);
      step.translate(0, 0.3 + i * ((deckH - 0.3) / steps), deckD / 2 + 0.35 + i * 0.3);
      structure.push(step);
    }

    const structureGeo = this.#trackGeo(mergeGeometries(structure, false));
    structure.forEach((g) => g.dispose());
    const structureMesh = new Mesh(structureGeo, this.steel);
    structureMesh.castShadow = true;
    structureMesh.receiveShadow = true;
    group.add(structureMesh);

    // Railings in hazard yellow.
    const rails = [];
    const railH = [0.55, 1.1];
    for (const h of railH) {
      const side = new BoxGeometry(0.06, 0.06, deckD);
      side.translate(-deckW / 2 + 0.08, deckH + h, 0);
      rails.push(side);
      const back = new BoxGeometry(deckW, 0.06, 0.06);
      back.translate(0, deckH + h, -deckD / 2 + 0.08);
      rails.push(back);
    }
    for (let i = 0; i < 6; i++) {
      const post = new BoxGeometry(0.06, 1.1, 0.06);
      post.translate(-deckW / 2 + 0.08, deckH + 0.55, -deckD / 2 + 0.4 + i * ((deckD - 0.8) / 5));
      rails.push(post);
    }
    const railGeo = this.#trackGeo(mergeGeometries(rails, false));
    rails.forEach((g) => g.dispose());
    const railMesh = new Mesh(railGeo, this.hazard);
    railMesh.castShadow = true;
    group.add(railMesh);

    this.group.add(group);
    /** @type {Group} */
    this.platform = group;
    /** @type {Vector3} World position of the platform deck, for staging. */
    this.platformDeck = new Vector3(-4.6, deckH + 0.16, 0.4);
  }

  /**
   * Ground support equipment: safety cones, a tool chest, a hydraulic jack and
   * a cable reel. These are what make the bay read as in-use.
   * @private
   */
  #createGroundEquipment() {
    const group = new Group();
    group.name = 'GroundEquipment';

    /* ------------------------------------------------------------- cones */

    const conePositions = [
      [3.6, 0, 4.2], [-3.6, 0, 4.4], [4.4, 0, -3.4], [-4.6, 0, -3.8],
      [5.6, 0, 1.2], [-6.2, 0, 2.6], [6.4, 0, 4.6], [-7.0, 0, 5.2],
    ];

    const coneGeo = this.#trackGeo(new ConeGeometry(0.24, 0.62, 12));
    const coneBaseGeo = this.#trackGeo(new BoxGeometry(0.46, 0.05, 0.46));
    const coneBandGeo = this.#trackGeo(new CylinderGeometry(0.105, 0.135, 0.085, 12));

    const cones = new InstancedMesh(coneGeo, this.cone, conePositions.length);
    const bases = new InstancedMesh(coneBaseGeo, this.rubber, conePositions.length);
    const bands = new InstancedMesh(coneBandGeo, this.emissiveCool, conePositions.length);
    cones.name = 'SafetyCones';

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);

    conePositions.forEach(([x, , z], i) => {
      quaternion.setFromAxisAngle(new Vector3(0, 1, 0), this.random() * Math.PI);
      position.set(x, 0.33, z);
      cones.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      position.set(x, 0.025, z);
      bases.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      position.set(x, 0.34, z);
      bands.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });

    cones.instanceMatrix.needsUpdate = true;
    bases.instanceMatrix.needsUpdate = true;
    bands.instanceMatrix.needsUpdate = true;
    cones.castShadow = true;
    group.add(cones, bases, bands);

    /* --------------------------------------------------------- tool chest */

    const chest = new Group();
    const bodyGeo = this.#trackGeo(new BoxGeometry(1.5, 0.95, 0.68));
    const body = new Mesh(bodyGeo, this.#track(new MeshStandardMaterial({
      color: 0x9c1f28, roughness: 0.42, metalness: 0.72,
      envMap: this.assets.get('env.default'), envMapIntensity: 0.6,
    })));
    body.position.y = 0.62;
    body.castShadow = true;
    chest.add(body);

    const drawerParts = [];
    for (let i = 0; i < 4; i++) {
      const g = new BoxGeometry(1.36, 0.03, 0.02);
      g.translate(0, 0.28 + i * 0.21, 0.35);
      drawerParts.push(g);
    }
    const drawerGeo = this.#trackGeo(mergeGeometries(drawerParts, false));
    drawerParts.forEach((g) => g.dispose());
    chest.add(new Mesh(drawerGeo, this.steel));

    const casterGeo = this.#trackGeo(new CylinderGeometry(0.09, 0.09, 0.07, 10));
    const casters = new InstancedMesh(casterGeo, this.rubber, 4);
    let ci = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        position.set(sx * 0.6, 0.09, sz * 0.24);
        quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
        casters.setMatrixAt(ci++, matrix.compose(position, quaternion, scale));
      }
    }
    casters.instanceMatrix.needsUpdate = true;
    chest.add(casters);

    chest.position.set(3.9, 0, 2.6);
    chest.rotation.y = -0.4;
    group.add(chest);

    /* ------------------------------------------------------ hydraulic jack */

    const jack = new Group();
    const jackBase = new Mesh(
      this.#trackGeo(new BoxGeometry(1.1, 0.18, 1.1)),
      this.hazard,
    );
    jackBase.position.y = 0.09;
    jackBase.castShadow = true;
    jack.add(jackBase);

    const ram = new Mesh(
      this.#trackGeo(new CylinderGeometry(0.13, 0.16, 1.5, 16)),
      this.#track(new MeshStandardMaterial({
        color: 0xb8c2cc, roughness: 0.22, metalness: 0.95,
        envMap: this.assets.get('env.default'), envMapIntensity: 1.1,
      })),
    );
    ram.position.y = 0.95;
    ram.castShadow = true;
    jack.add(ram);

    const head = new Mesh(this.#trackGeo(new CylinderGeometry(0.3, 0.22, 0.16, 16)), this.steel);
    head.position.y = 1.76;
    jack.add(head);

    jack.position.set(-2.2, 0, -3.4);
    group.add(jack);

    /* ----------------------------------------------------------- cable reel */

    const reel = new Group();
    const drum = new Mesh(
      this.#trackGeo(new CylinderGeometry(0.42, 0.42, 0.5, 20)),
      this.rubber,
    );
    drum.rotation.z = Math.PI / 2;
    drum.position.y = 0.45;
    drum.castShadow = true;
    reel.add(drum);

    const flangeGeo = this.#trackGeo(new CylinderGeometry(0.52, 0.52, 0.04, 20));
    for (const sx of [-0.27, 0.27]) {
      const flange = new Mesh(flangeGeo, this.hazard);
      flange.rotation.z = Math.PI / 2;
      flange.position.set(sx, 0.45, 0);
      reel.add(flange);
    }

    const frameParts = [];
    for (const sx of [-1, 1]) {
      const leg = new BoxGeometry(0.06, 0.9, 0.06);
      leg.translate(sx * 0.38, 0.45, 0);
      frameParts.push(leg);
      const foot = new BoxGeometry(0.08, 0.06, 0.7);
      foot.translate(sx * 0.38, 0.03, 0);
      frameParts.push(foot);
    }
    const frameGeo = this.#trackGeo(mergeGeometries(frameParts, false));
    frameParts.forEach((g) => g.dispose());
    reel.add(new Mesh(frameGeo, this.steel));

    reel.position.set(-5.4, 0, 3.6);
    reel.rotation.y = 0.7;
    group.add(reel);

    this.group.add(group);
    /** @type {Group} */
    this.equipment = group;
  }

  /**
   * The environment is fully static, so this is a no-op — it exists so the
   * scene manager can treat every object uniformly.
   * @param {number} _dt Delta time in seconds.
   */
  update(_dt) {
    /* Static geometry: nothing to advance. */
  }

  /** Releases every GPU resource owned by the hangar. */
  dispose() {
    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) m.dispose();
    this._signTexture?.dispose();
    this._geometries.clear();
    this._materials.clear();
  }
}

/** Interior dimensions, exported for staging calculations. */
export { BAY };
