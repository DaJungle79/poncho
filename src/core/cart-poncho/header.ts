/**
 * PonchoROM header parser. The full 64-byte header layout, the master
 * palette, PRG-ROM, CHR-ROM, and trailer rules are documented in
 * `docs/poncho-rom.md`. This module is the runtime contract: any time
 * a `.poncho` file is loaded, it goes through `parsePonchoRom`.
 *
 * The parser is pure: it inspects a `Uint8Array`, validates the
 * structure, and returns a `PonchoRomLayout` with offsets/lengths the
 * caller can slice. No copies are made; the caller can `subarray()`
 * into the original buffer for palette / PRG / CHR data.
 */

import { crc32 } from './crc32';

/** ASCII `PNCH`. */
export const PONCHO_MAGIC = Object.freeze([0x50, 0x4e, 0x43, 0x48] as const);
export const PONCHO_VERSION = 0x01;
export const HEADER_SIZE = 64;

export class PonchoRomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PonchoRomError';
  }
}

export type TvSystem = 'ntsc' | 'pal' | 'both';

export interface PonchoFlags {
  /** Bit 0: NES-compat sub-mode. The PRG-ROM is original iNES code. */
  nesCompat: boolean;
  /** Bit 1: trailer block follows the CHR-ROM. */
  trailerPresent: boolean;
}

export interface PonchoHeader {
  version: number;
  flags: PonchoFlags;
  prgSizeKb: number;
  chrSizeKb: number;
  paletteCount: number;
  mapperId: number;
  mapperSubmode: number;
  prgRamKb: number;
  chrRamKb: number;
  tvSystem: TvSystem;
  region: number;
  /** CRC32 of all bytes from offset 0x40 onwards. */
  crc32: number;
  /** CRC32 of the source iNES file if produced by the converter, else 0. */
  sourceInesCrc32: number;
  /** UTF-8, trailing null bytes stripped. */
  title: string;
}

/**
 * Result of parsing. Each section is described by `(offset, length)`
 * into the original buffer — the caller slices to read the data.
 */
export interface PonchoRomLayout {
  header: PonchoHeader;
  paletteOffset: number;
  paletteByteLength: number;
  prgOffset: number;
  prgByteLength: number;
  chrOffset: number;
  chrByteLength: number;
  /** 0 / 0 when `flags.trailerPresent` is false. */
  trailerOffset: number;
  trailerByteLength: number;
}

export interface ParseOptions {
  /** Skip CRC32 validation. Useful for hand-built fixtures and for speed. */
  skipCrc?: boolean;
}

/** Cheap magic-byte sniff. Used by the console detector. */
export function isPonchoRom(data: Uint8Array): boolean {
  return data.length >= 4
      && data[0] === PONCHO_MAGIC[0]
      && data[1] === PONCHO_MAGIC[1]
      && data[2] === PONCHO_MAGIC[2]
      && data[3] === PONCHO_MAGIC[3];
}

/**
 * Decode just the 64-byte header. Validates magic + version + tv_system
 * but does no size or CRC checking — callers (like `parsePonchoRom` or
 * the conversion tool) can inspect the header without allocating the
 * body. Throws `PonchoRomError` on a malformed header.
 */
export function parseHeader(data: Uint8Array): PonchoHeader {
  if (data.length < HEADER_SIZE) {
    throw new PonchoRomError(
      `File too short: ${data.length} bytes (need at least ${HEADER_SIZE} for the header)`,
    );
  }
  if (!isPonchoRom(data)) {
    throw new PonchoRomError('Not a PonchoROM (magic bytes mismatch)');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const version = view.getUint8(0x04);
  if (version !== PONCHO_VERSION) {
    throw new PonchoRomError(
      `Unsupported PonchoROM version: 0x${version.toString(16).padStart(2, '0')}`,
    );
  }

  const flagsByte = view.getUint8(0x05);
  const flags: PonchoFlags = {
    nesCompat:      (flagsByte & 0b0000_0001) !== 0,
    trailerPresent: (flagsByte & 0b0000_0010) !== 0,
  };

  const tvByte = view.getUint8(0x16);
  let tvSystem: TvSystem;
  if      (tvByte === 0) tvSystem = 'ntsc';
  else if (tvByte === 1) tvSystem = 'pal';
  else if (tvByte === 2) tvSystem = 'both';
  else throw new PonchoRomError(`Invalid tv_system value: ${tvByte}`);

  return {
    version,
    flags,
    prgSizeKb:       view.getUint16(0x06, true),
    chrSizeKb:       view.getUint32(0x08, true),
    paletteCount:    view.getUint16(0x0c, true),
    mapperId:        view.getUint16(0x0e, true),
    mapperSubmode:   view.getUint16(0x10, true),
    prgRamKb:        view.getUint16(0x12, true),
    chrRamKb:        view.getUint16(0x14, true),
    tvSystem,
    region:          view.getUint8(0x17),
    crc32:           view.getUint32(0x18, true),
    sourceInesCrc32: view.getUint32(0x1c, true),
    title:           readTitle(data.subarray(0x20, 0x40)),
  };
}

export function parsePonchoRom(
  data: Uint8Array,
  options: ParseOptions = {},
): PonchoRomLayout {
  const header = parseHeader(data);

  const paletteOffset     = HEADER_SIZE;
  const paletteByteLength = header.paletteCount * 4;
  const prgOffset         = paletteOffset + paletteByteLength;
  const prgByteLength     = header.prgSizeKb * 1024;
  const chrOffset         = prgOffset + prgByteLength;
  const chrByteLength     = header.chrSizeKb * 1024;
  const minSize           = chrOffset + chrByteLength;

  if (data.length < minSize) {
    throw new PonchoRomError(
      `File too short: ${data.length} bytes (header declares ${minSize})`,
    );
  }

  let trailerOffset = 0;
  let trailerByteLength = 0;
  if (header.flags.trailerPresent) {
    trailerOffset     = chrOffset + chrByteLength;
    trailerByteLength = data.length - trailerOffset;
  }

  if (!options.skipCrc) {
    const computed = crc32(data.subarray(HEADER_SIZE));
    if (computed !== header.crc32) {
      throw new PonchoRomError(
        `CRC32 mismatch: header declares 0x${header.crc32.toString(16).padStart(8, '0')}, ` +
        `computed 0x${computed.toString(16).padStart(8, '0')}`,
      );
    }
  }

  return {
    header,
    paletteOffset,
    paletteByteLength,
    prgOffset,
    prgByteLength,
    chrOffset,
    chrByteLength,
    trailerOffset,
    trailerByteLength,
  };
}

function readTitle(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder('utf-8').decode(bytes.subarray(0, end));
}
