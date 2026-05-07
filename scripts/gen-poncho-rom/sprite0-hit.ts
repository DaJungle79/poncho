/**
 * Generates `sprite0-hit.poncho` — exercises Phase 6 of the v0.3.0
 * plan: PPUSTATUS sprite-0 hit detection in upscaled mode.
 *
 * Setup:
 *   - flags.upscaledMode = 1, 8 KB CHR-RAM, NROM, vertical mirror
 *   - 2-entry palette (black, red)
 *
 * PRG:
 *   1. Upload tile 0 with every pixel value = 1 (plane 0 = 0xFF × 8,
 *      plane 1 = 0x00 × 8).
 *   2. Set palette: $3F00 = 0, $3F01 = 1, $3F11 = 1
 *      (BG sub-palette 0 entry 1 + sprite sub-palette 0 entry 1 → red).
 *   3. Place sprite-0 at OAM[0..3] = [100, 0, 0x00, 50]:
 *      - y = 100 (NES scanline of expected hit)
 *      - tile = 0 (opaque everywhere)
 *      - attr = 0 (sub-palette 0, no flip, no priority)
 *      - x = 50  (well clear of x=255 quirk)
 *   4. Halt.
 *
 * Default nametable (all zeros) → BG renders tile 0 everywhere → BG
 * pixels are all opaque (value 1). Sprite-0's first pixel (top-left)
 * hits BG at scanline 100. PpuUltra.sprite0Hit becomes true once a
 * full frame has ticked through pre-render.
 *
 * Run with: `npm run gen:poncho:sprite0-hit`.
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
  const jmp_abs = (lo: number, hi: number) => {
    prg[p++] = 0x4c; prg[p++] = lo; prg[p++] = hi;
  };

  // 1. Tile 0: 8 bytes of 0xFF (plane 0) + 8 bytes of 0x00 (plane 1).
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  ldx_imm(0);
  const plane0Loop = p;
  lda_imm(0xff);
  sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane0Loop - (p + 2));
  ldx_imm(0);
  const plane1Loop = p;
  lda_imm(0x00);
  sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane1Loop - (p + 2));

  // 2. Palette. $3F00 = 0, $3F01 = 1 (BG sub-pal 0 entry 1 = red),
  //              $3F11 = 1 (sprite sub-pal 0 entry 1 = red).
  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x07, 0x20);

  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x07, 0x20);

  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x11); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x07, 0x20);

  // 3. OAM[0..3] = [100, 0, 0x00, 50].
  lda_imm(0x00); sta_abs(0x03, 0x20);   // OAMADDR = 0
  lda_imm(100);  sta_abs(0x04, 0x20);   // y
  lda_imm(0x00); sta_abs(0x04, 0x20);   // tile
  lda_imm(0x00); sta_abs(0x04, 0x20);   // attr
  lda_imm(50);   sta_abs(0x04, 0x20);   // x

  // 4. Halt.
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
  ]);
  const rom = assemblePonchoRom({
    palette,
    prg: buildPrg(),
    chr: new Uint8Array(0),
    chrRamKb: 8,
    title: 'Sprite-0 hit (synth)',
    flags: { upscaledMode: true, trailerPresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 0,
      bootMirroring: 1,
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'sprite0-hit.poncho');
  writeFileSync(romPath, rom);
  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
