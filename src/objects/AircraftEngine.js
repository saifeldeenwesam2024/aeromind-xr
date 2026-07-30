/**
 * @file AircraftEngine.js
 * @description The high-bypass turbofan — the subject of the whole story.
 *
 * The engine is generated parametrically: a lathed nacelle with a genuine
 * inlet-lip profile and an internal bypass duct, twenty-four twisted fan blades
 * built from stacked aerofoil sections, an outlet guide vane row, a core cowl
 * and an exhaust cone.
 *
 * Two rendering ideas carry the analytics:
 *
 *   1. **Per-instance blade state.** All twenty-four blades are a single
 *      `InstancedMesh`, and each instance carries `aHighlight` and `aStress`
 *      attributes. Injecting those into the standard material through
 *      `onBeforeCompile` means one draw call can show twenty-four independently
 *      lit blades — which is how blade #7 can go amber, then red, while its
 *      neighbours stay cold, at no rendering cost.
 *
 *   2. **A shared scan uniform.** The nacelle, the blades and the overlay all
 *      read the same `uScanZ` published by {@link ScanBeam}. Surfaces ignite
 *      exactly where the beam intersects them, so the sweep looks like a
 *      measurement passing through the machine rather than a sprite sliding
 *      over it.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { canvasTexture, createCanvas } from '../engine/TextureFactory.js';
import { clamp, damp, lerp, saturate, TAU } from '../engine/Utils.js';
import { Glow } from '../effects/Glow.js';

/** Number of fan blades. A real high-bypass fan runs 18–26. */
export const BLADE_COUNT = 24;
/** Zero-based index of the blade carrying the simulated defect (blade #7). */
export const FAULT_BLADE = 6;

/**
 * Parametric high-bypass turbofan with analytical overlays.
 * @class
 */
export class AircraftEngine {
  /**
   * @param {import('../engine/AssetManager.js').AssetManager} assets Asset registry.
   */
  constructor(assets) {
    /** @type {import('../engine/AssetManager.js').AssetManager} */
    this.assets = assets;

    /** @type {Group} Root node. The engine axis runs along world Z. */
    this.group = new Group();
    this.group.name = 'AircraftEngine';

    /** @type {Group} Rotating assembly: spinner, fan blades and crack marker. */
    this.rotor = new Group();
    this.rotor.name = 'FanRotor';
    this.group.add(this.rotor);

    /** @type {number} Current fan speed in revolutions per minute. */
    this.rpm = 0;
    /** @type {number} Fan speed the engine eases toward. */
    this.targetRpm = 0;
    /** @type {number} Accumulated rotor angle in radians. */
    this.rotorAngle = 0;

    /** @type {Float32Array} Per-blade highlight energy, 0–1. */
    this.bladeHighlight = new Float32Array(BLADE_COUNT);
    /** @type {Float32Array} Per-blade structural stress, 0–1. */
    this.bladeStress = new Float32Array(BLADE_COUNT);
    /** @type {Float32Array} Highlight values the blades ease toward. */
    this._bladeTarget = new Float32Array(BLADE_COUNT);

    /** @type {number} Overlay opacity the engine eases toward. */
    this._overlayTarget = 0;
    /** @type {number} Twin alignment the engine eases toward. */
    this._lockTarget = 0;
    /** @type {number} Crack reveal the engine eases toward. */
    this._faultTarget = 0;

    /** @type {Set<import('three').BufferGeometry>} */
    this._geometries = new Set();
    /** @type {Set<import('three').Material>} */
    this._materials = new Set();

    this.#createMaterials();
    this.#createNacelle();
    this.#createFan();
    this.#createStators();
    this.#createCore();
    this.#createStand();
    this.#createOverlay();
    this.#createFaultMarker();
  }

  /* ===================================================================== */
  /* Materials                                                              */
  /* ===================================================================== */

  /**
   * Builds the physical materials, injecting the per-instance blade state and
   * the shared scan band into the standard shader.
   * @private
   */
  #createMaterials() {
    const env = this.assets.get('env.default');

