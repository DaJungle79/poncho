import { describe, expect, it } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';

/**
 * Unit-level coverage for the upscaled-CHR render path. These tests
 * drive the PpuUltra directly (no CPU, no PRG) so they isolate the
 * 8×8 2 bpp → 4×4-block render logic from any 6502 timing concerns.
 */

const ABGR = (r: number, g: number, b: number, a = 0xff) =>
  ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

const RED   = ABGR(0xff, 0x00, 0x00);
const BLACK = ABGR(0x00, 0x00, 0x00);

function rgbaPalette(...rgbs: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const buf = new Uint8Array(rgbs.length * 4);
  for (let i = 0; i < rgbs.length; i++) {
    const [r, g, b] = rgbs[i]!;
    buf[i * 4 + 0] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 0xff;
  }
  return buf;
}

describe('PpuUltra — upscaled-CHR render path', () => {
  it('paints each NES pixel as a 4×4 block', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0, 0, 0], [0xff, 0, 0]));
    ppu.setMirroring('vertical');
    ppu.setUpscaledMode(true);

    // CHR backing store. Tile 0: plane 0 = 0x80 in every row, plane 1 = 0
    // → leftmost-column pixels = 1, rest = 0.
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0x80;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    // Sub-palette 0 entry 1 = master[1] (red); universal BG = master[0] (black).
    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, 0x00);
    ppu.cpuWrite(0x2007, 0x00);
    ppu.cpuWrite(0x2007, 0x01);

    // Default nametable (all zeros) → every cell is tile 0.
    ppu.renderFrame();

    const fb = ppu.framebuffer.data;
    // First 4 columns of the first NES tile slot: red.
    expect(fb[0]).toBe(RED);
    expect(fb[1]).toBe(RED);
    expect(fb[2]).toBe(RED);
    expect(fb[3]).toBe(RED);
    // Columns 4-31: tile column 1-7 → pixel value 0 → universal BG (black).
    expect(fb[4]).toBe(BLACK);
    expect(fb[31]).toBe(BLACK);
    // Next NES tile slot starts at column 32 — its column 0 → red again.
    expect(fb[32]).toBe(RED);
    expect(fb[35]).toBe(RED);
    expect(fb[36]).toBe(BLACK);

    // The 4×4 block extends downward: rows 0..3 same content.
    for (let y = 0; y < 4; y++) {
      expect(fb[y * 1024 + 0]).toBe(RED);
      expect(fb[y * 1024 + 4]).toBe(BLACK);
    }
  });

  it('routes CHR-area $2007 writes to the chrWriter callback', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    let captured = -1;
    ppu.setChrWriter((addr, v) => {
      if (addr === 0x0042) captured = v;
    });
    ppu.cpuWrite(0x2006, 0x00);
    ppu.cpuWrite(0x2006, 0x42);
    ppu.cpuWrite(0x2007, 0xab);
    expect(captured).toBe(0xab);
  });

  it('falls back to universal BG when no chrReader is wired', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0x00, 0x80, 0x00]));
    ppu.setUpscaledMode(true);
    // chrReader stays null on purpose.
    ppu.renderFrame();
    const fb = ppu.framebuffer.data;
    const expected = ABGR(0x00, 0x80, 0x00);
    expect(fb[0]).toBe(expected);
    expect(fb[fb.length - 1]).toBe(expected);
  });
});
