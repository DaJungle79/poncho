/**
 * Generates `upscaled-chr.poncho` — exercises Phase 4 of the v0.3.0
 * plan: the upscaled-mode CHR render path (8×8 2 bpp NES tiles painted
 * as 4×4 blocks in the 1024×960 framebuffer) with CHR-RAM uploads via
 * `$2007`.
 *
 * Setup:
 *   - flags.upscaledMode = 1
 *   - chrRamKb = 8 (no CHR-ROM)
 *   - NROM-style banking, vertical boot mirroring
 *   - 2-entry master palette (black + red)
 *
 * PRG (lives in the single 16 KB bank, mirrored at $C000-$FFFF):
 *
 *   1. Set PPUADDR = $0000 (CHR-RAM tile 0, plane 0).
 *   2. Write 8 bytes of 0x80 (one 8×8 NES tile's plane-0 data, with
 *      bit 7 set on every row → leftmost-column-only pixels = 1).
 *   3. Write 8 bytes of 0x00 (plane 1 — clear).
 *      → CHR-RAM[0..15] now describes a tile whose only "lit" pixels
 *        are in column 0; every other pixel is 0 (transparent BG).
 *   4. Set PPUADDR = $3F00. Write [0x00, 0x01] for the first sub-palette
 *      (universal BG = master[0] = black; sub-palette 0 entry 1 =
 *      master[1] = red).
 *   5. Halt.
 *
 * Default nametable (all zeros) → every cell uses tile 0. Each NES tile
 * slot in the 32×30 grid renders the same column-0-stripe pattern; in
 * Poncho coordinates that's a 4-px-wide red stripe every 32 px:
 *
 *   px 0–3:    red       (NES col 0 of tile)
 *   px 4–31:   black     (NES cols 1–7 of tile, transparent → universal BG)
 *   px 32–35:  red       (NES col 0 of next tile)
 *   …
 *
 * Run with: `npm run gen:poncho:upscaled-chr`.
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
  lda_imm(0x00); sta_abs(0x06, 0x20); // hi
  lda_imm(0x00); sta_abs(0x06, 0x20); // lo

  // 2. Plane 0: write 0x80 eight times. (Bit 7 set on every row →
  //    column 0 of the tile has pixel value 1; columns 1–7 = 0.)
  ldx_imm(0);
  const plane0Loop = p;
  lda_imm(0x80);
  sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane0Loop - (p + 2));

  // 3. Plane 1: write 0x00 eight times. (Pixel values stay in {0,1}.)
  ldx_imm(0);
  const plane1Loop = p;
  lda_imm(0x00);
  sta_abs(0x07, 0x20);
  inx();
  cpx_imm(8);
  bne(plane1Loop - (p + 2));

  // 4. Palette setup. PPUADDR ← $3F00 then write [0x00, 0x01].
  lda_imm(0x3f); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x07, 0x20); // $3F00 = 0 (black BG)
  lda_imm(0x01); sta_abs(0x07, 0x20); // $3F01 = 1 (red)

  // 5. Halt.
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
    [0xff, 0x00, 0x00], // 1: red   (BG sub-palette 0 entry 1)
  ]);

  const rom = assemblePonchoRom({
    palette,
    prg: buildPrg(),
    chr: new Uint8Array(0),
    chrRamKb: 8,
    title: 'Upscaled CHR-RAM (synth)',
    flags: { upscaledMode: true, trailerPresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 0,
      bootMirroring: 1,
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'upscaled-chr.poncho');
  writeFileSync(romPath, rom);
  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
