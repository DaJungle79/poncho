import { describe, expect, it } from 'vitest';

import {
  PonchoMapper,
  type PonchoMapperOptions,
} from '../../src/core/mappers-poncho/poncho-mapper';

function makePrg(banks: number, fillByte: (bank: number, offset: number) => number): Uint8Array {
  const bankSize = 16 * 1024;
  const prg = new Uint8Array(banks * bankSize);
  for (let b = 0; b < banks; b++) {
    for (let o = 0; o < bankSize; o++) {
      prg[b * bankSize + o] = fillByte(b, o);
    }
  }
  return prg;
}

describe('PonchoMapper — NROM-style banking (variant 0)', () => {
  it('mirrors a single 16 KB PRG bank across $8000-$FFFF', () => {
    const prg = makePrg(1, (_b, o) => o & 0xff);
    const m = new PonchoMapper(prg, new Uint8Array(0), { bankingVariant: 0 });
    expect(m.cpuRead(0x8000)).toBe(0);
    expect(m.cpuRead(0x8001)).toBe(1);
    // Mirror at $C000 reads the same bytes.
    expect(m.cpuRead(0xc000)).toBe(0);
    expect(m.cpuRead(0xc001)).toBe(1);
    // Reset vector at $FFFC = PRG[0x3FFC] (mirror).
    expect(m.cpuRead(0xfffc)).toBe(0xfc);
  });

  it('keeps a 32 KB PRG laid out flat with no mirroring', () => {
    const prg = makePrg(2, (b, _o) => (b === 0 ? 0xaa : 0xbb));
    const m = new PonchoMapper(prg, new Uint8Array(0), { bankingVariant: 0 });
    expect(m.cpuRead(0x8000)).toBe(0xaa);
    expect(m.cpuRead(0xc000)).toBe(0xbb);
  });

  it('drops cpuWrite (no banking)', () => {
    const prg = makePrg(1, (_b, _o) => 0x55);
    const m = new PonchoMapper(prg, new Uint8Array(0), { bankingVariant: 0 });
    m.cpuWrite(0x8000, 0xff);
    expect(m.cpuRead(0x8000)).toBe(0x55);
  });
});

describe('PonchoMapper — UxROM-style banking (variant 2)', () => {
  /**
   * Build a 4-bank (64 KB) PRG where every byte in bank N is the value
   * 0xA0 | N. That makes any read trivially identify which bank served it.
   */
  function fourBankSentinel(): Uint8Array {
    return makePrg(4, (b, _o) => 0xa0 | b);
  }

  function newMapper(opts: Partial<PonchoMapperOptions> = {}): PonchoMapper {
    return new PonchoMapper(fourBankSentinel(), new Uint8Array(0), {
      bankingVariant: 2,
      ...opts,
    });
  }

  it('initial bank = 0 at $8000-$BFFF, fixed last bank at $C000-$FFFF', () => {
    const m = newMapper();
    expect(m.cpuRead(0x8000)).toBe(0xa0); // bank 0
    expect(m.cpuRead(0xbfff)).toBe(0xa0);
    expect(m.cpuRead(0xc000)).toBe(0xa3); // last bank (3)
    expect(m.cpuRead(0xffff)).toBe(0xa3);
  });

  it('any write to $8000-$FFFF selects the bank for $8000-$BFFF', () => {
    const m = newMapper();
    m.cpuWrite(0x8000, 0x01);
    expect(m.cpuRead(0x8000)).toBe(0xa1);
    m.cpuWrite(0xc000, 0x02); // write to fixed-bank window also bank-selects
    expect(m.cpuRead(0x8000)).toBe(0xa2);
    m.cpuWrite(0xffff, 0x03);
    expect(m.cpuRead(0x8000)).toBe(0xa3);
  });

  it('fixed last bank is unaffected by bank selects', () => {
    const m = newMapper();
    m.cpuWrite(0x8000, 0x00);
    expect(m.cpuRead(0xc000)).toBe(0xa3);
    m.cpuWrite(0x8000, 0x02);
    expect(m.cpuRead(0xc000)).toBe(0xa3);
  });

  it('bank index wraps modulo bank count for non-power-of-two PRGs', () => {
    // 3-bank PRG (48 KB). Selecting bank 4 should map to bank 4 % 3 = 1.
    const prg = makePrg(3, (b, _o) => 0xb0 | b);
    const m = new PonchoMapper(prg, new Uint8Array(0), { bankingVariant: 2 });
    m.cpuWrite(0x8000, 0x04);
    expect(m.cpuRead(0x8000)).toBe(0xb1);
  });

  it('reads below $8000 always return 0', () => {
    const m = newMapper();
    expect(m.cpuRead(0x4020)).toBe(0);
    expect(m.cpuRead(0x6000)).toBe(0);
    expect(m.cpuRead(0x7fff)).toBe(0);
  });

  it('exposes the friendly name in the mapper', () => {
    const m = newMapper();
    expect(m.name).toBe('PonchoMapper/UxROM-style');
  });
});

describe('PonchoMapper — boot mirroring delivery', () => {
  function newMapper(bootMirroring: 0 | 1 | 2 | 3): PonchoMapper {
    return new PonchoMapper(new Uint8Array(1024), new Uint8Array(0), {
      bankingVariant: 0,
      bootMirroring,
    });
  }
  it('decodes bootMirroring 0..3 to the canonical Mirroring strings', () => {
    expect(newMapper(0).mirroring()).toBe('horizontal');
    expect(newMapper(1).mirroring()).toBe('vertical');
    expect(newMapper(2).mirroring()).toBe('four-screen');
    expect(newMapper(3).mirroring()).toBe('single-low');
  });
});

describe('PonchoMapper — variant dispatch', () => {
  it('exposes the friendly variant name for each supported banking variant', () => {
    const expectations: Array<[0 | 1 | 2 | 3 | 4 | 7, string]> = [
      [0, 'PonchoMapper/NROM-style'],
      [1, 'PonchoMapper/MMC1-style'],
      [2, 'PonchoMapper/UxROM-style'],
      [3, 'PonchoMapper/CNROM-style'],
      [4, 'PonchoMapper/MMC3-style'],
      [7, 'PonchoMapper/AxROM-style'],
    ];
    for (const [variant, expected] of expectations) {
      const m = new PonchoMapper(new Uint8Array(16 * 1024), new Uint8Array(8192), {
        bankingVariant: variant,
      });
      expect(m.name).toBe(expected);
    }
  });
});
