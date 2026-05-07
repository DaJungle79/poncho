import { describe, expect, it } from 'vitest';

import {
  HEADER_SIZE,
  PONCHO_VERSION,
  PonchoRomError,
  decodeMapperSubmode,
  encodeMapperSubmode,
  isPonchoRom,
  parseHeader,
  parsePonchoRom,
} from '../../src/core/cart-poncho/header';
import { crc32 } from '../../src/core/cart-poncho/crc32';

/**
 * Build a syntactically valid PonchoROM in memory. Defaults yield the
 * minimum file the spec accepts: 1 KB PRG, 1 KB CHR, 4 palette entries.
 * Override individual fields to exercise edge cases.
 */
interface BuildOpts {
  magic?: number[];
  version?: number;
  flags?: number;
  prgSizeKb?: number;
  chrSizeKb?: number;
  paletteCount?: number;
  mapperId?: number;
  mapperSubmode?: number;
  prgRamKb?: number;
  chrRamKb?: number;
  tvSystem?: number;
  region?: number;
  crc32Override?: number; // when set, embedded CRC ignores the body
  sourceInesCrc32?: number;
  title?: string;
  trailerBytes?: Uint8Array;
  /** When true, file size is truncated to header length only. */
  truncate?: number;
}

function buildRom(opts: BuildOpts = {}): Uint8Array {
  const magic           = opts.magic           ?? [0x50, 0x4e, 0x43, 0x48];
  const version         = opts.version         ?? PONCHO_VERSION;
  const flags           = opts.flags           ?? 0;
  const prgSizeKb       = opts.prgSizeKb       ?? 1;
  const chrSizeKb       = opts.chrSizeKb       ?? 1;
  const paletteCount    = opts.paletteCount    ?? 4;
  const mapperId        = opts.mapperId        ?? 1;
  const mapperSubmode   = opts.mapperSubmode   ?? 0;
  const prgRamKb        = opts.prgRamKb        ?? 0;
  const chrRamKb        = opts.chrRamKb        ?? 0;
  const tvSystem        = opts.tvSystem        ?? 0;
  const region          = opts.region          ?? 0;
  const sourceInesCrc32 = opts.sourceInesCrc32 ?? 0;
  const title           = opts.title           ?? '';
  const trailerBytes    = opts.trailerBytes    ?? new Uint8Array(0);

  const paletteBytes = paletteCount * 4;
  const prgBytes     = prgSizeKb * 1024;
  const chrBytes     = chrSizeKb * 1024;
  const totalBeforeTrailer = HEADER_SIZE + paletteBytes + prgBytes + chrBytes;
  const total = totalBeforeTrailer + trailerBytes.length;

  const rom = new Uint8Array(total);
  const view = new DataView(rom.buffer);

  rom.set(magic, 0x00);
  view.setUint8(0x04, version);
  view.setUint8(0x05, flags);
  view.setUint16(0x06, prgSizeKb, true);
  view.setUint32(0x08, chrSizeKb, true);
  view.setUint16(0x0c, paletteCount, true);
  view.setUint16(0x0e, mapperId, true);
  view.setUint16(0x10, mapperSubmode, true);
  view.setUint16(0x12, prgRamKb, true);
  view.setUint16(0x14, chrRamKb, true);
  view.setUint8(0x16, tvSystem);
  view.setUint8(0x17, region);
  view.setUint32(0x1c, sourceInesCrc32, true);

  // Title — UTF-8, null-padded into 32 bytes.
  const titleBytes = new TextEncoder().encode(title);
  if (titleBytes.length > 32) throw new Error('test fixture title too long');
  rom.set(titleBytes, 0x20);

  // Trailer goes after CHR.
  if (trailerBytes.length > 0) {
    rom.set(trailerBytes, totalBeforeTrailer);
  }

  // CRC over body (everything after the header).
  const computed = crc32(rom.subarray(HEADER_SIZE));
  view.setUint32(0x18, opts.crc32Override ?? computed, true);

  if (opts.truncate !== undefined) {
    return rom.subarray(0, opts.truncate);
  }
  return rom;
}

describe('isPonchoRom', () => {
  it('returns true for valid PNCH magic', () => {
    expect(isPonchoRom(buildRom())).toBe(true);
  });

  it('returns false for iNES bytes', () => {
    const ines = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, 0, 0, 0, 0]);
    expect(isPonchoRom(ines)).toBe(false);
  });

  it('returns false for inputs shorter than 4 bytes', () => {
    expect(isPonchoRom(new Uint8Array(0))).toBe(false);
    expect(isPonchoRom(new Uint8Array([0x50, 0x4e, 0x43]))).toBe(false);
  });

  it('returns false for random bytes', () => {
    expect(isPonchoRom(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe(false);
  });
});

