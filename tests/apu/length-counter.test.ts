import { describe, expect, it } from 'vitest';
import { LengthCounter } from '../../src/core/apu/length-counter';

describe('LengthCounter', () => {
  it('starts disabled and inactive', () => {
    const lc = new LengthCounter();
    expect(lc.active()).toBe(false);
    expect(lc.value).toBe(0);
  });

  it('loads value from the LENGTH_TABLE only when enabled', () => {
    const lc = new LengthCounter();
    lc.loadFromIndex(0); // index 0 = 10
    expect(lc.value).toBe(0); // disabled — no load
    lc.setEnabled(true);
    lc.loadFromIndex(0);
    expect(lc.value).toBe(10);
  });

  it('decrements once per tick (no halt)', () => {
    const lc = new LengthCounter();
    lc.setEnabled(true);
    lc.loadFromIndex(2); // index 2 = 20
    lc.tick();
    expect(lc.value).toBe(19);
    for (let i = 0; i < 19; i++) lc.tick();
    expect(lc.value).toBe(0);
  });

  it('does not decrement past zero', () => {
    const lc = new LengthCounter();
    lc.setEnabled(true);
    lc.loadFromIndex(1); // 254
    lc.tick();
    lc.tick();
    expect(lc.value).toBe(252);
  });

  it('halt freezes the counter', () => {
    const lc = new LengthCounter();
    lc.setEnabled(true);
    lc.loadFromIndex(0);
    lc.halt = true;
    lc.tick();
    lc.tick();
    expect(lc.value).toBe(10); // unchanged
  });

  it('disabling forces value to 0 immediately', () => {
    const lc = new LengthCounter();
    lc.setEnabled(true);
    lc.loadFromIndex(0);
    lc.setEnabled(false);
    expect(lc.value).toBe(0);
    expect(lc.active()).toBe(false);
  });
});
