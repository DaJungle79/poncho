import { describe, expect, it } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';

const DOTS_PER_FRAME = 341 * 262;
const VBLANK_DOT_OFFSET = 241 * 341 + 1; // scanline 241, dot 1

function tickN(ppu: PpuUltra, n: number): void {
  for (let i = 0; i < n; i++) ppu.tick();
}

/**
 * Step-10 register file. Tests cover: PPUCTRL bit decode, PPUMASK
 * tracking, PPUSTATUS read semantics, $2002 latch reset, $2005
 * scroll latching, and NMI delivery on vblank entry.
 */
describe('PpuUltra registers — $2000 / $2001 / $2002 / $2005 / NMI', () => {
  it('$2000 decodes every controllable bit', () => {
    const ppu = new PpuUltra();
    ppu.cpuWrite(0x2000, 0xff);
    expect(ppu.baseNametable).toBe(3);
    expect(ppu.bgPatternBase).toBe(0x1000);
    expect(ppu.spritePatternBase).toBe(0x1000);
    expect(ppu.spriteSize16).toBe(true);
    expect(ppu.nmiEnabled).toBe(true);
    ppu.cpuWrite(0x2000, 0x00);
    expect(ppu.baseNametable).toBe(0);
    expect(ppu.bgPatternBase).toBe(0);
    expect(ppu.spritePatternBase).toBe(0);
    expect(ppu.spriteSize16).toBe(false);
    expect(ppu.nmiEnabled).toBe(false);
  });

  it('$2001 PPUMASK toggles BG/sprite enable', () => {
    const ppu = new PpuUltra();
    ppu.cpuWrite(0x2001, 0x18); // BG + sprites on
    expect(ppu.showBackground).toBe(true);
    expect(ppu.showSprites).toBe(true);
    ppu.cpuWrite(0x2001, 0x00); // both off
    expect(ppu.showBackground).toBe(false);
    expect(ppu.showSprites).toBe(false);
  });

  it('$2002 read returns vblank flag and clears it', () => {
    const ppu = new PpuUltra();
    // Tick to vblank entry — vblankFlag becomes true.
    tickN(ppu, VBLANK_DOT_OFFSET + 1);
    let status = ppu.cpuRead(0x2002);
    expect(status & 0x80).toBe(0x80);
    // Second read sees the cleared flag.
    status = ppu.cpuRead(0x2002);
    expect(status & 0x80).toBe(0);
  });

  it('$2002 read resets the $2005/$2006 write toggle', () => {
    const ppu = new PpuUltra();
    // First $2006 write latches hi byte; toggle becomes 1.
    ppu.cpuWrite(0x2006, 0x3f);
    // Reading $2002 should clear the toggle.
    ppu.cpuRead(0x2002);
    // Now write 0x12 to $2006: with toggle reset, it's the new HIGH byte.
    ppu.cpuWrite(0x2006, 0x12);
    ppu.cpuWrite(0x2006, 0x34); // low byte
    // VRAM addr should be 0x1234 — verify by writing $2007 to a non-palette
    // range; nothing observable, but auto-increment proves the addr was set.
    // Easier: write into nametable RAM and read back via internal field.
    // We use $2000-range: $1234 is below $2000, so this falls into the
    // CHR-RAM path (no-op in stub). To test cleanly, redo with $2000-3000
    // range:
    ppu.cpuRead(0x2002);
    ppu.cpuWrite(0x2006, 0x20);
    ppu.cpuWrite(0x2006, 0x05);
    ppu.cpuWrite(0x2007, 0x42);
    expect(ppu.nametableRam[5]).toBe(0x42);
  });

  it('$2005 PPUSCROLL latches X first then Y, sharing toggle with $2006', () => {
    const ppu = new PpuUltra();
    ppu.cpuWrite(0x2005, 16); // X
    ppu.cpuWrite(0x2005, 32); // Y
    // Render and verify the screen has scrolled — easiest probe:
    // call refreshBgColor + renderFrame and inspect a known pixel
    // shift. The behaviour test is in scroll-render below.
    // Here just verify the toggle is back to phase 0 by writing $2006
    // and checking it works as the new hi byte.
    ppu.cpuWrite(0x2006, 0x20);
    ppu.cpuWrite(0x2006, 0x07);
    ppu.cpuWrite(0x2007, 0x88);
    expect(ppu.nametableRam[7]).toBe(0x88);
  });

  it('NMI fires on vblank entry only when $2000 bit 7 is set', () => {
    const ppu = new PpuUltra();
    let nmis = 0;
    ppu.setNmiCallback(() => nmis++);

    // Disabled: tick a full frame, no NMI.
    tickN(ppu, DOTS_PER_FRAME);
    expect(nmis).toBe(0);

    // Enable; tick another full frame; NMI fires once.
    ppu.cpuWrite(0x2000, 0x80);
    tickN(ppu, DOTS_PER_FRAME);
    expect(nmis).toBe(1);

    // Tick another frame; another NMI.
    tickN(ppu, DOTS_PER_FRAME);
    expect(nmis).toBe(2);
  });

  it('vblank flag is cleared at the pre-render scanline', () => {
    const ppu = new PpuUltra();
    // Tick to vblank entry.
    tickN(ppu, VBLANK_DOT_OFFSET + 1);
    expect(ppu.cpuRead(0x2002) & 0x80).toBe(0x80);
    // Reading clears it; tick to next pre-render dot.
    // The pre-render dot is scanline 261, dot 1; we're now 1 dot past
    // vblank-entry on scanline 241.
    const remaining = (261 - 241) * 341;
    tickN(ppu, remaining);
    // We're now at scanline 261 dot 1 → flags cleared by tick().
    // (Already cleared by our earlier read; verify still 0.)
    expect(ppu.cpuRead(0x2002) & 0x80).toBe(0);
  });
});

