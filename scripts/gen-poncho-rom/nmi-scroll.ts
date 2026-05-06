/**
 * Generates `nmi-scroll.poncho`. NMI-driven scroll counter.
 *
 *   - Boot sets up palette and a striped nametable (alternating tile 0 /
 *     tile 1 columns; tile 0 = solid pixel value 1, tile 1 = transparent).
 *   - Boot enables NMI and clears scroll.
 *   - On every NMI the handler increments a zero-page counter and writes
 *     the new value as the X scroll via $2005.
 *   - Main loop spins forever.
 *
 * The integration test runs N frames and verifies the BG has shifted
 * by N pixels — that proves NMI fired N times, the CPU ran the handler
 * end-to-end, and $2005 reached the PPU.
 *
 * Run with: `npm run gen:poncho:nmi-scroll`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';
import { encodePngRgba } from '../lib/png';

const OUTPUT_DIR = resolve('tests/roms/poncho');
const SCREEN_WIDTH = 1024;
const SCREEN_HEIGHT = 960;

function main(): void {
  const palette = makePalette([
    [0x00, 0x00, 0x00], // 0 black
    [0xff, 0x00, 0x00], // 1 red ← BG colour
  ]);

  const prg = new Uint8Array(1024);
  let p = 0;
  function emit(...bytes: number[]): void {
    for (const b of bytes) prg[p++] = b & 0xff;
  }
  function ldaImm(v: number): void { emit(0xa9, v & 0xff); }
  function staAbs(addr: number): void { emit(0x8d, addr & 0xff, (addr >> 8) & 0xff); }
  function ldxImm(v: number): void { emit(0xa2, v & 0xff); }
  function ldyImm(v: number): void { emit(0xa0, v & 0xff); }

  // ----- Reset entry @ $C000 -----
  // Set palette[1] = master[1] (red).
  ldaImm(0x3f); staAbs(0x2006);
  ldaImm(0x01); staAbs(0x2006);
  ldaImm(0x01); staAbs(0x2007);

  // Reset VRAM addr to $2000.
  ldaImm(0x20); staAbs(0x2006);
  ldaImm(0x00); staAbs(0x2006);

  // Fill nametable+attr (1024 bytes) with alternating columns 0/1.
  // Outer loop: 4 pages × 256 = 1024 writes.
  // We use Y as the inner index; A toggles.
  ldxImm(0x04);                    // X = 4 outer iterations
  ldyImm(0x00);                    // Y = 0
  // .outer: $C015 (approx)
  const outerStart = 0xc000 + p;
  ldaImm(0x00);                    // A = 0
  emit(0x8d, 0x07, 0x20);          // STA $2007 (write tile index 0)
  ldaImm(0x01);
  emit(0x8d, 0x07, 0x20);          // STA $2007 (write tile index 1)
  emit(0xc8);                      // INY
  emit(0xd0, 0xf3);                // BNE -13 → back to start of inner pair (writes 2 per loop, 256 iter = 512 bytes per outer)
  emit(0xca);                      // DEX
  emit(0xd0, 0xf0);                // BNE -16 → back to outerStart
  void outerStart;

  // Initialise scroll counter at $00 = 0.
  ldaImm(0x00);
  emit(0x85, 0x00);                // STA $00 (zero-page)

  // Apply initial scroll (X=0, Y=0). Reading $2002 first resets the
  // scroll/addr toggle to phase 0.
  emit(0xad, 0x02, 0x20);          // LDA $2002
  ldaImm(0x00);
  emit(0x8d, 0x05, 0x20);          // STA $2005 (X=0)
  emit(0x8d, 0x05, 0x20);          // STA $2005 (Y=0)

  // Enable NMI.
  ldaImm(0x80);
  emit(0x8d, 0x00, 0x20);          // STA $2000

  // Halt loop.
  const haltAddr = 0xc000 + p;
  emit(0x4c, haltAddr & 0xff, (haltAddr >> 8) & 0xff);

  // ----- NMI handler -----
  const nmiAddr = 0xc000 + p;
  emit(0x48);                      // PHA
  emit(0xe6, 0x00);                // INC $00
  emit(0xa5, 0x00);                // LDA $00
  emit(0xad, 0x02, 0x20);          // LDA $2002 (reset scroll toggle) — overwrites A
  emit(0xa5, 0x00);                // LDA $00 again to reload counter
  emit(0x8d, 0x05, 0x20);          // STA $2005 (X scroll)
  ldaImm(0x00);
  emit(0x8d, 0x05, 0x20);          // STA $2005 (Y scroll = 0)
  emit(0x68);                      // PLA
  emit(0x40);                      // RTI

  // Vectors. NMI → nmiAddr; Reset → $C000; IRQ → $C000.
  prg[0x3fa] = nmiAddr & 0xff; prg[0x3fb] = (nmiAddr >> 8) & 0xff;
  prg[0x3fc] = 0x00; prg[0x3fd] = 0xc0;
  prg[0x3fe] = 0x00; prg[0x3ff] = 0xc0;

  // CHR: tile 0 = pixel value 1 everywhere, tile 1 = transparent.
  const chr = new Uint8Array(2048);
  chr.fill(1, 0, 1024);

  const rom = assemblePonchoRom({
    palette, prg, chr,
    title: 'NMI Scroll (synth)',
  });

  // Expected initial frame (after one NMI: scroll X = 1).
  // Without scroll: cols 0..31 = tile 0 (red), 32..63 = tile 1 (black), …
  // With scroll X = 1: every visible pixel shifts left by 1.
  // For frame N: scroll X = N.
  const frame = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  for (let py = 0; py < SCREEN_HEIGHT; py++) {
    for (let px = 0; px < SCREEN_WIDTH; px++) {
      const srcX = (px + 1) % 1024;
      const tileCol = (srcX / 32) | 0;
      const isRed = (tileCol & 1) === 0;
      const off = (py * SCREEN_WIDTH + px) * 4;
      frame[off + 0] = isRed ? 0xff : 0x00;
      frame[off + 1] = 0x00;
      frame[off + 2] = 0x00;
      frame[off + 3] = 0xff;
    }
  }
  const png = encodePngRgba(SCREEN_WIDTH, SCREEN_HEIGHT, frame);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'nmi-scroll.poncho');
  const pngPath = join(OUTPUT_DIR, 'nmi-scroll.frame0.png');
  writeFileSync(romPath, rom);
  writeFileSync(pngPath, png);

  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
  console.log(`Wrote ${pngPath} (${png.length} bytes)`);
}

main();
