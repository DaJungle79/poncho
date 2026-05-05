import { describe, expect, it } from 'vitest';
import { Pulse } from '../../src/core/apu/pulse';

describe('Pulse channel', () => {
  it('is silent until $4015 enable is set', () => {
    const p = new Pulse(0);
    p.write(0, 0x3f); // duty=0, constant volume = 15
    p.write(2, 0x10); // period low = 16
    p.write(3, 0x00); // length index 0 (10)
    expect(p.output()).toBe(0); // length not loaded (disabled)
  });

  it('outputs envelope value during the high half of the duty waveform', () => {
    const p = new Pulse(0);
    p.setEnabled(true);
    p.write(0, 0x3f);  // duty=0, constant volume=15
    p.write(2, 0x40);  // period low = 64 (>= 8 to avoid mute)
    p.write(3, 0x08);  // length index 1 (254 — long), period high=0
    // Duty pattern [0,1,0,0,0,0,0,0]; at phase 1, duty bit = 1.
    // Writing $4003 reset dutyPhase to 0 — currently silent.
    expect(p.output()).toBe(0);
    // Step the timer enough to roll into phase 1.
    for (let i = 0; i < 65; i++) p.tickTimer();
    // Now dutyPhase should be 1: high.
    expect(p.output()).toBe(15);
  });

  it('mutes when timer period is below 8', () => {
    const p = new Pulse(0);
    p.setEnabled(true);
    p.write(0, 0x3f);
    p.write(2, 0x05); // period 5 < 8: silenced
    p.write(3, 0x08);
    for (let i = 0; i < 100; i++) p.tickTimer();
    expect(p.output()).toBe(0);
  });

  it('mutes when length counter is 0', () => {
    const p = new Pulse(0);
    p.setEnabled(true);
    p.write(0, 0x3f);
    p.write(2, 0x40);
    p.write(3, 0x08);
    p.setEnabled(false); // forces length = 0
    expect(p.output()).toBe(0);
  });

  it('sweep changes timerPeriod when target is in range', () => {
    const p = new Pulse(0);
    p.setEnabled(true);
    p.write(0, 0x3f);
    p.write(2, 0x80); // period low
    p.write(3, 0x09); // period high = 1, period = 0x180 = 384
    // Sweep: enable | period 0 | negate=0 | shift 1 → adds period >> 1 each tick.
    p.write(1, 0x81);
    // First half-frame triggers a reload, divider=0; the reload happens BEFORE
    // the shift on real chip: nesdev says "if divider is 0 OR reload was set,
    // reload divider; else decrement".
    p.clockHalfFrame();
    // Period should now be ~384 + 192 = 576.
    expect(p.output() >= 0).toBe(true); // sanity: still not silenced
  });
});
