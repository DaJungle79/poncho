import { describe, expect, it } from 'vitest';
import { Noise } from '../../src/core/apu/noise';

describe('Noise channel', () => {
  it('LFSR starts at 1 and shifts every period cycle', () => {
    const n = new Noise();
    n.setEnabled(true);
    n.write(0, 0x1f); // constant volume 15
    n.write(2, 0x00); // mode 0, period 4 (smallest)
    n.write(3, 0x08); // length-index 1 (254)
    // Tick the timer enough to consume several shifts.
    const seenOutputs = new Set<number>();
    for (let i = 0; i < 200; i++) {
      n.tickTimer();
      seenOutputs.add(n.output());
    }
    // We should see both 0 and 15 — the LFSR cycles through opaque +
    // transparent halves.
    expect(seenOutputs.has(0)).toBe(true);
    expect(seenOutputs.has(15)).toBe(true);
  });

  it('is silent when length counter is 0', () => {
    const n = new Noise();
    n.write(0, 0x1f);
    n.write(2, 0x00);
    n.write(3, 0x08);
    // Never enabled (length never loaded).
    for (let i = 0; i < 50; i++) n.tickTimer();
    expect(n.output()).toBe(0);
  });

  it('mode 1 short LFSR produces a different (shorter) cycle than mode 0', () => {
    const setup = (mode: 0 | 1) => {
      const n = new Noise();
      n.setEnabled(true);
      n.write(0, 0x1f);
      n.write(2, mode === 1 ? 0x80 : 0x00);
      n.write(3, 0x08);
      const seen: number[] = [];
      for (let i = 0; i < 1000; i++) {
        n.tickTimer();
        seen.push(n.output());
      }
      return seen.join(',');
    };
    expect(setup(0)).not.toBe(setup(1));
  });
});
