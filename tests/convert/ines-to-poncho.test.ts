import { describe, expect, it } from 'vitest';

import {
  decodeMapperSubmode,
  isPonchoRom,
  parsePonchoRom,
} from '../../src/core/cart-poncho/header';
import { detectConsole } from '../../src/console/detect';
import { PonchoNes } from '../../src/console/poncho-nes';
import { NES_MASTER_PALETTE_RGBA } from '../../src/core/ppu-ultra/nes-master-palette';
import {
  ConvertError,
  bankingVariantName,
  convertInesToPoncho,
} from '../../src/convert/ines-to-poncho';

/**
 * Build a minimal synthetic iNES file in memory:
 *   - 1 × 16 KB PRG bank by default (configurable)
 *   - 1 × 8 KB CHR bank (or zero for CHR-RAM)
 *   - configurable mapper id, mirroring, has-battery, has-trainer
 *
 * The PRG starts with a halt loop at $C000 (`JMP $C000`) and a reset
 * vector pointing there, so the converted ROM can boot through the
 * PpuUltra without crashing.
 */
function buildIneS(opts: {
  prgBanks?: number;
  chrBanks?: number;
  mapper?: number;
  mirroring?: 'horizontal' | 'vertical' | 'four-screen';
  hasBattery?: boolean;
  hasTrainer?: boolean;
} = {}): Uint8Array {
  const prgBanks = opts.prgBanks ?? 1;
  const chrBanks = opts.chrBanks ?? 1;
  const mapper = opts.mapper ?? 0;
  const mirroring = opts.mirroring ?? 'horizontal';
  const hasBattery = opts.hasBattery ?? false;
  const hasTrainer = opts.hasTrainer ?? false;

  const header = new Uint8Array(16);
  header[0] = 0x4e; header[1] = 0x45; header[2] = 0x53; header[3] = 0x1a;
  header[4] = prgBanks;
  header[5] = chrBanks;
  // flags6: low nibble = mapper-low, mirroring + battery + trainer + four-screen
  let flags6 = 0;
  if (mirroring === 'vertical') flags6 |= 0x01;
  if (mirroring === 'four-screen') flags6 |= 0x08;
  if (hasBattery) flags6 |= 0x02;
  if (hasTrainer) flags6 |= 0x04;
  flags6 |= (mapper & 0x0f) << 4;
  header[6] = flags6;
  // flags7: mapper-high nibble
  header[7] = mapper & 0xf0;

  const prg = new Uint8Array(prgBanks * 16384);
  // Halt loop at the start of bank 0; PRG mirrors to $C000 for NROM
  // single-bank carts. Banking-variant carts have their own setup
  // expectations but the loop runs even unconfigured for sanity.
  prg[0x0000] = 0x4c; prg[0x0001] = 0x00; prg[0x0002] = 0x80;
  // Reset vector at $FFFC = $8000 (last bank's offset 0x3FFC for 1-bank).
  const lastBankOff = (prgBanks - 1) * 16384;
  prg[lastBankOff + 0x3ffa] = 0x00; prg[lastBankOff + 0x3ffb] = 0x80;
  prg[lastBankOff + 0x3ffc] = 0x00; prg[lastBankOff + 0x3ffd] = 0x80;
  prg[lastBankOff + 0x3ffe] = 0x00; prg[lastBankOff + 0x3fff] = 0x80;

  const chr = new Uint8Array(chrBanks * 8192);

  const out = new Uint8Array(header.length + prg.length + chr.length);
  out.set(header, 0);
  out.set(prg, header.length);
  out.set(chr, header.length + prg.length);
  return out;
}

describe('convertInesToPoncho — header + flag plumbing', () => {
  it('produces an upscaled-mode PonchoROM that round-trips through the parser', () => {
    const ines = buildIneS({ prgBanks: 2, chrBanks: 1, mapper: 0 });
    const result = convertInesToPoncho(ines, { title: 'NROM Synth' });

    expect(isPonchoRom(result.poncho)).toBe(true);
    const layout = parsePonchoRom(result.poncho);
    expect(layout.header.title).toBe('NROM Synth');
    expect(layout.header.flags.upscaledMode).toBe(true);
    expect(layout.header.mapperId).toBe(1);
    expect(layout.header.prgSizeKb).toBe(32);
    expect(layout.header.chrSizeKb).toBe(8);
    expect(layout.header.chrRamKb).toBe(0);
    // 64-entry NES canonical palette.
    expect(layout.header.paletteCount).toBe(64);
  });

  it('embeds the canonical NES master palette', () => {
    const { poncho } = convertInesToPoncho(buildIneS({}));
    const layout = parsePonchoRom(poncho);
    const slice = poncho.subarray(
      layout.paletteOffset,
      layout.paletteOffset + layout.paletteByteLength,
    );
    expect(slice).toEqual(NES_MASTER_PALETTE_RGBA);
  });

  it('records the source iNES CRC32 in the header', () => {
    const { poncho } = convertInesToPoncho(buildIneS({}));
    const layout = parsePonchoRom(poncho);
    expect(layout.header.sourceInesCrc32).not.toBe(0);
  });

  it('truncates titles longer than 32 UTF-8 bytes', () => {
    const longTitle = 'A'.repeat(50);
    const { poncho } = convertInesToPoncho(buildIneS({}), { title: longTitle });
    const layout = parsePonchoRom(poncho);
    expect(layout.header.title.length).toBe(32);
  });
});

