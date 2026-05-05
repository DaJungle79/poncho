import { describe, expect, it } from 'vitest';
import { Triangle } from '../../src/core/apu/triangle';

describe('Triangle channel', () => {
  it('is silent at reset (timer period 0 < 2 mute threshold)', () => {
    const t = new Triangle();
    expect(t.output()).toBe(0);
  });

  it('mutes when timer period is too low', () => {
    const t = new Triangle();
    t.setEnabled(true);
    t.write(0, 0x80); // control set, linearReload = 0
    t.write(2, 0x01); // period low
    t.write(3, 0x00); // period high = 0; total period = 1 < 2 → mute
    expect(t.output()).toBe(0);
  });

  it('advances sequence index when both gates are open', () => {
    const t = new Triangle();
    t.setEnabled(true);
    t.write(0, 0x80);   // control + linearReload = 0... but reload value 0 stalls
    t.write(0, 0xff);   // control + linearReload = 0x7F
    t.write(3, 0x09);   // length index 1 (254), period high=1, period = 0x100
    t.clockLinear();    // linear counter := 127
    // Period is 256; we need 256 ticks for one timer underflow.
    const start = t.output();
    for (let i = 0; i < 257; i++) t.tickTimer();
    const after = t.output();
    expect(after).not.toBe(start); // sequence advanced
  });
});
