import { describe, expect, it } from 'vitest';
import { Nes } from '../../src/console/nes';
import { parseInes } from '../../src/core/cart/ines';

/**
 * Build a minimal NROM ROM whose program loads $03 into A then writes A to
 * $4014 (triggering OAM DMA from page $0300). The reset vector points at
 * the program. We pre-fill page $0300 with a known signature so we can
 * verify the bytes ended up in OAM.
 */
function buildRomThatTriggersOamDma(): Uint8Array {
  const prg = new Uint8Array(16384);
  // LDA #$03 ; STA $4014
  prg[0] = 0xa9;
  prg[1] = 0x03;
  prg[2] = 0x8d;
  prg[3] = 0x14;
  prg[4] = 0x40;
  // Reset vector → $8000 (mirror of $C000 wraps to start of bank for NROM 1-bank)
  prg[0x3ffc] = 0x00;
  prg[0x3ffd] = 0x80;

  const chr = new Uint8Array(8192);

  const data = new Uint8Array(16 + prg.length + chr.length);
  data.set([0x4e, 0x45, 0x53, 0x1a]); // iNES magic
  data[4] = 1; // 1x16K PRG
  data[5] = 1; // 1x8K CHR
  data[6] = 0;
  data[7] = 0;
  data.set(prg, 16);
  data.set(chr, 16 + prg.length);

  return data;
}

describe('OAM DMA via $4014', () => {
  it('copies 256 bytes from CPU page → PPU OAM and stalls the CPU', () => {
    const data = buildRomThatTriggersOamDma();
    parseInes(data); // sanity-check the helper

    const nes = new Nes();
    nes.loadRom(data);

    // Pre-fill source page $0300 with a recognizable pattern.
    for (let i = 0; i < 256; i++) {
      nes.cpuBus.write(0x0300 + i, (i + 1) & 0xff);
    }

    // Run LDA #$03 (2 cycles) and STA $4014 (4 cycles + 514 stall).
    nes.cpu.step(); // LDA
    const cyclesBeforeDma = nes.cpu.cycles();
    nes.cpu.step(); // STA $4014 — triggers DMA + stall
    const cyclesAfterDmaWrite = nes.cpu.cycles();
    // The write itself is 4 cycles. The stall isn't consumed yet — it'll be
    // burned on the *next* step() calls, one per cycle.
    expect(cyclesAfterDmaWrite - cyclesBeforeDma).toBe(4);

    // OAM should now contain bytes 1..256 (with the byte-2 mask applied).
    for (let i = 0; i < 256; i++) {
      const expected = (i & 0x03) === 0x02
        ? ((i + 1) & 0xe3)
        : (i + 1) & 0xff;
      expect(nes.ppu.oam[i]).toBe(expected);
    }

    // Burn the stall. Each step() returns 1 while stalled.
    let stallCycles = 0;
    while (nes.cpu.step() === 1 && stallCycles < 600) stallCycles++;
    // 513 if cycles-pre-DMA was even, +1 if odd.
    expect(stallCycles).toBeGreaterThanOrEqual(513);
    expect(stallCycles).toBeLessThanOrEqual(514);
  });
});
