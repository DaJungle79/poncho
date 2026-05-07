/**
 * Generates `scanline-split.poncho` — exercises Phase 7 of the v0.3.0
 * plan: per-scanline BG render. PRG changes a BG palette entry mid-frame
 * (after sprite-0 hit fires at NES scanline 32). With per-scanline
 * rendering, the top of the frame uses the OLD palette and the bottom
 * uses the NEW palette.
 *
 * Setup:
 *   - flags.upscaledMode = 1, 8 KB CHR-RAM, NROM-style banking, vertical
 *     mirroring
 *   - 3-entry master palette: black / red / green
 *
 * PRG:
 *   1. Upload tile 0 to CHR-RAM with every pixel value = 1 (plane 0 =
 *      0xFF × 8, plane 1 = 0x00 × 8). Default nametable (all zeros) →
 *      every BG cell uses tile 0 → BG is fully opaque.
 *   2. Set palette: $3F00 = 0 (black BG), $3F01 = 1 (red — initial
 *      colour for tile-pixel-1), $3F11 = 1 (sprite uses red — same
 *      base colour as BG so the sprite is invisible against BG, but
 *      sprite-0's opaque pixel still fires the hit).
 *   3. Place sprite-0 at OAM[0..3] = [32, 0, 0, 0]. y = 32 is exactly
 *      the scanline where we want the palette flip.
 *   4. Poll $2002 bit 6 (sprite-0 hit) in a tight loop.
 *   5. On hit: write $3F01 = 2 (green). The PpuUltra picks this up for
 *      every subsequent scanline.
 *   6. Halt.
 *
 * Expected after running 2 frames:
 *   - Frame 0 sets up state. Pre-render computes sprite-0 hit scanline
 *     = 32.
 *   - Frame 1 visible region runs through:
 *       - Scanlines 0..31  → BG renders with $3F01 = 1 → red.
 *       - Scanline 32      → sprite-0 hit fires; PRG executes a few
 *                            cycles; palette write completes mid- to
 *                            late-scanline 32. Per-scanline render at
 *                            end-of-scanline 32 picks up the new value.
 *       - Scanlines 32..239 → BG renders with $3F01 = 2 → green.
 *
 *   Top (Poncho rows 0..127) = red.
 *   Bottom (Poncho rows 128..959) = green.
 *
 * Run with: `npm run gen:poncho:scanline-split`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { encodeMapperSubmode } from '../../src/core/cart-poncho/header';
import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';

const OUTPUT_DIR = resolve('tests/roms/poncho');

function buildPrg(): Uint8Array {
  const prg = new Uint8Array(16 * 1024);
  let p = 0;

  const lda_imm = (v: number) => { prg[p++] = 0xa9; prg[p++] = v & 0xff; };
  const sta_abs = (lo: number, hi: number) => {
    prg[p++] = 0x8d; prg[p++] = lo; prg[p++] = hi;
  };
  const ldx_imm = (v: number) => { prg[p++] = 0xa2; prg[p++] = v & 0xff; };
  const inx     = ()           => { prg[p++] = 0xe8; };
  const cpx_imm = (v: number) => { prg[p++] = 0xe0; prg[p++] = v & 0xff; };
  const bne     = (rel: number) => { prg[p++] = 0xd0; prg[p++] = rel & 0xff; };
  const bvc     = (rel: number) => { prg[p++] = 0x50; prg[p++] = rel & 0xff; };
  const jmp_abs = (lo: number, hi: number) => {
    prg[p++] = 0x4c; prg[p++] = lo; prg[p++] = hi;
  };
  const bit_abs = (lo: number, hi: number) => {
    prg[p++] = 0x2c; prg[p++] = lo; prg[p++] = hi;
  };

  // 1. Upload tile 0: 8 × 0xFF (plane 0) + 8 × 0x00 (plane 1).
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  ldx_imm(0);
  const plane0Loop = p;
  lda_imm(0xff); sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane0Loop - (p + 2));
  ldx_imm(0);
  const plane1Loop = p;
  lda_imm(0x00); sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane1Loop - (p + 2));

  // 2. Palette: $3F00 = 0, $3F01 = 1 (red), $3F11 = 1 (sprite red).
  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x07, 0x20);   // $3F00 = 0

  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x07, 0x20);   // $3F01 = 1 (red)

  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x11); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x07, 0x20);   // $3F11 = 1

  // 3. Sprite-0 at (x=0, y=32), tile 0, attr 0.
  lda_imm(0x00); sta_abs(0x03, 0x20);   // OAMADDR = 0
  lda_imm(32);   sta_abs(0x04, 0x20);   // y = 32
  lda_imm(0x00); sta_abs(0x04, 0x20);   // tile = 0
  lda_imm(0x00); sta_abs(0x04, 0x20);   // attr = 0
  lda_imm(0x00); sta_abs(0x04, 0x20);   // x = 0

  // 4. Poll sprite-0 hit. `bit $2002` reads PPUSTATUS, copying bit 6
  //    into the V flag. `bvc` loops while V is clear.
  const pollLoop = p;
  bit_abs(0x02, 0x20);
  bvc(pollLoop - (p + 2));

  // 5. Hit fired — write $3F01 = 2 (green).
  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x06, 0x20);
  lda_imm(0x02); sta_abs(0x07, 0x20);   // $3F01 = 2 (green)

  // 6. Halt.
  const haltOff = p;
  jmp_abs(haltOff & 0xff, 0xc0 | ((haltOff >> 8) & 0x3f));

  prg[0x3ffa] = 0x00; prg[0x3ffb] = 0xc0;
  prg[0x3ffc] = 0x00; prg[0x3ffd] = 0xc0;
  prg[0x3ffe] = 0x00; prg[0x3fff] = 0xc0;

  return prg;
}

function main(): void {
  const palette = makePalette([
    [0x00, 0x00, 0x00], // 0: black
    [0xff, 0x00, 0x00], // 1: red
    [0x00, 0xff, 0x00], // 2: green
  ]);
  const rom = assemblePonchoRom({
    palette,
    prg: buildPrg(),
    chr: new Uint8Array(0),
    chrRamKb: 8,
    title: 'Scanline split (synth)',
    flags: { upscaledMode: true, trailerPresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 0,
      bootMirroring: 1,
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'scanline-split.poncho');
  writeFileSync(romPath, rom);
  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
