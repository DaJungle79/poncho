import { describe, expect, it } from 'vitest';
import type { InesRom } from '../../src/core/cart/ines';
import { Mmc3 } from '../../src/core/mappers/mmc3';

function makeRom(prgBanks8k: number, chrBanks1k: number): InesRom {
  // Each 8-KiB PRG bank gets filled with a unique byte (the bank index).
  // CHR banks at 1-KiB granularity: byte = bank index.
  const prg = new Uint8Array(prgBanks8k * 8192);
  for (let b = 0; b < prgBanks8k; b++) prg.fill(b, b * 8192, (b + 1) * 8192);
  const chr = new Uint8Array(chrBanks1k * 1024);
  for (let b = 0; b < chrBanks1k; b++) chr.fill(b, b * 1024, (b + 1) * 1024);
  return {
    header: {
      // prgRomBanks counts 16K units, so divide.
      prgRomBanks: prgBanks8k / 2,
      chrRomBanks: chrBanks1k / 8,
      mapper: 4,
      mirroring: 'horizontal',
      hasBattery: false,
      hasTrainer: false,
    },
    prgRom: prg,
    chrRom: chr,
    trainer: null,
  };
}

describe('MMC3 — PRG bank routing', () => {
  it('default layout: R6 at $8000, fixed second-to-last at $C000, fixed last at $E000', () => {
    const m = new Mmc3(makeRom(8, 8)); // 64K PRG, 8K CHR
    // R6 defaults to 0; banks fill = bank index.
    expect(m.cpuRead(0x8000)).toBe(0);
    // $A000-$BFFF = R7 (also defaults to 0).
    expect(m.cpuRead(0xa000)).toBe(0);
    // $C000-$DFFF = second-to-last (bank 6).
    expect(m.cpuRead(0xc000)).toBe(6);
    // $E000-$FFFF = last (bank 7).
    expect(m.cpuRead(0xe000)).toBe(7);
  });

  it('writing R6 swaps the $8000 window', () => {
    const m = new Mmc3(makeRom(8, 8));
    // Select R6, then write bank index.
    m.cpuWrite(0x8000, 6);     // bank-select reg = 6 (PRG R6)
    m.cpuWrite(0x8001, 3);     // R6 := bank 3
    expect(m.cpuRead(0x8000)).toBe(3);
  });

  it('PRG mode 1 (bit 6 of $8000): swaps $8000 and $C000 windows', () => {
    const m = new Mmc3(makeRom(8, 8));
    m.cpuWrite(0x8000, 0x40 | 6); // PRG mode 1 + select R6
    m.cpuWrite(0x8001, 3);        // R6 := bank 3
    // Now $8000 = second-to-last (bank 6), $C000 = R6 (bank 3).
    expect(m.cpuRead(0x8000)).toBe(6);
    expect(m.cpuRead(0xc000)).toBe(3);
    // Last bank is still pinned at $E000.
    expect(m.cpuRead(0xe000)).toBe(7);
  });
});

describe('MMC3 — CHR bank routing', () => {
  it('default layout (mode 0): R0/R1 at $0000-$0FFF (2KB each), R2-R5 at $1000-$1FFF', () => {
    const m = new Mmc3(makeRom(8, 32)); // 32K CHR
    // Set R0 to bank 4 (with low bit forced off → bank 4 then 5 in 1K slots).
    m.cpuWrite(0x8000, 0); m.cpuWrite(0x8001, 4);
    expect(m.ppuRead(0x0000)).toBe(4);   // slot 0 = R0 & ~1 = 4
    expect(m.ppuRead(0x0400)).toBe(5);   // slot 1 = R0 & ~1 + 1 = 5

    // R2 selects 1K bank for slot 4 ($1000-$13FF).
    m.cpuWrite(0x8000, 2); m.cpuWrite(0x8001, 9);
    expect(m.ppuRead(0x1000)).toBe(9);
  });

  it('CHR mode 1 (bit 7 of $8000): R2-R5 at $0000-$0FFF, R0/R1 at $1000-$1FFF', () => {
    const m = new Mmc3(makeRom(8, 32));
    m.cpuWrite(0x8000, 0x80 | 0); m.cpuWrite(0x8001, 4); // R0 := 4
    // In mode 1, R0 maps to slot 4 ($1000) instead of slot 0.
    expect(m.ppuRead(0x1000)).toBe(4);
    expect(m.ppuRead(0x1400)).toBe(5);
  });
});

