/**
 * Generates `multi-nametable.poncho` — exercises Phase 3 of the v0.3.0
 * plan: multiple logical nametables, mirroring resolution, and the
 * PPUCTRL base-nametable offset that contributes to effective scroll.
 *
 * Setup: vertical mirroring (NT0/NT2 share VRAM, NT1/NT3 share VRAM —
 * both physical pages are independently writable), native-mode CHR with
 * two pre-baked tiles (tile 0 = pixel value 1 everywhere; tile 1 = pixel
 * value 2 everywhere). Palette has red at master index 1 and green at
 * master index 2.
 *
 * PRG (lives in the single PRG bank that mirrors $C000-$FFFF):
 *
 *   1. Write the BG palette: $3F00 = 0 (black BG), $3F01 = 1 (red),
 *      $3F02 = 2 (green), $3F03 = 3 (blue).
 *   2. Fill NT0 ($2000-$23FF) with tile 0 (the entire 32×30 grid). The
 *      attribute table at $23C0+ stays 0 → sub-palette 0.
 *   3. Fill NT1 ($2400-$27FF) with tile 1.
 *   4. Set PPUCTRL to base nametable = 1 (bit 0 set) — the visible area
 *      now starts at NT1's top-left.
 *   5. Halt.
 *
 * Integration test runs one frame and verifies pixel (0, 0) is green
 * (NT1's tile 1 → master[2]).
 *
 * Run with: `npm run gen:poncho:multi-nametable`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { encodeMapperSubmode } from '../../src/core/cart-poncho/header';
import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';

const OUTPUT_DIR = resolve('tests/roms/poncho');

// Master palette: index 0 = black (universal BG), 1 = red, 2 = green, 3 = blue.
const PALETTE = makePalette([
  [0x00, 0x00, 0x00], // 0: universal BG (black)
  [0xff, 0x00, 0x00], // 1: red    (NT0 fill — not visible after baseNT=1)
  [0x00, 0xff, 0x00], // 2: green  (NT1 fill — what we actually see)
  [0x00, 0x00, 0xff], // 3: blue
]);

const PRG_SIZE = 16 * 1024;
const TILE_BYTES = 1024;
const CHR_SIZE = 2 * TILE_BYTES;

function buildPrg(): Uint8Array {
  const prg = new Uint8Array(PRG_SIZE);
  // Place code at PRG offset 0 — mirrored to $C000.
  let p = 0;

  const lda_imm = (v: number) => { prg[p++] = 0xa9; prg[p++] = v & 0xff; };
  const sta_abs = (lo: number, hi: number) => {
    prg[p++] = 0x8d; prg[p++] = lo; prg[p++] = hi;
  };
  const ldx_imm = (v: number) => { prg[p++] = 0xa2; prg[p++] = v & 0xff; };
  const ldy_imm = (v: number) => { prg[p++] = 0xa0; prg[p++] = v & 0xff; };
  const inx     = ()           => { prg[p++] = 0xe8; };
  const iny     = ()           => { prg[p++] = 0xc8; };
  const cpx_imm = (v: number) => { prg[p++] = 0xe0; prg[p++] = v & 0xff; };
  const cpy_imm = (v: number) => { prg[p++] = 0xc0; prg[p++] = v & 0xff; };
  const bne     = (rel: number) => { prg[p++] = 0xd0; prg[p++] = rel & 0xff; };
  const txa     = ()           => { prg[p++] = 0x8a; };
  const and_imm = (v: number) => { prg[p++] = 0x29; prg[p++] = v & 0xff; };
  const jmp_abs = (lo: number, hi: number) => {
    prg[p++] = 0x4c; prg[p++] = lo; prg[p++] = hi;
  };

  // ------- 1. Fill all 4 BG sub-palettes with the same 4-colour ramp -------
  // ($3F00..$3F0F = [0,1,2,3] × 4). The PRG fills 1024 bytes per nametable,
  // which overwrites the 64-byte attribute table with whatever tile-value
  // it was using; making every sub-palette identical neutralises that.
  lda_imm(0x3f); sta_abs(0x06, 0x20); // PPUADDR hi = $3F
  lda_imm(0x00); sta_abs(0x06, 0x20); // PPUADDR lo = $00
  ldx_imm(0);
  const palLoopStart = p;
  txa();                              // A = X
  and_imm(0x03);                      // A = X & 3 → cycles 0,1,2,3
  sta_abs(0x07, 0x20);                // STA $2007
  inx();
  cpx_imm(0x10);
  bne(palLoopStart - (p + 2));        // BNE palLoopStart

  // ------- 2. Fill NT0 ($2000-$23FF) with tile 0 ---------------------------
  // $2006 ← $20, $00 → VRAM addr = $2000.
  // Then write 0x400 (1024) bytes via $2007. Done with two nested loops:
  // outer Y: 0..3, inner X: 0..255 → 4 * 256 = 1024.
  lda_imm(0x20); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x00); // tile 0 byte to repeat
  ldy_imm(0);
  const fillNt0Start = p;
  ldx_imm(0);
  // inner_loop_nt0:
  const innerNt0Start = p;
  sta_abs(0x07, 0x20); // STA $2007
  inx();
  bne(innerNt0Start - (p + 2)); // BNE inner_loop_nt0
  iny();
  cpy_imm(4);
  bne(fillNt0Start - (p + 2)); // BNE fillNt0Start

  // ------- 3. Fill NT1 ($2400-$27FF) with tile 1 ---------------------------
  lda_imm(0x24); sta_abs(0x06, 0x20);
  lda_imm(0x00); sta_abs(0x06, 0x20);
  lda_imm(0x01); // tile 1 byte
  ldy_imm(0);
  const fillNt1Start = p;
  ldx_imm(0);
  const innerNt1Start = p;
  sta_abs(0x07, 0x20);
  inx();
  bne(innerNt1Start - (p + 2));
  iny();
  cpy_imm(4);
  bne(fillNt1Start - (p + 2));

  // ------- 4. PPUCTRL = $01 (base nametable = NT1) -------------------------
  lda_imm(0x01);
  sta_abs(0x00, 0x20); // STA $2000

  // ------- 5. Halt loop ----------------------------------------------------
  const haltOffset = p;
  jmp_abs(haltOffset & 0xff, 0xc0 | ((haltOffset >> 8) & 0x3f));

  // Reset/IRQ vectors.
  prg[0x3ffa] = 0x00; prg[0x3ffb] = 0xc0; // NMI → $C000
  prg[0x3ffc] = 0x00; prg[0x3ffd] = 0xc0; // Reset → $C000
  prg[0x3ffe] = 0x00; prg[0x3fff] = 0xc0; // IRQ  → $C000

  return prg;
}

function buildChr(): Uint8Array {
  // Two native-mode 32×32 8 bpp tiles. Tile 0 = pixel value 1, tile 1 = 2.
  const chr = new Uint8Array(CHR_SIZE);
  chr.fill(1, 0 * TILE_BYTES, 1 * TILE_BYTES);
  chr.fill(2, 1 * TILE_BYTES, 2 * TILE_BYTES);
  return chr;
}

function main(): void {
  const prg = buildPrg();
  const chr = buildChr();

  const rom = assemblePonchoRom({
    palette: PALETTE,
    prg,
    chr,
    title: 'Multi-NT (synthetic)',
    flags: { upscaledMode: false, trailerPresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 0,  // NROM-style: flat PRG mirroring
      bootMirroring: 1,   // vertical: NT0/NT2 share, NT1/NT3 share
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'multi-nametable.poncho');
  writeFileSync(romPath, rom);
  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
