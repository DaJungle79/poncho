/**
 * Generates `palette-write.poncho` and `palette-write.frame0.png`.
 * PRG: at boot, point the PPU's VRAM address at $3F00 and write a
 * known master-palette index (5 = magenta in the 8-colour test
 * palette below); then halt. After one frame the framebuffer must
 * be a solid fill of master[5].
 *
 * Run with: `npm run gen:poncho:palette-write`
 *
 * What this exercises:
 *   - PpuUltra register file ($2006 latch, $2007 write + auto-increment)
 *   - Palette RAM update path
 *   - Framebuffer regeneration when palette[0] changes
 *   - PRG → bus → PPU register-write end-to-end
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';
import { encodePngRgba } from '../lib/png';

const OUTPUT_DIR = resolve('tests/roms/poncho');
const SCREEN_WIDTH = 1024;
const SCREEN_HEIGHT = 960;

/** Master palette index to write into palette RAM[0]. Picked to be non-zero. */
const TARGET_INDEX = 5;

function main(): void {
  // 8 distinguishable colours; index 5 = magenta (R=255, G=0, B=255).
  const palette = makePalette([
    [0x00, 0x00, 0x00], // 0 black
    [0xff, 0x00, 0x00], // 1 red
    [0x00, 0xff, 0x00], // 2 green
    [0x00, 0x00, 0xff], // 3 blue
    [0xff, 0xff, 0x00], // 4 yellow
    [0xff, 0x00, 0xff], // 5 magenta ← target
    [0x00, 0xff, 0xff], // 6 cyan
    [0xff, 0xff, 0xff], // 7 white
  ]);

  // 6502 PRG: write TARGET_INDEX to $3F00 via $2006/$2007, then halt.
  //
  //   $C000  A9 3F          LDA #$3F
  //   $C002  8D 06 20       STA $2006
  //   $C005  A9 00          LDA #$00
  //   $C007  8D 06 20       STA $2006
  //   $C00A  A9 05          LDA #TARGET_INDEX
  //   $C00C  8D 07 20       STA $2007
  //   $C00F  4C 0F C0       JMP $C00F  ; halt
  const prg = new Uint8Array(1024);
  let p = 0;
  prg[p++] = 0xa9; prg[p++] = 0x3f;                     // LDA #$3F
  prg[p++] = 0x8d; prg[p++] = 0x06; prg[p++] = 0x20;    // STA $2006
  prg[p++] = 0xa9; prg[p++] = 0x00;                     // LDA #$00
  prg[p++] = 0x8d; prg[p++] = 0x06; prg[p++] = 0x20;    // STA $2006
  prg[p++] = 0xa9; prg[p++] = TARGET_INDEX;             // LDA #target
  prg[p++] = 0x8d; prg[p++] = 0x07; prg[p++] = 0x20;    // STA $2007
  // Halt loop at $C00F.
  prg[p++] = 0x4c; prg[p++] = 0x0f; prg[p++] = 0xc0;    // JMP $C00F

  // Reset / NMI / IRQ vectors all → $C000.
  prg[0x3fa] = 0x00; prg[0x3fb] = 0xc0;
  prg[0x3fc] = 0x00; prg[0x3fd] = 0xc0;
  prg[0x3fe] = 0x00; prg[0x3ff] = 0xc0;

  const chr = new Uint8Array(1024);

  const rom = assemblePonchoRom({
    palette,
    prg,
    chr,
    title: 'Palette Write (synthetic)',
  });

  // Expected frame: solid fill of master[TARGET_INDEX].
  const r = palette[TARGET_INDEX * 4 + 0]!;
  const g = palette[TARGET_INDEX * 4 + 1]!;
  const b = palette[TARGET_INDEX * 4 + 2]!;
  const a = palette[TARGET_INDEX * 4 + 3]!;
  const frame = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
    frame[i * 4 + 0] = r;
    frame[i * 4 + 1] = g;
    frame[i * 4 + 2] = b;
    frame[i * 4 + 3] = a;
  }
  const png = encodePngRgba(SCREEN_WIDTH, SCREEN_HEIGHT, frame);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'palette-write.poncho');
  const pngPath = join(OUTPUT_DIR, 'palette-write.frame0.png');
  writeFileSync(romPath, rom);
  writeFileSync(pngPath, png);

  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
  console.log(`Wrote ${pngPath} (${png.length} bytes)`);
}

main();
