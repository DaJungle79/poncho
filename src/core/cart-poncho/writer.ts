/**
 * PonchoROM assembler. Inverse of `parsePonchoRom`. Used by the
 * synthetic-ROM generators (`scripts/gen-poncho-rom/`) and, later,
 * by the iNES → PonchoROM conversion tool.
 *
 * The caller supplies the raw bytes for each section (palette, PRG,
 * CHR, optional trailer) plus header metadata. The assembler computes
 * everything else: section sizes, palette count, body CRC32, default
 * field values.
 */

import { aiCacheSectionLength, writeAiCacheSection, type AiCacheSection } from './ai-cache';
import { crc32 } from './crc32';
import {
  HEADER_SIZE,
  PONCHO_MAGIC,
  PONCHO_VERSION,
  type PonchoFlags,
  type TvSystem,
} from './header';

export class PonchoWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PonchoWriterError';
  }
}

export interface AssembleParts {
  flags?: PonchoFlags;
  mapperId?: number;
  mapperSubmode?: number;
  prgRamKb?: number;
  chrRamKb?: number;
  tvSystem?: TvSystem;
  region?: number;
  sourceInesCrc32?: number;
  /** Up to 32 bytes when UTF-8 encoded. */
  title?: string;

  /** Master palette, flat RGBA. Length must be a multiple of 4. */
  palette: Uint8Array;
  /** PRG-ROM. Length must be a multiple of 1024. */
  prg: Uint8Array;
  /** CHR-ROM. Length must be a multiple of 1024. */
  chr: Uint8Array;
  /**
   * Optional AI cache section. When provided, sets `flags.aiCachePresent`
   * and writes the serialised section between CHR and trailer. Each
   * entry in the section is 1056 bytes (16-byte hash + 16-byte NES tile +
   * 1024-byte upscaled tile) — see `ai-cache.ts`.
   */
  aiCache?: AiCacheSection;
  /** Optional trailer block. Implies `flags.trailerPresent` if present. */
  trailer?: Uint8Array;
}

/**
 * Build a flat RGBA palette buffer from `[r, g, b, a?]` tuples. Alpha
 * defaults to 0xFF (opaque) when omitted.
 */
export function makePalette(
  entries: ReadonlyArray<readonly [number, number, number, number?]>,
): Uint8Array {
  const buf = new Uint8Array(entries.length * 4);
  for (let i = 0; i < entries.length; i++) {
    const [r, g, b, a = 0xff] = entries[i]!;
    buf[i * 4 + 0] = r & 0xff;
    buf[i * 4 + 1] = g & 0xff;
    buf[i * 4 + 2] = b & 0xff;
    buf[i * 4 + 3] = a & 0xff;
  }
  return buf;
}

export function assemblePonchoRom(parts: AssembleParts): Uint8Array {
  if (parts.palette.length % 4 !== 0) {
    throw new PonchoWriterError(
      `palette length must be a multiple of 4 (got ${parts.palette.length})`,
    );
  }
  if (parts.prg.length % 1024 !== 0) {
    throw new PonchoWriterError(
      `PRG length must be a multiple of 1024 (got ${parts.prg.length})`,
    );
  }
  if (parts.chr.length % 1024 !== 0) {
    throw new PonchoWriterError(
      `CHR length must be a multiple of 1024 (got ${parts.chr.length})`,
    );
  }

  const titleBytes = parts.title ? new TextEncoder().encode(parts.title) : new Uint8Array(0);
  if (titleBytes.length > 32) {
    throw new PonchoWriterError(
      `title is ${titleBytes.length} UTF-8 bytes, max 32`,
    );
  }

  const paletteCount = parts.palette.length / 4;
  const prgSizeKb    = parts.prg.length / 1024;
  const chrSizeKb    = parts.chr.length / 1024;
  const trailer      = parts.trailer ?? new Uint8Array(0);
  const trailerPresent = trailer.length > 0 || parts.flags?.trailerPresent === true;

  // AI cache section: serialise once up-front so we know its size.
  const aiCacheBytes = parts.aiCache
    ? writeAiCacheSection(parts.aiCache)
    : new Uint8Array(0);
  const aiCachePresent = aiCacheBytes.length > 0 || parts.flags?.aiCachePresent === true;
  if (aiCachePresent && aiCacheBytes.length === 0) {
    throw new PonchoWriterError('flags.aiCachePresent set but no aiCache section provided');
  }
  if (parts.aiCache && aiCacheBytes.length !== aiCacheSectionLength(parts.aiCache.entries.length)) {
    // Defensive — writeAiCacheSection should always produce the canonical size.
    throw new PonchoWriterError(
      `AI cache section size mismatch (got ${aiCacheBytes.length} bytes)`,
    );
  }

  if (paletteCount > 0xffff) {
    throw new PonchoWriterError(`palette has ${paletteCount} entries, max 65535`);
  }
  if (prgSizeKb > 0xffff) {
    throw new PonchoWriterError(`PRG is ${prgSizeKb} KB, max 65535 KB`);
  }
  if (chrSizeKb > 0xffffffff) {
    throw new PonchoWriterError(`CHR is ${chrSizeKb} KB, max 4294967295 KB`);
  }

  const totalSize =
    HEADER_SIZE +
    parts.palette.length +
    parts.prg.length +
    parts.chr.length +
    aiCacheBytes.length +
    trailer.length;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  // Magic
  out[0] = PONCHO_MAGIC[0];
  out[1] = PONCHO_MAGIC[1];
  out[2] = PONCHO_MAGIC[2];
  out[3] = PONCHO_MAGIC[3];

  view.setUint8(0x04, PONCHO_VERSION);
  view.setUint8(
    0x05,
    (parts.flags?.upscaledMode ? 0b001 : 0) |
    (trailerPresent             ? 0b010 : 0) |
    (aiCachePresent             ? 0b100 : 0),
  );
  view.setUint16(0x06, prgSizeKb, true);
  view.setUint32(0x08, chrSizeKb, true);
  view.setUint16(0x0c, paletteCount, true);
  view.setUint16(0x0e, parts.mapperId ?? 1, true);
  view.setUint16(0x10, parts.mapperSubmode ?? 0, true);
  view.setUint16(0x12, parts.prgRamKb ?? 0, true);
  view.setUint16(0x14, parts.chrRamKb ?? 0, true);
  view.setUint8(0x16, encodeTvSystem(parts.tvSystem ?? 'ntsc'));
  view.setUint8(0x17, parts.region ?? 0);
  // crc32 written below after body is laid down
  view.setUint32(0x1c, parts.sourceInesCrc32 ?? 0, true);
  out.set(titleBytes, 0x20);

  // Body — order matches the file format: palette, PRG, CHR, AI cache, trailer.
  let cursor = HEADER_SIZE;
  out.set(parts.palette, cursor);   cursor += parts.palette.length;
  out.set(parts.prg, cursor);       cursor += parts.prg.length;
  out.set(parts.chr, cursor);       cursor += parts.chr.length;
  if (aiCacheBytes.length > 0) {
    out.set(aiCacheBytes, cursor);  cursor += aiCacheBytes.length;
  }
  if (trailer.length > 0) out.set(trailer, cursor);

  // Body CRC
  view.setUint32(0x18, crc32(out.subarray(HEADER_SIZE)), true);

  return out;
}

function encodeTvSystem(tv: TvSystem): number {
  if (tv === 'ntsc') return 0;
  if (tv === 'pal')  return 1;
  if (tv === 'both') return 2;
  throw new PonchoWriterError(`Invalid tv_system: ${tv as string}`);
}
