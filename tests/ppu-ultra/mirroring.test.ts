import { describe, expect, it } from 'vitest';

import { PpuUltra, resolvePhysicalNT } from '../../src/core/ppu-ultra/ppu-ultra';

describe('resolvePhysicalNT', () => {
  it('horizontal mirror: NT0,1 → page 0; NT2,3 → page 1', () => {
    expect(resolvePhysicalNT(0, 'horizontal')).toBe(0);
    expect(resolvePhysicalNT(1, 'horizontal')).toBe(0);
    expect(resolvePhysicalNT(2, 'horizontal')).toBe(1);
    expect(resolvePhysicalNT(3, 'horizontal')).toBe(1);
  });

  it('vertical mirror: NT0,2 → page 0; NT1,3 → page 1', () => {
    expect(resolvePhysicalNT(0, 'vertical')).toBe(0);
    expect(resolvePhysicalNT(1, 'vertical')).toBe(1);
    expect(resolvePhysicalNT(2, 'vertical')).toBe(0);
    expect(resolvePhysicalNT(3, 'vertical')).toBe(1);
  });

  it('single-low collapses everything to page 0', () => {
    for (const nt of [0, 1, 2, 3]) {
      expect(resolvePhysicalNT(nt, 'single-low')).toBe(0);
    }
  });

  it('single-high collapses everything to page 1', () => {
    for (const nt of [0, 1, 2, 3]) {
      expect(resolvePhysicalNT(nt, 'single-high')).toBe(1);
    }
  });
});

describe('PpuUltra — mirroring-driven $2007 writes', () => {
  /**
   * Lay down the smallest possible PPU state that lets us write to a
   * nametable: PPU is in a known-zero state after construction, so we
   * just need to drive $2006 to the target address and write via $2007.
   */
  function setVramAddr(ppu: PpuUltra, addr: number): void {
    ppu.cpuWrite(0x2006, (addr >> 8) & 0x3f);
    ppu.cpuWrite(0x2006, addr & 0xff);
  }

  it('vertical mirror: writes to $2400 land in physical page 1', () => {
    const ppu = new PpuUltra();
    ppu.setMirroring('vertical');
    setVramAddr(ppu, 0x2400);
    ppu.cpuWrite(0x2007, 0xab);
    // Physical page 0 starts at offset 0; page 1 at 1024.
    expect(ppu.nametableRam[0x000]).toBe(0);
    expect(ppu.nametableRam[0x400]).toBe(0xab);
  });

  it('horizontal mirror: writes to $2400 land in physical page 0', () => {
    const ppu = new PpuUltra();
    ppu.setMirroring('horizontal');
    setVramAddr(ppu, 0x2400);
    ppu.cpuWrite(0x2007, 0xcd);
    expect(ppu.nametableRam[0x000]).toBe(0xcd);
    expect(ppu.nametableRam[0x400]).toBe(0);
  });

  it('single-low: writes to all four logical nametables collapse to page 0', () => {
    const ppu = new PpuUltra();
    ppu.setMirroring('single-low');
    for (const [logical, expected] of [
      [0x2000, 0xa1],
      [0x2400, 0xa2],
      [0x2800, 0xa3],
      [0x2c00, 0xa4],
    ] as const) {
      setVramAddr(ppu, logical);
      ppu.cpuWrite(0x2007, expected);
    }
    // Last write wins (all four logical pages map to page 0 offset 0).
    expect(ppu.nametableRam[0x000]).toBe(0xa4);
    expect(ppu.nametableRam[0x400]).toBe(0);
  });

  it('vertical mirror: writes to $2C00 alias to physical page 1', () => {
    const ppu = new PpuUltra();
    ppu.setMirroring('vertical');
    setVramAddr(ppu, 0x2c00);
    ppu.cpuWrite(0x2007, 0xee);
    expect(ppu.nametableRam[0x400]).toBe(0xee);
  });
});
