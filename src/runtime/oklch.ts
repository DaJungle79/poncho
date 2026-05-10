/**
 * sRGB ↔ Oklch conversion helpers — minimal, allocation-free.
 *
 * Oklch (Björn Ottosson, 2020) is a polar form of Oklab — a
 * perceptually-uniform colour space designed so that linear
 * interpolation between two colours in this space produces
 * perceptually-linear gradients (no muddy mid-tones, no hue shifts).
 *
 * v0.5's Phase 4.6 extended sub-palette uses this for ramp generation:
 * the per-base shading ramp interpolates from `lerp_oklch(black, base)`
 * for the lower half and `lerp_oklch(base, white)` for the upper half.
 * Result vs. the original linear-sRGB lerp: mid-shades are visibly
 * brighter / closer to perceptual midpoint, so xBRZ-snap output lands
 * on a closer perceptual match for any RGB midpoint.
 *
 * The chain (forward):
 *   sRGB byte (0..255) → linear sRGB → LMS' (cube root) → Oklab → Oklch
 *
 * Reverse:
 *   Oklch → Oklab → LMS' (cube) → linear sRGB → sRGB byte
 *
 * Polynomial constants from Ottosson's reference:
 * https://bottosson.github.io/posts/oklab/
 *
 * The whole module is < 80 LOC, no dependencies, no per-call allocs.
 */

/** Triple of (L, a, b) in Oklab space. Stored as separate numbers to avoid arrays. */
export interface Oklab { L: number; a: number; b: number }

/** Triple of (L, C, h) in Oklch — h in radians. */
export interface Oklch { L: number; C: number; h: number }

/** sRGB byte 0..255 → linear sRGB 0..1 (gamma decode). */
function srgbByteToLinear(v: number): number {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Linear sRGB 0..1 → sRGB byte 0..255 (gamma encode + clamp). */
function linearToSrgbByte(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 255;
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

/** Linear sRGB → Oklab. */
export function linearSrgbToOklab(r: number, g: number, b: number): Oklab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

/** Oklab → linear sRGB. */
export function oklabToLinearSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r:  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

/** sRGB byte triple → Oklab. */
export function srgbToOklab(r: number, g: number, b: number): Oklab {
  return linearSrgbToOklab(
    srgbByteToLinear(r),
    srgbByteToLinear(g),
    srgbByteToLinear(b),
  );
}

/** Oklab → sRGB byte triple. */
export function oklabToSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const lin = oklabToLinearSrgb(L, a, b);
  return {
    r: linearToSrgbByte(lin.r),
    g: linearToSrgbByte(lin.g),
    b: linearToSrgbByte(lin.b),
  };
}

/** Oklab → Oklch (polar form). */
export function oklabToOklch(L: number, a: number, b: number): Oklch {
  return { L, C: Math.sqrt(a * a + b * b), h: Math.atan2(b, a) };
}

/** Oklch → Oklab. */
export function oklchToOklab(L: number, C: number, h: number): Oklab {
  return { L, a: C * Math.cos(h), b: C * Math.sin(h) };
}

/**
 * Linear interpolate two sRGB byte triples through Oklab (NOT Oklch —
 * Oklab linear interpolation is perceptually uniform AND doesn't have
 * to handle the hue-wraparound of Oklch). For our use case (black →
 * base → white ramps, all sharing similar hue), Oklab is the right
 * choice; the polar form is only needed for cross-hue blends.
 *
 * `t` in 0..1 — t=0 returns colour A, t=1 returns colour B.
 *
 * Returns sRGB bytes (already gamma-encoded + clamped).
 */
export function lerpOklab(
  ar: number, ag: number, ab: number,
  br: number, bg: number, bb: number,
  t: number,
): { r: number; g: number; b: number } {
  const A = srgbToOklab(ar, ag, ab);
  const B = srgbToOklab(br, bg, bb);
  return oklabToSrgb(
    A.L + (B.L - A.L) * t,
    A.a + (B.a - A.a) * t,
    A.b + (B.b - A.b) * t,
  );
}
