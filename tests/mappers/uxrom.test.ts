import { describe, expect, it } from 'vitest';
import type { InesRom } from '../../src/core/cart/ines';
import { Uxrom } from '../../src/core/mappers/uxrom';

function makeRom(prgBanks: number, fillBank: (bank: number) => number): InesRom {
  const prg = new Uint8Array(prgBanks * 16384);
  for (let b = 0; b < prgBanks; b++) prg.fill(fillBank(b), b * 16384, (b + 1) * 16384);
  return {
    header: {
      prgRomBanks: prgBanks,
      chrRomBanks: 0,
      mapper: 2,
      mirroring: 'vertical',
      hasBattery: false,
      hasTrainer: false,
    },
    prgRom: prg,
    chrRom: new Uint8Array(0),
    trainer: null,
  };
}

describe('UxROM', () => {
  it('maps the last bank into $C000-$FFFF (fixed)', () => {
    const m = new Uxrom(makeRom(8, (b) => b));
    expect(m.cpuRead(0xc000)).toBe(7); // last bank fill = 7
    expect(m.cpuRead(0xffff)).toBe(7);
  });

  it('switchable bank at $8000 follows writes to any address in $8000-$FFFF', () => {
    const m = new Uxrom(makeRom(8, (b) => b));
    m.cpuWrite(0x8000, 0x03);
    expect(m.cpuRead(0x8000)).toBe(3);
    expect(m.cpuRead(0xbfff)).toBe(3);
    // Writes anywhere in the range are bank-select.
    m.cpuWrite(0xfffe, 0x05);
    expect(m.cpuRead(0x8000)).toBe(5);
  });

  it('switching banks does not affect the fixed last bank', () => {
    const m = new Uxrom(makeRom(8, (b) => b));
    m.cpuWrite(0x8000, 0x02);
    expect(m.cpuRead(0x8000)).toBe(2);
    expect(m.cpuRead(0xc000)).toBe(7);
  });

  it('CHR-RAM at $0000-$1FFF is read/writeable', () => {
    const m = new Uxrom(makeRom(2, () => 0));
    m.ppuWrite(0x0010, 0xab);
    expect(m.ppuRead(0x0010)).toBe(0xab);
  });

  it('mirroring comes from the iNES header and never changes', () => {
    const m = new Uxrom(makeRom(2, () => 0));
    expect(m.mirroring()).toBe('vertical');
    // Writes don't change mirroring on UxROM.
    m.cpuWrite(0xa000, 0x01);
    expect(m.mirroring()).toBe('vertical');
  });

  it('PRG-RAM at $6000-$7FFF persists through reads', () => {
    const m = new Uxrom(makeRom(2, () => 0));
    m.cpuWrite(0x6000, 0x55);
    m.cpuWrite(0x7fff, 0x66);
    expect(m.cpuRead(0x6000)).toBe(0x55);
    expect(m.cpuRead(0x7fff)).toBe(0x66);
  });
});
