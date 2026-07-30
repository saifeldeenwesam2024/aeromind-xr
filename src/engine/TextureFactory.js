/**
 * @file TextureFactory.js
 * @description Procedural texture generation. Every surface, label and panel in
 * AeroMind XR is authored in code with the Canvas 2D API rather than shipped as
 * an image file. This keeps the payload tiny, makes the experience work fully
 * offline, and lets typography stay razor-sharp at any panel size.
 */

import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  ClampToEdgeWrapping,
  RGBAFormat,
  SRGBColorSpace,
  NoColorSpace,
} from 'three';

/** Font stack used for every rendered label. Resolves offline on all targets. */
export const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Helvetica Neue", Arial, sans-serif';
/** Monospaced stack for telemetry read-outs. */
export const MONO_FONT =
  'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * Creates a 2D drawing surface.
 * @param {number} w Width in pixels.
 * @param {number} h Height in pixels.
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}}
 */
export function createCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(w));
  canvas.height = Math.max(2, Math.round(h));
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
  ctx.textBaseline = 'alphabetic';
  return { canvas, ctx };
}

/**
 * Wraps a canvas in a colour-managed texture with sensible filtering.
 * @param {HTMLCanvasElement} canvas Source canvas.
 * @param {object} [options] Texture options.
 * @param {boolean} [options.srgb] Treat the canvas as colour data.
 * @param {number} [options.anisotropy] Anisotropic filtering level.
 * @param {boolean} [options.repeat] Enable tiling.
 * @returns {CanvasTexture}
 */
export function canvasTexture(canvas, options = {}) {
  const { srgb = true, anisotropy = 8, repeat = false } = options;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.anisotropy = anisotropy;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Draws a rounded rectangle path on the supplied context.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {number} x Left edge.
 * @param {number} y Top edge.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} r Corner radius.
 */
export function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * Draws letter-spaced text, which the Canvas API does not support natively on
 * every browser. Returns the advance width so callers can lay out rows.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {string} text Text to draw.
 * @param {number} x Baseline start X.
 * @param {number} y Baseline Y.
 * @param {number} [spacing] Extra spacing between glyphs in pixels.
 * @param {'left'|'center'|'right'} [align] Horizontal alignment about `x`.
 * @returns {number} Total drawn width.
 */
export function trackedText(ctx, text, x, y, spacing = 0, align = 'left') {
  const chars = [...text];
  let total = 0;
  for (const c of chars) total += ctx.measureText(c).width + spacing;
  total -= spacing;

  let cursor = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const previousAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const c of chars) {
    ctx.fillText(c, cursor, y);
    cursor += ctx.measureText(c).width + spacing;
  }
  ctx.textAlign = previousAlign;
  return total;
}

/**
 * Word-wraps text into lines that fit `maxWidth` using the current font.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {string} text Source text.
 * @param {number} maxWidth Maximum line width in pixels.
 * @returns {string[]} Wrapped lines.
 */
export function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/* =========================================================================
   Material maps
   ========================================================================= */

/**
 * Brushed-metal albedo/roughness pair for the engine cowling and structures.
 * @param {object} [options] Generation options.
 * @param {number} [options.size] Texture resolution.
 * @param {string} [options.base] Base colour.
 * @param {number} [options.streaks] Number of brushed streaks.
 * @returns {{map: CanvasTexture, roughnessMap: CanvasTexture}}
 */