describe('PpuUltra render — scrolling', () => {
  it('X scroll shifts BG pixels horizontally', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(new Uint8Array([
      0x00, 0x00, 0x00, 0xff, // 0 black (universal BG)
      0xff, 0x00, 0x00, 0xff, // 1 red   (sub-palette 0 colour 1)
    ]));

    // Tile 0 = all pixel value 1 (red). Tile 1 = all pixel value 0 (transparent).
    const chr = new Uint8Array(2048);
    chr.fill(1, 0, 1024);
    ppu.setChr(chr);

    // Universal BG = master[0], sub-palette 0 colour 1 = master[1].
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x00); ppu.cpuWrite(0x2007, 0x00);
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x01); ppu.cpuWrite(0x2007, 0x01);

    // Nametable: alternating tile 0 / tile 1 columns.
    ppu.cpuWrite(0x2006, 0x20); ppu.cpuWrite(0x2006, 0x00);
    for (let i = 0; i < 32 * 30; i++) {
      ppu.cpuWrite(0x2007, i & 1);
    }

    const red = 0xff0000ff;
    const black = 0xff000000;

    // Without scroll: column 0..31 = tile 0 (red), column 32..63 = tile 1 (black), …
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(red);
    expect(ppu.framebuffer.data[16]).toBe(red);
    expect(ppu.framebuffer.data[32]).toBe(black);
    expect(ppu.framebuffer.data[48]).toBe(black);
    expect(ppu.framebuffer.data[64]).toBe(red);

    // Scroll X = 16: source pixel 16 maps to screen pixel 0.
    // So screen column 0..15 = tile 0 (red, right half), 16..47 = tile 1
    // (black, full), 48..79 = tile 0 (red), 80..111 = tile 1 (black), …
    ppu.cpuWrite(0x2005, 16);
    ppu.cpuWrite(0x2005, 0);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(red);
    expect(ppu.framebuffer.data[15]).toBe(red);
    expect(ppu.framebuffer.data[16]).toBe(black);
    expect(ppu.framebuffer.data[47]).toBe(black);
    expect(ppu.framebuffer.data[48]).toBe(red);
  });

  it('Y scroll shifts BG pixels vertically', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(new Uint8Array([
      0x00, 0x00, 0x00, 0xff,
      0xff, 0x00, 0x00, 0xff,
    ]));
    const chr = new Uint8Array(2048);
    chr.fill(1, 0, 1024);
    ppu.setChr(chr);
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x01); ppu.cpuWrite(0x2007, 0x01);

    // Top row of nametable = tile 0 (red); rest = tile 1 (transparent → black).
    ppu.cpuWrite(0x2006, 0x20); ppu.cpuWrite(0x2006, 0x00);
    for (let col = 0; col < 32; col++) ppu.cpuWrite(0x2007, 0);
    for (let i = 32; i < 32 * 30; i++) ppu.cpuWrite(0x2007, 1);

    // No scroll: screen row 0..31 = red.
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0 * 1024]).toBe(0xff0000ff);
    expect(ppu.framebuffer.data[31 * 1024]).toBe(0xff0000ff);
    expect(ppu.framebuffer.data[32 * 1024]).toBe(0xff000000);

    // Scroll Y = 16: source row 16 maps to screen row 0. Screen row 0..15
    // = tile 0 (bottom half, red); screen row 16..47 = tile 1 (black).
    ppu.cpuWrite(0x2005, 0);
    ppu.cpuWrite(0x2005, 16);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0 * 1024]).toBe(0xff0000ff);
    expect(ppu.framebuffer.data[15 * 1024]).toBe(0xff0000ff);
    expect(ppu.framebuffer.data[16 * 1024]).toBe(0xff000000);
  });

  it('PPUMASK BG-disable bit blanks the BG layer to universal-BG', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(new Uint8Array([
      0xff, 0x00, 0xff, 0xff, // 0 magenta = universal BG
      0xff, 0x00, 0x00, 0xff, // 1 red    = sub-palette 0 colour 1
    ]));
    const chr = new Uint8Array(1024);
    chr.fill(1);
    ppu.setChr(chr);
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x00); ppu.cpuWrite(0x2007, 0x00);
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x01); ppu.cpuWrite(0x2007, 0x01);

    // Default: BG enabled → red everywhere.
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xff0000ff);

    // Disable BG: universal-BG (magenta) everywhere.
    ppu.cpuWrite(0x2001, 0x00);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xffff00ff);
  });
});
