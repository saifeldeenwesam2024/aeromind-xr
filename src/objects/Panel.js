/**
 * @file Panel.js
 * @description A single world-space holographic panel.
 *
 * Panels are **not** screen-space overlays. Each one is a real quad standing at
 * a fixed position and orientation in the hangar, which means the viewer can
 * lean in, look around the edge of one, and read the parallax between a panel
 * and the engine behind it. That is the entire difference between "a HUD" and
 * "a hologram", and it is why the DOM is never used for in-experience UI.
 *
 * Content is painted with the Canvas 2D API into a texture. Redraws are
 * throttled to roughly 12 Hz — fast enough that counters look live, slow enough
 * that thirteen simultaneous panels cost almost nothing. Values ease toward
 * their targets on every frame regardless, so the motion stays smooth even
 * though the pixels update in steps.
 */

import { Group, Mesh, PlaneGeometry } from 'three';
import { createPanelMaterial } from '../effects/Glow.js';
import {
  canvasTexture, createCanvas, MONO_FONT, roundRect, trackedText, UI_FONT, wrapText,
} from '../engine/TextureFactory.js';
import { clamp, damp, formatNumber, saturate } from '../engine/Utils.js';

/** Semantic colours shared by every panel. */
const INK = {
  base: '#dceaf8',
  dim: 'rgba(150,185,220,0.78)',
  faint: 'rgba(120,155,190,0.45)',
  accent: '#7ad9ff',
  ok: '#4ce6a6',
  warn: '#ffb44a',
  fault: '#ff5f68',
  grid: 'rgba(110,190,240,0.16)',
};

/**
 * @typedef {object} PanelRow
 * @property {string} label Row label.
 * @property {number} [value] Current numeric value.
 * @property {number} [target] Value to ease toward.
 * @property {string} [display] Literal string, used instead of a number.
 * @property {string} [unit] Unit suffix.
 * @property {number} [decimals] Decimal places.
 * @property {number} [bar] Bar fill, 0–1.
 * @property {number} [barTarget] Bar fill to ease toward.
 * @property {'ok'|'warn'|'fault'|'idle'} [state] Semantic state.
 */

/**
 * @typedef {object} PanelData
 * @property {string} title Panel heading.
 * @property {string} [badge] Small tag in the header's right corner.
 * @property {'metrics'|'graph'|'checklist'|'gauge'|'text'|'stack'} [kind] Body layout.
 * @property {PanelRow[]} [rows] Rows for metric and stack layouts.
 * @property {number[]} [series] Sample buffer for the graph layout.
 * @property {Array<{label: string, done: boolean}>} [checklist] Checklist items.
 * @property {{value: number, target?: number, label: string, caption?: string}} [gauge] Gauge state.
 * @property {string} [text] Body copy, revealed by typewriter.
 * @property {string} [footer] Footer line.
 * @property {'ok'|'warn'|'fault'|'idle'} [status] Header status dot.
 */

/**
 * A world-space holographic panel.
 * @class
 */
