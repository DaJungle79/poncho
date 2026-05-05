import { describe, expect, it } from 'vitest';
import { FrameCounter } from '../../src/core/apu/frame-counter';
import { FRAME_4STEP_CYCLES, FRAME_5STEP_CYCLES } from '../../src/core/apu/timing';

interface Counts {
  quarter: number;
  half: number;
}

function makeFrame(): { fc: FrameCounter; counts: Counts } {
  const counts: Counts = { quarter: 0, half: 0 };
  const fc = new FrameCounter({
    onQuarterFrame: () => counts.quarter++,
    onHalfFrame: () => counts.half++,
  });
  return { fc, counts };
}

describe('FrameCounter — 4-step mode', () => {
  it('fires quarter on every step and half on steps 1 and 3', () => {
    const { fc, counts } = makeFrame();
    fc.write(0); // mode 0, IRQ enabled
    // Step right up to step 0 (cycle 7457).
    for (let i = 0; i < FRAME_4STEP_CYCLES[0]; i++) fc.tick();
    expect(counts).toEqual({ quarter: 1, half: 0 });

    // Step to cycle 14913 (step 1).
    for (let i = FRAME_4STEP_CYCLES[0]; i < FRAME_4STEP_CYCLES[1]; i++) fc.tick();
    expect(counts).toEqual({ quarter: 2, half: 1 });

    // Step to cycle 29829 (step 3, end).
    for (let i = FRAME_4STEP_CYCLES[1]; i < FRAME_4STEP_CYCLES[3]; i++) fc.tick();
    expect(counts).toEqual({ quarter: 4, half: 2 });
  });

  it('fires IRQ at end of frame when not inhibited', () => {
    const { fc } = makeFrame();
    fc.write(0); // mode 0, IRQ NOT inhibited
    expect(fc.irqPending()).toBe(false);
    for (let i = 0; i < FRAME_4STEP_CYCLES[3]; i++) fc.tick();
    expect(fc.irqPending()).toBe(true);
  });

  it('IRQ stays clear when inhibit bit is set', () => {
    const { fc } = makeFrame();
    fc.write(0x40); // mode 0, IRQ inhibit
    for (let i = 0; i < FRAME_4STEP_CYCLES[3]; i++) fc.tick();
    expect(fc.irqPending()).toBe(false);
  });
});

describe('FrameCounter — 5-step mode', () => {
  it('writing $4017 with bit 7 immediately clocks both events', () => {
    const { fc, counts } = makeFrame();
    fc.write(0x80); // mode 1: immediate clock
    expect(counts).toEqual({ quarter: 1, half: 1 });
  });

  it('does not generate IRQ', () => {
    const { fc } = makeFrame();
    fc.write(0x80);
    for (let i = 0; i < FRAME_5STEP_CYCLES[4] + 10; i++) fc.tick();
    expect(fc.irqPending()).toBe(false);
  });
});
