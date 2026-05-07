/**
 * Generates `sprite-8x16.poncho` — exercises Phase 6 of the v0.3.0
 * plan: 8×16 sprite mode (PPUCTRL bit 5).
 *
 * Setup:
 *   - flags.upscaledMode = 1, 8 KB CHR-RAM, NROM, vertical mirror
 *   - 2-entry palette (black, red)
 *
 * PRG:
 *   1. Upload 32 bytes of tile data starting at $0000:
 *      - Bytes  0..7:  0xFF (tile 0 plane 0 — top of 8×16 sprite)
 *      - Bytes  8..15: 0x00 (tile 0 plane 1)
 *      - Bytes 16..23: 0xFF (tile 1 plane 0 — bottom of 8×16 sprite)
 *      - Bytes 24..31: 0x00 (tile 1 plane 1)
 *      Both tiles render as solid pixel-value-1 → red.
 *   2. Sprite palette: $3F11 = 1 (sub-palette 0 entry 1 → red).
 *   3. PPUCTRL = 0x20  (bit 5 set → 8×16 sprite mode).
 *   4. OAM[0..3] = [16, 0x00, 0x00, 8]:
 *      - y = 16  (Poncho y = 64)
 *      - tile = 0x00 (LSB=0 → pattern $0000; pair index 0 → top tile 0,
 *        bottom tile 1)
 *      - attr = 0
 *      - x = 8   (Poncho x = 32)
 *   5. Halt.
 *
 * Expected: a 32×64 red rectangle at Poncho (32, 64) → (63, 127).
 *
 * Run with: `npm run gen:poncho:sprite-8x16`.
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

  // 1. Upload 32 bytes (2 NES tiles) starting at $0000.
  //    Pattern: 8 × 0xFF, 8 × 0x00, 8 × 0xFF, 8 × 0x00.
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);

  // Tile 0 plane 0 (8 × 0xFF).
  ldx_imm(0);
  const t0p0 = p;
  lda_imm(0xff); sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(t0p0 - (p + 2));

  // Tile 0 plane 1 (8 × 0x00).
  ldx_imm(0);
  const t0p1 = p;
  lda_imm(0x00); sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(t0p1 - (p + 2));

  // Tile 1 plane 0 (8 × 0xFF).
  ldx_imm(0);
  const t1p0 = p;
  lda_imm(0xff); sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(t1p0 - (p + 2));

  // Tile 1 plane 1 (8 × 0x00).
  ldx_imm(0);
  const t1p1 = p;
  lda_imm(0x00); sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(t1p1 - (p + 2));

  // 2. Palette: $3F11 = 1 (sprite sub-pal 0 entry 1 → red).
  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x11); sta_abs(0x06, 0x20);
  lda_imm(0x01); sta_abs(0x07, 0x20);

  // 3. PPUCTRL = 0x20 (8×16 sprite mode).
  lda_imm(0x20); sta_abs(0x00, 0x20);

  // 4. OAM[0..3] = [16, 0, 0, 8].
  lda_imm(0x00); sta_abs(0x03, 0x20);
  lda_imm(16);   sta_abs(0x04, 0x20); // y
  lda_imm(0x00); sta_abs(0x04, 0x20); // tile (= top tile 0, bottom tile 1, pattern $0000)
  lda_imm(0x00); sta_abs(0x04, 0x20); // attr
  lda_imm(8);    sta_abs(0x04, 0x20); // x

  // 5. Halt.
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
    title: '8x16 sprite (synth)',
    flags: { upscaledMode: true, trailerPresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 0,
      bootMirroring: 1,
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'sprite-8x16.poncho');
  writeFileSync(romPath, rom);
  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
