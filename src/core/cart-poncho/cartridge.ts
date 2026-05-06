/**
 * Poncho-NES cartridge wrapper. Holds the parsed PonchoROM layout, the
 * sliced palette / PRG / CHR buffers, and a constructed mapper. The
 * shape mirrors `src/core/cart/cartridge.ts` (the iNES wrapper) so
 * compositions can treat both consoles uniformly where it matters.
 */

import { parsePonchoRom, type PonchoRomLayout } from './header';
import { PonchoMapper } from '../mappers-poncho/poncho-mapper';
import type { Mapper } from '../cart/mapper';

export class PonchoCartridge {
  readonly layout: PonchoRomLayout;
  readonly palette: Uint8Array;
  readonly prg: Uint8Array;
  readonly chr: Uint8Array;
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
    this.chr = data.subarray(
      this.layout.chrOffset,
      this.layout.chrOffset + this.layout.chrByteLength,
    );
    this.mapper = new PonchoMapper(this.prg, this.chr);
  }
}