describe('parsePonchoRom — happy path', () => {
  it('parses a minimal valid ROM', () => {
    const rom = buildRom();
    const layout = parsePonchoRom(rom);
    expect(layout.header.version).toBe(PONCHO_VERSION);
    expect(layout.header.prgSizeKb).toBe(1);
    expect(layout.header.chrSizeKb).toBe(1);
    expect(layout.header.paletteCount).toBe(4);
    expect(layout.header.mapperId).toBe(1);
  });

  // Header-only path: feeds parseHeader a hand-built 64-byte buffer with
  // values designed to expose any byte-offset or endianness mistake.
  // Avoids allocating multi-GB bodies just to verify field decoding.
  it('parseHeader reads each numeric field at its documented offset', () => {
    const buf = new Uint8Array(HEADER_SIZE);
    const v = new DataView(buf.buffer);
    buf.set([0x50, 0x4e, 0x43, 0x48], 0x00);
    v.setUint8(0x04, PONCHO_VERSION);
    v.setUint8(0x05, 0b0000_0011); // both flags
    v.setUint16(0x06, 0x1234, true);
    v.setUint32(0x08, 0xdeadbeef, true);
    v.setUint16(0x0c, 0x0100, true);
    v.setUint16(0x0e, 0x4321, true);
    v.setUint16(0x10, 0x0009, true);
    v.setUint16(0x12, 0x0008, true);
    v.setUint16(0x14, 0x0010, true);
    v.setUint8(0x16, 2); // tv_system = both
    v.setUint8(0x17, 0x42);
    v.setUint32(0x18, 0x11223344, true);
    v.setUint32(0x1c, 0xcafebabe, true);
    new TextEncoder().encodeInto('Hello', buf.subarray(0x20));

    const h = parseHeader(buf);
    expect(h.version).toBe(PONCHO_VERSION);
    expect(h.flags).toEqual({ upscaledMode: true, trailerPresent: true });
    expect(h.prgSizeKb).toBe(0x1234);
    expect(h.chrSizeKb).toBe(0xdeadbeef);
    expect(h.paletteCount).toBe(0x0100);
    expect(h.mapperId).toBe(0x4321);
    expect(h.mapperSubmode).toBe(0x0009);
    expect(h.prgRamKb).toBe(8);
    expect(h.chrRamKb).toBe(16);
    expect(h.tvSystem).toBe('both');
    expect(h.region).toBe(0x42);
    expect(h.crc32).toBe(0x11223344);
    expect(h.sourceInesCrc32).toBe(0xcafebabe);
    expect(h.title).toBe('Hello');
  });

  it('decodes flags bitfield', () => {
    expect(parsePonchoRom(buildRom({ flags: 0b00 })).header.flags).toEqual({
      upscaledMode: false,
      trailerPresent: false,
    });
    expect(parsePonchoRom(buildRom({ flags: 0b01 })).header.flags).toEqual({
      upscaledMode: true,
      trailerPresent: false,
    });
    expect(parsePonchoRom(buildRom({ flags: 0b10, trailerBytes: new Uint8Array([1, 2, 3]) }))
      .header.flags).toEqual({
      upscaledMode: false,
      trailerPresent: true,
    });
  });

  it('decodes tv_system enum', () => {
    expect(parsePonchoRom(buildRom({ tvSystem: 0 })).header.tvSystem).toBe('ntsc');
    expect(parsePonchoRom(buildRom({ tvSystem: 1 })).header.tvSystem).toBe('pal');
    expect(parsePonchoRom(buildRom({ tvSystem: 2 })).header.tvSystem).toBe('both');
  });

  it('reads UTF-8 titles and strips trailing nulls', () => {
    expect(parsePonchoRom(buildRom({ title: 'Contra' })).header.title).toBe('Contra');
    expect(parsePonchoRom(buildRom({ title: 'Castlevania' })).header.title).toBe('Castlevania');
    expect(parsePonchoRom(buildRom({ title: '魂斗羅' })).header.title).toBe('魂斗羅');
    expect(parsePonchoRom(buildRom({ title: '' })).header.title).toBe('');
  });

  it('computes section offsets and lengths', () => {
    const rom = buildRom({ paletteCount: 16, prgSizeKb: 4, chrSizeKb: 8 });
    const layout = parsePonchoRom(rom);
    expect(layout.paletteOffset).toBe(HEADER_SIZE);
    expect(layout.paletteByteLength).toBe(16 * 4);
    expect(layout.prgOffset).toBe(HEADER_SIZE + 64);
    expect(layout.prgByteLength).toBe(4 * 1024);
    expect(layout.chrOffset).toBe(HEADER_SIZE + 64 + 4096);
    expect(layout.chrByteLength).toBe(8 * 1024);
    expect(layout.trailerOffset).toBe(0);
    expect(layout.trailerByteLength).toBe(0);
  });

  it('reports trailer offset and length when flag is set', () => {
    const trailer = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const rom = buildRom({ flags: 0b10, trailerBytes: trailer });
    const layout = parsePonchoRom(rom);
    expect(layout.trailerOffset).toBe(HEADER_SIZE + 16 + 1024 + 1024);
    expect(layout.trailerByteLength).toBe(trailer.length);
    expect(rom.subarray(layout.trailerOffset, layout.trailerOffset + layout.trailerByteLength))
      .toEqual(trailer);
  });

  it('skipCrc bypasses integrity check', () => {
    const rom = buildRom({ crc32Override: 0xdeadbeef });
    expect(() => parsePonchoRom(rom)).toThrow(PonchoRomError);
    expect(() => parsePonchoRom(rom, { skipCrc: true })).not.toThrow();
  });
});

