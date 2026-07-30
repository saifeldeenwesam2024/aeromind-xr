/**
 * @file Hologram.js
 * @description The holographic workspace — the constellation of panels the AI
 * projects around the engine, the data tethers that connect them to the part
 * they describe, and the full-scale title cards.
 *
 * Layout is deliberate rather than decorative. Panels sit on an arc centred on
 * the viewer's station, spread across four height tiers. Because the arc is
 * centred on the eyes rather than on the engine, every panel sits at the same
 * distance — nothing is uncomfortably close to fuse in stereo — and a panel's
 * stated bearing is exactly how far the viewer must turn to look at it. The
 * tiers mean they have to look up and down as well, which is the whole point of
 * putting information in a room instead of on a screen.
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { Glow } from '../effects/Glow.js';
import { createHeadline } from '../engine/TextureFactory.js';
import { damp, saturate } from '../engine/Utils.js';

/**
 * Manages the panel constellation, its tethers and its reveal choreography.
 * @class
 */
export class Hologram {
  /**
   * @param {object} [options] Configuration.
   * @param {Vector3} [options.anchor] Point the panels orbit — the engine.
   * @param {Vector3} [options.station] Where the viewer stands; panels aim here.
   */
  constructor(options = {}) {
    const {
      anchor = new Vector3(0, 2.6, 0),
      station = new Vector3(0, 1.68, 6.2),
    } = options;

    /** @type {Group} Scene graph node for the whole workspace. */
    this.group = new Group();
    this.group.name = 'HolographicWorkspace';

    /** @type {Vector3} */
    this.anchor = anchor.clone();
    /** @type {Vector3} */
    this.station = station.clone();

    /** @type {import('./Panel.js').Panel[]} Panels in reveal order. */
    this.panels = [];
    /** @type {Map<string, import('./Panel.js').Panel>} Panels by id. */
    this.byId = new Map();

    /** @type {Group} Container for the data tethers. */
    this.tethers = new Group();
    this.tethers.name = 'DataTethers';
    this.group.add(this.tethers);

    /** @type {Mesh[]} */
    this._beams = [];
    /** @type {PlaneGeometry} Shared unit beam geometry, grown from its origin. */
    this._beamGeometry = new PlaneGeometry(1, 1, 1, 1);
    this._beamGeometry.translate(0.5, 0, 0);

    /** @type {ShaderMaterial} */
    this._beamMaterial = this.#createBeamMaterial();
  }

  /**
   * Data tether shader: a thin ribbon with packets running along it from the
   * engine toward the panel that is analysing it.
   * @returns {ShaderMaterial}
   * @private
   */
  #createBeamMaterial() {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(0x6fd2ff) },
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
        uniform vec3  uColor;
        uniform float uOpacity;
        varying vec2 vUv;

        void main() {
          // Soft edges across the ribbon's width.
          float across = smoothstep(0.0, 0.42, vUv.y) * smoothstep(1.0, 0.58, vUv.y);

          // Data packets travelling toward the panel.
          float flow = fract(vUv.x * 2.4 - uTime * 0.75);
          float packet = smoothstep(0.86, 1.0, flow) * 1.5;

          // The ribbon fades at both ends so it never looks bolted on.
          float ends = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.86, vUv.x);

