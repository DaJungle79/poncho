import { describe, expect, it } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';

/**
 * Phase 7 — per-scanline BG rendering. The PpuUltra now renders BG
 * scanline-by-scanline at the END of each visible scanline (dot 340)
 * rather than eagerly at vblank-entry. State changes mid-frame
 * (palette / scroll / showBg) take effect from the next-rendered
 * scanline onwards.
 *
 * These unit tests bypass the CPU entirely — they tick PpuUltra
 * directly and inspect the framebuffer between scanlines.
 */

const ABGR = (r: number, g: number, b: number, a = 0xff) =>
  ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

const RED   = ABGR(0xff, 0x00, 0x00);
const GREEN = ABGR(0x00, 0xff, 0x00);

function rgbaPalette(...rgbs: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const buf = new Uint8Array(rgbs.length * 4);
  for (let i = 0; i < rgbs.length; i++) {
    const [r, g, b] = rgbs[i]!;
    buf[i * 4 + 0] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 0xff;
  }
  return buf;
}

/** Tick `dots` PPU dots. */
function tickDots(ppu: PpuUltra, dots: number): void {
  for (let i = 0; i < dots; i++) ppu.tick();
}

describe('PpuUltra — per-scanline BG render', () => {
  it('mid-frame palette write applies only to scanlines rendered AFTER the write', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0, 0, 0], [0xff, 0, 0], [0, 0xff, 0]));
    ppu.setUpscaledMode(true);

    // Tile 0: every pixel value = 1 (plane 0 = 0xFF, plane 1 = 0).
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    // BG palette: $3F00 = 0 (universal BG), $3F01 = 1 (red).
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x01); ppu.cpuWrite(0x2007, 0x01);

    // Tick the first 50 NES scanlines (each = 341 dots) — those render
    // with $3F01 = 1 (red).
    tickDots(ppu, 50 * 341);

    // Mid-frame: change $3F01 to 2 (green).
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x01); ppu.cpuWrite(0x2007, 0x02);

    // Tick scanlines 50..99 — render with $3F01 = 2 (green).
    tickDots(ppu, 50 * 341);

    const fb = ppu.framebuffer.data;
    const px = (y: number, x: number) => fb[y * 1024 + x];

    // Top (NES scanlines 0..49 → Poncho rows 0..199): red.
    expect(px(0, 0)).toBe(RED);
    expect(px(100, 0)).toBe(RED);
    expect(px(199, 0)).toBe(RED);

    // After the palette write (NES scanlines 50..99 → Poncho rows
    // 200..399): green.
    expect(px(200, 0)).toBe(GREEN);
    expect(px(300, 0)).toBe(GREEN);
    expect(px(399, 0)).toBe(GREEN);
  });

  it('a per-scanline render does NOT touch rows for other scanlines', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0, 0, 0], [0xff, 0, 0]));
    ppu.setUpscaledMode(true);
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);
    ppu.cpuWrite(0x2006, 0x3f); ppu.cpuWrite(0x2006, 0x01); ppu.cpuWrite(0x2007, 0x01);

    // Tick the first 10 NES scanlines.
    tickDots(ppu, 10 * 341);

    // Scanlines 0..9 (Poncho rows 0..39) should be red. Scanlines 10..239
    // should remain at their original framebuffer value (since per-scanline
    // rendering hasn't touched them).
    const fb = ppu.framebuffer.data;
    const px = (y: number, x: number) => fb[y * 1024 + x];
    expect(px(0, 0)).toBe(RED);
    expect(px(39, 0)).toBe(RED);
    // Row 40 (NES scanline 10) — not rendered yet. The fresh Uint32Array
    // is zero-initialised and the new refreshBgColor doesn't touch the
    // framebuffer, so unrendered rows are still 0.
    expect(px(40, 0)).toBe(0);
  });

  it('disabled BG (showBg=false) per-scanline fills with universal BG only', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(rgbaPalette([0x80, 0x80, 0x80])); // grey
    ppu.setUpscaledMode(true);
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;
    ppu.setChrReader((addr) => chr[addr & 0x1fff]!);

    // Disable BG (PPUMASK bit 3 = 0).
    ppu.cpuWrite(0x2001, 0x00);

    // Tick a few scanlines.
    tickDots(ppu, 30 * 341);

    const fb = ppu.framebuffer.data;
    const grey = ABGR(0x80, 0x80, 0x80);
    expect(fb[0]).toBe(grey);
    expect(fb[20 * 1024 + 100]).toBe(grey);
  });
});
