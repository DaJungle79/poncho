import { describe, expect, it } from 'vitest';
import { PpuStatus } from '../../src/core/ppu/registers';
import {
  DOTS_PER_FRAME,
  DOTS_PER_SCANLINE,
  PRE_RENDER_SCANLINE,
  SCANLINES_PER_FRAME,
  VBLANK_FIRST_SCANLINE,
} from '../../src/core/ppu/timing';
import { makePpu } from './helpers';

describe('PPU timing constants', () => {
  it('NTSC frame is 262 scanlines × 341 dots', () => {
    expect(SCANLINES_PER_FRAME).toBe(262);
    expect(DOTS_PER_SCANLINE).toBe(341);
    expect(DOTS_PER_FRAME).toBe(89_342);
  });
});

describe('PPU dot/scanline counters', () => {
  it('advance one dot per tick and wrap to next scanline at dot 341', () => {
    const h = makePpu();
    const { ppu } = h;
    h.tickDots(340);
    expect(ppu.currentDot()).toBe(340);
    expect(ppu.currentScanline()).toBe(0);
    h.tickDots(1);
    expect(ppu.currentDot()).toBe(0);
    expect(ppu.currentScanline()).toBe(1);
  });

  it('wrap to scanline 0 after the pre-render line', () => {
    const h = makePpu();
    h.tickUntil(PRE_RENDER_SCANLINE, DOTS_PER_SCANLINE - 1);
    h.tickDots(1);
    expect(h.ppu.currentScanline()).toBe(0);
    expect(h.ppu.currentFrame()).toBe(1);
  });
});

describe('VBlank flag', () => {
  it('sets when advancing into scanline 241, dot 1', () => {
    const h = makePpu();
    h.tickUntil(VBLANK_FIRST_SCANLINE, 0);
    expect(h.ppu.regs.status & PpuStatus.VBlank).toBe(0);
    h.tickDots(1); // advance from (241,0) into (241,1) — sets vblank
    expect(h.ppu.regs.status & PpuStatus.VBlank).toBe(PpuStatus.VBlank);
  });

  it('clears when advancing into pre-render dot 1, along with sprite flags', () => {
    const h = makePpu();
    h.ppu.regs.status |= PpuStatus.VBlank | PpuStatus.SpriteZeroHit | PpuStatus.SpriteOverflow;
    h.tickUntil(PRE_RENDER_SCANLINE, 0);
    h.tickDots(1);
    expect(h.ppu.regs.status & PpuStatus.VBlank).toBe(0);
    expect(h.ppu.regs.status & PpuStatus.SpriteZeroHit).toBe(0);
    expect(h.ppu.regs.status & PpuStatus.SpriteOverflow).toBe(0);
  });

  it('runFrame helper completes a frame on vblank', () => {
    const h = makePpu();
    let dots = 0;
    while (!h.ppu.tick() && dots < 200_000) dots++;
    // tick() advances first, then checks; the tick that returns true lands
    // us at (241, 1) — the exact dot vblank gets set.
    expect(h.ppu.currentScanline()).toBe(VBLANK_FIRST_SCANLINE);
    expect(h.ppu.currentDot()).toBe(1);
  });
});
