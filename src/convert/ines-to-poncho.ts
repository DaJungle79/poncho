/**
 * iNES → PonchoROM (upscaled-mode) conversion. Wraps NES bytes
 * verbatim into a Poncho-NES cartridge that boots through the same
 * runtime as a native PonchoROM:
 *
 *   - PRG copied byte-for-byte. Same 6502 code, no rewriting.
 *   - CHR copied byte-for-byte (or `chrRamKb=8` for CHR-RAM games —
 *     PRG fills the buffer at runtime).
 *   - `flags.upscaledMode = 1`. PpuUltra walks 8×8 2 bpp tiles and
 *     paints each NES pixel as a 4×4 block in the 1024×960 framebuffer.
 *     OAM is interpreted as 64 × 4-byte sprites at 8-bit coords (×4 at
 *     render); $4014 DMA copies 256 bytes.
 *   - `mapperSubmode` encodes which PonchoMapper banking variant to
 *     instantiate. Variants match the iNES mapper numbers for clarity:
 *     NROM(0), MMC1(1), UxROM(2), CNROM(3), MMC3(4), AxROM(7).
 *   - Master palette = canonical 64-entry NES palette.
 *   - `source_ines_crc32` records the original iNES file's CRC32 for
 *     traceability.
 *
 * No PRG rewriting; no CHR upscaling at conversion time. The runtime
 * (PpuUltra + PonchoMapper) does all per-pixel and per-write work
 * natively. Conversion is therefore deterministic, fast, and reversible.
 *
 * Browser-importable so the web shell's "Convert .nes" button can run
 * conversions client-side.
 */

import { parseInes } from '../core/cart/ines';
import { crc32 } from '../core/cart-poncho/crc32';
import {
  encodeMapperSubmode,
  type BankingVariant,
  type BootMirroring,
} from '../core/cart-poncho/header';
import { assemblePonchoRom } from '../core/cart-poncho/writer';
import { NES_MASTER_PALETTE_RGBA } from '../core/ppu-ultra/nes-master-palette';

export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertError';
  }
}

export interface ConvertOptions {
  /** Cartridge title (max 32 UTF-8 bytes). Defaults to empty. */
  title?: string;
}

export interface ConvertNotes {
  sourceMapper: number;
  bankingVariant: BankingVariant;
  sourceMirroring: 'horizontal' | 'vertical' | 'four-screen' | 'single-low' | 'single-high';
  hasBattery: boolean;
  prgKb: number;
  /** CHR-ROM size in KB. Zero for CHR-RAM cartridges. */
  chrKb: number;
  /** CHR-RAM size in KB. 8 for CHR-RAM cartridges, 0 for CHR-ROM. */
  chrRamKb: number;
  paletteEntries: number;
  warnings: string[];
}

export interface ConvertResult {
  poncho: Uint8Array;
  notes: ConvertNotes;
}

/**
 * iNES mapper id → PonchoMapper banking variant. The numbers match by
 * convention so the mapper-submode field reads the same as the source
 * iNES mapper number.
 */
const MAPPER_TO_VARIANT: Record<number, BankingVariant> = {
  0: 0, // NROM
  1: 1, // MMC1
  2: 2, // UxROM
  3: 3, // CNROM
  4: 4, // MMC3
  7: 7, // AxROM
};

const MIRRORING_TO_BOOT: Record<string, BootMirroring> = {
  'horizontal': 0,
  'vertical': 1,
  'four-screen': 2,
};

const SUPPORTED_MAPPER_NAMES = 'NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 (4), AxROM (7)';

export function convertInesToPoncho(
  inesBytes: Uint8Array,
  opts: ConvertOptions = {},
): ConvertResult {
  const ines = parseInes(inesBytes);

  const variant = MAPPER_TO_VARIANT[ines.header.mapper];
  if (variant === undefined) {
    throw new ConvertError(
      `iNES mapper ${ines.header.mapper} is not supported by the PonchoMapper. ` +
      `Supported: ${SUPPORTED_MAPPER_NAMES}.`,
    );
  }

  if (ines.header.hasTrainer) {
    throw new ConvertError('iNES file has a trainer block; not supported.');
  }

  // parseInes synthesises an 8 KB zero buffer for CHR-RAM games; re-check
  // the raw header byte to detect CHR-RAM unambiguously.
  const isChrRam = inesBytes[5] === 0;
  const chr = isChrRam ? new Uint8Array(0) : ines.chrRom;
  const chrRamKb = isChrRam ? 8 : 0;

  const bootMirroring = MIRRORING_TO_BOOT[ines.header.mirroring] ?? 0;

  const warnings: string[] = [];
  if (ines.header.mirroring === 'four-screen' && variant !== 4) {
    warnings.push(
      'Four-screen mirroring requires cart-supplied 4 KB VRAM — PpuUltra ' +
      'currently only handles two physical pages, so wide scrolling may glitch.',
    );
  }

  const sourceCrc = crc32(inesBytes);

  const poncho = assemblePonchoRom({
    title: opts.title?.slice(0, 32) ?? '',
    flags: { upscaledMode: true, trailerPresent: false },
    mapperId: 1,
    mapperSubmode: encodeMapperSubmode({ bankingVariant: variant, bootMirroring }),
    chrRamKb,
    sourceInesCrc32: sourceCrc,
    palette: NES_MASTER_PALETTE_RGBA,
    prg: ines.prgRom,
    chr,
  });

  return {
    poncho,
    notes: {
      sourceMapper: ines.header.mapper,
      bankingVariant: variant,
      sourceMirroring: ines.header.mirroring,
      hasBattery: ines.header.hasBattery,
      prgKb: ines.prgRom.length / 1024,
      chrKb: chr.length / 1024,
      chrRamKb,
      paletteEntries: NES_MASTER_PALETTE_RGBA.length / 4,
      warnings,
    },
  };
}

/** Friendly name for a supported banking variant; used by the CLI + UI. */
export function bankingVariantName(variant: BankingVariant): string {
  switch (variant) {
    case 0: return 'NROM';
    case 1: return 'MMC1';
    case 2: return 'UxROM';
    case 3: return 'CNROM';
    case 4: return 'MMC3';
    case 7: return 'AxROM';
  }
}
