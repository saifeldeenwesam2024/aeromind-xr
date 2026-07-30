/**
 * @file VRMenu.js
 * @description The in-headset control surface.
 *
 * Inside a Cardboard viewer there is no mouse, no keyboard, and usually no
 * button — so every control has to be reachable with the head alone. This menu
 * solves that the way good MR interfaces do: it is not on screen at all until
 * the viewer looks down, at which point it rises into view and is operated by
 * resting the gaze reticle on a control until its dwell ring completes.
 *
 * Hiding it above a downward gaze threshold is deliberate. Controls that float
 * permanently in the field of view are the fastest way to break the illusion of
 * being somewhere; controls that appear when you look for them reinforce it.
 */

import {
  AdditiveBlending,
  DoubleSide,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import {
  canvasTexture, createCanvas, MONO_FONT, roundRect, trackedText,
} from '../engine/TextureFactory.js';
import { Glow } from '../effects/Glow.js';
import { clamp, damp, saturate } from '../engine/Utils.js';

/** Downward gaze pitch, in radians, at which the menu begins to appear. */
const SUMMON_PITCH = -0.42;

/**
 * @typedef {object} MenuItem
 * @property {string} id Action identifier.
 * @property {string} label Display label.
 * @property {string} [glyph] Optional short glyph shown above the label.
 */

/**
 * Gaze-operated menu, parented to the camera rig.
 * @class
 */
export class VRMenu {
  /**
   * @param {MenuItem[]} items Menu entries, laid out left to right.
   * @param {object} [options] Configuration.
   * @param {number} [options.distance] Distance from the eyes, in metres.
   * @param {number} [options.drop] How far below the eye line the menu sits.
   */
  constructor(items, options = {}) {
    const { distance = 1.25, drop = 0.72 } = options;

    /** @type {Group} Root, parented to the camera rig. */
    this.group = new Group();
    this.group.name = 'VRMenu';
    this.group.visible = false;
    this.group.renderOrder = 50;

    /** @type {number} */
    this.distance = distance;
    /** @type {number} */
    this.drop = drop;

    /** @type {MenuItem[]} */
    this.items = items;
    /** @type {Mesh[]} Interactive button meshes, in menu order. */
    this.buttons = [];
    /** @type {Map<string, Function>} */
    this.handlers = new Map();

    /** @type {number} Visibility, 0–1. */
    this.visibility = 0;
    /** @type {number} Visibility the menu eases toward. */
    this.targetVisibility = 0;
    /** @type {boolean} Whether the menu is permitted to appear at all. */
    this.enabled = false;
    /** @type {?Mesh} Button currently under the reticle. */
    this.hovered = null;

    /** @type {Set<import('three').Material>} */
    this._materials = new Set();
    /** @type {Set<import('three').Texture>} */
    this._textures = new Set();

    /** @type {PlaneGeometry} Shared button geometry. */
    this._geometry = new PlaneGeometry(0.26, 0.2);

    this.#build();
  }

  /**
   * Lays the buttons out on a shallow arc so each one faces the viewer.
   * @private
   */
  #build() {
    const count = this.items.length;
    const spacingRad = 0.185;

    this.items.forEach((item, index) => {
      const texture = this.#createLabel(item);
      const material = this.#createButtonMaterial(texture);

      const mesh = new Mesh(this._geometry, material);
      const angle = (index - (count - 1) / 2) * spacingRad;

      mesh.position.set(
        Math.sin(angle) * this.distance,
        -this.drop,
        -Math.cos(angle) * this.distance,
      );
      mesh.rotation.y = angle;
      mesh.rotation.x = 0.62; // tilted up toward the downward gaze
      mesh.renderOrder = 51;
      mesh.userData.item = item;
      mesh.userData.index = index;

      this.group.add(mesh);
      this.buttons.push(mesh);
    });
  }

  /**
   * Paints a button label.
   * @param {MenuItem} item Menu entry.
   * @returns {import('three').Texture}
   * @private
   */
  #createLabel(item) {
    const { canvas, ctx } = createCanvas(320, 246);

    ctx.strokeStyle = 'rgba(122,217,255,0.55)';
    ctx.lineWidth = 3;
    roundRect(ctx, 8, 8, 304, 230, 26);
    ctx.stroke();

    if (item.glyph) {
      ctx.fillStyle = '#dceaf8';
      ctx.font = `300 84px ${MONO_FONT}`;
      trackedText(ctx, item.glyph, 160, 132, 2, 'center');
    }

    ctx.fillStyle = '#7ad9ff';
    ctx.font = `600 30px ${MONO_FONT}`;
    trackedText(ctx, item.label.toUpperCase(), 160, item.glyph ? 190 : 138, 4, 'center');

    const texture = canvasTexture(canvas);
    this._textures.add(texture);
    return texture;
  }

  /**
   * Button material: a glass plate that brightens on hover and fills with the
   * dwell progress from left to right.
   * @param {import('three').Texture} map Label texture.
   * @returns {ShaderMaterial}
   * @private
   */
  #createButtonMaterial(map) {
    const material = Glow.register(new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: map },
        uOpacity: { value: 0 },
        uHover: { value: 0 },
        uDwell: { value: 0 },
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
        uniform float uHover;
        uniform float uDwell;
        varying vec2 vUv;

        void main() {
          vec4 tex = texture2D(uMap, vUv);

          // Plate: a dim wash that lifts on hover.
          float plate = (0.05 + uHover * 0.16) *
                        smoothstep(0.0, 0.06, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));

          // Dwell fill sweeping across the plate.
          float fill = step(vUv.x, uDwell) * 0.22 * uHover;

          vec3 col = tex.rgb * (0.75 + uHover * 0.6) + vec3(0.28, 0.62, 0.95) * (plate + fill);
          float a = max(tex.a, plate + fill) * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(col * a * 1.5, a);
        }
      `,
    }));
    this._materials.add(material);
    return material;
  }

  /* -------------------------------------------------------------- control */

  /**
   * Parents the menu to a camera rig.
   * @param {import('../engine/CameraRig.js').CameraRig} rig Camera rig.
   */
  attach(rig) {
    /** @type {import('../engine/CameraRig.js').CameraRig} */
    this.rig = rig;
    rig.rig.add(this.group);
  }

  /**
   * Registers an action handler.
   * @param {string} id Item identifier.
   * @param {Function} handler Callback.
   * @returns {VRMenu} This menu, for chaining.
   */
  on(id, handler) {
    this.handlers.set(id, handler);
    return this;
  }

  /**
   * Enables or disables the menu entirely. Disabled menus never appear, however
   * far down the viewer looks.
   * @param {boolean} value Whether the menu may be summoned.
   */
  setEnabled(value) {
    this.enabled = value;
    if (!value) this.targetVisibility = 0;
  }

  /**
   * The meshes a gaze ray should be tested against.
   * @returns {Mesh[]}
   */
  getInteractives() {
    return this.visibility > 0.5 ? this.buttons : [];
  }

  /**
   * Runs the action bound to a button.
   * @param {Mesh} mesh Button mesh.
   */
  activate(mesh) {
    const item = mesh?.userData?.item;
    if (!item) return;
    this.handlers.get(item.id)?.(item);
  }

  /* --------------------------------------------------------------- update */

  /**
   * Advances the menu.
   * @param {number} dt Delta time in seconds.
   * @param {object} gaze Gaze state from the input manager.
   * @param {*} gaze.target Object under the reticle.
   * @param {number} gaze.progress Dwell progress, 0–1.
   */
  update(dt, gaze) {
    // Summon on downward gaze. The pitch is read from the head's forward
    // vector rather than an Euler angle, so it is well behaved at every roll.
    if (this.enabled && this.rig) {
      const forward = this.rig.getGazeDirection(new Vector3());
      const pitch = Math.asin(clamp(forward.y, -1, 1));
      this.targetVisibility = pitch < SUMMON_PITCH ? 1 : 0;
    }

    this.visibility = damp(this.visibility, this.targetVisibility, 5, dt);
    this.group.visible = this.visibility > 0.01;
    if (!this.group.visible) return;

    // The whole menu rises as it fades in.
    this.group.position.y = (1 - this.visibility) * -0.22;

    this.hovered = gaze?.target && this.buttons.includes(gaze.target) ? gaze.target : null;

    for (const button of this.buttons) {
      const u = button.material.uniforms;
      const isHovered = button === this.hovered;
      u.uOpacity.value = saturate(this.visibility);
      u.uHover.value = damp(u.uHover.value, isHovered ? 1 : 0, 8, dt);
      u.uDwell.value = isHovered ? (gaze?.progress ?? 0) : 0;
      button.scale.setScalar(1 + u.uHover.value * 0.06);
    }
  }

  /** Releases GPU resources. */
  dispose() {
    this._geometry.dispose();
    for (const material of this._materials) {
      Glow.unregister(material);
      material.dispose();
    }
    for (const texture of this._textures) texture.dispose();
    this._materials.clear();
    this._textures.clear();
    this.buttons.length = 0;
  }
}