export function createBrushedMetal(options = {}) {
  const { size = 512, base = '#6d7683', streaks = 900 } = options;
  const { canvas, ctx } = createCanvas(size, size);

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Horizontal brushing.
  for (let i = 0; i < streaks; i++) {
    const y = Math.random() * size;
    const alpha = 0.02 + Math.random() * 0.05;
    ctx.strokeStyle = Math.random() > 0.5
      ? `rgba(255,255,255,${alpha})`
      : `rgba(0,0,0,${alpha})`;
    ctx.lineWidth = 0.5 + Math.random() * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 3);
    ctx.stroke();
  }

  // Subtle large-scale mottling so flat panels are never perfectly uniform.
  for (let i = 0; i < 60; i++) {
    const r = 30 + Math.random() * 140;
    const g = ctx.createRadialGradient(
      Math.random() * size, Math.random() * size, 0,
      Math.random() * size, Math.random() * size, r,
    );
    g.addColorStop(0, `rgba(255,255,255,${0.012 + Math.random() * 0.02})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  const rough = createCanvas(size, size);
  rough.ctx.drawImage(canvas, 0, 0);
  rough.ctx.globalCompositeOperation = 'saturation';
  rough.ctx.fillStyle = '#808080';
  rough.ctx.fillRect(0, 0, size, size);
  rough.ctx.globalCompositeOperation = 'source-over';
  rough.ctx.fillStyle = 'rgba(120,120,120,0.55)';
  rough.ctx.fillRect(0, 0, size, size);

  return {
    map: canvasTexture(canvas, { repeat: true }),
    roughnessMap: canvasTexture(rough.canvas, { srgb: false, repeat: true }),
  };
}

/**
 * Worn concrete hangar floor with painted safety markings and specular sheen.
 * @param {number} [size] Texture resolution.
 * @returns {{map: CanvasTexture, roughnessMap: CanvasTexture}}
 */
export function createHangarFloor(size = 1024) {
  const { canvas, ctx } = createCanvas(size, size);

  ctx.fillStyle = '#14181f';
  ctx.fillRect(0, 0, size, size);

  // Aggregate speckle.
  for (let i = 0; i < 26000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() * 1.6;
    const shade = 18 + Math.random() * 34;
    ctx.fillStyle = `rgba(${shade},${shade + 3},${shade + 8},${0.25 + Math.random() * 0.5})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Expansion joints on a 4-cell grid.
  ctx.strokeStyle = 'rgba(6,8,12,0.85)';
  ctx.lineWidth = 3;
  for (let i = 1; i < 4; i++) {
    const p = (size / 4) * i;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }

  // Faded safety line.
  ctx.strokeStyle = 'rgba(196,158,60,0.16)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(size * 0.08, 0);
  ctx.lineTo(size * 0.08, size);
  ctx.stroke();

  // Grime pools.
  for (let i = 0; i < 40; i++) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    const r = 40 + Math.random() * 160;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // Roughness: darker = smoother = more reflective, giving a polished-but-worn
  // floor that catches the hangar lights.
  const rough = createCanvas(size, size);
  rough.ctx.fillStyle = '#4a4a4a';
  rough.ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    const r = 60 + Math.random() * 220;
    const g = rough.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(${Math.random() > 0.5 ? 150 : 20},0,0,0.35)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    rough.ctx.fillStyle = g;
    rough.ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  return {
    map: canvasTexture(canvas, { repeat: true }),
    roughnessMap: canvasTexture(rough.canvas, { srgb: false, repeat: true }),
  };
}

/**
 * Soft radial sprite used for dust motes, sparks and light bloom points.
 * @param {number} [size] Texture resolution.
 * @param {number} [hardness] 0 = very soft, 1 = hard edged.
 * @returns {CanvasTexture}
 */
export function createSoftSprite(size = 128, hardness = 0.25) {
  const { canvas, ctx } = createCanvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(Math.max(0.01, hardness), 'rgba(255,255,255,0.65)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = canvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = LinearFilter;
  return tex;
}

/**
 * Anamorphic streak sprite for LED highlights and lens glints.
 * @param {number} [w] Width.
 * @param {number} [h] Height.
 * @returns {CanvasTexture}
 */
export function createStreakSprite(w = 256, h = 64) {
  const { canvas, ctx } = createCanvas(w, h);
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, h * 0.5 - 1.5, w, 3);
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, h * 0.5 - 6, w, 12);
  ctx.globalAlpha = 0.12;
  ctx.fillRect(0, h * 0.5 - 18, w, 36);
  const tex = canvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = LinearFilter;
  return tex;
}

/**
 * Generates the thermal gradient look-up ramp (cool blue → amber → white hot).
 * Sampled by the engine's heat-map overlay shader.
 * @param {number} [width] Ramp resolution.
 * @returns {DataTexture}
 */
