/**
 * @file Glow.js
 * @description The shader library that defines AeroMind's holographic language:
 * glass panels, volumetric light shafts, ground projections, the atmospheric
 * backdrop, and the two screen-space passes that finish each eye.
 *
 * Every material produced here registers its `uTime` uniform with a central
 * clock, so a single call to {@link GlowSystem#update} advances the entire
 * holographic layer. That keeps animation perfectly in sync between the left
 * and right eye — each eye renders the same frame state, which is essential for
 * comfortable stereoscopic viewing.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';

/** Shared GLSL: hash/noise helpers injected into several fragment shaders. */
const GLSL_NOISE = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float scanline(float coord, float speed, float density, float time) {
    return smoothstep(0.55, 1.0, sin((coord * density) - time * speed) * 0.5 + 0.5);
  }
`;

/**
 * Central registry and clock for every animated holographic material.
 * @class
 */
class GlowSystem {
  constructor() {
    /** @type {Set<ShaderMaterial>} Materials driven by the shared clock. */
    this.materials = new Set();
    /** @type {number} Seconds since start. */
    this.time = 0;
  }

  /**
   * Registers a material so its `uTime` uniform is advanced automatically.
   * @param {ShaderMaterial} material Material exposing a `uTime` uniform.
   * @returns {ShaderMaterial} The same material, for chaining.
   */
  register(material) {
    if (material?.uniforms?.uTime) this.materials.add(material);
    return material;
  }

  /**
   * Releases a material and frees its GPU resources.
   * @param {ShaderMaterial} material Material to drop.
   */
  unregister(material) {
    this.materials.delete(material);
  }

  /**
   * Advances the shared clock. Called once per frame, before rendering either
   * eye, so both eyes observe an identical world state.
   * @param {number} time Absolute time in seconds.
   */
  update(time) {
    this.time = time;
    for (const m of this.materials) m.uniforms.uTime.value = time;
  }

  /** Disposes every registered material. */
  dispose() {
    for (const m of this.materials) m.dispose();
    this.materials.clear();
  }
}

/** Singleton clock shared by the whole holographic layer. */
export const Glow = new GlowSystem();

/* =========================================================================
   Glass panel — the substrate for every floating UI surface
   ========================================================================= */

/**
 * Creates the frosted-glass material used behind holographic panels. The panel
 * content arrives as a canvas texture; this shader adds the depth cues that
 * make it feel like a physical pane of light: edge refraction, a travelling
 * specular sheen, corner brackets and a soft vignette.
 *
 * @param {object} options Material configuration.
 * @param {import('three').Texture} options.map Panel content texture.
 * @param {number|string} [options.tint] Glass tint.
 * @param {number|string} [options.border] Border colour.
 * @param {number} [options.opacity] Global opacity.
 * @param {number} [options.radius] Corner radius in UV units.
 * @param {number} [options.aspect] Panel width / height, for square corners.
 * @returns {ShaderMaterial}
 */
export function createPanelMaterial(options) {
  const {
    map,
    tint = 0x0a1c33,
    border = 0x6fd2ff,
    opacity = 1.0,
    radius = 0.045,
    aspect = 1.6,
  } = options;

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: map },
      uTint: { value: new Color(tint) },
      uBorder: { value: new Color(border) },
      uOpacity: { value: opacity },
      uRadius: { value: radius },
      uAspect: { value: aspect },
      /** 0 = collapsed to a line, 1 = fully materialised. */
      uOpen: { value: 1.0 },
      /** Extra rim energy used for attention pulses. */
      uHighlight: { value: 0.0 },
      uHighlightColor: { value: new Color(0x6fd2ff) },
    },
    vertexShader: /* glsl */ `
      uniform float uOpen;
      varying vec2 vUv;
      varying vec3 vViewDir;

      void main() {
        vUv = uv;
        // Panels unfold vertically from their centre line as they materialise.
        vec3 p = position;
        p.y *= smoothstep(0.0, 1.0, uOpen);
        vec4 worldPos = modelMatrix * vec4(p, 1.0);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uMap;
      uniform vec3  uTint;
      uniform vec3  uBorder;
      uniform float uOpacity;
      uniform float uRadius;
      uniform float uAspect;
      uniform float uOpen;
      uniform float uHighlight;
      uniform vec3  uHighlightColor;

      varying vec2 vUv;
      varying vec3 vViewDir;

      ${GLSL_NOISE}

      /** Signed distance to a rounded box centred on the UV space. */
      float sdRoundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
      }

      void main() {
        vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
        vec2 half_ = vec2(uAspect, 1.0) * 0.5;
        float d = sdRoundBox(p, half_, uRadius);

        // Hard clip outside the rounded silhouette, antialiased by 1px.
        float aa = fwidth(d) * 1.2;
        float inside = 1.0 - smoothstep(-aa, aa, d);
        if (inside < 0.002) discard;

        vec4 content = texture2D(uMap, vUv);

        // Frosted substrate: darker toward the edges, slight view-dependent lift.
        float vignette = smoothstep(0.0, 0.35, -d);
        vec3 glass = uTint * (0.55 + 0.75 * vignette);

        // Travelling specular sheen, like light raking across glass.
        float sheen = smoothstep(0.86, 1.0, sin((vUv.x + vUv.y) * 3.0 - uTime * 0.55));
        glass += vec3(0.25, 0.45, 0.7) * sheen * 0.16;

        // Border: a bright 2-unit rim hugging the rounded edge.
        float rim = smoothstep(0.014, 0.0, abs(d)) ;
        float rimSoft = smoothstep(0.09, 0.0, abs(d)) * 0.35;

        // Animated corner brackets travelling around the perimeter.
        float perim = atan(p.y, p.x) / 6.2831853 + 0.5;
        float chase = smoothstep(0.75, 1.0, sin(perim * 12.566 - uTime * 1.8) * 0.5 + 0.5);

        vec3 col = glass;
        col = mix(col, content.rgb, content.a);
        col += uBorder * (rim * (0.9 + chase * 0.8) + rimSoft);
        col += uHighlightColor * uHighlight * (rim * 1.6 + 0.25 * vignette);

        // Materialisation wipe.
        float wipe = smoothstep(uOpen * 1.15 - 0.15, uOpen * 1.15, 1.0 - vUv.y);
        col += uBorder * wipe * 0.9 * (1.0 - uOpen) * 4.0;

        float alpha = inside * uOpacity * smoothstep(0.0, 0.25, uOpen);
        float bodyAlpha = mix(0.62, 0.92, vignette);
        alpha *= max(bodyAlpha, max(content.a, rim));

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  return Glow.register(material);
}

