/**
 * PonchoMapper — stub implementation.
 *
 * Today: flat mirroring of PRG-ROM into $8000-$FFFF; CHR reads pass
 * through to the cartridge buffer; CHR writes land in CHR-RAM when the
 * cartridge declares one. No banking, no IRQs — those land in Phases
 * 2, 4, 8 of the v0.3.0 plan as banking variants are wired in.
 *
 * The full PonchoMapper register map (PRG bank @ $8000-$9FFF, CHR bank
 * @ $A000-$BFFF, palette swap @ $C000-$DFFF, mapper config + IRQ @
 * $E000-$FFFF) is documented in `docs/poncho-rom.md` and grows here as
 * the chip needs it.
 */

import type { Mapper } from '../cart/mapper';
import type { Mirroring } from '../cart/ines';

export interface PonchoMapperOptions {
  /** True when `chr` is CHR-RAM (writable). False for CHR-ROM (writes dropped). */
  writable?: boolean;
}

export class PonchoMapper implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper';

  private readonly chrWritable: boolean;

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
    options: PonchoMapperOptions = {},
  ) {
    this.chrWritable = options.writable === true;
  }

  cpuRead(addr: number): number {
    if (addr < 0x8000) return 0;
    if (this.prg.length === 0) return 0;
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }

  cpuWrite(_addr: number, _value: number): void {
    /* no banking yet */
  }

  ppuRead(addr: number): number {
    if (addr >= 0x2000 || this.chr.length === 0) return 0;
    return this.chr[addr % this.chr.length]!;
  }

  ppuWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    if (addr >= 0x2000 || this.chr.length === 0) return;
    this.chr[addr % this.chr.length] = value & 0xff;
  }

  mirroring(): Mirroring {
    return 'horizontal';
  }

  notifyPpuA12(_level: 0 | 1): void {
    /* no IRQ counter yet */
  }

  irqPending(): boolean {
    return false;
  }

  irqClear(): void {
    /* no-op */
  }

  getSram(): Uint8Array | null {
    return null;
  }

  loadSram(_data: Uint8Array): void {
    /* no SRAM */
  }
}