    /** @type {MeshStandardMaterial} Painted composite nacelle skin. */
    this.cowlMaterial = this.#track(new MeshStandardMaterial({
      color: 0x8f98a3,
      map: this.assets.get('metal.cowling.map'),
      roughnessMap: this.assets.get('metal.cowling.roughness'),
      roughness: 0.42,
      metalness: 0.72,
      envMap: env,
      envMapIntensity: 0.55,
      side: DoubleSide,
    }));
    this.#injectScanBand(this.cowlMaterial);

    /** @type {MeshStandardMaterial} Titanium fan blades. */
    this.bladeMaterial = this.#track(new MeshStandardMaterial({
      color: 0x79828f,
      map: this.assets.get('metal.blade.map'),
      roughnessMap: this.assets.get('metal.blade.roughness'),
      roughness: 0.3,
      metalness: 0.95,
      envMap: env,
      envMapIntensity: 0.75,
      side: DoubleSide,
    }));
    this.#injectBladeState(this.bladeMaterial);

    /** @type {MeshStandardMaterial} Machined hardware. */
    this.hardwareMaterial = this.#track(new MeshStandardMaterial({
      color: 0x5e6773,
      roughness: 0.42,
      metalness: 0.9,
      envMap: env,
      envMapIntensity: 0.55,
    }));

    /** @type {MeshStandardMaterial} Heat-stained hot section. */
    this.hotSectionMaterial = this.#track(new MeshStandardMaterial({
      color: 0x4b4038,
      roughness: 0.52,
      metalness: 0.86,
      envMap: env,
      envMapIntensity: 0.8,
    }));

    /** @type {MeshStandardMaterial} Support stand. */
    this.standMaterial = this.#track(new MeshStandardMaterial({
      color: 0x2f3742,
      map: this.assets.get('metal.structure.map'),
      roughness: 0.7,
      metalness: 0.8,
      envMap: env,
      envMapIntensity: 0.45,
    }));
  }

  /**
   * Registers a material for disposal.
   * @template {import('three').Material} T
   * @param {T} material Material.
   * @returns {T}
   * @private
   */
  #track(material) {
    this._materials.add(material);
    return material;
  }

  /**
   * Registers a geometry for disposal.
   * @template {import('three').BufferGeometry} T
   * @param {T} geometry Geometry.
   * @returns {T}
   * @private
   */
  #trackGeo(geometry) {
    this._geometries.add(geometry);
    return geometry;
  }

  /**
   * Adds the travelling scan band to a standard material.
   *
   * The band is computed from world-space Z, so it lands on the geometry at the
   * plane the beam currently occupies regardless of how the mesh is animated.
   * @param {MeshStandardMaterial} material Material to extend.
   * @private
   */
  #injectScanBand(material) {
    material.userData.uniforms = {
      uScanZ: { value: 999 },
      uScanWidth: { value: 0.22 },
      uScanEnergy: { value: 0 },
      uScanColor: { value: new Color(0x6fe0ff) },
    };

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, material.userData.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          varying float vScanAxis;
        `)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          vScanAxis = (modelMatrix * vec4(transformed, 1.0)).z;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          uniform float uScanZ;
          uniform float uScanWidth;
          uniform float uScanEnergy;
          uniform vec3  uScanColor;
          varying float vScanAxis;
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */ `
          #include <emissivemap_fragment>
          float scanDist = abs(vScanAxis - uScanZ);
          float scanBand = smoothstep(uScanWidth, 0.0, scanDist);
          totalEmissiveRadiance += uScanColor * scanBand * uScanEnergy * 1.6;
        `);
    };

    // Changing `onBeforeCompile` requires a new program key so three does not
    // reuse a cached program compiled without these injections.
    material.customProgramCacheKey = () => 'aeromind-scan-band';
  }

  /**
   * Adds per-instance blade highlight and stress to the blade material.
   * @param {MeshStandardMaterial} material Blade material.
   * @private
   */
  #injectBladeState(material) {
    material.userData.uniforms = {
      uScanZ: { value: 999 },
      uScanWidth: { value: 0.22 },
      uScanEnergy: { value: 0 },
      uScanColor: { value: new Color(0x6fe0ff) },
      /** Blend from inspection blue → caution amber → fault red. */
      uCoolColor: { value: new Color(0x3aa8ff) },
      uWarnColor: { value: new Color(0xffa32e) },
      uFaultColor: { value: new Color(0xff3b46) },
      uTime: { value: 0 },
    };

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, material.userData.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          attribute float aHighlight;
          attribute float aStress;
          varying float vHighlight;
          varying float vStress;
          varying float vScanAxis;
          varying float vSpan;
        `)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          vHighlight = aHighlight;
          vStress = aStress;
          vSpan = uv.y;
          vScanAxis = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).z;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          uniform float uScanZ;
          uniform float uScanWidth;
          uniform float uScanEnergy;
          uniform vec3  uScanColor;
          uniform vec3  uCoolColor;
          uniform vec3  uWarnColor;
          uniform vec3  uFaultColor;
          uniform float uTime;
          varying float vHighlight;
          varying float vStress;
          varying float vScanAxis;
          varying float vSpan;
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */ `
          #include <emissivemap_fragment>

          // Inspection state: cool below 0.5, warm above, saturating to fault.
          vec3 stateColor = mix(uCoolColor, uWarnColor, smoothstep(0.35, 0.75, vStress));
          stateColor = mix(stateColor, uFaultColor, smoothstep(0.75, 1.0, vStress));

          // A fault pulses; a healthy highlight does not.
          float pulse = 1.0 + vStress * 0.45 * sin(uTime * 5.5);

          // Stress concentrates toward the blade root, as it does in reality.
          float rootBias = mix(1.25, 0.55, vSpan);

          totalEmissiveRadiance += stateColor * vHighlight * pulse * rootBias * 1.5;

          float scanDist = abs(vScanAxis - uScanZ);
          float scanBand = smoothstep(uScanWidth, 0.0, scanDist);
          totalEmissiveRadiance += uScanColor * scanBand * uScanEnergy * 2.0;
        `);
    };

    material.customProgramCacheKey = () => 'aeromind-blade-state';
  }

  /* ===================================================================== */
  /* Geometry                                                               */
  /* ===================================================================== */

  /**
   * The nacelle: one closed lathe profile describing the inlet lip, the
   * internal bypass duct, the rear fan-cowl and the outer skin. Drawing it as a
   * single continuous surface rather than separate tubes is what makes the
   * inlet read as an aerodynamic lip instead of a pipe.
   * @private
   */
  #createNacelle() {
    /** Profile points as (radius, axial). +Z is the front of the engine. */
    const profile = [
      // Inner bypass duct, running rearward from the lip.
      [1.52, 2.42], [1.44, 2.16], [1.42, 1.80], [1.44, 1.20], [1.46, 0.40],
      [1.44, -0.40], [1.38, -1.30], [1.30, -2.05], [1.26, -2.42],
      // Rear lip, turning outward.
      [1.34, -2.62], [1.50, -2.70], [1.64, -2.60],
      // Outer skin, running forward.
      [1.76, -2.30], [1.86, -1.60], [1.91, -0.60], [1.92, 0.40],
      [1.89, 1.30], [1.82, 1.92], [1.70, 2.28],
      // Inlet lip, curling back into the duct.
      [1.60, 2.46], [1.52, 2.42],
    ];

    const points = profile.map(([r, y]) => new Vector2(r, y));
    const geometry = this.#trackGeo(new LatheGeometry(points, 72));
    // LatheGeometry revolves about +Y; the engine axis is +Z.
    geometry.rotateX(Math.PI / 2);
    geometry.computeVertexNormals();

    /** @type {Mesh} */
    this.nacelle = new Mesh(geometry, this.cowlMaterial);
    this.nacelle.name = 'Nacelle';
    this.nacelle.castShadow = true;
    this.nacelle.receiveShadow = true;
    this.group.add(this.nacelle);

    // Polished inlet lip ring — the brightest specular on the whole engine.
    const lipGeo = this.#trackGeo(new TorusGeometry(1.56, 0.075, 12, 72));
    const lip = new Mesh(lipGeo, this.#track(new MeshStandardMaterial({
      color: 0x9fa9b5,
      roughness: 0.16,
      metalness: 1.0,
      envMap: this.assets.get('env.default'),
      envMapIntensity: 0.85,
    })));
    lip.position.z = 2.44;
    lip.name = 'InletLip';
    this.group.add(lip);
    /** @type {Mesh} */
    this.inletLip = lip;
  }

  /**
   * The fan: twenty-four twisted blades on a single instanced draw, plus the
   * spinner cone.
   * @private
   */
  #createFan() {
    const geometry = this.#trackGeo(createFanBladeGeometry({
      spanSections: 12,
      chordSections: 16,
      rootRadius: 0.34,
      tipRadius: 1.38,
      rootChord: 0.62,
      tipChord: 0.46,
      rootTwist: 0.95,
      tipTwist: 0.28,
      maxThickness: 0.11,
      sweep: 0.34,
    }));

    // Per-instance analytical state.
    geometry.setAttribute('aHighlight',
      new InstancedBufferAttribute(new Float32Array(BLADE_COUNT), 1));
    geometry.setAttribute('aStress',
      new InstancedBufferAttribute(new Float32Array(BLADE_COUNT), 1));

    /** @type {InstancedMesh} */
    this.blades = new InstancedMesh(geometry, this.bladeMaterial, BLADE_COUNT);
    this.blades.name = 'FanBlades';
    this.blades.castShadow = true;
    this.blades.frustumCulled = false;

    const matrix = new Matrix4();
    const position = new Vector3(0, 0, 0.9);
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const axis = new Vector3(0, 0, 1);

    for (let i = 0; i < BLADE_COUNT; i++) {
      quaternion.setFromAxisAngle(axis, (i / BLADE_COUNT) * TAU);
      this.blades.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    this.blades.instanceMatrix.needsUpdate = true;
    this.rotor.add(this.blades);

    /** @type {InstancedBufferAttribute} */
    this.highlightAttr = geometry.getAttribute('aHighlight');
    /** @type {InstancedBufferAttribute} */
    this.stressAttr = geometry.getAttribute('aStress');

    // Fan hub.
    const hubGeo = this.#trackGeo(new CylinderGeometry(0.36, 0.4, 0.5, 32));
    hubGeo.rotateX(Math.PI / 2);
    const hub = new Mesh(hubGeo, this.hardwareMaterial);
    hub.position.z = 0.9;
    this.rotor.add(hub);

    // Spinner with the anti-icing spiral that every turbofan wears.
    const spinnerGeo = this.#trackGeo(new ConeGeometry(0.34, 1.15, 32, 1, false));
    spinnerGeo.rotateX(Math.PI / 2);
    const spinner = new Mesh(spinnerGeo, this.#track(new MeshStandardMaterial({
      color: 0x9aa3ad,
      map: createSpinnerTexture(),
      roughness: 0.26,
      metalness: 0.95,
      envMap: this.assets.get('env.default'),
      envMapIntensity: 0.8,
    })));
    spinner.position.z = 1.74;
    spinner.name = 'Spinner';
    spinner.castShadow = true;
    this.rotor.add(spinner);
    /** @type {Mesh} */
    this.spinner = spinner;
    this._materials.add(spinner.material);
  }

  /**
   * Outlet guide vanes downstream of the fan — a static row of thin, cambered
   * struts, instanced.
   * @private
   */
  #createStators() {
    const count = 40;
    const geometry = this.#trackGeo(createFanBladeGeometry({
      spanSections: 4,
      chordSections: 8,
      rootRadius: 0.46,
      tipRadius: 1.36,
      rootChord: 0.3,
      tipChord: 0.26,
      rootTwist: -0.42,
      tipTwist: -0.2,
      maxThickness: 0.05,
      sweep: 0.05,
    }));

    /** @type {InstancedMesh} */
    this.stators = new InstancedMesh(geometry, this.hardwareMaterial, count);
    this.stators.name = 'OutletGuideVanes';
    this.stators.frustumCulled = false;

    const matrix = new Matrix4();
    const position = new Vector3(0, 0, 0.05);
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const axis = new Vector3(0, 0, 1);

    for (let i = 0; i < count; i++) {
      quaternion.setFromAxisAngle(axis, (i / count) * TAU + 0.08);
      this.stators.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    this.stators.instanceMatrix.needsUpdate = true;
    this.group.add(this.stators);
  }

  /**
   * The engine core: the inner cowl running back through the bypass duct, and
   * the exhaust cone.
   * @private
   */
  #createCore() {
    const profile = [
      [0.44, 0.30], [0.52, -0.10], [0.58, -0.70], [0.60, -1.40],
      [0.56, -2.10], [0.50, -2.60], [0.44, -2.95],
    ].map(([r, y]) => new Vector2(r, y));

    const coreGeo = this.#trackGeo(new LatheGeometry(profile, 40));
    coreGeo.rotateX(Math.PI / 2);
    const core = new Mesh(coreGeo, this.hardwareMaterial);
    core.name = 'CoreCowl';
    core.castShadow = true;
    this.group.add(core);

    // Exhaust cone, heat-stained.
    const coneGeo = this.#trackGeo(new ConeGeometry(0.42, 1.5, 32));
    coneGeo.rotateX(-Math.PI / 2);
    const cone = new Mesh(coneGeo, this.hotSectionMaterial);
    cone.position.z = -3.55;
    cone.name = 'ExhaustCone';
    this.group.add(cone);

    // Nozzle ring.
    const nozzleGeo = this.#trackGeo(new CylinderGeometry(0.72, 0.66, 0.7, 36, 1, true));
    nozzleGeo.rotateX(Math.PI / 2);
    const nozzle = new Mesh(nozzleGeo, this.hotSectionMaterial);
    nozzle.position.z = -3.1;
    this.group.add(nozzle);

    // Dark interior disc so the duct does not show the far wall through it.
    const backGeo = this.#trackGeo(new CircleGeometry(1.3, 40));
    const back = new Mesh(backGeo, this.#track(new MeshStandardMaterial({
      color: 0x0a0d12, roughness: 1, metalness: 0, side: DoubleSide,
    })));
    back.position.z = -2.35;
    this.group.add(back);
  }

  /**
   * The maintenance stand the engine rests on. Without it the engine would
   * appear to float, and the whole scale illusion would collapse.
   * @private
   */
  #createStand() {
    const stand = new Group();
    stand.name = 'EngineStand';

    const cradleGeo = this.#trackGeo(new TorusGeometry(1.95, 0.11, 8, 28, Math.PI * 0.8));
    for (const z of [1.3, -1.5]) {
      const cradle = new Mesh(cradleGeo, this.standMaterial);
      cradle.rotation.z = Math.PI + Math.PI * 0.1;
      cradle.position.z = z;
      cradle.castShadow = true;
      stand.add(cradle);
    }

    const legGeo = this.#trackGeo(new CylinderGeometry(0.09, 0.11, 2.6, 10));
    for (const [x, z] of [[-1.5, 1.3], [1.5, 1.3], [-1.5, -1.5], [1.5, -1.5]]) {
      const leg = new Mesh(legGeo, this.standMaterial);
      leg.position.set(x, -1.3, z);
      leg.castShadow = true;
      stand.add(leg);
    }

    const railGeo = this.#trackGeo(new CylinderGeometry(0.07, 0.07, 3.2, 8));
    railGeo.rotateX(Math.PI / 2);
    for (const x of [-1.5, 1.5]) {
      const rail = new Mesh(railGeo, this.standMaterial);
      rail.position.set(x, -2.5, -0.1);
      stand.add(rail);
    }

    const footGeo = this.#trackGeo(new CylinderGeometry(0.26, 0.26, 0.12, 12));
    for (const [x, z] of [[-1.5, 1.3], [1.5, 1.3], [-1.5, -1.5], [1.5, -1.5]]) {
      const foot = new Mesh(footGeo, this.standMaterial);
      foot.position.set(x, -2.55, z);
      stand.add(foot);
    }

    this.group.add(stand);
    /** @type {Group} */
    this.stand = stand;
  }

  /**
   * The analytical overlay shell.
   *
   * A second copy of the nacelle and the fan, rendered additively with a mode
   * switch: wireframe digital twin, thermal map, or stress map. It is scaled a
   * hair larger than the physical geometry so it reads as a projection sitting
   * *on* the machine rather than z-fighting with it.
   * @private
   */
  #createOverlay() {
    /** @type {Group} */
    this.overlay = new Group();
    this.overlay.name = 'AnalyticalOverlay';
    this.overlay.visible = false;
    this.group.add(this.overlay);

    /** @type {ShaderMaterial} */
    this.overlayMaterial = this.#createOverlayMaterial(false);
    /** @type {ShaderMaterial} */
    this.overlayBladeMaterial = this.#createOverlayMaterial(true);

    const nacelleOverlay = new Mesh(this.nacelle.geometry, this.overlayMaterial);
    nacelleOverlay.scale.setScalar(1.008);
    nacelleOverlay.renderOrder = 8;
    this.overlay.add(nacelleOverlay);

    /** @type {Group} Rotates with the rotor so blade overlays stay aligned. */
    this.overlayRotor = new Group();
    this.overlay.add(this.overlayRotor);

    const bladeOverlay = new InstancedMesh(
      this.blades.geometry, this.overlayBladeMaterial, BLADE_COUNT,
    );
    bladeOverlay.frustumCulled = false;
    bladeOverlay.renderOrder = 9;
    bladeOverlay.instanceMatrix = this.blades.instanceMatrix;
    this.overlayRotor.add(bladeOverlay);
    /** @type {InstancedMesh} */
    this.bladeOverlay = bladeOverlay;

    /** @type {number} 0 = digital twin, 1 = thermal, 2 = stress. */
    this.overlayMode = 0;
  }

  /**
   * Builds the overlay shader.
   * @param {boolean} instanced Whether the material drives an instanced mesh.
   * @returns {ShaderMaterial}
   * @private
   */
  #createOverlayMaterial(instanced) {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        /** 0 = digital twin, 1 = thermal, 2 = stress. */
        uMode: { value: 0 },
        uRamp: { value: this.assets.get('ramp.thermal') },
        uTwinColor: { value: new Color(0x5fd0ff) },
        /** Alignment progress: 0 = offset and ghosted, 1 = locked. */
        uLock: { value: 0 },
        uScanZ: { value: 999 },
        uScanWidth: { value: 0.22 },
        uScanEnergy: { value: 0 },
      },
      vertexShader: /* glsl */ `
        ${instanced ? 'attribute float aStress;\nattribute float aHighlight;' : ''}
        varying vec2  vUv;
        varying vec3  vWorldPos;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vStress;
        varying float vHighlight;

        uniform float uLock;

        void main() {
          vUv = uv;
          ${instanced ? 'vStress = aStress; vHighlight = aHighlight;' : 'vStress = 0.0; vHighlight = 0.0;'}

          // Before lock, the twin sits slightly offset from the physical part —
          // the misalignment the AI is about to resolve.
          vec3 offset = vec3(0.0, 0.0, 1.0) * (1.0 - uLock) * 0.55
                      + vec3(0.18, 0.12, 0.0) * (1.0 - uLock);

          vec3 p = position + offset;
          ${instanced
            ? 'vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);\n          vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);'
            : 'vec4 world = modelMatrix * vec4(p, 1.0);\n          vNormalW = normalize(mat3(modelMatrix) * normal);'}

          vWorldPos = world.xyz;
          vViewDir = normalize(cameraPosition - world.xyz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float     uTime;
        uniform float     uOpacity;
        uniform float     uMode;
        uniform sampler2D uRamp;
        uniform vec3      uTwinColor;
        uniform float     uLock;
        uniform float     uScanZ;
        uniform float     uScanWidth;
        uniform float     uScanEnergy;

        varying vec2  vUv;
        varying vec3  vWorldPos;
        varying vec3  vNormalW;
        varying vec3  vViewDir;
        varying float vStress;
        varying float vHighlight;

        /** Antialiased contour lines at a fixed world-space spacing. */
        float contour(float value, float spacing) {
          float f = abs(fract(value / spacing - 0.5) - 0.5) / fwidth(value / spacing);
          return 1.0 - min(f, 1.0);
        }

        void main() {
          float fresnel = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 2.1);

          // --- Mode 0: digital twin ----------------------------------------
          // Structural contour lines along the engine axis plus a rim glow.
          float lines = contour(vWorldPos.z, 0.16) * 0.55
                      + contour(vUv.x * 6.2831853, 0.32) * 0.3;
          vec3 twin = uTwinColor * (lines + fresnel * 1.1 + 0.05);

          // --- Mode 1: thermal ---------------------------------------------
          // Heat rises toward the core and the hot section behind the fan.
          float radial = length(vWorldPos.xy);
          float heat = smoothstep(1.9, 0.35, radial) * 0.7
                     + smoothstep(1.2, -2.6, vWorldPos.z) * 0.45
                     + vStress * 0.55;
          heat += sin(uTime * 0.9 + vWorldPos.z * 2.0) * 0.02;
          vec3 thermal = texture2D(uRamp, vec2(clamp(heat, 0.02, 0.98), 0.5)).rgb;
          thermal *= (0.55 + fresnel * 0.9);

          // --- Mode 2: stress ----------------------------------------------
          // Load concentrates at blade roots; contours read like an FEA plot.
          float load = clamp(vStress * 1.15 + (1.0 - vUv.y) * 0.35, 0.0, 1.0);
          vec3 stress = texture2D(uRamp, vec2(clamp(load, 0.02, 0.98), 0.5)).rgb;
          float isoline = contour(load, 0.12) * 0.6;
          stress = stress * (0.5 + fresnel * 0.8) + vec3(isoline) * 0.35;

          // Blend between the three analytical modes.
          vec3 col = mix(twin, thermal, smoothstep(0.0, 1.0, clamp(uMode, 0.0, 1.0)));
          col = mix(col, stress, smoothstep(1.0, 2.0, clamp(uMode, 1.0, 2.0)));

          // Alignment shimmer: unlocked twins flicker as they search for a fit.
          float searching = (1.0 - uLock);
          col *= 1.0 - searching * 0.35 * step(0.5, fract(vWorldPos.y * 14.0 + uTime * 7.0));

          // Shared inspection beam.
          float scanBand = smoothstep(uScanWidth, 0.0, abs(vWorldPos.z - uScanZ));
          col += vec3(0.42, 0.85, 1.0) * scanBand * uScanEnergy * 2.4;

          float alpha = clamp(max(max(col.r, col.g), col.b), 0.0, 1.0) * uOpacity;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    this._materials.add(material);
    return Glow.register(material);
  }

  /**
   * The fault callout on blade #7: a crack glyph, a magnifier ring and a
   * leader line, all parented to the rotor so they travel with the blade.
   * @private
   */
  #createFaultMarker() {
    /** @type {Group} */
    this.faultMarker = new Group();
    this.faultMarker.name = 'FaultMarker';
    this.faultMarker.visible = false;

    // Position at blade #7's root region.
    const angle = (FAULT_BLADE / BLADE_COUNT) * TAU;
    const radius = 0.62;
    this.faultMarker.position.set(
      Math.cos(angle + Math.PI / 2) * radius,
      Math.sin(angle + Math.PI / 2) * radius,
      0.95,
    );
    this.faultMarker.rotation.z = angle;
    this.rotor.add(this.faultMarker);

    // Crack glyph.
    const crackTexture = createCrackTexture();
    this._crackTexture = crackTexture;
    const crackMat = this.#track(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: crackTexture },
        uColor: { value: new Color(0xff4a52) },
        uProgress: { value: 0 },
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
        uniform sampler2D uMap;
        uniform vec3 uColor;
        uniform float uProgress;
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          // The crack draws itself left to right as the analysis resolves.
          float reveal = smoothstep(uProgress + 0.12, uProgress - 0.02, vUv.x);
          float pulse = 0.75 + 0.25 * sin(uTime * 6.0);
          float a = tex.a * reveal * pulse;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor * a * 2.2, a);
        }
      `,
    }));
    Glow.register(crackMat);
    /** @type {ShaderMaterial} */
    this.crackMaterial = crackMat;

    const crackGeo = this.#trackGeo(new PlaneGeometry(0.5, 0.22));
    const crack = new Mesh(crackGeo, crackMat);
    crack.renderOrder = 20;
    this.faultMarker.add(crack);

    // Magnifier ring around the defect.
    const ringGeo = this.#trackGeo(new TorusGeometry(0.34, 0.008, 6, 40));
    const ringMat = this.#track(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(0xff5a63) },
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
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float dashes = step(0.45, fract(vUv.x * 16.0 - uTime * 0.4));
          float a = (0.35 + dashes * 0.65) * uOpacity;
          gl_FragColor = vec4(uColor * a * 2.0, a);
        }
      `,
    }));
    Glow.register(ringMat);
    /** @type {ShaderMaterial} */
    this.faultRingMaterial = ringMat;

    const ring = new Mesh(ringGeo, ringMat);
    ring.renderOrder = 20;
    this.faultMarker.add(ring);
    /** @type {Mesh} */
    this.faultRing = ring;
  }

  /* ===================================================================== */
  /* Public control surface                                                 */
  /* ===================================================================== */

  /**
   * Sets the fan speed the rotor eases toward.
   * @param {number} rpm Target speed in revolutions per minute.
   */
  setSpin(rpm) {
    this.targetRpm = Math.max(0, rpm);
  }

  /**
   * Sets one blade's highlight energy.
   * @param {number} index Blade index, 0-based.
   * @param {number} value Highlight energy, 0–1.
   */
  setBladeHighlight(index, value) {
    if (index < 0 || index >= BLADE_COUNT) return;
    this._bladeTarget[index] = saturate(value);
  }

  /**
   * Sets one blade's structural stress, which drives its colour from blue
   * through amber to red.
   * @param {number} index Blade index, 0-based.
   * @param {number} value Stress, 0–1.
   */
  setBladeStress(index, value) {
    if (index < 0 || index >= BLADE_COUNT) return;
    this.bladeStress[index] = saturate(value);
    this.stressAttr.setX(index, this.bladeStress[index]);
    this.stressAttr.needsUpdate = true;
  }

  /**
   * Runs the sequential blade inspection.
   *
   * As `progress` advances from 0 to 1 the highlight travels around the fan,
   * igniting each blade in turn and leaving a decaying trail — the visual
   * grammar of a machine checking twenty-four items one at a time.
   *
   * @param {number} progress Normalised sweep position, 0–1.
   * @param {number} [trail] How many blades stay lit behind the head.
   */
  sweepBlades(progress, trail = 4) {
    const head = saturate(progress) * BLADE_COUNT;
    for (let i = 0; i < BLADE_COUNT; i++) {
      const behind = head - i;
      let energy = 0;
      if (behind >= 0) {
        energy = behind < 0.9 ? 1 : Math.max(0, 1 - (behind - 0.9) / trail) * 0.42;
      }
      // The faulted blade never dims once it has been found.
      if (i === FAULT_BLADE && behind >= 0) energy = Math.max(energy, 0.85);
      this._bladeTarget[i] = energy;
    }
  }

  /**
   * Clears every blade highlight.
   * @param {boolean} [keepFault] Leave the faulted blade lit.
   */
  clearBlades(keepFault = false) {
    for (let i = 0; i < BLADE_COUNT; i++) {
      this._bladeTarget[i] = keepFault && i === FAULT_BLADE ? 0.85 : 0;
    }
  }

  /**
   * Sets the analytical overlay.
   * @param {'twin'|'thermal'|'stress'} mode Overlay mode.
   */
  setOverlayMode(mode) {
    this.overlayMode = mode === 'thermal' ? 1 : mode === 'stress' ? 2 : 0;
  }

  /**
   * Fades the analytical overlay in or out.
   * @param {number} value Opacity, 0–1.
   */
  setOverlayOpacity(value) {
    this._overlayTarget = saturate(value);
  }

  /**
   * Sets digital-twin alignment: 0 is a ghosted, offset, searching twin; 1 is
   * locked precisely onto the physical engine.
   * @param {number} value Lock progress, 0–1.
   */
  setTwinLock(value) {
    this._lockTarget = saturate(value);
  }

  /**
   * Reveals the crack on blade #7.
   * @param {number} value Reveal progress, 0–1.
   */
  setFaultReveal(value) {
    this._faultTarget = saturate(value);
  }

  /**
   * Subscribes the engine's materials to a scan beam.
   * @param {import('../effects/ScanBeam.js').ScanBeam} beam Beam to follow.
   */
  connectScanBeam(beam) {
    // The two standard materials expose their injected uniforms through
    // `userData`, so they are wrapped to match the subscriber shape.
    beam.subscribe({ uniforms: this.cowlMaterial.userData.uniforms });
    beam.subscribe({ uniforms: this.bladeMaterial.userData.uniforms });
    beam.subscribe(this.overlayMaterial);
    beam.subscribe(this.overlayBladeMaterial);
  }

  /**
   * The world-space position of the faulted blade, used to aim callouts.
   * @param {Vector3} target Vector to write into.
   * @returns {Vector3}
   */
  getFaultPosition(target) {
    this.faultMarker.getWorldPosition(target);
    return target;
  }

  /* ===================================================================== */
  /* Frame update                                                           */
  /* ===================================================================== */

  /**
   * Advances rotation, blade easing and overlay state.
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   */
  update(dt, time) {
    // Spool: a fan's inertia is enormous, so it must ease, never snap.
    this.rpm = damp(this.rpm, this.targetRpm, 0.55, dt);
    if (this.rpm > 0.5) {
      this.rotorAngle = (this.rotorAngle + (this.rpm / 60) * TAU * dt) % TAU;
      this.rotor.rotation.z = this.rotorAngle;
      this.overlayRotor.rotation.z = this.rotorAngle;
    }

    // Blade highlight easing, written straight into the instanced attribute.
    let dirty = false;
    for (let i = 0; i < BLADE_COUNT; i++) {
      const next = damp(this.bladeHighlight[i], this._bladeTarget[i], 7, dt);
      if (Math.abs(next - this.bladeHighlight[i]) > 1e-4) {
        this.bladeHighlight[i] = next;
        this.highlightAttr.setX(i, next);
        dirty = true;
      }
    }
    if (dirty) this.highlightAttr.needsUpdate = true;

    this.bladeMaterial.userData.uniforms.uTime.value = time;

    // Overlay easing.
    const overlayTarget = this._overlayTarget ?? 0;
    const current = this.overlayMaterial.uniforms.uOpacity.value;
    const next = damp(current, overlayTarget, 2.4, dt);
    this.overlayMaterial.uniforms.uOpacity.value = next;
    this.overlayBladeMaterial.uniforms.uOpacity.value = next;
    this.overlay.visible = next > 0.004;

    const modeNow = damp(this.overlayMaterial.uniforms.uMode.value, this.overlayMode, 2.6, dt);
    this.overlayMaterial.uniforms.uMode.value = modeNow;
    this.overlayBladeMaterial.uniforms.uMode.value = modeNow;

    const lockNow = damp(this.overlayMaterial.uniforms.uLock.value, this._lockTarget ?? 0, 1.8, dt);
    this.overlayMaterial.uniforms.uLock.value = lockNow;
    this.overlayBladeMaterial.uniforms.uLock.value = lockNow;

    // Fault marker.
    const faultNow = damp(this.crackMaterial.uniforms.uProgress.value, this._faultTarget ?? 0, 1.6, dt);
    this.crackMaterial.uniforms.uProgress.value = faultNow;
    this.faultRingMaterial.uniforms.uOpacity.value = clamp(faultNow * 1.2, 0, 1);
    this.faultMarker.visible = faultNow > 0.01;
    if (this.faultMarker.visible) {
      const breathe = 1 + Math.sin(time * 2.6) * 0.06;
      this.faultRing.scale.setScalar(breathe);
    }
  }

  /** Releases every GPU resource owned by the engine. */
  dispose() {
    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) { Glow.unregister(m); m.dispose(); }
    this._crackTexture?.dispose();
    this._geometries.clear();
    this._materials.clear();
  }
}

/* ======================================================================= */
/* Geometry generators                                                      */
/* ======================================================================= */

/**
 * Builds a twisted, tapered, swept fan blade from stacked aerofoil sections.
 *
 * The blade is a closed lofted surface: at each station along the span a
 * symmetric aerofoil is generated, scaled to that station's chord, twisted to
 * that station's stagger angle and displaced by the sweep. Consecutive
 * sections are then stitched into quads. Root and tip are capped with fans so
 * the blade is watertight and takes lighting correctly from both sides.
 *
 * The `uv.y` coordinate carries normalised span, which the analytics shaders
 * use to concentrate stress toward the root.
 *
 * @param {object} options Blade parameters.
 * @param {number} options.spanSections Stations along the span.
 * @param {number} options.chordSections Points per surface, per station.
 * @param {number} options.rootRadius Radius at the hub, in metres.
 * @param {number} options.tipRadius Radius at the tip, in metres.
 * @param {number} options.rootChord Chord length at the root.
 * @param {number} options.tipChord Chord length at the tip.
 * @param {number} options.rootTwist Stagger angle at the root, radians.
 * @param {number} options.tipTwist Stagger angle at the tip, radians.
 * @param {number} options.maxThickness Peak thickness/chord ratio.
 * @param {number} options.sweep Rearward tip displacement, in metres.
 * @returns {BufferGeometry}
 */
export function createFanBladeGeometry(options) {
  const {
    spanSections, chordSections,
    rootRadius, tipRadius, rootChord, tipChord,
    rootTwist, tipTwist, maxThickness, sweep,
  } = options;

  const ring = chordSections * 2; // upper surface + lower surface
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  /**
   * Symmetric four-digit aerofoil half-thickness.
   * @param {number} x Normalised chord position, 0–1.
   * @param {number} t Thickness ratio.
   * @returns {number}
   */
  const thickness = (x, t) => 5 * t * (
    0.2969 * Math.sqrt(Math.max(x, 0)) - 0.1260 * x -
    0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x
  );

  for (let s = 0; s <= spanSections; s++) {
    const v = s / spanSections;
    const radius = lerp(rootRadius, tipRadius, v);
    const chord = lerp(rootChord, tipChord, v);
    const twist = lerp(rootTwist, tipTwist, v);
    // Blades thin toward the tip, as real fan blades do.
    const t = maxThickness * lerp(1.0, 0.55, v);
    const axialSweep = -sweep * v * v;

    const cos = Math.cos(twist);
    const sin = Math.sin(twist);

    for (let c = 0; c < ring; c++) {
      // Walk the upper surface leading edge → trailing edge, then back along
      // the lower surface, producing a closed loop.
      const upper = c < chordSections;
      const i = upper ? c : ring - c;
      const x = i / chordSections; // 0 at leading edge, 1 at trailing edge

      // Cosine spacing packs points where curvature is highest.
      const xc = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(x, 1));
      const half = thickness(xc, t) * chord;

      // Local blade frame: chord along Z, thickness along X, span along Y.
      const chordPos = (xc - 0.35) * chord;
      const thickPos = upper ? half : -half;

      const y = radius;
      const z = chordPos * cos - thickPos * sin + axialSweep;
      const xx = chordPos * sin + thickPos * cos;

      positions.push(xx, y, z);
      normals.push(0, 0, 0); // replaced by computeVertexNormals
      uvs.push(c / ring, v);
    }
  }

  // Stitch consecutive stations.
  for (let s = 0; s < spanSections; s++) {
    for (let c = 0; c < ring; c++) {
      const cNext = (c + 1) % ring;
      const a = s * ring + c;
      const b = s * ring + cNext;
      const d = (s + 1) * ring + c;
      const e = (s + 1) * ring + cNext;
      indices.push(a, d, b);
      indices.push(b, d, e);
    }
  }

  // Cap the root and the tip with triangle fans about their centroids.
  for (const [station, flip] of [[0, true], [spanSections, false]]) {
    const base = station * ring;
    let cx = 0; let cy = 0; let cz = 0;
    for (let c = 0; c < ring; c++) {
      cx += positions[(base + c) * 3];
      cy += positions[(base + c) * 3 + 1];
      cz += positions[(base + c) * 3 + 2];
    }
    const centre = positions.length / 3;
    positions.push(cx / ring, cy / ring, cz / ring);
    normals.push(0, 0, 0);
    uvs.push(0.5, station === 0 ? 0 : 1);

    for (let c = 0; c < ring; c++) {
      const a = base + c;
      const b = base + ((c + 1) % ring);
      if (flip) indices.push(centre, b, a);
      else indices.push(centre, a, b);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Paints the spinner's anti-icing spiral — the white comma every turbofan wears
 * so ground crew can see at a glance whether the fan is turning.
 * @returns {import('three').Texture}
 */
function createSpinnerTexture() {
  const { canvas, ctx } = createCanvas(512, 512);
  ctx.fillStyle = '#20262e';
  ctx.fillRect(0, 0, 512, 512);

  // The cone's UV wraps around X, so a diagonal band becomes a spiral.
  ctx.strokeStyle = '#eef3f8';
  ctx.lineWidth = 46;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(120, 512);
  ctx.quadraticCurveTo(230, 300, 250, 40);
  ctx.stroke();

  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3;
  for (let i = 0; i < 512; i += 24) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
  }

  return canvasTexture(canvas);
}

/**
 * Paints the crack glyph shown on blade #7 — a branching fatigue crack with a
 * soft heat-affected halo.
 * @returns {import('three').Texture}
 */
function createCrackTexture() {
  const { canvas, ctx } = createCanvas(512, 256);

  // Halo.
  const halo = ctx.createRadialGradient(256, 128, 4, 256, 128, 150);
  halo.addColorStop(0, 'rgba(255,255,255,0.5)');
  halo.addColorStop(0.45, 'rgba(255,120,120,0.18)');
  halo.addColorStop(1, 'rgba(255,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 512, 256);

  /**
   * Draws one jagged crack branch.
   * @param {number} x0 Start X.
   * @param {number} y0 Start Y.
   * @param {number} x1 End X.
   * @param {number} y1 End Y.
   * @param {number} width Stroke width.
   * @param {number} jitter Lateral randomness.
   */
  const branch = (x0, y0, x1, y1, width, jitter) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(
        x0 + (x1 - x0) * t + (Math.random() - 0.5) * jitter,
        y0 + (y1 - y0) * t + (Math.random() - 0.5) * jitter,
      );
    }
    ctx.stroke();
  };

  branch(70, 132, 440, 122, 5, 16);
  branch(190, 128, 250, 78, 2.5, 10);
  branch(300, 126, 356, 178, 2.5, 10);
  branch(380, 124, 412, 92, 1.8, 8);

  return canvasTexture(canvas);
}