/* =========================================================================
   Volumetric light shaft
   ========================================================================= */

/**
 * Creates the material for a cone of light in fog: bright at the emitter,
 * dissolving with distance, with slow drifting density so it feels alive.
 * @param {object} [options] Material configuration.
 * @param {number|string} [options.color] Shaft colour.
 * @param {number} [options.intensity] Brightness multiplier.
 * @param {number} [options.falloff] Distance falloff exponent.
 * @returns {ShaderMaterial}
 */
export function createLightShaftMaterial(options = {}) {
  const { color = 0x8ec9ff, intensity = 0.35, falloff = 1.8 } = options;

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(color) },
      uIntensity: { value: intensity },
      uFalloff: { value: falloff },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3  uColor;
      uniform float uIntensity;
      uniform float uFalloff;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;

      ${GLSL_NOISE}

      void main() {
        // Fade along the cone (uv.y runs from apex to base on a ConeGeometry).
        float along = pow(1.0 - vUv.y, uFalloff);

        // Grazing angles are thicker: that is what sells the volume.
        float grazing = 1.0 - abs(dot(normalize(vWorldNormal), normalize(vViewDir)));
        grazing = pow(grazing, 1.4);

        // Slow density drift, as if dust were moving through the beam.
        float drift = 0.85 + 0.15 * sin(vUv.x * 18.0 + uTime * 0.5)
                            * cos(vUv.y * 9.0 - uTime * 0.31);

        float a = along * grazing * drift * uIntensity;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });

  return Glow.register(material);
}

/* =========================================================================
   Ground projection — the pool of light an emitter casts on the floor
   ========================================================================= */

/**
 * Creates a soft additive disc used for light pools and holographic footprints.
 * @param {object} [options] Material configuration.
 * @param {number|string} [options.color] Disc colour.
 * @param {number} [options.intensity] Brightness multiplier.
 * @param {number} [options.rings] Number of concentric technical rings.
 * @returns {ShaderMaterial}
 */
export function createGroundGlowMaterial(options = {}) {
  const { color = 0x4fc3ff, intensity = 0.5, rings = 3.0 } = options;

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(color) },
      uIntensity: { value: intensity },
      uRings: { value: rings },
      uProgress: { value: 1.0 },
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
      uniform float uIntensity;
      uniform float uRings;
      uniform float uProgress;
      varying vec2 vUv;

      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        if (r > 1.0) discard;

        float core = pow(1.0 - r, 2.4);
        float ring = smoothstep(0.9, 1.0, sin(r * uRings * 6.2831853 - uTime * 1.2)) * 0.35;
        float sweep = smoothstep(0.02, 0.0, abs(r - fract(uTime * 0.35))) * 0.6;
        float a = (core + ring * (1.0 - r) + sweep * (1.0 - r)) * uIntensity * uProgress;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });

  return Glow.register(material);
}

/* =========================================================================
   Atmospheric backdrop
   ========================================================================= */

/**
 * Creates the inward-facing gradient dome that closes the world off. It is not
 * a skybox in the usual sense — it is the residual glow of a very large, very
 * dark room, and it gives the fog something to fade into.
 * @param {object} [options] Material configuration.
 * @param {number|string} [options.top] Colour at the zenith.
 * @param {number|string} [options.bottom] Colour at the horizon.
 * @returns {ShaderMaterial}
 */
