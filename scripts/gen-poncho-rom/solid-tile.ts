/**
 * Generates `solid-tile.poncho` and `solid-tile.frame0.png`. The
 * minimum exerciser of the BG tile-render pipeline: every visible
 * pixel comes from a tile fetch (not the universal-BG fallback).
 *
 * What this exercises:
 *   - $2007 writes into nametable VRAM ($2000-$2FFF range)
 *   - VRAM auto-increment across a 1 KB span (nametable + attributes)
 *   - PpuUltra.renderFrame() walking 30 × 32 tiles × 32 × 32 pixels
 *   - Attribute decode → sub-palette selection (sub-palette 0 here)
 *   - CHR tile lookup
 *
 * Master palette is 8 colours; PRG installs colour index 5 (magenta)
 * as the universal BG and index 2 (green) as sub-palette 0 colour 1.
 * CHR tile 0 is filled with pixel value 1, so every pixel of every
 * tile resolves to green. The expected frame is therefore solid
 * green — but driven through the BG render path, not via the
 * universal-BG fallback.
 *
 * Run with: `npm run gen:poncho:solid-tile`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';
import { encodePngRgba } from '../lib/png';

const OUTPUT_DIR = resolve('tests/roms/poncho');
const SCREEN_WIDTH = 1024;
const SCREEN_HEIGHT = 960;

const TILE_PIXEL_VALUE = 1; // resolves through paletteRam[1] → master idx 2 → green

function main(): void {
  // 8 distinguishable colours.
  const palette = makePalette([
    [0x00, 0x00, 0x00], // 0 black
    [0xff, 0x00, 0x00], // 1 red
    [0x00, 0xff, 0x00], // 2 green ← sub-palette 0 colour 1
    [0x00, 0x00, 0xff], // 3 blue
    [0xff, 0xff, 0x00], // 4 yellow
    [0xff, 0x00, 0xff], // 5 magenta ← universal BG
    [0x00, 0xff, 0xff], // 6 cyan
    [0xff, 0xff, 0xff], // 7 white
  ]);

  // 6502 PRG:
  //   1. Write 5 to palette[$3F00]   (universal BG = magenta)
  //   2. Write 2 to palette[$3F01]   (sub-palette 0 colour 1 = green)
  //   3. Reset VRAM addr to $2000 and write 1024 zero bytes
  //      (nametable cells = tile 0, attribute table = sub-palette 0)
  //   4. Halt.
  //
  // Layout:
  //   $C000  A9 3F           LDA #$3F
  //   $C002  8D 06 20        STA $2006
  //   $C005  A9 00           LDA #$00
  //   $C007  8D 06 20        STA $2006
  //   $C00A  A9 05           LDA #$05            ; universal BG = master[5]
  //   $C00C  8D 07 20        STA $2007
  //   $C00F  A9 02           LDA #$02            ; palette[1]   = master[2]
  //   $C011  8D 07 20        STA $2007
  //   $C014  A9 20           LDA #$20            ; reset VRAM addr to $2000
  //   $C016  8D 06 20        STA $2006
  //   $C019  A9 00           LDA #$00
  //   $C01B  8D 06 20        STA $2006
  //   $C01E  A2 04           LDX #$04            ; outer count: 4 × 256 = 1024 writes
  //   $C020  A0 00           LDY #$00            ; inner count
  //   $C022  A9 00           LDA #$00            ; constant 0 (tile 0 / attr 0)
  //   $C024  8D 07 20        STA $2007           ; loop body
  //   $C027  C8              INY
  //   $C028  D0 FA           BNE $C024           ; back -6 → $C024
  //   $C02A  CA              DEX
  //   $C02B  D0 F7           BNE $C024           ; back -9 → $C024
  //   $C02D  4C 2D C0        JMP $C02D           ; halt
  const prg = new Uint8Array(1024);
  let p = 0;
  prg[p++] = 0xa9; prg[p++] = 0x3f;
  prg[p++] = 0x8d; prg[p++] = 0x06; prg[p++] = 0x20;
  prg[p++] = 0xa9; prg[p++] = 0x00;
  prg[p++] = 0x8d; prg[p++] = 0x06; prg[p++] = 0x20;
  prg[p++] = 0xa9; prg[p++] = 0x05;
  prg[p++] = 0x8d; prg[p++] = 0x07; prg[p++] = 0x20;
  prg[p++] = 0xa9; prg[p++] = 0x02;
  prg[p++] = 0x8d; prg[p++] = 0x07; prg[p++] = 0x20;
  prg[p++] = 0xa9; prg[p++] = 0x20;
  prg[p++] = 0x8d; prg[p++] = 0x06; prg[p++] = 0x20;
  prg[p++] = 0xa9; prg[p++] = 0x00;
  prg[p++] = 0x8d; prg[p++] = 0x06; prg[p++] = 0x20;
  prg[p++] = 0xa2; prg[p++] = 0x04;
  prg[p++] = 0xa0; prg[p++] = 0x00;
  prg[p++] = 0xa9; prg[p++] = 0x00;
  prg[p++] = 0x8d; prg[p++] = 0x07; prg[p++] = 0x20;
  prg[p++] = 0xc8;
  prg[p++] = 0xd0; prg[p++] = 0xfa;
  prg[p++] = 0xca;
  prg[p++] = 0xd0; prg[p++] = 0xf7;
  prg[p++] = 0x4c; prg[p++] = 0x2d; prg[p++] = 0xc0;

  prg[0x3fa] = 0x00; prg[0x3fb] = 0xc0;
  prg[0x3fc] = 0x00; prg[0x3fd] = 0xc0;
  prg[0x3fe] = 0x00; prg[0x3ff] = 0xc0;

  // CHR tile 0: every pixel is `TILE_PIXEL_VALUE` = 1.
  const chr = new Uint8Array(1024);
  chr.fill(TILE_PIXEL_VALUE);

  const rom = assemblePonchoRom({
    palette,
    prg,
    chr,
    title: 'Solid Tile (synthetic)',
  });

  // Expected frame: every pixel = master[2] = green (0, 255, 0).
  const r = palette[2 * 4 + 0]!;
  const g = palette[2 * 4 + 1]!;
  const b = palette[2 * 4 + 2]!;
  const a = palette[2 * 4 + 3]!;
  const frame = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
    frame[i * 4 + 0] = r;
    frame[i * 4 + 1] = g;
    frame[i * 4 + 2] = b;
    frame[i * 4 + 3] = a;
  }
  const png = encodePngRgba(SCREEN_WIDTH, SCREEN_HEIGHT, frame);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'solid-tile.poncho');
  const pngPath = join(OUTPUT_DIR, 'solid-tile.frame0.png');
  writeFileSync(romPath, rom);
  writeFileSync(pngPath, png);

  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
  console.log(`Wrote ${pngPath} (${png.length} bytes)`);
}

main();