describe('convertInesToPoncho — mapper id mapping', () => {
  const cases: Array<[number, 0 | 1 | 2 | 3 | 4 | 7, string]> = [
    [0, 0, 'NROM'],
    [1, 1, 'MMC1'],
    [2, 2, 'UxROM'],
    [3, 3, 'CNROM'],
    [4, 4, 'MMC3'],
    [7, 7, 'AxROM'],
  ];
  for (const [iNESMapper, expectedVariant, name] of cases) {
    it(`maps iNES mapper ${iNESMapper} (${name}) → banking variant ${expectedVariant}`, () => {
      const { poncho, notes } = convertInesToPoncho(buildIneS({ mapper: iNESMapper, prgBanks: 4 }));
      expect(notes.bankingVariant).toBe(expectedVariant);
      expect(bankingVariantName(notes.bankingVariant)).toBe(name);
      const layout = parsePonchoRom(poncho);
      expect(decodeMapperSubmode(layout.header.mapperSubmode).bankingVariant).toBe(expectedVariant);
    });
  }
});

describe('convertInesToPoncho — mirroring mapping', () => {
  it('maps horizontal/vertical/four-screen iNES mirroring into mapper_submode', () => {
    const cases = [
      ['horizontal', 0],
      ['vertical', 1],
      ['four-screen', 2],
    ] as const;
    for (const [mirror, expected] of cases) {
      const { poncho } = convertInesToPoncho(buildIneS({ mirroring: mirror }));
      const layout = parsePonchoRom(poncho);
      expect(decodeMapperSubmode(layout.header.mapperSubmode).bootMirroring).toBe(expected);
    }
  });
});

describe('convertInesToPoncho — CHR-ROM vs CHR-RAM', () => {
  it('CHR-ROM games embed CHR verbatim and leave chrRamKb=0', () => {
    const { poncho, notes } = convertInesToPoncho(buildIneS({ chrBanks: 2 }));
    const layout = parsePonchoRom(poncho);
    expect(layout.header.chrSizeKb).toBe(16);
    expect(layout.header.chrRamKb).toBe(0);
    expect(notes.chrKb).toBe(16);
    expect(notes.chrRamKb).toBe(0);
  });

  it('CHR-RAM games (chrBanks=0) emit chrSizeKb=0 + chrRamKb=8', () => {
    const { poncho, notes } = convertInesToPoncho(
      buildIneS({ mapper: 2, chrBanks: 0 }), // UxROM is canonical CHR-RAM mapper
    );
    const layout = parsePonchoRom(poncho);
    expect(layout.header.chrSizeKb).toBe(0);
    expect(layout.header.chrRamKb).toBe(8);
    expect(notes.chrKb).toBe(0);
    expect(notes.chrRamKb).toBe(8);
  });
});

describe('convertInesToPoncho — error paths', () => {
  it('rejects unsupported mappers', () => {
    expect(() => convertInesToPoncho(buildIneS({ mapper: 5 })))
      .toThrow(/mapper 5 is not supported/);
    expect(() => convertInesToPoncho(buildIneS({ mapper: 9 })))
      .toThrow(/mapper 9 is not supported/);
    expect(() => convertInesToPoncho(buildIneS({ mapper: 11 })))
      .toThrow(/not supported/);
  });

  it('rejects ROMs with a trainer block', () => {
    expect(() => convertInesToPoncho(buildIneS({ hasTrainer: true })))
      .toThrow(/trainer/i);
  });

  it('throws ConvertError specifically (not a generic Error)', () => {
    let caught: unknown = null;
    try {
      convertInesToPoncho(buildIneS({ mapper: 5 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvertError);
  });
});

describe('convertInesToPoncho — boots through PonchoNes.loadRom', () => {
  it('detect → load → runFrame produces a 1024×960 frame for a converted NROM ROM', () => {
    const ines = buildIneS({ mapper: 0, prgBanks: 1, chrBanks: 1 });
    const { poncho } = convertInesToPoncho(ines);

    const factory = detectConsole(poncho);
    expect(factory).not.toBeNull();
    expect(factory!.spec.id).toBe('poncho-nes');

    const console = factory!.create();
    expect(console).toBeInstanceOf(PonchoNes);
    console.loadRom(poncho);
    const fb = console.runFrame();
    expect(fb.width).toBe(1024);
    expect(fb.height).toBe(960);
  });

  it('a converted UxROM CHR-RAM cart loads cleanly (boots into halt loop)', () => {
    const ines = buildIneS({ mapper: 2, prgBanks: 4, chrBanks: 0 });
    const { poncho } = convertInesToPoncho(ines);
    const factory = detectConsole(poncho);
    const console = factory!.create() as PonchoNes;
    console.loadRom(poncho);
    expect(() => console.runFrame()).not.toThrow();
    expect(console.cartridge!.chrIsRam).toBe(true);
  });
});
