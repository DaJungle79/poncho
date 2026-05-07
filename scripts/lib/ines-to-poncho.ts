/**
 * iNES → PonchoROM conversion. Pure function; no I/O.
 *
 * Mechanical conversion per `docs/poncho-rom.md` §134:
 *   - PRG-ROM copied verbatim.
 *   - CHR-ROM expanded from 8×8 2 bpp tiles to 32×32 8 bpp tiles via
 *     4×4 nearest-neighbour pixel replication. Pixel values 0–3 are
 *     preserved, so the same NES sub-palette indices apply.
 *   - Master palette = canonical NES master palette (64 RGBA entries).
 *   - Header records the source iNES CRC32 for traceability.
 *
 * **Mapper coverage.** v1 of the PonchoMapper does flat PRG mirroring
 * with no banking, so this converter currently rejects anything but
 * NROM (mapper 0). Other mappers will be unlocked as the PonchoMapper
 * grows native equivalents of MMC1/UxROM/CNROM/MMC3/AxROM banking.
 *
 * **Other runtime gaps the converter does NOT compensate for** (these
 * need fixes in `PpuUltra` / `PonchoMapper`, not in the converter):
 *   - OAM layout: NES OAM is 4 bytes/sprite + 256-byte DMA; PpuUltra
 *     expects 8 bytes/sprite + 512-byte DMA. Sprites in converted
 *     ROMs will not render correctly until a translation shim lands.
 *   - Sprite coords are 8-bit on the NES (256×240) but the PpuUltra
 *     framebuffer is 1024×960 — sprite positions need a ×4 scale.
 *   - PpuUltra renders from a single nametable ($2000); horizontal /
 *     vertical mirroring of the second nametable is not implemented.
 *   - Sprite-0 hit, per-scanline mid-frame palette/scroll changes,
 *     8×16 sprite mode are not implemented.
 *
 * The converted ROM is still a valid PonchoROM that loads and renders
 * its background; the gaps above show up as missing/glitched sprites
 * and scrolling artifacts. Iterating on those is the point of using
 * this tool.
 */

import { parseInes, type InesRom } from '../../src/core/cart/ines';
import { crc32 } from '../../src/core/cart-poncho/crc32';
import { assemblePonchoRom } from '../../src/core/cart-poncho/writer';
import { NES_MASTER_PALETTE_RGBA } from '../../src/core/ppu-ultra/nes-master-palette';

export interface ConvertOptions {
  /** Cartridge title (max 32 UTF-8 bytes). Defaults to empty. */
  title?: string;
}

export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertError';
  }
}

export interface ConvertResult {
  poncho: Uint8Array;
  /** Diagnostic info — what we kept, what we dropped, what's pending. */
  notes: ConvertNotes;
}

export interface ConvertNotes {
  sourceMapper: number;
  sourceMirroring: InesRom['header']['mirroring'];
  hasBattery: boolean;
  prgKb: number;
  chrKbSource: number;
  chrKbExpanded: number;
  paletteEntries: number;
  warnings: string[];
}

/** NES tile in CHR is 8×8 px, 2 bpp planar = 16 bytes. */
const NES_TILE_BYTES = 16;
/** Poncho tile is 32×32 px, 8 bpp linear = 1024 bytes. */
const PONCHO_TILE_BYTES = 1024;
const PONCHO_TILE_PX = 32;
/** 4× linear scale: each NES pixel becomes a 4×4 block in the Poncho tile. */
const SCALE = 4;

