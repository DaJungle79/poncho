import { describe, expect, it } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';

/**
 * BG-tile renderer. These tests poke palette RAM, nametable RAM, and
 * a CHR buffer directly via the public surface, then call
 * `renderFrame()` and inspect pixels — bypasses the full dot/scanline
 * timing so each scenario is a few microseconds.
 */
describe('PpuUltra.renderFrame — BG tile pipeline', () => {
  function makePalette8(): Uint8Array {
    return new Uint8Array([
      0x00, 0x00, 0x00, 0xff, // 0 black
      0xff, 0x00, 0x00, 0xff, // 1 red
      0x00, 0xff, 0x00, 0xff, // 2 green
      0x00, 0x00, 0xff, 0xff, // 3 blue
      0xff, 0xff, 0x00, 0xff, // 4 yellow
      0xff, 0x00, 0xff, 0xff, // 5 magenta
      0x00, 0xff, 0xff, 0xff, // 6 cyan
      0xff, 0xff, 0xff, 0xff, // 7 white
    ]);
  }

  /** Helper: write a value into palette RAM at a specific index. */
  function setPalette(ppu: PpuUltra, index: number, value: number): void {
    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, index & 0x1f);
    ppu.cpuWrite(0x2007, value);
  }

  it('all-zero CHR + zero nametable → universal BG colour', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());
    ppu.setChr(new Uint8Array(1024)); // tile 0 = all zeros
    setPalette(ppu, 0, 5);            // universal BG = master[5] = magenta

    ppu.renderFrame();

    const expected = 0xffff00ff;
    expect(ppu.framebuffer.data[0]).toBe(expected);
    expect(ppu.framebuffer.data[ppu.framebuffer.data.length - 1]).toBe(expected);
  });

  it('CHR tile 0 = all 1s, sub-palette 0 colour 1 → that colour fills', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    const chr = new Uint8Array(1024);
    chr.fill(1);
    ppu.setChr(chr);

    setPalette(ppu, 0, 5); // universal BG = magenta
    setPalette(ppu, 1, 2); // sub-palette 0 colour 1 = green

    ppu.renderFrame();

    const greenAbgr = 0xff00ff00;
    expect(ppu.framebuffer.data[0]).toBe(greenAbgr);
    expect(ppu.framebuffer.data[1023]).toBe(greenAbgr);                    // top-right
    expect(ppu.framebuffer.data[ppu.framebuffer.data.length - 1]).toBe(greenAbgr); // bottom-right
  });

  it('attribute byte selects sub-palette: tile-row 0..1 vs row 2..3', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // Tile 0 = all pixel value 1.
    const chr = new Uint8Array(1024);
    chr.fill(1);
    ppu.setChr(chr);

    setPalette(ppu, 0, 0);  // universal BG = black (so non-tiled pixels are visible if any)
    setPalette(ppu, 1, 2);  // sub-palette 0 colour 1 = green
    setPalette(ppu, 5, 3);  // sub-palette 1 colour 1 = blue
    setPalette(ppu, 9, 1);  // sub-palette 2 colour 1 = red
    setPalette(ppu, 13, 4); // sub-palette 3 colour 1 = yellow

    // Attribute byte at nametable offset 960 covers the top-left 4×4
    // tile group: top-left 2×2 cells → sub-palette 0 (bits 0-1 = 00),
    // top-right 2×2 → sub-palette 2 (bits 2-3 = 10),
    // bottom-left 2×2 → sub-palette 1 (bits 4-5 = 01),
    // bottom-right 2×2 → sub-palette 3 (bits 6-7 = 11).
    // Encoded byte: 0b11_01_10_00 = 0xD8.
    ppu.nametableRam[960] = 0xd8;

    ppu.renderFrame();

    // Pixel at (0, 0) — tile (0,0), sub-palette 0 → green.
    expect(ppu.framebuffer.data[0]).toBe(0xff00ff00);
    // Pixel at tile column 2 → x = 64; sub-palette 2 → red.
    expect(ppu.framebuffer.data[64]).toBe(0xff0000ff);
    // Pixel at tile row 2 → y = 64; col 0 → sub-palette 1 → blue.
    expect(ppu.framebuffer.data[64 * 1024]).toBe(0xffff0000);
    // Pixel at tile row 2 col 2 → (64, 64) → sub-palette 3 → yellow.
    expect(ppu.framebuffer.data[64 * 1024 + 64]).toBe(0xff00ffff);
  });

  it('nametable cell selects which CHR tile is fetched', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // Two tiles: tile 0 = all pixel value 1, tile 1 = all pixel value 2.
    const chr = new Uint8Array(2048);
    chr.fill(1, 0, 1024);    // tile 0
    chr.fill(2, 1024, 2048); // tile 1
    ppu.setChr(chr);

    setPalette(ppu, 0, 0);  // universal BG = black
    setPalette(ppu, 1, 2);  // sub-palette 0 colour 1 = green
    setPalette(ppu, 2, 3);  // sub-palette 0 colour 2 = blue

    // Cell (0, 0) → tile 0; cell (0, 1) → tile 1.
    ppu.nametableRam[0] = 0;
    ppu.nametableRam[1] = 1;

    ppu.renderFrame();

    expect(ppu.framebuffer.data[0]).toBe(0xff00ff00);  // green from tile 0
    expect(ppu.framebuffer.data[32]).toBe(0xffff0000); // tile 1 starts at x=32 → blue
  });
});
