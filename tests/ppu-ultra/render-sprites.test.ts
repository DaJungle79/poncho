import { describe, expect, it } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';

/**
 * Sprite render path. The tests poke palette RAM, OAM, and a CHR
 * buffer directly, then call `renderFrame()` and check pixels.
 */
describe('PpuUltra.renderFrame — sprite layer', () => {
  function makePalette8(): Uint8Array {
    return new Uint8Array([
      0x00, 0x00, 0x00, 0xff, // 0 black  (universal BG)
      0xff, 0x00, 0x00, 0xff, // 1 red    (sprite colour)
      0x00, 0xff, 0x00, 0xff, // 2 green
      0x00, 0x00, 0xff, 0xff, // 3 blue
      0xff, 0xff, 0x00, 0xff, // 4 yellow
      0xff, 0x00, 0xff, 0xff, // 5 magenta
      0x00, 0xff, 0xff, 0xff, // 6 cyan
      0xff, 0xff, 0xff, 0xff, // 7 white
    ]);
  }

  function setPalette(ppu: PpuUltra, paletteRamIndex: number, masterIdx: number): void {
    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, paletteRamIndex & 0x1f);
    ppu.cpuWrite(0x2007, masterIdx);
  }

  function writeOam(ppu: PpuUltra, addr: number, ...bytes: number[]): void {
    ppu.cpuWrite(0x2003, addr);
    for (const b of bytes) ppu.cpuWrite(0x2004, b);
  }

  function makeChr2(): Uint8Array {
    // Tile 0 = transparent; tile 1 = solid pixel value 1.
    const chr = new Uint8Array(2048);
    chr.fill(1, 1024, 2048);
    return chr;
  }

  it('renders a single 32×32 sprite at (x, y) using sprite palette 0 colour 1', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());
    ppu.setChr(makeChr2());

    setPalette(ppu, 0, 0);   // universal BG = master[0] = black
    setPalette(ppu, 17, 1);  // sprite sub-palette 0 colour 1 = master[1] = red

    // OAM[0..7]: y=80, x=100, tile=1, attr=0, size=0
    writeOam(ppu, 0,
      0x50, 0x00, // y_lo, y_hi
      0x64, 0x00, // x_lo, x_hi
      0x01, 0x00, // tile_lo, tile_hi
      0x00,       // attr (sub-palette 0, no flip)
      0x00,       // size
    );

    ppu.renderFrame();

    const black = 0xff000000;
    const red = 0xff0000ff;
    const fb = ppu.framebuffer.data;

    // Inside the 32×32 sprite region.
    expect(fb[80 * 1024 + 100]).toBe(red);            // top-left
    expect(fb[80 * 1024 + 131]).toBe(red);            // top-right
    expect(fb[111 * 1024 + 100]).toBe(red);           // bottom-left
    expect(fb[111 * 1024 + 131]).toBe(red);           // bottom-right

    // Outside the sprite region.
    expect(fb[80 * 1024 + 99]).toBe(black);           // 1 pixel to the left
    expect(fb[80 * 1024 + 132]).toBe(black);          // 1 pixel to the right
    expect(fb[79 * 1024 + 100]).toBe(black);          // 1 pixel above
    expect(fb[112 * 1024 + 100]).toBe(black);         // 1 pixel below

    // Count: exactly 32×32 = 1024 red pixels.
    let count = 0;
    for (let i = 0; i < fb.length; i++) if (fb[i] === red) count++;
    expect(count).toBe(1024);
  });

  it('sprite-pixel 0 is transparent (BG shows through)', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // Tile 0 = all transparent (BG default) → universal-BG everywhere.
    // Tile 1 = half-and-half: top 16 rows pixel 1, bottom 16 rows pixel 0.
    const chr = new Uint8Array(2048);
    chr.fill(1, 1024, 1024 + 32 * 16);
    ppu.setChr(chr);

    setPalette(ppu, 0, 5);   // BG = magenta
    setPalette(ppu, 17, 1);  // sprite sub-palette 0 colour 1 = red

    // Sprite 0 at (16, 16), tile 1, sub-palette 0.
    writeOam(ppu, 0, 0x10, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00);

    ppu.renderFrame();

    const fb = ppu.framebuffer.data;
    const magenta = 0xffff00ff;
    const red = 0xff0000ff;

    // Top half of sprite (sprite rows 0..15) = pixel 1 → red.
    expect(fb[16 * 1024 + 16]).toBe(red);
    expect(fb[(16 + 15) * 1024 + 16]).toBe(red);

    // Bottom half of sprite (rows 16..31) = transparent → BG (magenta) shows.
    expect(fb[(16 + 16) * 1024 + 16]).toBe(magenta);
    expect(fb[(16 + 31) * 1024 + 16]).toBe(magenta);
  });

  it('horizontal flip (attr bit 3) mirrors X within the sprite', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // CHR tile 0: leftmost column (x=0 in tile) = pixel 1, rest = 0.
    const chr = new Uint8Array(1024);
    for (let row = 0; row < 32; row++) chr[row * 32 + 0] = 1;
    ppu.setChr(chr);

    setPalette(ppu, 0, 0);
    setPalette(ppu, 17, 1);

    // No flip: red column at sprite-x = 0.
    writeOam(ppu, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xff0000ff);
    expect(ppu.framebuffer.data[1]).toBe(0xff000000);

    // With flip-H: red column at sprite-x = 31.
    writeOam(ppu, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xff000000);
    expect(ppu.framebuffer.data[31]).toBe(0xff0000ff);
  });

  it('vertical flip (attr bit 4) mirrors Y within the sprite', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // CHR tile 0: top row (y=0 in tile) = pixel 1, rest = 0.
    const chr = new Uint8Array(1024);
    for (let col = 0; col < 32; col++) chr[col] = 1;
    ppu.setChr(chr);

    setPalette(ppu, 0, 0);
    setPalette(ppu, 17, 1);

    // No flip.
    writeOam(ppu, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xff0000ff);
    expect(ppu.framebuffer.data[1024]).toBe(0xff000000);

    // With flip-V.
    writeOam(ppu, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xff000000);
    expect(ppu.framebuffer.data[31 * 1024]).toBe(0xff0000ff);
  });

  it('off-screen sprites (y ≥ 960 or x ≥ 1024) are skipped cleanly', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());
    const chr = new Uint8Array(1024);
    chr.fill(1);
    ppu.setChr(chr);
    setPalette(ppu, 0, 0);
    setPalette(ppu, 17, 1);

    // Sprite at y=1000 (>= 960 = off-screen vertically).
    writeOam(ppu, 0, 0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
    expect(() => ppu.renderFrame()).not.toThrow();

    // No red pixels should appear.
    let count = 0;
    for (let i = 0; i < ppu.framebuffer.data.length; i++) {
      if (ppu.framebuffer.data[i] === 0xff0000ff) count++;
    }
    expect(count).toBe(0);
  });

  it('$2003/$2004 round-trip — OAM read returns the byte at the latched addr', () => {
    const ppu = new PpuUltra();
    writeOam(ppu, 17, 0x42, 0xab);
    ppu.cpuWrite(0x2003, 17);
    expect(ppu.cpuRead(0x2004)).toBe(0x42);
  });
});