export class Panel {
  /**
   * @param {object} options Panel configuration.
   * @param {PanelData} options.data Content.
   * @param {number} [options.width] Panel width in metres.
   * @param {number} [options.height] Panel height in metres.
   * @param {number} [options.resolution] Texture pixels per metre.
   * @param {number} [options.repaintHz] Canvas repaint rate. Values ease every
   *   frame regardless; only the texture upload is throttled, which is the part
   *   that costs real time on a mobile GPU.
   * @param {number|string} [options.tint] Glass tint.
   * @param {number|string} [options.border] Border colour.
   * @param {boolean} [options.typewriter] Reveal body copy character by character.
   */
  constructor(options) {
    const {
      data,
      width = 1.5,
      height = 0.95,
      resolution = 560,
      repaintHz = 12,
      tint = 0x08192e,
      border = 0x6fd2ff,
      typewriter = false,
    } = options;

    /** @type {PanelData} Live content; mutate freely, then call {@link invalidate}. */
    this.data = data;
    /** @type {number} Panel width in metres. */
    this.width = width;
    /** @type {number} Panel height in metres. */
    this.height = height;
    /** @type {boolean} */
    this.typewriter = typewriter;
    /** @type {number} Minimum seconds between canvas repaints. */
    this.repaintInterval = 1 / Math.max(1, repaintHz);

    const pxW = Math.round(width * resolution);
    const pxH = Math.round(height * resolution);
    const surface = createCanvas(pxW, pxH);

    /** @type {HTMLCanvasElement} */
    this.canvas = surface.canvas;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = surface.ctx;
    /** @type {import('three').Texture} */
    this.texture = canvasTexture(this.canvas, { anisotropy: 8 });

    /** @type {import('three').ShaderMaterial} */
    this.material = createPanelMaterial({
      map: this.texture,
      tint,
      border,
      aspect: width / height,
      radius: 0.055,
    });

    /** @type {Group} Scene graph node. Position and orient this. */
    this.group = new Group();
    this.group.name = `Panel:${data.title ?? 'untitled'}`;

    /** @type {Mesh} */
    this.mesh = new Mesh(new PlaneGeometry(width, height, 1, 1), this.material);
    this.mesh.renderOrder = 12;
    this.group.add(this.mesh);

    /** @type {number} Open progress, 0 = hidden, 1 = fully materialised. */
    this.open = 0;
    /** @type {number} Open progress the panel eases toward. */
    this.openTarget = 0;
    /** @type {number} Seconds remaining before the panel starts opening. */
    this.delay = 0;
    /** @type {number} Attention highlight, 0–1. */
    this.highlight = 0;
    /** @type {number} Highlight the panel eases toward. */
    this.highlightTarget = 0;

    /** @type {number} Seconds since the panel finished opening. */
    this.age = 0;
    /** @type {number} Seconds of accumulated time since the last repaint. */
    this._repaintTimer = 0;
    /** @type {boolean} */
    this._dirty = true;

    this.group.visible = false;
    this.#paint();
  }

  /* ---------------------------------------------------------------- state */

  /**
   * Places the panel in the world.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {Panel} This panel, for chaining.
   */
  setPosition(x, y, z) {
    this.group.position.set(x, y, z);
    return this;
  }

  /**
   * Orients the panel toward a point, keeping it upright. Panels are aimed once
   * at build time — they do not billboard, because a hologram that always faces
   * you is a sprite, not an object in the room.
   * @param {import('three').Vector3} point World-space point to face.
   * @returns {Panel} This panel, for chaining.
   */
  faceTowards(point) {
    const dx = point.x - this.group.position.x;
    const dz = point.z - this.group.position.z;
    this.group.rotation.y = Math.atan2(dx, dz);
    return this;
  }

  /**
   * Adds a downward tilt, matching how a person angles a screen toward their
   * eyes when it sits above head height.
   * @param {number} radians Tilt angle.
   * @returns {Panel} This panel, for chaining.
   */
  tilt(radians) {
    this.mesh.rotation.x = radians;
    return this;
  }

  /**
   * Materialises the panel.
   * @param {number} [delay] Seconds to wait before opening.
   */
  show(delay = 0) {
    this.delay = delay;
    this.openTarget = 1;
    this.group.visible = true;
  }

  /** Dissolves the panel. */
  hide() {
    this.delay = 0;
    this.openTarget = 0;
  }

  /**
   * Sets the attention highlight, used when the AI is actively citing a panel.
   * @param {number} value Highlight, 0–1.
   */
  setHighlight(value) {
    this.highlightTarget = saturate(value);
  }

  /** Forces a repaint on the next update. */
  invalidate() {
    this._dirty = true;
  }