export function createAtmosphereMaterial(options = {}) {
  const { top = 0x040910, bottom = 0x0d1f33 } = options;

  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uTop: { value: new Color(top) },
      uBottom: { value: new Color(bottom) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocalPos;
      void main() {
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      varying vec3 vLocalPos;
      void main() {
        float h = normalize(vLocalPos).y * 0.5 + 0.5;
        gl_FragColor = vec4(mix(uBottom, uTop, smoothstep(0.25, 0.85, h)), 1.0);
      }
    `,
  });

  return Glow.register(material);
}

/* =========================================================================
   Screen-space helpers used by the stereo compositor
   ========================================================================= */

/**
 * Barrel-distortion + chromatic-aberration shader applied to each eye when
 * rendering through a Cardboard-class viewer.
 *
 * A stereoscopic viewer's lens magnifies the image and introduces pincushion
 * distortion; pre-distorting the render with the inverse (barrel) function
 * cancels it, so straight lines in the world stay straight through the lens.
 *
 * @type {{uniforms: object, vertexShader: string, fragmentShader: string}}
 */
export const LensDistortionShader = {
  uniforms: {
    tDiffuse: { value: null },
    /** Lens centre in UV space; Cardboard lenses sit off-centre per eye. */
    uCenter: { value: new Vector2(0.5, 0.5) },
    /**
     * Radial distortion coefficients (k1, k2). These sit in the middle of the
     * range covered by Cardboard-class viewers: enough pre-distortion that
     * straight edges stay straight through the lens, without throwing away so
     * much of the frame to the black corners that the field of view suffers.
     */
    uCoefficients: { value: new Vector2(0.17, 0.15) },
    /** Overall strength; 0 disables distortion entirely. */
    uStrength: { value: 1.0 },
    /** Chromatic aberration, in UV units at the image edge. */
    uAberration: { value: 0.0022 },
    /** Vignette darkening at the frame edge. */
    uVignette: { value: 0.28 },
    /** Scales the sampled area so the distorted image still fills the eye. */
    uScale: { value: 0.95 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2  uCenter;
    uniform vec2  uCoefficients;
    uniform float uStrength;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uScale;
    varying vec2 vUv;

    /** Applies the radial polynomial to a centred coordinate. */
    vec2 distort(vec2 centred, float scale) {
      float r2 = dot(centred, centred);
      float f = 1.0 + uStrength * (uCoefficients.x * r2 + uCoefficients.y * r2 * r2);
      return centred * f * scale;
    }

    void main() {
      vec2 centred = vUv - uCenter;

      vec2 uvR = distort(centred, uScale * (1.0 + uAberration)) + uCenter;
      vec2 uvG = distort(centred, uScale) + uCenter;
      vec2 uvB = distort(centred, uScale * (1.0 - uAberration)) + uCenter;

      // Anything sampled from outside the source is black — that is the dark
      // border you legitimately see at the edge of a Cardboard image.
      float inside =
        step(0.0, uvG.x) * step(uvG.x, 1.0) *
        step(0.0, uvG.y) * step(uvG.y, 1.0);

      vec3 col = vec3(
        texture2D(tDiffuse, clamp(uvR, 0.0, 1.0)).r,
        texture2D(tDiffuse, clamp(uvG, 0.0, 1.0)).g,
        texture2D(tDiffuse, clamp(uvB, 0.0, 1.0)).b
      ) * inside;

      float v = 1.0 - uVignette * dot(centred, centred) * 4.0;
      gl_FragColor = vec4(col * clamp(v, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Final grade applied to the monoscopic desktop preview: filmic contrast, a
 * whisper of chromatic aberration and a cinematic vignette.
 * @type {{uniforms: object, vertexShader: string, fragmentShader: string}}
 */
export const CinematicGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    /** Global fade-to-black used by the story director. */
    uFade: { value: 1.0 },
    uVignette: { value: 0.5 },
    uAberration: { value: 0.0012 },
    uGrain: { value: 0.035 },
    uTint: { value: new Vector3(1.0, 1.005, 1.03) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFade;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uGrain;
    uniform vec3  uTint;
    varying vec2 vUv;

    ${GLSL_NOISE}

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      vec3 col = vec3(
        texture2D(tDiffuse, vUv + c * uAberration).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - c * uAberration).b
      );

      col *= uTint;

      // Gentle filmic shoulder — keeps highlights from clipping to flat white.
      col = col / (col + vec3(0.155)) * 1.155;

      float vig = 1.0 - uVignette * r2 * 2.2;
      col *= clamp(vig, 0.0, 1.0);

      // Sensor grain, animated so it never looks like a static overlay.
      float g = hash21(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(max(col, vec3(0.0)) * uFade, 1.0);
    }
  `,
};
