import { describe, expect, it } from 'vitest';
import type { InesRom } from '../../src/core/cart/ines';
import { Axrom } from '../../src/core/mappers/axrom';

function makeRom(prgBanks32k: number): InesRom {
  // Each 32-KiB PRG bank filled with its own bank index for easy assertions.
  const prg = new Uint8Array(prgBanks32k * 32768);
  for (let b = 0; b < prgBanks32k; b++) prg.fill(b, b * 32768, (b + 1) * 32768);
  return {
    header: {
      prgRomBanks: prgBanks32k * 2, // header counts 16-KiB units
      chrRomBanks: 0,
      mapper: 7,
      mirroring: 'horizontal', // header value is ignored by AxROM
      hasBattery: false,
      hasTrainer: false,
    },
    prgRom: prg,
    chrRom: new Uint8Array(0),
    trainer: null,
  };
}

describe('AxROM', () => {
  it('maps the entire $8000-$FFFF as one switchable 32-KiB bank', () => {
    const m = new Axrom(makeRom(4));
    expect(m.cpuRead(0x8000)).toBe(0); // bank 0 default
    expect(m.cpuRead(0xffff)).toBe(0);
  });

  it('bank-select writes anywhere in $8000-$FFFF select the 32 KiB window', () => {
    const m = new Axrom(makeRom(4));
    m.cpuWrite(0x8000, 0x02);
    expect(m.cpuRead(0x8000)).toBe(2);
    expect(m.cpuRead(0xffff)).toBe(2);
    m.cpuWrite(0xfffe, 0x03);
    expect(m.cpuRead(0x9000)).toBe(3);
  });

  it('starts in single-screen-low and toggles to high on bit 4 set', () => {
    const m = new Axrom(makeRom(2));
    expect(m.mirroring()).toBe('single-low');
    m.cpuWrite(0x8000, 0x10);
    expect(m.mirroring()).toBe('single-high');
    m.cpuWrite(0x8000, 0x00);
    expect(m.mirroring()).toBe('single-low');
  });

  it('PRG bank and mirroring update independently from one write', () => {
    const m = new Axrom(makeRom(4));
    m.cpuWrite(0x8000, 0x13); // bank=3, mirror=high
    expect(m.cpuRead(0x8000)).toBe(3);
    expect(m.mirroring()).toBe('single-high');
  });

  it('CHR-RAM reads back what was written', () => {
    const m = new Axrom(makeRom(2));
    m.ppuWrite(0x0123, 0x99);
    expect(m.ppuRead(0x0123)).toBe(0x99);
  });
});