          float a = (0.16 + packet) * across * ends * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * a * 1.8, a);
        }
      `,
    });
    return Glow.register(material);
  }

  /* --------------------------------------------------------------- layout */

  /**
   * Places a panel on the arc and registers it.
   *
   * The arc is centred on the **viewer's station**, not on the engine. That
   * distinction matters: an arc around the engine looks even on a plan drawing,
   * but the viewer stands outside it, so panels at wide bearings collapse
   * toward the centre of the field of view and pile up on each other. Orbiting
   * the station instead means `angle` is exactly the angle the viewer must turn
   * their head, and every panel is the same distance from their eyes — which is
   * also what keeps them all comfortable to fuse in stereo.
   *
   * @param {string} id Stable identifier.
   * @param {import('./Panel.js').Panel} panel Panel to place.
   * @param {object} slot Placement.
   * @param {number} slot.angle Bearing from the viewer's forward axis, in
   *   degrees. Negative is to the viewer's left.
   * @param {number} slot.radius Distance from the viewer, in metres.
   * @param {number} slot.height World Y of the panel centre.
   * @param {number} [slot.tilt] Additional downward tilt, in degrees.
   * @param {boolean} [slot.tether] Draw a data tether to the anchor.
   * @returns {import('./Panel.js').Panel} The placed panel.
   */
  place(id, panel, slot) {
    const { angle, radius, height, tilt = 0, tether = true } = slot;

    // Forward is the direction from the viewer toward the engine, so a bearing
    // of 0° always puts a panel directly ahead of the viewer.
    const forward = Math.atan2(
      this.anchor.x - this.station.x,
      this.anchor.z - this.station.z,
    );
    // Subtracted, not added: a rotation about +Y carries the viewer's forward
    // axis to their *left*, so a positive bearing must rotate the other way to
    // mean "to the right", which is what every caller assumes.
    const theta = forward - (angle * Math.PI) / 180;

    panel.setPosition(
      this.station.x + Math.sin(theta) * radius,
      height,
      this.station.z + Math.cos(theta) * radius,
    );
    panel.faceTowards(this.station);

    // Panels angle their face toward the eye: those above the eye line tilt
    // their bottom edge forward, those below tilt their top edge forward —
    // exactly how a person angles a monitor they are looking up or down at.
    const auto = (height - this.station.y) * 0.16;
    panel.tilt(auto + (tilt * Math.PI) / 180);

    this.group.add(panel.group);
    this.panels.push(panel);
    this.byId.set(id, panel);

    if (tether) this.#createTether(panel);
    return panel;
  }

  /**
   * Builds a tether from the anchor to a panel's near edge.
   * @param {import('./Panel.js').Panel} panel Panel to connect.
   * @private
   */
  #createTether(panel) {
    const beam = new Mesh(this._beamGeometry, this._beamMaterial);
    beam.renderOrder = 11;
    beam.frustumCulled = false;
    beam.userData.panel = panel;
    this.tethers.add(beam);
    this._beams.push(beam);
    this.#aimTether(beam);
  }

  /**
   * Points a tether at its panel and scales it to span the gap.
   * @param {Mesh} beam Tether mesh.
   * @private
   */
  #aimTether(beam) {
    const panel = beam.userData.panel;
    const from = this.anchor;
    const to = panel.group.position;

    beam.position.copy(from);
    beam.lookAt(to);
    // `lookAt` aims -Z at the target; the ribbon grows along +X, so yaw by 90°.
    beam.rotateY(-Math.PI / 2);

    const distance = from.distanceTo(to);
    beam.scale.set(distance, Math.max(0.05, distance * 0.012), 1);
  }

  /* ------------------------------------------------------------ transport */

  /**
   * Reveals panels one after another.
   * @param {string[]} [order] Ids to reveal; defaults to placement order.
   * @param {number} [interval] Seconds between reveals.
   * @param {number} [start] Delay before the first reveal.
   */
  reveal(order = null, interval = 0.42, start = 0) {
    const list = order
      ? order.map((id) => this.byId.get(id)).filter(Boolean)
      : this.panels;
    list.forEach((panel, i) => panel.show(start + i * interval));
    this._tetherTarget = 1;
  }

  /**
   * Dissolves every panel.
   * @param {number} [interval] Seconds between hides.
   */
  hideAll(interval = 0.08) {
    this.panels.forEach((panel, i) => {
      panel.delay = i * interval;
      panel.openTarget = 0;
    });
    this._tetherTarget = 0;
  }

  /**
   * Shows a single panel by id.
   * @param {string} id Panel id.
   * @param {number} [delay] Seconds to wait.
   */
  show(id, delay = 0) {
    this.byId.get(id)?.show(delay);
    this._tetherTarget = 1;
  }

  /**
   * Highlights one panel and dims the rest — used when the AI cites a specific
   * source for its reasoning.
   * @param {?string} id Panel id, or null to clear.
   */
  focus(id) {
    for (const [key, panel] of this.byId) {
      panel.setHighlight(key === id ? 1 : 0);
    }
  }

  /**
   * Sets tether opacity directly.
   * @param {number} value Opacity, 0–1.
   */
  setTetherOpacity(value) {
    this._tetherTarget = saturate(value);
  }

  /* --------------------------------------------------------------- update */

  /**
   * Advances every panel and the tethers.
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   */
  update(dt, time) {
    for (const panel of this.panels) panel.update(dt, time);

    const target = this._tetherTarget ?? 0;
    const u = this._beamMaterial.uniforms.uOpacity;
    u.value = damp(u.value, target, 2.2, dt);
    this.tethers.visible = u.value > 0.004;

    // A tether is only meaningful while its panel is actually present.
    if (this.tethers.visible) {
      for (const beam of this._beams) {
        beam.visible = beam.userData.panel.open > 0.25;
      }
    }
  }

  /** Releases GPU resources for the workspace and every panel it owns. */
  dispose() {
    for (const panel of this.panels) panel.dispose();
    this.panels.length = 0;
    this.byId.clear();
    this._beamGeometry.dispose();
    Glow.unregister(this._beamMaterial);
    this._beamMaterial.dispose();
  }
}

/**
 * A full-scale typographic card standing in world space.
 *
 * Title cards are geometry, not DOM: they are lit by the same bloom, occluded
 * by the same fog, and — critically — they have real stereoscopic depth. Text
 * that floats at a believable distance is one of the strongest cues that the
 * viewer is inside a space rather than looking at a screen.
 * @class
 */
export class TitleCard {
  /**
   * @param {object} spec Card content and placement.
   * @param {string} [spec.eyebrow] Tracked label above the title.
   * @param {string} [spec.title] Headline.
   * @param {string} [spec.subtitle] Supporting line.
   * @param {string[]} [spec.bullets] Tracked words beneath.
   * @param {number} [spec.width] Card width in metres.
   * @param {number} [spec.aspect] Width / height ratio.
   * @param {string} [spec.accent] Accent colour.
   */
  constructor(spec) {
    const { width = 6.4, aspect = 2, accent = '#7ad9ff' } = spec;

    /** @type {import('three').Texture} */
    this.texture = createHeadline({
      ...spec,
      accent,
      width: 2048,
      height: Math.round(2048 / aspect),
    });

    /** @type {ShaderMaterial} */
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: this.texture },
        uOpacity: { value: 0 },
        /** Vertical dissolve: 0 = fully dissolved, 1 = fully formed. */
        uForm: { value: 0 },
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
        uniform float uOpacity;
        uniform float uForm;
        varying vec2 vUv;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          vec4 tex = texture2D(uMap, vUv);
          if (tex.a < 0.004) discard;

          // Glyphs assemble from horizontal noise bands as the card forms.
          float band = hash21(floor(vec2(vUv.y * 220.0, 0.0)));
          float form = smoothstep(band * 0.7, band * 0.7 + 0.35, uForm);

          // A soft light sweep passes across the type once it has formed.
          float sweep = smoothstep(0.9, 1.0, sin((vUv.x * 2.4 - uTime * 0.35)));

          vec3 col = tex.rgb * (1.0 + sweep * 0.7);
          float a = tex.a * uOpacity * form;
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
    Glow.register(this.material);

    /** @type {Mesh} */
    this.mesh = new Mesh(new PlaneGeometry(width, width / aspect), this.material);
    this.mesh.renderOrder = 30;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;

    /** @type {Group} Scene graph node. */
    this.group = new Group();
    this.group.add(this.mesh);

    /** @type {number} Opacity the card eases toward. */
    this.targetOpacity = 0;
    /** @type {number} Formation progress the card eases toward. */
    this.targetForm = 0;
  }

  /**
   * Places and aims the card.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {Vector3} [lookAt] Point to face.
   * @returns {TitleCard} This card, for chaining.
   */
  place(x, y, z, lookAt = null) {
    this.group.position.set(x, y, z);
    if (lookAt) {
      this.group.rotation.y = Math.atan2(lookAt.x - x, lookAt.z - z);
    }
    return this;
  }

  /**
   * Fades the card in and assembles the type.
   * @param {number} [opacity] Target opacity.
   */
  show(opacity = 1) {
    this.targetOpacity = opacity;
    this.targetForm = 1;
    this.mesh.visible = true;
  }

  /** Fades the card out. */
  hide() {
    this.targetOpacity = 0;
    this.targetForm = 0;
  }

  /**
   * Advances the card's animation.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    const u = this.material.uniforms;
    u.uOpacity.value = damp(u.uOpacity.value, this.targetOpacity, 2.0, dt);
    u.uForm.value = damp(u.uForm.value, this.targetForm, 1.5, dt);
    this.mesh.visible = u.uOpacity.value > 0.004;
  }

  /** Releases GPU resources. */
  dispose() {
    this.mesh.geometry.dispose();
    Glow.unregister(this.material);
    this.material.dispose();
    this.texture.dispose();
  }
}
