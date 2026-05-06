/**
 * Generates `solid-bg.poncho` and `solid-bg.frame0.png`. The simplest
 * test target for the 2C02-Ultra: every pixel of the framebuffer
 * should match palette entry 0 (the universal background colour) once
 * the PPU is wired up.
 *
 * Run with: `npm run gen:poncho:solid-bg`
 *
 * What this exercises (per the test plan in `docs/poncho-rom.md` /
 * the build order):
 *   - Header parsing (magic, version, sizes, CRC32)
 *   - Master palette upload to palette RAM
 *   - PPU's "no rendering yet, just emit universal BG colour" path
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';
import { encodePngRgba } from '../lib/png';

const OUTPUT_DIR = resolve('tests/roms/poncho');

// 2C02-Ultra render target — see docs/poncho-rom.md.
const SCREEN_WIDTH = 1024;
const SCREEN_HEIGHT = 960;

// Universal background colour. Picked to be obviously not-black so a
// blank framebuffer would be detected.
const BG_R = 0xe6;
const BG_G = 0x3e;
const BG_B = 0x32;

function main(): void {
  // Master palette: just the BG colour. The Ultra PPU's universal-BG
  // semantics say palette[0][0] is the colour drawn anywhere a tile
  // pixel resolves to index 0 on the BG layer.
  const palette = makePalette([[BG_R, BG_G, BG_B]]);

  // PRG: a halt loop plus the reset/NMI/IRQ vectors. PonchoMapper
  // mirrors a 1 KB PRG 32× across $8000-$FFFF, so the bytes we write
  // at PRG[0] appear at $C000 and the vectors at PRG[0x3FA-0x3FF]
  // appear at $FFFA-$FFFF.
  //
  //   $C000:  JMP $C000           ; 4C 00 C0
  //   $FFFA:  NMI vector  → $C000
  //   $FFFC:  Reset vector → $C000
  //   $FFFE:  IRQ vector  → $C000
  const prg = new Uint8Array(1024);
  prg[0x000] = 0x4c;            // JMP absolute
  prg[0x001] = 0x00;            //   target lo
  prg[0x002] = 0xc0;            //   target hi
  prg[0x3fa] = 0x00; prg[0x3fb] = 0xc0; // NMI
  prg[0x3fc] = 0x00; prg[0x3fd] = 0xc0; // Reset
  prg[0x3fe] = 0x00; prg[0x3ff] = 0xc0; // IRQ

  const chr = new Uint8Array(1024);

  const rom = assemblePonchoRom({
    palette,
    prg,
    chr,
    title: 'Solid BG (synthetic)',
  });

  // Expected frame: solid fill of the BG colour, full alpha.
  const frame = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
    frame[i * 4 + 0] = BG_R;
    frame[i * 4 + 1] = BG_G;
    frame[i * 4 + 2] = BG_B;
    frame[i * 4 + 3] = 0xff;
  }
  const png = encodePngRgba(SCREEN_WIDTH, SCREEN_HEIGHT, frame);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'solid-bg.poncho');
  const pngPath = join(OUTPUT_DIR, 'solid-bg.frame0.png');
  writeFileSync(romPath, rom);
  writeFileSync(pngPath, png);

  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
  console.log(`Wrote ${pngPath} (${png.length} bytes)`);
}

main();
