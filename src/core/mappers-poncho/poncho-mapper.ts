/**
 * PonchoMapper — stub implementation.
 *
 * Today: flat mirroring of PRG-ROM into $8000-$FFFF; CHR reads/writes
 * are no-ops; no banking; no IRQs. Just enough to let 6502 PRG code
 * fetch from the cartridge.
 *
 * The full PonchoMapper register map (PRG bank @ $8000-$9FFF, CHR bank
 * @ $A000-$BFFF, palette swap @ $C000-$DFFF, mapper config + IRQ @
 * $E000-$FFFF — plus NES-compat sub-mode) is documented in
 * `docs/poncho-rom.md` and grows here as the chip needs it.
 */

import type { Mapper } from '../cart/mapper';
import type { Mirroring } from '../cart/ines';

export class PonchoMapper implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper';

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
  ) {}

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

  ppuWrite(_addr: number, _value: number): void {
    /* no CHR-RAM yet */
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