export function createThermalRamp(width = 256) {
  const stops = [
    [0.00, [0.02, 0.09, 0.28]],
    [0.25, [0.05, 0.42, 0.78]],
    [0.45, [0.10, 0.78, 0.62]],
    [0.62, [0.85, 0.82, 0.20]],
    [0.80, [1.00, 0.52, 0.10]],
    [1.00, [1.00, 0.93, 0.86]],
  ];
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    }
    const k = (t - a[0]) / (b[0] - a[0] || 1);
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.round(255 * (a[1][c] + (b[1][c] - a[1][c]) * k));
    }
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, width, 1, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  return tex;
}

/**
 * Renders a headline block — the typography used for the title cards. Text is
 * drawn on a transparent canvas so it can be composited additively in world
 * space with a bloom-friendly glow.
 * @param {object} spec Headline description.
 * @param {string} [spec.eyebrow] Small tracked label above the title.
 * @param {string} spec.title Main headline.
 * @param {string} [spec.subtitle] Supporting line.
 * @param {string[]} [spec.bullets] Optional tracked words below.
 * @param {number} [spec.width] Canvas width.
 * @param {number} [spec.height] Canvas height.
 * @param {string} [spec.color] Primary ink colour.
 * @param {string} [spec.accent] Accent ink colour.
 * @returns {CanvasTexture}
 */
export function createHeadline(spec) {
  const {
    eyebrow = '', title = '', subtitle = '', bullets = [],
    width = 2048, height = 1024,
    color = '#eaf4ff', accent = '#7ad9ff',
  } = spec;

  const { canvas, ctx } = createCanvas(width, height);
  const cx = width / 2;
  let y = height * 0.5;

  // Vertical rhythm is computed first so the block is optically centred.
  const titleSize = Math.round(height * 0.19);
  const blockH =
    (eyebrow ? height * 0.09 : 0) +
    titleSize * 1.05 +
    (subtitle ? height * 0.11 : 0) +
    (bullets.length ? height * 0.14 : 0);
  y = (height - blockH) / 2;

  ctx.textAlign = 'center';

  if (eyebrow) {
    y += height * 0.07;
    ctx.font = `500 ${Math.round(height * 0.035)}px ${MONO_FONT}`;
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = height * 0.03;
    trackedText(ctx, eyebrow.toUpperCase(), cx, y, height * 0.018, 'center');
    y += height * 0.02;
  }

  if (title) {
    y += titleSize * 0.86;
    ctx.font = `200 ${titleSize}px ${UI_FONT}`;
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(122,217,255,0.85)';
    ctx.shadowBlur = height * 0.05;
    trackedText(ctx, title, cx, y, titleSize * 0.045, 'center');
    y += titleSize * 0.28;
  }

  if (subtitle) {
    y += height * 0.075;
    ctx.font = `300 ${Math.round(height * 0.045)}px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(160,196,230,0.92)';
    ctx.shadowBlur = height * 0.02;
    trackedText(ctx, subtitle, cx, y, height * 0.006, 'center');
  }

  if (bullets.length) {
    y += height * 0.115;
    ctx.font = `400 ${Math.round(height * 0.042)}px ${MONO_FONT}`;
    ctx.shadowColor = accent;
    ctx.shadowBlur = height * 0.028;
    const gap = height * 0.055;
    ctx.fillStyle = accent;

    // Measure the whole row so the words distribute evenly around centre.
    const widths = bullets.map((b) => {
      let w = 0;
      for (const c of b.toUpperCase()) w += ctx.measureText(c).width + height * 0.012;
      return w;
    });
    const total = widths.reduce((a, b) => a + b, 0) + gap * (bullets.length - 1);
    let cursor = cx - total / 2;
    bullets.forEach((b, i) => {
      trackedText(ctx, b.toUpperCase(), cursor, y, height * 0.012, 'left');
      cursor += widths[i] + gap;
      if (i < bullets.length - 1) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.fillRect(cursor - gap * 0.5, y - height * 0.014, 2, height * 0.02);
        ctx.restore();
      }
    });
  }

  ctx.shadowBlur = 0;
  return canvasTexture(canvas);
}