export function convertInesToPoncho(
  inesBytes: Uint8Array,
  opts: ConvertOptions = {},
): ConvertResult {
  const ines = parseInes(inesBytes);

  if (ines.header.mapper !== 0) {
    throw new ConvertError(
      `Mapper ${ines.header.mapper} not yet supported by the PonchoMapper. ` +
      `v1 supports NROM (mapper 0) only.`,
    );
  }
  // parseInes synthesises an 8 KB zero buffer for CHR-RAM games (when
  // chrRomBanks is 0), so we re-check the raw header byte to detect them.
  if (inesBytes[5] === 0) {
    throw new ConvertError(
      'iNES file declares 0 CHR-ROM banks (CHR-RAM game). ' +
      'CHR-RAM is not supported by the PonchoMapper stub.',
    );
  }
  if (ines.header.hasTrainer) {
    throw new ConvertError(
      'iNES file has a trainer block. Trainers are not supported.',
    );
  }

  const warnings: string[] = [];
  if (ines.header.mirroring === 'four-screen') {
    warnings.push(
      'Source uses four-screen mirroring; PpuUltra is single-screen — ' +
      'multi-nametable scrolling will glitch.',
    );
  } else if (ines.header.mirroring === 'vertical') {
    warnings.push(
      'Source uses vertical mirroring; PpuUltra renders from a single ' +
      'nametable — horizontally scrolling games will tile incorrectly.',
    );
  }

  const prg = ines.prgRom;
  if (prg.length % 1024 !== 0) {
    // NROM PRG is always 16 KB or 32 KB so this should never trip; left
    // as a guard for future mappers.
    throw new ConvertError(`PRG-ROM size ${prg.length} is not a multiple of 1024`);
  }

  const chr = expandNesChrToPoncho(ines.chrRom);

  const sourceCrc = crc32(inesBytes);

  const poncho = assemblePonchoRom({
    title: opts.title?.slice(0, 32) ?? '',
    flags: { upscaledMode: false, trailerPresent: false },
    mapperId: 1,
    mapperSubmode: 0,
    tvSystem: 'ntsc',
    sourceInesCrc32: sourceCrc,
    palette: NES_MASTER_PALETTE_RGBA,
    prg,
    chr,
  });

  return {
    poncho,
    notes: {
      sourceMapper: ines.header.mapper,
      sourceMirroring: ines.header.mirroring,
      hasBattery: ines.header.hasBattery,
      prgKb: prg.length / 1024,
      chrKbSource: ines.chrRom.length / 1024,
      chrKbExpanded: chr.length / 1024,
      paletteEntries: NES_MASTER_PALETTE_RGBA.length / 4,
      warnings,
    },
  };
}

/**
 * Expand a buffer of NES CHR (8×8 2 bpp planar tiles) into Poncho CHR
 * (32×32 8 bpp linear tiles) via 4×4 nearest-neighbour replication.
 *
 * NES tile encoding: bytes 0–7 = bitplane 0 (one row each, MSB = leftmost
 * pixel). Bytes 8–15 = bitplane 1, same layout. Pixel value at (x, y) =
 * `bit(plane0[y], 7 - x) | (bit(plane1[y], 7 - x) << 1)`. Result is in 0–3.
 *
 * Poncho tile: row-major 8 bpp, byte at offset `row * 32 + col`.
 */
export function expandNesChrToPoncho(nesChr: Uint8Array): Uint8Array {
  if (nesChr.length % NES_TILE_BYTES !== 0) {
    throw new ConvertError(
      `CHR-ROM size ${nesChr.length} is not a multiple of ${NES_TILE_BYTES} (NES tile size)`,
    );
  }
  const tileCount = nesChr.length / NES_TILE_BYTES;
  const out = new Uint8Array(tileCount * PONCHO_TILE_BYTES);

  for (let t = 0; t < tileCount; t++) {
    const srcBase = t * NES_TILE_BYTES;
    const dstBase = t * PONCHO_TILE_BYTES;
    for (let y = 0; y < 8; y++) {
      const plane0 = nesChr[srcBase + y]!;
      const plane1 = nesChr[srcBase + 8 + y]!;
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x;
        const pv = ((plane0 >> bit) & 1) | (((plane1 >> bit) & 1) << 1);
        // Replicate pv into the SCALE×SCALE block at (x*SCALE, y*SCALE)
        // in the Poncho tile.
        const dy0 = y * SCALE;
        const dx0 = x * SCALE;
        for (let dy = 0; dy < SCALE; dy++) {
          const rowOff = dstBase + (dy0 + dy) * PONCHO_TILE_PX + dx0;
          // Inline 4-byte fill is hotter than `fill()` for tiny ranges.
          out[rowOff + 0] = pv;
          out[rowOff + 1] = pv;
          out[rowOff + 2] = pv;
          out[rowOff + 3] = pv;
        }
      }
    }
  }

  return out;
}
