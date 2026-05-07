/**
 * Poncho-NES cartridge wrapper. Holds the parsed PonchoROM layout, the
 * sliced palette / PRG / CHR buffers, optionally an allocated CHR-RAM
 * buffer for upscaled-mode cartridges that upload tiles at runtime, and
 * a constructed mapper. Mirrors the shape of `src/core/cart/cartridge.ts`
 * (the iNES wrapper) so compositions can treat both consoles uniformly
 * where it matters.
 *
 * CHR addressing rules (read/write side, set up here so PonchoMapper
 * doesn't have to branch):
 *
 *   - `chrSizeKb > 0, chrRamKb == 0`  → CHR-ROM cartridge. `chr` slices
 *                                       the file; writes are dropped.
 *   - `chrSizeKb == 0, chrRamKb > 0`  → CHR-RAM cartridge. `chr` is a
 *                                       fresh writable buffer; the file
 *                                       carries no CHR bytes.
 *   - both > 0                        → reserved for future split-bank
 *                                       designs; currently treated as
 *                                       CHR-RAM-priority (writable
 *                                       buffer, file CHR ignored — we'll
 *                                       revisit when a real cart needs
 *                                       both).
 */

import { decodeMapperSubmode, parsePonchoRom, type PonchoRomLayout } from './header';
import { PonchoMapper } from '../mappers-poncho/poncho-mapper';
import type { Mapper } from '../cart/mapper';

export class PonchoCartridge {
  readonly layout: PonchoRomLayout;
  readonly palette: Uint8Array;
  readonly prg: Uint8Array;
  /**
   * Active CHR buffer. Either a slice of the file (CHR-ROM) or a
   * freshly-allocated writable buffer (CHR-RAM). Always present —
   * never null, so the mapper / PpuUltra never has to null-check.
   */
  readonly chr: Uint8Array;
  /** True when `chr` is a writable CHR-RAM buffer rather than a file slice. */
  readonly chrIsRam: boolean;
  readonly mapper: Mapper;

  constructor(data: Uint8Array, layout?: PonchoRomLayout) {
    this.layout = layout ?? parsePonchoRom(data);
    this.palette = data.subarray(
      this.layout.paletteOffset,
      this.layout.paletteOffset + this.layout.paletteByteLength,
    );
    this.prg = data.subarray(
      this.layout.prgOffset,
      this.layout.prgOffset + this.layout.prgByteLength,
    );

    const chrRamBytes = this.layout.header.chrRamKb * 1024;
    if (chrRamBytes > 0) {
      this.chr = new Uint8Array(chrRamBytes);
      this.chrIsRam = true;
    } else {
      this.chr = data.subarray(
        this.layout.chrOffset,
        this.layout.chrOffset + this.layout.chrByteLength,
      );
      this.chrIsRam = false;
    }

    const submode = decodeMapperSubmode(this.layout.header.mapperSubmode);
    this.mapper = new PonchoMapper(this.prg, this.chr, {
      writable: this.chrIsRam,
      bankingVariant: submode.bankingVariant,
      bootMirroring: submode.bootMirroring,
    });
  }
}
