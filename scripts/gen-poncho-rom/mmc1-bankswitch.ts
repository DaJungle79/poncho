/**
 * Generates `mmc1-bankswitch.poncho` — exercises Phase 8 of v0.3.0:
 * MMC1-style PRG bank-switching via the serial register protocol.
 *
 * Setup:
 *   - flags.upscaledMode = 0 (native mode — keeps the synth simple, no
 *     CHR-RAM gymnastics)
 *   - Native CHR with 1 trivial tile (so the BG render path doesn't
 *     crash; we don't actually look at framebuffer pixels here).
 *   - 4 PRG banks of 16 KB each. Each bank's first byte is a sentinel:
 *     bank 0 = 0xB0, bank 1 = 0xB1, bank 2 = 0xB2, bank 3 = 0xB3.
 *
 * MMC1 default boot: control = $0C → PRG mode 3 (last bank fixed at
 * $C000). PRG bank 3 (the fixed one) holds the executable at $C000.
 *
 * Code at $C000 selects each bank in turn via the 5-bit serial protocol
 * (5 writes to $E000-$FFFF, LSB first), reads the byte at $8000, stores
 * it in zero-page. End state: $00 = 0xB0, $01 = 0xB1, $02 = 0xB2.
 *
 * Run with: `npm run gen:poncho:mmc1-bankswitch`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { encodeMapperSubmode } from '../../src/core/cart-poncho/header';
import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';

const OUTPUT_DIR = resolve('tests/roms/poncho');
const PRG_BANK = 16 * 1024;

function main(): void {
  // 4 PRG banks of 16 KB each = 64 KB total.
  const prg = new Uint8Array(4 * PRG_BANK);
  prg[0 * PRG_BANK] = 0xb0;
  prg[1 * PRG_BANK] = 0xb1;
  prg[2 * PRG_BANK] = 0xb2;
  prg[3 * PRG_BANK] = 0xb3;

  // PRG layout in bank 3 (the fixed bank at $C000).
  const codeBase = 3 * PRG_BANK;
  let p = codeBase;

  const lda_imm = (v: number) => { prg[p++] = 0xa9; prg[p++] = v & 0xff; };
  const sta_abs = (lo: number, hi: number) => {
    prg[p++] = 0x8d; prg[p++] = lo; prg[p++] = hi;
  };
  const lda_abs = (lo: number, hi: number) => {
    prg[p++] = 0xad; prg[p++] = lo; prg[p++] = hi;
  };
  const sta_zp  = (z: number) => { prg[p++] = 0x85; prg[p++] = z & 0xff; };
  const jmp_abs = (lo: number, hi: number) => {
    prg[p++] = 0x4c; prg[p++] = lo; prg[p++] = hi;
  };
  const lsr_a   = ()           => { prg[p++] = 0x4a; };

  // selectBank(N): write N (5 bits, LSB first) to $E000-$FFFF.
  // Implementation: load N, write low bit + LSR five times.
  // Hand-unroll the 5 writes for each of N = 0, 1, 2.
  const writeBitToE000 = () => {
    sta_abs(0x00, 0xe0);   // STA $E000 — low bit fed into shift register
  };
  const selectBank = (n: number) => {
    // Write 5 bits of `n`, LSB first.
    for (let i = 0; i < 5; i++) {
      lda_imm((n >> i) & 1);
      writeBitToE000();
    }
  };

  // Bank-select 0
  selectBank(0);
  lda_abs(0x00, 0x80);   // LDA $8000 — read bank 0 sentinel
  sta_zp(0x00);

  // Bank-select 1
  selectBank(1);
  lda_abs(0x00, 0x80);
  sta_zp(0x01);

  // Bank-select 2
  selectBank(2);
  lda_abs(0x00, 0x80);
  sta_zp(0x02);

  // Halt.
  void lsr_a; // unused helper, keeps the assembler shape consistent
  const haltOff = p - codeBase;
  const haltLo = haltOff & 0xff;
  const haltHi = 0xc0 | ((haltOff >> 8) & 0x3f);
  jmp_abs(haltLo, haltHi);

  // Reset / IRQ vectors at $FFFA-$FFFF (= bank-3 offsets $3FFA-$3FFF).
  prg[codeBase + 0x3ffa] = 0x00; prg[codeBase + 0x3ffb] = 0xc0;
  prg[codeBase + 0x3ffc] = 0x00; prg[codeBase + 0x3ffd] = 0xc0;
  prg[codeBase + 0x3ffe] = 0x00; prg[codeBase + 0x3fff] = 0xc0;

  const palette = makePalette([[0, 0, 0]]);
  const chr = new Uint8Array(1024); // 1 KB native-mode CHR placeholder

  const rom = assemblePonchoRom({
    palette,
    prg,
    chr,
    title: 'MMC1 bankswitch',
    flags: { upscaledMode: false, trailerPresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 1, // MMC1-style
      bootMirroring: 0,  // horizontal (default after reset; control $0C may override)
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'mmc1-bankswitch.poncho');
  writeFileSync(romPath, rom);
  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
