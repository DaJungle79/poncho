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

describe('PpuUltra — upscaled-OAM sprite render', () => {
  it('paints a NES sprite as a 32×32 block at NES coords × 4', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0x00, 0x00, 0x00], [0xff, 0x00, 0x00]));
    ppu.setMirroring('vertical');
    ppu.setUpscaledMode(true);

    // Tile 0 at PPU $0000: every pixel value = 1 (plane 0 = 0xFF, plane 1 = 0).
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    // Sprite sub-palette 1 entry 1 = master[1] (red).
    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, 0x15);
    ppu.cpuWrite(0x2007, 0x01);

    // Place a sprite at NES (8, 16) tile 0, sub-palette 1.
    ppu.cpuWrite(0x2003, 0x00); // OAMADDR = 0
    ppu.cpuWrite(0x2004, 16);   // y
    ppu.cpuWrite(0x2004, 0);    // tile
    ppu.cpuWrite(0x2004, 0x01); // attr
    ppu.cpuWrite(0x2004, 8);    // x

    ppu.renderFrame();

    const fb = ppu.framebuffer.data;
    const px = (y: number, x: number) => fb[y * 1024 + x];
    // NES (8, 16) → Poncho (32, 64). Sprite spans Poncho (32..63, 64..95).
    expect(px(64, 32)).toBe(RED);
    expect(px(95, 63)).toBe(RED);
    expect(px(80, 48)).toBe(RED);
    // Just outside.
    expect(px(63, 48)).toBe(BLACK);
    expect(px(80, 31)).toBe(BLACK);
    expect(px(80, 64)).toBe(BLACK);
  });

  it('honours sprite flip-H attribute bit', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0x00, 0x00, 0x00], [0xff, 0x00, 0x00]));
    ppu.setUpscaledMode(true);

    // Tile 0: only the leftmost column (col 0) has pixel value = 1.
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0x80;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    // Sprite sub-palette 0 entry 1 → red.
    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, 0x11);
    ppu.cpuWrite(0x2007, 0x01);

    // Sprite at NES (0, 0), tile 0, attr = 0x40 (flip-H).
    ppu.cpuWrite(0x2003, 0x00);
    ppu.cpuWrite(0x2004, 0);
    ppu.cpuWrite(0x2004, 0);
    ppu.cpuWrite(0x2004, 0x40);
    ppu.cpuWrite(0x2004, 0);

    ppu.renderFrame();
    const fb = ppu.framebuffer.data;
    // Without flip: NES col 0 = lit → Poncho cols 0..3 red. With flip-H,
    // NES col 7 should be lit instead → Poncho cols 28..31 red.
    expect(fb[28]).toBe(RED);
    expect(fb[31]).toBe(RED);
    expect(fb[0]).toBe(BLACK);
    expect(fb[27]).toBe(BLACK);
  });

  it('skips off-screen sprites (y >= 0xEF)', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0x00, 0x00, 0x00], [0xff, 0x00, 0x00]));
    ppu.setUpscaledMode(true);

    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, 0x11);
    ppu.cpuWrite(0x2007, 0x01);

    // Sprite with y = 0xF0 (hidden).
    ppu.cpuWrite(0x2003, 0);
    ppu.cpuWrite(0x2004, 0xf0);
    ppu.cpuWrite(0x2004, 0);
    ppu.cpuWrite(0x2004, 0);
    ppu.cpuWrite(0x2004, 100);

    ppu.renderFrame();
    const fb = ppu.framebuffer.data;
    // Whole framebuffer should be background (no sprite anywhere).
    let red = 0;
    for (let i = 0; i < fb.length; i++) if (fb[i] === RED) red++;
    expect(red).toBe(0);
  });
});

describe('PpuUltra — 8×16 sprite mode', () => {
  it('renders an 8×16 sprite as a 32×64 block (top tile + bottom tile)', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0x00, 0x00, 0x00], [0xff, 0x00, 0x00]));
    ppu.setUpscaledMode(true);

    // Tile 0 = top half opaque (plane 0 = 0xFF × 8). Tile 1 = bottom half
    // opaque (same content, at $0010-$001F).
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;
    for (let i = 16; i < 24; i++) chr[i] = 0xff;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    // Sprite sub-palette 0 entry 1 → red.
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x11); ppu.cpuWrite(0x2007, 0x01);

    // PPUCTRL bit 5 → 8×16 sprite mode.
    ppu.cpuWrite(0x2000, 0x20);

    // Sprite-0: y=16, tile=0 (LSB=0 → pattern $0000; pair 0 → top tile 0,
    // bottom tile 1), attr=0, x=8.
    ppu.cpuWrite(0x2003, 0); ppu.cpuWrite(0x2004, 16);
    ppu.cpuWrite(0x2004, 0); ppu.cpuWrite(0x2004, 0);
    ppu.cpuWrite(0x2004, 8);

    ppu.renderFrame();

    const fb = ppu.framebuffer.data;
    const px = (y: number, x: number) => fb[y * 1024 + x];
    // 8×16 sprite at NES (8, 16) → Poncho (32..63, 64..127).
    expect(px(64, 32)).toBe(RED);    // top
    expect(px(95, 32)).toBe(RED);    // last row of top tile
    expect(px(96, 32)).toBe(RED);    // first row of bottom tile
    expect(px(127, 32)).toBe(RED);   // bottom
    // Just outside.
    expect(px(63, 32)).toBe(BLACK);
    expect(px(128, 32)).toBe(BLACK);
  });

  it('uses pattern table $1000 when tile LSB is set in 8×16 mode', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0x00, 0x00, 0x00], [0xff, 0x00, 0x00]));
    ppu.setUpscaledMode(true);

    // Place tile data at PPU $1000 (top of pattern table 1) only;
    // tile LSB selects pattern table $1000.
    const chr = new Uint8Array(8192);
    for (let i = 0x1000; i < 0x1008; i++) chr[i] = 0xff;
    for (let i = 0x1010; i < 0x1018; i++) chr[i] = 0xff;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x11); ppu.cpuWrite(0x2007, 0x01);
    ppu.cpuWrite(0x2000, 0x20); // 8×16 mode

    // tile = 0x01: LSB=1 → pattern $1000; pair 0 → tiles $1000-$1010
    // (after tile_idx & 0xFE = 0).
    ppu.cpuWrite(0x2003, 0); ppu.cpuWrite(0x2004, 16);
    ppu.cpuWrite(0x2004, 0x01); ppu.cpuWrite(0x2004, 0); ppu.cpuWrite(0x2004, 8);

    ppu.renderFrame();
    expect(ppu.framebuffer.data[64 * 1024 + 32]).toBe(RED);
    expect(ppu.framebuffer.data[127 * 1024 + 32]).toBe(RED);
  });
});

describe('PpuUltra — $4014 OAM DMA size in upscaled mode', () => {
  it('reads 256 bytes when upscaled mode is on', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    let calls = 0;
    const bus = {
      read(_addr: number): number { calls++; return 0; },
    };
    ppu.oamDma(bus, 0x02);
    expect(calls).toBe(256);
  });

  it('reads 512 bytes in native mode', () => {
    const ppu = new PpuUltra();
    let calls = 0;
    const bus = {
      read(_addr: number): number { calls++; return 0; },
    };
    ppu.oamDma(bus, 0x02);
    expect(calls).toBe(512);
  });
});
