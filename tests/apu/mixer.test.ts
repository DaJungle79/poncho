import { describe, expect, it } from 'vitest';
import { mixSample } from '../../src/core/apu/mixer';

describe('mixSample', () => {
  it('returns 0 when all channels are silent', () => {
    expect(mixSample({ pulse1: 0, pulse2: 0, triangle: 0, noise: 0, dmc: 0 })).toBe(0);
  });

  it('is monotonically non-decreasing as pulse volume rises', () => {
    let last = 0;
    for (let v = 0; v <= 15; v++) {
      const out = mixSample({ pulse1: v, pulse2: 0, triangle: 0, noise: 0, dmc: 0 });
      expect(out).toBeGreaterThanOrEqual(last);
      last = out;
    }
  });

  it('compresses signal when channels stack up (non-linear mixer)', () => {
    const onePulse = mixSample({ pulse1: 15, pulse2: 0, triangle: 0, noise: 0, dmc: 0 });
    const twoPulses = mixSample({ pulse1: 15, pulse2: 15, triangle: 0, noise: 0, dmc: 0 });
    expect(onePulse).toBeGreaterThan(0);
    expect(twoPulses).toBeGreaterThan(onePulse);
    // Doubling pulse 1 doesn't double the output — non-linear compression.
    expect(twoPulses).toBeLessThan(2 * onePulse);
  });

  it('output stays in the [0, 1.1] range even with everything maxed', () => {
    const max = mixSample({ pulse1: 15, pulse2: 15, triangle: 15, noise: 15, dmc: 127 });
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(1.1);
  });
});
