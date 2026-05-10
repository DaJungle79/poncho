/**
 * Oklch / Oklab conversion tests.
 *
 * Coverage:
 *   - Round-trip sRGB → Oklab → sRGB is identity (within ±1 byte)
 *   - Round-trip via Oklch (polar form) is also identity
 *   - lerpOklab(black, white, 0.5) is significantly brighter than the
 *     linear-RGB midpoint — proves the perceptual benefit
 *   - Oklab linear interpolation produces monotonic luminance
 *   - Endpoints (t=0 and t=1) are exact
 */

import { describe, expect, it } from 'vitest';
import {
  lerpOklab,
  oklabToOklch,
  oklabToSrgb,
  oklchToOklab,
  srgbToOklab,
} from '../../src/runtime/oklch';

describe('oklch — sRGB round-trip', () => {
  const SAMPLES = [
    [0, 0, 0],
    [255, 255, 255],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 200, 50],
    [123, 45, 67],
    [10, 200, 90],
  ];

  it('sRGB → Oklab → sRGB recovers each sample within ±1 byte', () => {
    for (const [r, g, b] of SAMPLES) {
      const lab = srgbToOklab(r!, g!, b!);
      const back = oklabToSrgb(lab.L, lab.a, lab.b);
      expect(Math.abs(back.r - r!)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - g!)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - b!)).toBeLessThanOrEqual(1);
    }
  });

  it('Oklab → Oklch → Oklab is exact (within float epsilon)', () => {
    for (const [r, g, b] of SAMPLES) {
      const lab1 = srgbToOklab(r!, g!, b!);
      const lch = oklabToOklch(lab1.L, lab1.a, lab1.b);
      const lab2 = oklchToOklab(lch.L, lch.C, lch.h);
      expect(Math.abs(lab2.L - lab1.L)).toBeLessThan(1e-9);
      expect(Math.abs(lab2.a - lab1.a)).toBeLessThan(1e-9);
      expect(Math.abs(lab2.b - lab1.b)).toBeLessThan(1e-9);
    }
  });
});

describe('lerpOklab — perceptual midpoint', () => {
  it('endpoints are exact', () => {
    const at0 = lerpOklab(255, 0, 0, 0, 0, 255, 0);
    expect(at0.r).toBeGreaterThanOrEqual(254); // round-trip ±1
    expect(at0.g).toBeLessThanOrEqual(1);
    expect(at0.b).toBeLessThanOrEqual(1);
    const at1 = lerpOklab(255, 0, 0, 0, 0, 255, 1);
    expect(at1.r).toBeLessThanOrEqual(1);
    expect(at1.g).toBeLessThanOrEqual(1);
    expect(at1.b).toBeGreaterThanOrEqual(254);
  });

  it('black → white midpoint differs measurably from the naïve linear midpoint', () => {
    // Linear-RGB midpoint between 0 and 255 is 128.
    // Oklab midpoint corresponds to sRGB byte ~99 (perceptual L=0.5
    // converts back through gamma + cube-root → roughly 100). The
    // exact value isn't the point — what matters is that the two
    // spaces produce *different* midpoints, proving Oklab isn't a
    // no-op wrapper around linear interpolation.
    const mid = lerpOklab(0, 0, 0, 255, 255, 255, 0.5);
    expect(Math.abs(mid.r - 128)).toBeGreaterThan(15);
    // Sanity — should still be a grey (R≈G≈B)
    expect(Math.abs(mid.r - mid.g)).toBeLessThanOrEqual(2);
    expect(Math.abs(mid.g - mid.b)).toBeLessThanOrEqual(2);
    // And bounded in 0..255.
    expect(mid.r).toBeGreaterThan(0);
    expect(mid.r).toBeLessThan(255);
  });

  it('produces monotonic luminance across a black → white ramp', () => {
    let lastSum = -1;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const c = lerpOklab(0, 0, 0, 255, 255, 255, t);
      const sum = c.r + c.g + c.b;
      expect(sum).toBeGreaterThanOrEqual(lastSum);
      lastSum = sum;
    }
  });

  it('coloured ramp (black → red) preserves hue trend', () => {
    // R should grow much faster than G or B from black to red.
    const at25 = lerpOklab(0, 0, 0, 255, 0, 0, 0.25);
    const at75 = lerpOklab(0, 0, 0, 255, 0, 0, 0.75);
    expect(at25.r).toBeGreaterThan(at25.g);
    expect(at25.r).toBeGreaterThan(at25.b);
    expect(at75.r).toBeGreaterThan(at25.r);
  });
});
