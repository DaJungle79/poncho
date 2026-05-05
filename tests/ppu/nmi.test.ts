import { describe, expect, it } from 'vitest';
import { PpuCtrl, PpuStatus } from '../../src/core/ppu/registers';
import { VBLANK_FIRST_SCANLINE } from '../../src/core/ppu/timing';
import { makePpu } from './helpers';

describe('NMI generation', () => {
  it('does not fire when NMI-enable is off, even at vblank', () => {
    const h = makePpu();
    h.ppu.cpuWrite(0x2000, 0); // NMI disabled
    h.tickUntil(VBLANK_FIRST_SCANLINE, 0);
    h.tickDots(1);
    expect(h.nmiCount()).toBe(0);
  });

  it('fires once at vblank-start when NMI-enable is on', () => {
    const h = makePpu();
    h.ppu.cpuWrite(0x2000, PpuCtrl.NmiEnable);
    h.tickUntil(VBLANK_FIRST_SCANLINE, 0);
    h.tickDots(1);
    expect(h.nmiCount()).toBe(1);
  });

  it('fires immediately if NMI-enable is set while VBlank is high', () => {
    const h = makePpu();
    // Park inside vblank with vblank flag latched.
    h.tickUntil(VBLANK_FIRST_SCANLINE + 5, 0);
    expect(h.ppu.regs.status & PpuStatus.VBlank).toBe(PpuStatus.VBlank);
    expect(h.nmiCount()).toBe(0);
    h.ppu.cpuWrite(0x2000, PpuCtrl.NmiEnable);
    expect(h.nmiCount()).toBe(1);
  });

  it('does not re-fire each tick within vblank — only on rising edge', () => {
    const h = makePpu();
    h.ppu.cpuWrite(0x2000, PpuCtrl.NmiEnable);
    h.tickUntil(VBLANK_FIRST_SCANLINE, 0);
    h.tickDots(1);
    expect(h.nmiCount()).toBe(1);
    h.tickDots(50); // still inside vblank
    expect(h.nmiCount()).toBe(1);
  });

  it('reading $2002 (which clears VBlank) drops the line so next vblank fires again', () => {
    const h = makePpu();
    h.ppu.cpuWrite(0x2000, PpuCtrl.NmiEnable);
    h.tickUntil(VBLANK_FIRST_SCANLINE, 0);
    h.tickDots(1);
    expect(h.nmiCount()).toBe(1);

    // Read $2002 — clears vblank, line drops.
    h.ppu.cpuRead(0x2002);

    // Advance to the *next* vblank.
    h.tickUntil(VBLANK_FIRST_SCANLINE, 0);
    h.tickDots(1);
    expect(h.nmiCount()).toBe(2);
  });
});
