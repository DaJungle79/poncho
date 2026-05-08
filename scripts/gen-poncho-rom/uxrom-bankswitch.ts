/**
 * Generates `uxrom-bankswitch.poncho` — synthetic ROM that exercises
 * UxROM-style banking on the PonchoMapper end-to-end (PRG runs, writes
 * to bank-select, reads back from $8000).
 *
 * Layout: 4 PRG banks (64 KB total) at banking variant 2.
 *
 *   Bank 0:  byte 0 = 0xA0
 *   Bank 1:  byte 0 = 0xA1
 *   Bank 2:  byte 0 = 0xA2
 *   Bank 3:  byte 0 = 0xA3   ← also the fixed bank (last) where code lives
 *
 * Bank 3 holds the executable, mapped at $C000-$FFFF. The reset vector
 * points to $C000.
 *
 * Code at $C000 (executes from the fixed last bank):
 *
 *   LDA #$00 / STA $8000   ; bank-select 0
 *   LDA $8000              ; reads bank 0's sentinel (0xA0)
 *   STA $00                ; store at zero-page $00
 *   LDA #$01 / STA $8000
 *   LDA $8000              ; bank 1 sentinel (0xA1)
 *   STA $01
 *   LDA #$02 / STA $8000
 *   LDA $8000              ; bank 2 sentinel (0xA2)
 *   STA $02
 *   JMP $C0XX (halt)       ; tight halt loop
 *
 * Integration test verifies cpuBus.ram[0..2] == [0xA0, 0xA1, 0xA2]
 * after running one frame, proving the bank-select wrote through and
 * subsequent reads served the right bank.
 *
 * Run with: `npm run gen:poncho:uxrom-bankswitch`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { encodeMapperSubmode } from '../../src/core/cart-poncho/header';
import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';

const OUTPUT_DIR = resolve('tests/roms/poncho');
const PRG_BANK = 16 * 1024;

function main(): void {
  // 4 banks of 16 KB each. Sentinel at byte 0 of each.
  const prg = new Uint8Array(4 * PRG_BANK);
  prg[0 * PRG_BANK] = 0xa0;
  prg[1 * PRG_BANK] = 0xa1;
  prg[2 * PRG_BANK] = 0xa2;
  prg[3 * PRG_BANK] = 0xa3;

  // Code lives in bank 3 (the fixed bank at $C000-$FFFF).
  // Bank 3 starts at PRG offset 3 * 16384 = 0xC000.
  // We assemble code into PRG starting at offset PRG_BANK * 3 + 16
  // (leave the 0xa3 sentinel at offset 0 intact for the integration test
  // to find — well, actually we need code starting at $C000, which is
  // offset 0 of bank 3, but we want to keep the sentinel readable too;
  // overwrite it. The test only reads the bank-0/1/2 sentinels, so it's
  // fine.)
  const codeBase = 3 * PRG_BANK;
  let p = codeBase;

  // Helper writers
  const lda_imm = (v: number) => { prg[p++] = 0xa9; prg[p++] = v & 0xff; };
  const sta_abs = (lo: number, hi: number) => { prg[p++] = 0x8d; prg[p++] = lo; prg[p++] = hi; };
  const lda_abs = (lo: number, hi: number) => { prg[p++] = 0xad; prg[p++] = lo; prg[p++] = hi; };
  const sta_zp  = (z: number) => { prg[p++] = 0x85; prg[p++] = z & 0xff; };

  // Code at $C000 — bank 3 PRG offset 0.
  // Bank-select 0
  lda_imm(0x00);
  sta_abs(0x00, 0x80); // STA $8000
  lda_abs(0x00, 0x80); // LDA $8000
  sta_zp(0x00);

  // Bank-select 1
  lda_imm(0x01);
  sta_abs(0x00, 0x80);
  lda_abs(0x00, 0x80);
  sta_zp(0x01);

  // Bank-select 2
  lda_imm(0x02);
  sta_abs(0x00, 0x80);
  lda_abs(0x00, 0x80);
  sta_zp(0x02);

  // Halt: JMP to current PC (a tight loop)
  // Resolve the halt-target = ($C000 + offset within bank 3)
  const haltOffsetWithinBank = p - codeBase;
  const haltAddrLo = haltOffsetWithinBank & 0xff;
  const haltAddrHi = 0xc0 | ((haltOffsetWithinBank >> 8) & 0x3f);
  prg[p++] = 0x4c; // JMP absolute
  prg[p++] = haltAddrLo;
  prg[p++] = haltAddrHi;

  // Reset vector at $FFFC = $C000.
  // $FFFC in the address space is bank 3 offset 0x3FFC.
  prg[codeBase + 0x3ffa] = 0x00; prg[codeBase + 0x3ffb] = 0xc0; // NMI
  prg[codeBase + 0x3ffc] = 0x00; prg[codeBase + 0x3ffd] = 0xc0; // Reset
  prg[codeBase + 0x3ffe] = 0x00; prg[codeBase + 0x3fff] = 0xc0; // IRQ

  const chr = new Uint8Array(1024);

  const rom = assemblePonchoRom({
    palette: makePalette([[0, 0, 0]]),
    prg,
    chr,
    title: 'UxROM Bankswitch (synthetic)',
    flags: { upscaledMode: true, trailerPresent: false, aiCachePresent: false },
    mapperSubmode: encodeMapperSubmode({
      bankingVariant: 2, // UxROM-style
      bootMirroring: 1,  // vertical (matches Contra's iNES setting)
    }),
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const romPath = join(OUTPUT_DIR, 'uxrom-bankswitch.poncho');
  writeFileSync(romPath, rom);

  console.log(`Wrote ${romPath} (${rom.length} bytes)`);
}

main();
