/**
 * Generates `single-sprite.poncho` and `single-sprite.frame0.png`.
 * One 32×32 sprite at (x=100, y=80) using sprite sub-palette 0
 * colour 1 (= red). BG is empty (universal BG = black).
 *
 * Exercises the sprite render path: $2003/$2004 OAM writes, attribute
 * bits, sprite tile fetch, sprite-pixel-0 transparency.
 *
 * Run with: `npm run gen:poncho:single-sprite`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';
import { encodePngRgba } from '../lib/png';

const OUTPUT_DIR = resolve('tests/roms/poncho');
const SCREEN_WIDTH = 1024;
const SCREEN_HEIGHT = 960;

const SPRITE_X = 100;
const SPRITE_Y = 80;
const SPRITE_W = 32;
const SPRITE_H = 32;

function main(): void {
  const palette = makePalette([
    [0x00, 0x00, 0x00], // 0 black ← universal BG
    [0xff, 0x00, 0x00], // 1 red   ← sprite colour
    [0x00, 0xff, 0x00], // 2 green
    [0x00, 0x00, 0xff], // 3 blue
    [0xff, 0xff, 0x00], // 4 yellow
    [0xff, 0x00, 0xff], // 5 magenta
    [0x00, 0xff, 0xff], // 6 cyan
    [0xff, 0xff, 0xff], // 7 white
  ]);

  // PRG plan:
  //   $C000  Setup palette: $3F00 = 0 (BG = black), $3F11 = 1 (sprite = red)
  //          (paletteRam index 17 = $3F11 = sprite sub-palette 0 colour 1)
  //   $C014  Setup OAM via $2003/$2004:
  //            sprite 0: y=80, x=100, tile=1, attr=0, size=0
  //   $C033  Halt loop.
  const prg = new Uint8Array(1024);
  let p = 0;
  function emit(...bytes: number[]): void {
    for (const b of bytes) prg[p++] = b & 0xff;
  }
  function ldaSta(imm: number, addr: number): void {
    emit(0xa9, imm, 0x8d, addr & 0xff, (addr >> 8) & 0xff);
  }

  // Palette setup.
  ldaSta(0x3f, 0x2006);  // VRAM addr = $3F00
  ldaSta(0x00, 0x2006);
  ldaSta(0x00, 0x2007);  // palette[0]  = master 0 (black)
  ldaSta(0x3f, 0x2006);  // VRAM addr = $3F11
  ldaSta(0x11, 0x2006);
  ldaSta(0x01, 0x2007);  // palette[17] = master 1 (red)

  // OAM setup. OAMADDR = 0; write 8 bytes for sprite 0.
  ldaSta(0x00, 0x2003);          // OAMADDR = 0
  ldaSta(SPRITE_Y & 0xff, 0x2004);
  ldaSta((SPRITE_Y >> 8) & 0xff, 0x2004);
  ldaSta(SPRITE_X & 0xff, 0x2004);
  ldaSta((SPRITE_X >> 8) & 0xff, 0x2004);
  ldaSta(0x01, 0x2004);          // tile_lo = 1
  ldaSta(0x00, 0x2004);          // tile_hi = 0
  ldaSta(0x00, 0x2004);          // attr = 0
  ldaSta(0x00, 0x2004);          // size = 0

  // Halt.
  const haltAddr = 0xc000 + p;
  emit(0x4c, haltAddr & 0xff, (haltAddr >> 8) & 0xff);

  prg[0x3fa] = 0x00; prg[0x3fb] = 0xc0; // NMI
  prg[0x3fc] = 0x00; prg[0x3fd] = 0xc0; // Reset
  prg[0x3fe] = 0x00; prg[0x3ff] = 0xc0; // IRQ

  // CHR: 2 tiles × 1024 bytes = 2 KB. Tile 0 = all transparent (pixel 0);
  // tile 1 = solid pixel value 1.
  const chr = new Uint8Array(2048);
  chr.fill(1, 1024, 2048);

  const rom = assemblePonchoRom({
    palette,
    prg,
    chr,
    title: 'Single Sprite (synth)',
  });

  // Expected frame: 32×32 red rectangle at (100, 80), rest black.
  const frame = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
    frame[i * 4 + 0] = 0;
    frame[i * 4 + 1] = 0;
    frame[i * 4 + 2] = 0;
    frame[i * 4 + 3] = 0xff;
  }
  for (let dy = 0; dy < SPRITE_H; dy++) {
    for (let dx = 0; dx < SPRITE_W; dx++) {
      const off = ((SPRITE_Y + dy) * SCREEN_WIDTH + (SPRITE_X + dx)) * 4;
      frame[off + 0] = 0xff; // R
      frame[off + 1] = 0;
      frame[off + 2] = 0;
      frame[off + 3] = 0xff;
    }
  }
  const png = encodePngRgba(SCREEN_WIDTH, SCREEN_HEIGHT, frame);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'single-sprite.poncho');
  const pngPath = join(OUTPUT_DIR, 'single-sprite.frame0.png');
  writeFileSync(romPath, rom);
  writeFileSync(pngPath, png);

  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
  console.log(`Wrote ${pngPath} (${png.length} bytes)`);
}

main();
