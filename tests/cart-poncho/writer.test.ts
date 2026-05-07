import { describe, expect, it } from 'vitest';

import { parsePonchoRom } from '../../src/core/cart-poncho/header';
import {
  PonchoWriterError,
  assemblePonchoRom,
  makePalette,
} from '../../src/core/cart-poncho/writer';

describe('makePalette', () => {
  it('packs RGB tuples with default alpha 0xFF', () => {
    const buf = makePalette([
      [0x12, 0x34, 0x56],
      [0xab, 0xcd, 0xef, 0x80],
    ]);
    expect(buf).toEqual(new Uint8Array([
      0x12, 0x34, 0x56, 0xff,
      0xab, 0xcd, 0xef, 0x80,
    ]));
  });

  it('returns an empty buffer for no entries', () => {
    expect(makePalette([])).toEqual(new Uint8Array(0));
  });
});

describe('assemblePonchoRom — round trip with parser', () => {
  it('produces a parseable ROM with computed sizes and CRC', () => {
    const palette = makePalette([[0xe6, 0x3e, 0x32], [0x00, 0x00, 0x00]]);
    const prg = new Uint8Array(2 * 1024);
    const chr = new Uint8Array(3 * 1024);
    prg[0] = 0xea; // NOP — just a sentinel byte
    chr[chr.length - 1] = 0x99;

    const rom = assemblePonchoRom({
      palette, prg, chr,
      title: 'Round Trip',
      mapperId: 7,
      mapperSubmode: 3,
      prgRamKb: 8,
      chrRamKb: 4,
      tvSystem: 'both',
      region: 0x05,
      sourceInesCrc32: 0xcafebabe,
      flags: { upscaledMode: true, trailerPresent: false },
    });

    const layout = parsePonchoRom(rom);
    expect(layout.header.title).toBe('Round Trip');
    expect(layout.header.paletteCount).toBe(2);
    expect(layout.header.prgSizeKb).toBe(2);
    expect(layout.header.chrSizeKb).toBe(3);
    expect(layout.header.mapperId).toBe(7);
    expect(layout.header.mapperSubmode).toBe(3);
    expect(layout.header.prgRamKb).toBe(8);
    expect(layout.header.chrRamKb).toBe(4);
    expect(layout.header.tvSystem).toBe('both');
    expect(layout.header.region).toBe(0x05);
    expect(layout.header.sourceInesCrc32).toBe(0xcafebabe);
    expect(layout.header.flags).toEqual({ upscaledMode: true, trailerPresent: false });

    expect(rom.subarray(layout.paletteOffset, layout.paletteOffset + layout.paletteByteLength))
      .toEqual(palette);
    expect(rom.subarray(layout.prgOffset, layout.prgOffset + layout.prgByteLength))
      .toEqual(prg);
    expect(rom.subarray(layout.chrOffset, layout.chrOffset + layout.chrByteLength))
      .toEqual(chr);
  });

  it('embeds the trailer and sets the trailerPresent flag', () => {
    const palette = makePalette([[0, 0, 0]]);
    const prg = new Uint8Array(1024);
    const chr = new Uint8Array(1024);
    const trailer = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const rom = assemblePonchoRom({ palette, prg, chr, trailer });
    const layout = parsePonchoRom(rom);

    expect(layout.header.flags.trailerPresent).toBe(true);
    expect(layout.trailerByteLength).toBe(4);
    expect(rom.subarray(layout.trailerOffset, layout.trailerOffset + 4)).toEqual(trailer);
  });

  it('defaults: NTSC, mapper 1, submode 0, no compat, region 0', () => {
    const rom = assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg: new Uint8Array(1024),
      chr: new Uint8Array(1024),
    });
    const { header } = parsePonchoRom(rom);
    expect(header.tvSystem).toBe('ntsc');
    expect(header.mapperId).toBe(1);
    expect(header.mapperSubmode).toBe(0);
    expect(header.prgRamKb).toBe(0);
    expect(header.chrRamKb).toBe(0);
    expect(header.region).toBe(0);
    expect(header.flags.upscaledMode).toBe(false);
    expect(header.flags.trailerPresent).toBe(false);
    expect(header.title).toBe('');
  });
});

describe('assemblePonchoRom — alignment and bounds', () => {
  const okPalette = makePalette([[0, 0, 0]]);
  const okPrg = new Uint8Array(1024);
  const okChr = new Uint8Array(1024);

  it('rejects palette length not a multiple of 4', () => {
    expect(() => assemblePonchoRom({
      palette: new Uint8Array(7), prg: okPrg, chr: okChr,
    })).toThrow(PonchoWriterError);
  });

  it('rejects PRG not a multiple of 1024', () => {
    expect(() => assemblePonchoRom({
      palette: okPalette, prg: new Uint8Array(500), chr: okChr,
    })).toThrow(/PRG length must be a multiple of 1024/);
  });

  it('rejects CHR not a multiple of 1024', () => {
    expect(() => assemblePonchoRom({
      palette: okPalette, prg: okPrg, chr: new Uint8Array(2000),
    })).toThrow(/CHR length must be a multiple of 1024/);
  });

  it('rejects title longer than 32 UTF-8 bytes', () => {
    expect(() => assemblePonchoRom({
      palette: okPalette, prg: okPrg, chr: okChr,
      title: 'x'.repeat(33),
    })).toThrow(/max 32/);
  });
});