describe('parsePonchoRom — rejects invalid input', () => {
  it('throws on empty buffer', () => {
    expect(() => parsePonchoRom(new Uint8Array(0))).toThrow(PonchoRomError);
  });

  it('throws on file shorter than the header', () => {
    expect(() => parsePonchoRom(buildRom({ truncate: HEADER_SIZE - 1 })))
      .toThrow(/File too short/);
  });

  it('throws on iNES magic', () => {
    const rom = buildRom({ magic: [0x4e, 0x45, 0x53, 0x1a] });
    expect(() => parsePonchoRom(rom)).toThrow(/Not a PonchoROM/);
  });

  it('throws on unknown version', () => {
    const rom = buildRom({ version: 0x99 });
    expect(() => parsePonchoRom(rom)).toThrow(/Unsupported PonchoROM version/);
  });

  it('throws when file is shorter than header-declared sizes', () => {
    const rom = buildRom({ prgSizeKb: 4 });
    const truncated = rom.subarray(0, rom.length - 100);
    expect(() => parsePonchoRom(truncated)).toThrow(/File too short.*declares/);
  });

  it('throws on invalid tv_system value', () => {
    expect(() => parsePonchoRom(buildRom({ tvSystem: 9 })))
      .toThrow(/Invalid tv_system value/);
  });

  it('throws when CRC32 does not match the body', () => {
    const rom = buildRom({ crc32Override: 0x00000000 });
    expect(() => parsePonchoRom(rom)).toThrow(/CRC32 mismatch/);
  });
});

describe('mapperSubmode codec', () => {
  it('round-trips banking variant + boot mirroring', () => {
    const cases = [
      { bankingVariant: 0, bootMirroring: 0 },
      { bankingVariant: 2, bootMirroring: 1 }, // UxROM, vertical (Contra)
      { bankingVariant: 4, bootMirroring: 0 },
      { bankingVariant: 7, bootMirroring: 3 },
    ] as const;
    for (const c of cases) {
      const raw = encodeMapperSubmode(c);
      expect(decodeMapperSubmode(raw)).toEqual(c);
    }
  });

  it('packs banking in low byte, mirroring in bits 8-9', () => {
    expect(encodeMapperSubmode({ bankingVariant: 2, bootMirroring: 1 }))
      .toBe((1 << 8) | 2);
    expect(encodeMapperSubmode({ bankingVariant: 4, bootMirroring: 3 }))
      .toBe((3 << 8) | 4);
  });

  it('ignores reserved bits when decoding', () => {
    const withGarbageInReserved = encodeMapperSubmode({ bankingVariant: 2, bootMirroring: 1 })
                                | 0xfc00;
    expect(decodeMapperSubmode(withGarbageInReserved))
      .toEqual({ bankingVariant: 2, bootMirroring: 1 });
  });
});

describe('crc32', () => {
  it('matches well-known reference values', () => {
    // "" → 0x00000000
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    // "123456789" → 0xCBF43926 (canonical CRC-32 reference)
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
