import { describe, expect, it } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';
import type { Mirroring } from '../../src/core/cart/ines';

/**
 * Live-mirroring-source tests. Mappers that flip nametable mirroring
 * at runtime (AxROM bit 4, MMC1 control register, MMC3 $A000) need
 * PpuUltra to query the mapper on every nametable fetch — the same
 * pattern classic-NES PpuBus uses. These tests exercise that path
 * with a controllable callback in place of a real mapper.
 */
describe('PpuUltra — setMirroringSource (live mapper-driven mirroring)', () => {
  function setVramAddr(ppu: PpuUltra, addr: number): void {
    ppu.cpuWrite(0x2006, (addr >> 8) & 0x3f);
    ppu.cpuWrite(0x2006, addr & 0xff);
  }

  it('initial fallback to setMirroring when no source is installed', () => {
    const ppu = new PpuUltra();
    ppu.setMirroring('vertical');
    // Write to NT2 with vertical mirror → should land at physical page 0.
    setVramAddr(ppu, 0x2800);
    ppu.cpuWrite(0x2007, 0x42);
    expect(ppu.nametableRam[0]).toBe(0x42);
  });

  it('source callback overrides cached mirroring on every fetch', () => {
    const ppu = new PpuUltra();
    let active: Mirroring = 'horizontal';
    ppu.setMirroringSource(() => active);
    ppu.setMirroring('vertical'); // cached fallback — should be ignored

    // With horizontal mirror: NT2 → physical page 1.
    setVramAddr(ppu, 0x2800);
    ppu.cpuWrite(0x2007, 0xaa);
    expect(ppu.nametableRam[0x400]).toBe(0xaa);
    expect(ppu.nametableRam[0]).toBe(0);

    // Flip the source to single-low: NT2 → physical page 0.
    active = 'single-low';
    setVramAddr(ppu, 0x2800);
    ppu.cpuWrite(0x2007, 0x55);
    expect(ppu.nametableRam[0]).toBe(0x55);
  });

  it('passing null clears the source and returns to cached fallback', () => {
    const ppu = new PpuUltra();
    let active: Mirroring = 'single-high';
    ppu.setMirroringSource(() => active);
    ppu.setMirroring('horizontal');

    // While the source is active: single-high → all logical NTs → page 1.
    setVramAddr(ppu, 0x2000);
    ppu.cpuWrite(0x2007, 0x11);
    expect(ppu.nametableRam[0x400]).toBe(0x11);

    // Drop the source — fallback to cached horizontal.
    ppu.setMirroringSource(null);
    setVramAddr(ppu, 0x2000);
    ppu.cpuWrite(0x2007, 0x22);
    expect(ppu.nametableRam[0]).toBe(0x22);
  });

  it('an AxROM-style mid-game single-low ↔ single-high flip retargets nametable writes immediately', () => {
    // Simulates Battletoads / Marble Madness etc. The cartridge mapper
    // flips its single-screen mode mid-game; PpuUltra must observe the
    // change on the next nametable access (via the live source).
    const ppu = new PpuUltra();
    let active: Mirroring = 'single-low';
    ppu.setMirroringSource(() => active);

    // First write goes to physical page 0 (single-low).
    setVramAddr(ppu, 0x2400); // NT1
    ppu.cpuWrite(0x2007, 0x01);
    expect(ppu.nametableRam[0]).toBe(0x01);
    expect(ppu.nametableRam[0x400]).toBe(0);

    // The cart's bank-select write toggles bit 4 → single-high.
    active = 'single-high';

    // Next write must land on physical page 1 — no PPU re-init, no
    // explicit setMirroring() call needed.
    setVramAddr(ppu, 0x2400); // same NT1 address
    ppu.cpuWrite(0x2007, 0x02);
    expect(ppu.nametableRam[0x400]).toBe(0x02);
    expect(ppu.nametableRam[0]).toBe(0x01); // first write preserved on page 0
  });
});