describe('MMC3 — runtime mirroring', () => {
  it('writing $A000 toggles mirroring (vertical when bit 0 = 0)', () => {
    const m = new Mmc3(makeRom(4, 8));
    m.cpuWrite(0xa000, 0x00);
    expect(m.mirroring()).toBe('vertical');
    m.cpuWrite(0xa000, 0x01);
    expect(m.mirroring()).toBe('horizontal');
  });
});

describe('MMC3 — IRQ counter', () => {
  /**
   * Helper: simulate an A12 transition with `lowDots` PPU dots of "A12 low"
   * preceding a rising edge. The IRQ counter only clocks when at least 10
   * low-dots have accumulated.
   */
  function clock(m: Mmc3, lowDots = 16): void {
    // Make sure A12 is low first, then accumulate low-dots, then rise.
    m.notifyPpuA12(0);
    for (let i = 0; i < lowDots; i++) m.tickPpu();
    m.notifyPpuA12(1);
  }

  it('after reload, counter loads from latch on first clock and counts down', () => {
    const m = new Mmc3(makeRom(4, 8));
    m.cpuWrite(0xc000, 5);   // latch := 5
    m.cpuWrite(0xc001, 0);   // request reload
    m.cpuWrite(0xe001, 0);   // enable IRQ

    clock(m); // counter := 5 (load)
    expect(m.irqPending()).toBe(false);
    // 5 more clocks decrement 5 → 4 → 3 → 2 → 1 → 0 (fires on the 5th).
    for (let i = 0; i < 5; i++) clock(m);
    expect(m.irqPending()).toBe(true);
  });

  it('IRQ does not fire when disabled', () => {
    const m = new Mmc3(makeRom(4, 8));
    m.cpuWrite(0xc000, 1);
    m.cpuWrite(0xc001, 0);
    // IRQ remains disabled (no $E001 write).
    clock(m); // counter loads to 1
    clock(m); // counter -> 0; would fire if enabled
    expect(m.irqPending()).toBe(false);
  });

  it('writing $E000 disables IRQ and acknowledges any pending', () => {
    const m = new Mmc3(makeRom(4, 8));
    m.cpuWrite(0xc000, 0);
    m.cpuWrite(0xc001, 0);
    m.cpuWrite(0xe001, 0); // enable
    clock(m);              // counter = 0 -> reload to 0; with enable + counter==0, fires
    expect(m.irqPending()).toBe(true);
    m.cpuWrite(0xe000, 0); // ack + disable
    expect(m.irqPending()).toBe(false);
  });

  it('rapid A12 toggles do not clock the counter (filter blocks short-low pulses)', () => {
    const m = new Mmc3(makeRom(4, 8));
    m.cpuWrite(0xc000, 1);
    m.cpuWrite(0xc001, 0);
    m.cpuWrite(0xe001, 0);

    // Counter loaded by first long-low rising edge.
    clock(m, 16);
    // Now wiggle A12 quickly with only 5 low-dots between rising edges.
    for (let i = 0; i < 5; i++) {
      m.notifyPpuA12(0);
      for (let j = 0; j < 5; j++) m.tickPpu();
      m.notifyPpuA12(1);
    }
    // None of those should have clocked. IRQ shouldn't fire yet.
    expect(m.irqPending()).toBe(false);
  });
});
