/**
 * Generates `upscaled-sprite.poncho` — exercises Phase 5 of the v0.3.0
 * plan: the upscaled-mode sprite render path.
 *
 * Setup:
 *   - flags.upscaledMode = 1
 *   - chrRamKb = 8 (PRG uploads tile 0 at runtime)
 *   - NROM-style banking, vertical mirroring
 *   - 2-entry master palette (black + red)
 *
 * PRG (lives in the single 16 KB bank, mirrored at $C000-$FFFF):
 *
 *   1. Upload sprite tile 0 to CHR-RAM at $0000:
 *      - 8 bytes plane 0 = 0xFF (every NES pixel value-1 in the row)
 *      - 8 bytes plane 1 = 0x00
 *      → tile 0 has every pixel value = 1.
 *   2. Set the universal-BG palette and one sprite-palette entry:
 *      - $3F00 = 0  (universal BG → master[0] = black)
 *      - $3F15 = 1  (sprite sub-palette 1 entry 1 → master[1] = red)
 *      ($3F15 = sprite palette offset 16 + sub-palette 1 × 4 + entry 1 = offset 21.)
 *   3. Place one sprite at OAM[0..3]:
 *      - y    = 16  (NES px → Poncho y = 64)
 *      - tile = 0
 *      - attr = 0x01 (sub-palette 1, no flip, no priority)
 *      - x    = 8   (NES px → Poncho x = 32)
 *   4. Halt.
 *
 * Expected render: a 32 × 32 red square at Poncho (32, 64). BG is black
 * because $3F01 is unset (defaults to 0 → master[0] → black).
 *
 * Run with: `npm run gen:poncho:upscaled-sprite`.
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

  // 1. PPUADDR ← $0000 (CHR-RAM tile 0, plane 0).
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);

  // Plane 0: 8 bytes of 0xFF → all 8 pixels in each row have bit 0 set.
  ldx_imm(0);
  const plane0Loop = p;
  lda_imm(0xff);
  sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane0Loop - (p + 2));

  // Plane 1: 8 bytes of 0x00.
  ldx_imm(0);
  const plane1Loop = p;
  lda_imm(0x00);
  sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane1Loop - (p + 2));

  // 2. Palette: $3F00 = 0, $3F15 = 1 (sprite sub-palette 1 entry 1).
  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x07, 0x20);   // $3F00

  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x15); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x07, 0x20);   // $3F15

  // 3. OAM[0..3] = [16, 0, 0x01, 8] via $2003 / $2004.
  lda_imm(0x00); sta_abs(0x03, 0x20);   // OAMADDR = 0
  lda_imm(16);   sta_abs(0x04, 0x20);   // y = 16
  lda_imm(0x00); sta_abs(0x04, 0x20);   // tile = 0
  lda_imm(0x01); sta_abs(0x04, 0x20);   // attr = sub-palette 1
  lda_imm(8);    sta_abs(0x04, 0x20);   // x = 8

  // 4. Halt.
  const haltOff = p;
  jmp_abs(haltOff & 0xff, 0xc0 | ((haltOff >> 8) & 0x3f));

  // Reset/IRQ vectors → $C000.
  prg[0x3ffa] = 0x00; prg[0x3ffb] = 0xc0;
  prg[0x3ffc] = 0x00; prg[0x3ffd] = 0xc0;
  prg[0x3ffe] = 0x00; prg[0x3fff] = 0xc0;

  return prg;
}

function main(): void {
  const palette = makePalette([
    [0x00, 0x00, 0x00], // 0: black (universal BG)
    [0xff, 0x00, 0x00], // 1: red   (sprite colour)
  ]);

  const rom = assemblePonchoRom({
    palette,
    prg: buildPrg(),
    chr: new Uint8Array(0),
    chrRamKb: 8,
    title: 'Upscaled sprite (synth)',
    flags: { upscaledMode: true, trailerPresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 0,
      bootMirroring: 1,
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'upscaled-sprite.poncho');
  writeFileSync(romPath, rom);
  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
