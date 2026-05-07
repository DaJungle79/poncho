import { describe, expect, it } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';

/**
 * Unit-level coverage for PpuUltra sprite-0 hit detection in upscaled
 * mode. The tests drive PpuUltra directly (no CPU/PRG) so they isolate
 * the collision algorithm + scanline timing from any 6502 plumbing.
 *
 * To trigger the pre-render pass that pre-computes `sprite0HitScanline`,
 * we tick the chip through one full frame (262 × 341 dots), which lands
 * on the pre-render scanline 261 dot 1 once.
 */

function rgbaPalette(...rgbs: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const buf = new Uint8Array(rgbs.length * 4);
  for (let i = 0; i < rgbs.length; i++) {
    const [r, g, b] = rgbs[i]!;
    buf[i * 4 + 0] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 0xff;
  }
  return buf;
}

/**
 * Tick until the n-th vblank-entry. Mirrors what `runFrame()` does in
 * the PonchoNes composition: stop right after vblank-entry, i.e.
 * BEFORE the upcoming pre-render that would re-clear sprite-0 hit.
 *
 * Two ticks are needed for sprite-0 hit detection to land:
 *   frame 0 — pre-render computes `sprite0HitScanline` from the
 *             already-configured state.
 *   frame 1 — visible scanlines trigger the flag at the matching
 *             scanline; we stop at vblank-entry while the flag is
 *             still set.
 */
function tickFrames(ppu: PpuUltra, n: number): void {
  let count = 0;
  while (count < n) {
    if (ppu.tick()) count++;
  }
}

function setupOpaqueChrTile0(ppu: PpuUltra): void {
  // Tile 0: every pixel value = 1 (plane 0 = 0xFF in all 8 rows, plane 1 = 0).
  const chr = new Uint8Array(8192);
  for (let i = 0; i < 8; i++) chr[i] = 0xff;
  ppu.setChrReader((addr) => chr[addr & 0x1fff]!);
}

function configureRedPalette(ppu: PpuUltra): void {
  ppu.setMasterPalette(rgbaPalette([0x00, 0x00, 0x00], [0xff, 0x00, 0x00]));
  // BG sub-palette 0 entry 1 = master[1].
  ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x01); ppu.cpuWrite(0x2007, 0x01);
  // Sprite sub-palette 0 entry 1 = master[1].
  ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x11); ppu.cpuWrite(0x2007, 0x01);
}

function placeSprite0(ppu: PpuUltra, y: number, tile: number, attr: number, x: number): void {
  ppu.cpuWrite(0x2003, 0x00);
  ppu.cpuWrite(0x2004, y);
  ppu.cpuWrite(0x2004, tile);
  ppu.cpuWrite(0x2004, attr);
  ppu.cpuWrite(0x2004, x);
}

describe('PpuUltra sprite-0 hit — basic detection', () => {
  it('sets sprite0Hit when sprite-0 opaque pixel overlaps opaque BG', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    setupOpaqueChrTile0(ppu);
    configureRedPalette(ppu);
    placeSprite0(ppu, /*y*/ 100, /*tile*/ 0, /*attr*/ 0, /*x*/ 50);

    expect(ppu.sprite0Hit).toBe(false);
    tickFrames(ppu, 2);
    expect(ppu.sprite0Hit).toBe(true);
  });

  it('does NOT set sprite0Hit when BG is transparent', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    // No chrReader → BG bytes are unknown; even if rendered, BG always
    // resolves to the universal-BG colour. sprite0HitScanline detection
    // bails out without a chrReader.
    placeSprite0(ppu, 100, 0, 0, 50);
    tickFrames(ppu, 2);
    expect(ppu.sprite0Hit).toBe(false);
  });

  it('does NOT set sprite0Hit when sprite-0 is hidden (y >= 0xEF)', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    setupOpaqueChrTile0(ppu);
    configureRedPalette(ppu);
    placeSprite0(ppu, /*y*/ 0xf0, 0, 0, 50);
    tickFrames(ppu, 2);
    expect(ppu.sprite0Hit).toBe(false);
  });

  it('does NOT set sprite0Hit at x = 255 (hardware quirk)', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    // Tile that's only opaque at column 0 — so sprite-0's only opaque
    // pixel is at sprite-relative (0, *) = NES coord (x, y).
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0x80;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);
    configureRedPalette(ppu);
    // Set BG nametable[0] = tile 0 — but sub-palette will be 1 (default
    // attribute = 0 when we don't set it). For a clean BG-opaque, the
    // BG and sprite both render tile 0 → opaque only at column 0.
    placeSprite0(ppu, 100, 0, 0, 255);
    tickFrames(ppu, 2);
    // Sprite-0 column 0 is at x = 255 → quirk skips. No other sprite
    // pixels are opaque → no hit.
    expect(ppu.sprite0Hit).toBe(false);
  });

  it('flag clears at the next frame\'s pre-render', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    setupOpaqueChrTile0(ppu);
    configureRedPalette(ppu);
    placeSprite0(ppu, 100, 0, 0, 50);
    tickFrames(ppu, 2);
    expect(ppu.sprite0Hit).toBe(true);

    // Move sprite off-screen, then tick another frame — pre-render
    // recomputes sprite0HitScanline as -1 and the flag clears.
    placeSprite0(ppu, 0xf0, 0, 0, 50);
    tickFrames(ppu, 2);
    expect(ppu.sprite0Hit).toBe(false);
  });

  it('sprite0Hit clears when reading PPUSTATUS clears vblank but NOT sprite-0', () => {
    const ppu = new PpuUltra();
    ppu.setUpscaledMode(true);
    setupOpaqueChrTile0(ppu);
    configureRedPalette(ppu);
    placeSprite0(ppu, 100, 0, 0, 50);
    tickFrames(ppu, 2);
    expect(ppu.sprite0Hit).toBe(true);
    // Reading $2002 returns sprite-0 hit set in bit 6, then NES quirk:
    // bit 7 (vblank) is cleared, but sprite-0 stays until pre-render.
    const status = ppu.cpuRead(0x2002);
    expect((status & 0x40) !== 0).toBe(true);
    expect(ppu.sprite0Hit).toBe(true);
  });
});
