/**
 * Generates `compat-bg.nes` — a tiny iNES (NROM, mapper 0) ROM that
 * exercises the Ultra PPU's NES-compat render path. PRG sets up
 * palette and halts. CHR contains a single tile filled with NES
 * pixel value 1.
 *
 * The integration test loads this ROM into a `PonchoNes` console
 * (which routes iNES bytes into NES-compat mode) and verifies the
 * framebuffer is the expected colour.
 *
 * Run with: `npm run gen:poncho:compat-bg`
 *
 * iNES file layout:
 *   header (16 bytes) + PRG (16 KB, NROM-128) + CHR (8 KB)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUTPUT_DIR = resolve('tests/roms/poncho');

function main(): void {
  // ---- iNES header ----
  const header = new Uint8Array(16);
  header[0] = 0x4e; header[1] = 0x45; header[2] = 0x53; header[3] = 0x1a; // 'NES\x1A'
  header[4] = 1; // PRG: 1 × 16 KB
  header[5] = 1; // CHR: 1 × 8 KB
  // header[6..15] = 0 → mapper 0 (NROM), horizontal mirroring, no battery

  // ---- PRG (16 KB) ----
  const prg = new Uint8Array(16 * 1024);
  let p = 0;
  function emit(...bytes: number[]): void {
    for (const b of bytes) prg[p++] = b & 0xff;
  }

  // Code at $8000:
  //   LDA #$3F; STA $2006   ; VRAM addr = $3F00
  //   LDA #$00; STA $2006
  //   LDA #$00; STA $2007   ; palette[0] = master[0] (universal BG)
  //   LDA #$01; STA $2007   ; palette[1] = master[1]
  //   .halt: JMP .halt
  emit(0xa9, 0x3f, 0x8d, 0x06, 0x20);
  emit(0xa9, 0x00, 0x8d, 0x06, 0x20);
  emit(0xa9, 0x00, 0x8d, 0x07, 0x20);
  emit(0xa9, 0x01, 0x8d, 0x07, 0x20);
  // Halt at $8000 + p:
  const haltAddr = 0x8000 + p;
  emit(0x4c, haltAddr & 0xff, (haltAddr >> 8) & 0xff);

  // Vectors at PRG offsets 0x3FFA-0x3FFF (mapped to $FFFA-$FFFF on a
  // 16 KB NROM bank that mirrors $8000-$BFFF into $C000-$FFFF).
  prg[0x3ffa] = 0x00; prg[0x3ffb] = 0x80; // NMI   → $8000
  prg[0x3ffc] = 0x00; prg[0x3ffd] = 0x80; // Reset → $8000
  prg[0x3ffe] = 0x00; prg[0x3fff] = 0x80; // IRQ   → $8000

  // ---- CHR (8 KB) ----
  // Tile 0: all pixel value 1 (low plane all 0xFF, high plane all 0x00).
  const chr = new Uint8Array(8 * 1024);
  for (let i = 0; i < 8; i++) chr[i] = 0xff;        // low plane = 1s
  // chr[8..15] already 0 = high plane = 0s. Pixel value = (0<<1)|1 = 1.

  // ---- Assemble ----
  const out = new Uint8Array(header.length + prg.length + chr.length);
  out.set(header, 0);
  out.set(prg, header.length);
  out.set(chr, header.length + prg.length);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, 'compat-bg.nes');
  writeFileSync(path, out);
  console.log(`Wrote ${path} (${out.length} bytes)`);
}

main();