  /**
   * Appends a sample to the graph buffer, dropping the oldest when full.
   * @param {number} value Sample value.
   * @param {number} [maxLength] Buffer length.
   */
  pushSample(value, maxLength = 44) {
    if (!this.data.series) this.data.series = [];
    this.data.series.push(value);
    while (this.data.series.length > maxLength) this.data.series.shift();
    this._dirty = true;
  }

  /**
   * Marks a checklist item complete.
   * @param {number} index Item index.
   * @param {boolean} [done] Completion state.
   */
  setChecklistItem(index, done = true) {
    const item = this.data.checklist?.[index];
    if (!item || item.done === done) return;
    item.done = done;
    this._dirty = true;
  }

  /* --------------------------------------------------------------- update */

  /**
   * Advances animation and repaints when needed.
   * @param {number} dt Delta time in seconds.
   * @param {number} time Absolute time in seconds.
   */
  update(dt, time) {
    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay > 0) return;
    }

    this.open = damp(this.open, this.openTarget, 4.2, dt);
    this.highlight = damp(this.highlight, this.highlightTarget, 5, dt);
    this.material.uniforms.uOpen.value = this.open;
    this.material.uniforms.uHighlight.value = this.highlight;

    if (this.open < 0.004 && this.openTarget === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    if (this.open > 0.7) this.age += dt;

    // Ease every animated value toward its target. Doing this per frame while
    // repainting at 12 Hz gives smooth motion at a twelfth of the canvas cost.
    let animating = false;
    for (const row of this.data.rows ?? []) {
      if (row.target !== undefined) {
        const next = damp(row.value ?? 0, row.target, 2.6, dt);
        if (Math.abs(next - (row.value ?? 0)) > 1e-3) animating = true;
        row.value = next;
      }
      if (row.barTarget !== undefined) {
        const next = damp(row.bar ?? 0, row.barTarget, 2.6, dt);
        if (Math.abs(next - (row.bar ?? 0)) > 1e-3) animating = true;
        row.bar = next;
      }
    }

    const gauge = this.data.gauge;
    if (gauge?.target !== undefined) {
      const next = damp(gauge.value ?? 0, gauge.target, 2.2, dt);
      if (Math.abs(next - (gauge.value ?? 0)) > 1e-3) animating = true;
      gauge.value = next;
    }

    // The typewriter keeps the panel dirty until the text is fully revealed.
    if (this.typewriter && this.data.text) {
      const chars = Math.floor(this.age * 34);
      if (chars <= this.data.text.length + 2) animating = true;
    }

    this._repaintTimer += dt;
    if ((this._dirty || animating) && this._repaintTimer > this.repaintInterval) {
      this._repaintTimer = 0;
      this._dirty = false;
      this.#paint(time);
    }
  }

  /* ---------------------------------------------------------------- paint */

  /**
   * Repaints the panel content.
   * @param {number} [time] Absolute time, for animated flourishes.
   * @private
   */
  #paint(time = 0) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const pad = Math.round(W * 0.045);

    ctx.clearRect(0, 0, W, H);

    const headerH = this.#paintHeader(ctx, W, H, pad, time);
    const bodyTop = headerH;
    const footerH = this.data.footer ? Math.round(H * 0.11) : 0;
    const bodyH = H - bodyTop - footerH - pad * 0.4;

    switch (this.data.kind ?? 'metrics') {
      case 'graph':     this.#paintGraph(ctx, pad, bodyTop, W - pad * 2, bodyH); break;
      case 'checklist': this.#paintChecklist(ctx, pad, bodyTop, W - pad * 2, bodyH); break;
      case 'gauge':     this.#paintGauge(ctx, pad, bodyTop, W - pad * 2, bodyH, time); break;
      case 'text':      this.#paintText(ctx, pad, bodyTop, W - pad * 2, bodyH); break;
      case 'stack':     this.#paintStack(ctx, pad, bodyTop, W - pad * 2, bodyH); break;
      default:          this.#paintMetrics(ctx, pad, bodyTop, W - pad * 2, bodyH); break;
    }

    if (this.data.footer) this.#paintFooter(ctx, pad, H - footerH, W - pad * 2, footerH);

    this.texture.needsUpdate = true;
  }

  /**
   * Draws the title bar and returns its height.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} W Canvas width.
   * @param {number} H Canvas height.
   * @param {number} pad Padding.
   * @param {number} time Absolute time.
   * @returns {number} Header height in pixels.
   * @private
   */
  #paintHeader(ctx, W, H, pad, time) {
    const titleSize = Math.round(H * 0.102);
    const y = pad + titleSize * 0.85;

    // Status dot.
    const state = this.data.status ?? 'idle';
    const dotColor = state === 'ok' ? INK.ok : state === 'warn' ? INK.warn
      : state === 'fault' ? INK.fault : INK.accent;
    const pulse = state === 'fault' || state === 'warn'
      ? 0.55 + 0.45 * Math.sin(time * 5.2) : 1;

    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = dotColor;
    ctx.shadowColor = dotColor;
    ctx.shadowBlur = titleSize * 0.7;
    ctx.beginPath();
    ctx.arc(pad + titleSize * 0.22, y - titleSize * 0.3, titleSize * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = INK.base;
    ctx.font = `500 ${titleSize}px ${UI_FONT}`;
    ctx.textAlign = 'left';
    trackedText(ctx, this.data.title ?? '', pad + titleSize * 0.62, y, titleSize * 0.035, 'left');

    if (this.data.badge) {
      const badgeSize = Math.round(H * 0.056);
      ctx.font = `500 ${badgeSize}px ${MONO_FONT}`;
      let w = 0;
      for (const c of this.data.badge) w += ctx.measureText(c).width + badgeSize * 0.1;
      const bw = w + badgeSize * 1.1;
      const bh = badgeSize * 1.7;
      const bx = W - pad - bw;
      const by = y - titleSize * 0.78;

      ctx.strokeStyle = 'rgba(122,217,255,0.42)';
      ctx.fillStyle = 'rgba(38,110,168,0.22)';
      ctx.lineWidth = 1.6;
      roundRect(ctx, bx, by, bw, bh, bh * 0.3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = INK.accent;
      trackedText(ctx, this.data.badge, bx + badgeSize * 0.55, by + bh * 0.71, badgeSize * 0.1, 'left');
    }

    // Divider with a travelling bright segment.
    const dy = y + titleSize * 0.5;
    ctx.fillStyle = 'rgba(110,190,240,0.2)';
    ctx.fillRect(pad, dy, W - pad * 2, 1.5);
    const sweepX = pad + ((time * 0.28) % 1) * (W - pad * 2);
    const grad = ctx.createLinearGradient(sweepX - 60, 0, sweepX + 60, 0);
    grad.addColorStop(0, 'rgba(122,217,255,0)');
    grad.addColorStop(0.5, 'rgba(122,217,255,0.85)');
    grad.addColorStop(1, 'rgba(122,217,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(pad, dy, W - pad * 2, 1.5);

    return dy + Math.round(H * 0.045);
  }

  /**
   * Label/value rows with optional progress bars.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} x Left edge.
   * @param {number} y Top edge.
   * @param {number} w Width.
   * @param {number} h Height.
   * @private
   */
  #paintMetrics(ctx, x, y, w, h) {
    const rows = this.data.rows ?? [];
    if (!rows.length) return;

    const rowH = Math.min(h / rows.length, this.canvas.height * 0.15);
    const labelSize = Math.round(rowH * 0.36);
    const valueSize = Math.round(rowH * 0.48);

    rows.forEach((row, i) => {
      const ry = y + i * rowH;
      const stateColor = row.state === 'ok' ? INK.ok : row.state === 'warn' ? INK.warn
        : row.state === 'fault' ? INK.fault : INK.base;

      ctx.fillStyle = INK.dim;
      ctx.font = `400 ${labelSize}px ${UI_FONT}`;
      ctx.textAlign = 'left';
      trackedText(ctx, row.label.toUpperCase(), x, ry + labelSize, labelSize * 0.1, 'left');

      const value = row.display ?? (
        `${formatNumber(row.value ?? 0, row.decimals ?? 0)}${row.unit ?? ''}`
      );
      ctx.fillStyle = stateColor;
      ctx.font = `500 ${valueSize}px ${MONO_FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(value, x + w, ry + labelSize + valueSize * 0.05);
      ctx.textAlign = 'left';

      if (row.bar !== undefined) {
        const by = ry + labelSize + rowH * 0.24;
        const bh = Math.max(3, rowH * 0.1);
        ctx.fillStyle = 'rgba(110,190,240,0.14)';
        roundRect(ctx, x, by, w, bh, bh / 2);
        ctx.fill();

        const fill = clamp(row.bar, 0, 1) * w;
        if (fill > 1) {
          ctx.save();
          ctx.shadowColor = stateColor;
          ctx.shadowBlur = bh * 2.4;
          ctx.fillStyle = stateColor;
          roundRect(ctx, x, by, fill, bh, bh / 2);
          ctx.fill();
          ctx.restore();
        }
      }
    });
  }

  /**
   * Compact two-column stack, used for dense read-outs.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} x Left edge.
   * @param {number} y Top edge.
   * @param {number} w Width.
   * @param {number} h Height.
   * @private
   */
  #paintStack(ctx, x, y, w, h) {
    const rows = this.data.rows ?? [];
    const rowH = Math.min(h / Math.max(rows.length, 1), this.canvas.height * 0.11);
    const size = Math.round(rowH * 0.48);

    rows.forEach((row, i) => {
      const ry = y + i * rowH + size;
      const stateColor = row.state === 'ok' ? INK.ok : row.state === 'warn' ? INK.warn
        : row.state === 'fault' ? INK.fault : INK.base;

      ctx.fillStyle = i % 2 === 0 ? 'rgba(80,150,200,0.06)' : 'transparent';
      ctx.fillRect(x - 6, ry - size, w + 12, rowH);

      ctx.fillStyle = INK.dim;
      ctx.font = `400 ${size}px ${UI_FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(row.label, x, ry);

      ctx.fillStyle = stateColor;
      ctx.font = `500 ${size}px ${MONO_FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(
        row.display ?? `${formatNumber(row.value ?? 0, row.decimals ?? 0)}${row.unit ?? ''}`,
        x + w, ry,
      );
      ctx.textAlign = 'left';
    });
  }

  /**
   * Telemetry trace with a filled area and a live end-point.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} x Left edge.
   * @param {number} y Top edge.
   * @param {number} w Width.
   * @param {number} h Height.
   * @private
   */
  #paintGraph(ctx, x, y, w, h) {
    const series = this.data.series ?? [];
    const plotH = h * 0.74;

    // Grid.
    ctx.strokeStyle = INK.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gy = y + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();
    }
    for (let i = 0; i <= 6; i++) {
      const gx = x + (w / 6) * i;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + plotH);
      ctx.stroke();
    }

    if (series.length > 1) {
      let min = Infinity;
      let max = -Infinity;
      for (const v of series) { if (v < min) min = v; if (v > max) max = v; }
      const span = Math.max(max - min, 1e-3);
      const pad = span * 0.18;
      min -= pad; max += pad;

      /**
       * Maps a sample to canvas coordinates.
       * @param {number} v Sample value.
       * @param {number} i Sample index.
       * @returns {[number, number]}
       */
      const point = (v, i) => [
        x + (i / (series.length - 1)) * w,
        y + plotH - ((v - min) / (max - min)) * plotH,
      ];

      // Filled area under the trace.
      ctx.beginPath();
      ctx.moveTo(x, y + plotH);
      series.forEach((v, i) => { const [px, py] = point(v, i); ctx.lineTo(px, py); });
      ctx.lineTo(x + w, y + plotH);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, y, 0, y + plotH);
      fill.addColorStop(0, 'rgba(122,217,255,0.34)');
      fill.addColorStop(1, 'rgba(122,217,255,0)');
      ctx.fillStyle = fill;
      ctx.fill();

      // Trace.
      ctx.save();
      ctx.strokeStyle = INK.accent;
      ctx.lineWidth = Math.max(2, h * 0.018);
      ctx.lineJoin = 'round';
      ctx.shadowColor = INK.accent;
      ctx.shadowBlur = h * 0.09;
      ctx.beginPath();
      series.forEach((v, i) => {
        const [px, py] = point(v, i);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Live end-point.
      const [ex, ey] = point(series.at(-1), series.length - 1);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, Math.max(3, h * 0.03), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Read-out below the plot.
    const rows = this.data.rows ?? [];
    if (rows.length) {
      const size = Math.round(h * 0.13);
      const colW = w / rows.length;
      rows.forEach((row, i) => {
        const cx = x + colW * i;
        ctx.fillStyle = INK.faint;
        ctx.font = `400 ${Math.round(size * 0.72)}px ${UI_FONT}`;
        ctx.textAlign = 'left';
        trackedText(ctx, row.label.toUpperCase(), cx, y + plotH + size * 1.3, size * 0.08, 'left');

        const stateColor = row.state === 'ok' ? INK.ok : row.state === 'warn' ? INK.warn
          : row.state === 'fault' ? INK.fault : INK.base;
        ctx.fillStyle = stateColor;
        ctx.font = `500 ${size}px ${MONO_FONT}`;
        ctx.fillText(
          row.display ?? `${formatNumber(row.value ?? 0, row.decimals ?? 0)}${row.unit ?? ''}`,
          cx, y + plotH + size * 2.5,
        );
      });
    }
  }

  /**
   * Task checklist with animated completion ticks.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} x Left edge.
   * @param {number} y Top edge.
   * @param {number} w Width.
   * @param {number} h Height.
   * @private
   */
  #paintChecklist(ctx, x, y, w, h) {
    const items = this.data.checklist ?? [];
    if (!items.length) return;

    const rowH = Math.min(h / items.length, this.canvas.height * 0.13);
    const size = Math.round(rowH * 0.42);
    const box = rowH * 0.42;

    items.forEach((item, i) => {
      const ry = y + i * rowH + (rowH - box) * 0.5;
      const color = item.done ? INK.ok : INK.faint;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      roundRect(ctx, x, ry, box, box, box * 0.26);
      ctx.stroke();

      if (item.done) {
        ctx.save();
        ctx.strokeStyle = INK.ok;
        ctx.shadowColor = INK.ok;
        ctx.shadowBlur = box * 0.7;
        ctx.lineWidth = box * 0.16;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + box * 0.24, ry + box * 0.52);
        ctx.lineTo(x + box * 0.44, ry + box * 0.72);
        ctx.lineTo(x + box * 0.78, ry + box * 0.28);
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = item.done ? 'rgba(190,225,250,0.95)' : INK.dim;
      ctx.font = `400 ${size}px ${UI_FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(item.label, x + box * 1.5, ry + box * 0.74);

      if (item.done) {
        // Strike-through, drawn as a soft line rather than a hard cross-out.
        const tw = ctx.measureText(item.label).width;
        ctx.strokeStyle = 'rgba(76,230,166,0.42)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x + box * 1.5, ry + box * 0.52);
        ctx.lineTo(x + box * 1.5 + tw, ry + box * 0.52);
        ctx.stroke();
      }
    });
  }

  /**
   * Radial confidence gauge.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} x Left edge.
   * @param {number} y Top edge.
   * @param {number} w Width.
   * @param {number} h Height.
   * @param {number} time Absolute time.
   * @private
   */
  #paintGauge(ctx, x, y, w, h, time) {
    const gauge = this.data.gauge ?? { value: 0, label: '' };
    const cx = x + w * 0.5;
    const cy = y + h * 0.46;
    const radius = Math.min(w, h) * 0.36;
    const start = Math.PI * 0.78;
    const sweep = Math.PI * 1.44;
    const value = clamp(gauge.value ?? 0, 0, 1);

    // Track.
    ctx.strokeStyle = 'rgba(110,190,240,0.16)';
    ctx.lineWidth = radius * 0.17;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + sweep);
    ctx.stroke();

    // Value arc.
    const color = value > 0.85 ? INK.ok : value > 0.6 ? INK.accent : INK.warn;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = radius * 0.42;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + sweep * value);
    ctx.stroke();
    ctx.restore();

    // Tick marks.
    ctx.strokeStyle = 'rgba(150,195,235,0.3)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i <= 10; i++) {
      const a = start + (sweep / 10) * i;
      const r0 = radius * 1.16;
      const r1 = radius * (i % 5 === 0 ? 1.3 : 1.24);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }

    // Centre read-out.
    const valueSize = Math.round(radius * 0.72);
    ctx.fillStyle = INK.base;
    ctx.font = `200 ${valueSize}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(value * 100)}`, cx, cy + valueSize * 0.28);

    ctx.fillStyle = INK.faint;
    ctx.font = `500 ${Math.round(radius * 0.19)}px ${MONO_FONT}`;
    trackedText(ctx, gauge.label.toUpperCase(), cx, cy + radius * 0.72, radius * 0.03, 'center');

    if (gauge.caption) {
      ctx.fillStyle = INK.dim;
      ctx.font = `400 ${Math.round(radius * 0.2)}px ${UI_FONT}`;
      ctx.fillText(gauge.caption, cx, y + h - radius * 0.06);
    }

    // Orbiting scan dot: cheap, but it makes the gauge feel like it is thinking.
    const a = start + sweep * value;
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 4);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = color;
    ctx.shadowBlur = radius * 0.5;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, radius * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.textAlign = 'left';
  }

  /**
   * Body copy, optionally revealed character by character.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} x Left edge.
   * @param {number} y Top edge.
   * @param {number} w Width.
   * @param {number} h Height.
   * @private
   */
  #paintText(ctx, x, y, w, h) {
    const size = Math.round(h * 0.142);
    ctx.font = `400 ${size}px ${UI_FONT}`;

    let text = this.data.text ?? '';
    if (this.typewriter) {
      const chars = Math.floor(this.age * 34);
      text = text.slice(0, Math.max(0, chars));
    }

    const lines = wrapText(ctx, text, w);
    ctx.fillStyle = 'rgba(214,234,250,0.94)';
    lines.forEach((line, i) => {
      ctx.fillText(line, x, y + size * (1.05 + i * 1.42));
    });

    // Blinking caret while the text is still arriving.
    if (this.typewriter && text.length < (this.data.text ?? '').length) {
      const last = lines.at(-1) ?? '';
      const cw = ctx.measureText(last).width;
      ctx.fillStyle = INK.accent;
      ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(this.age * 6));
      ctx.fillRect(
        x + cw + 4,
        y + size * (0.25 + Math.max(0, lines.length - 1) * 1.42),
        size * 0.5, size,
      );
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Footer strip.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} x Left edge.
   * @param {number} y Top edge.
   * @param {number} w Width.
   * @param {number} h Height.
   * @private
   */
  #paintFooter(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(110,190,240,0.16)';
    ctx.fillRect(x, y, w, 1);
    ctx.fillStyle = INK.faint;
    ctx.font = `500 ${Math.round(h * 0.4)}px ${MONO_FONT}`;
    ctx.textAlign = 'left';
    trackedText(ctx, (this.data.footer ?? '').toUpperCase(), x, y + h * 0.75, h * 0.05, 'left');
  }

  /** Releases GPU resources. */
  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** Semantic ink colours, exported so other holographic surfaces stay in step. */
export { INK };
