/**
 * NROM-style PonchoMapper variant. Flat PRG mirroring across $8000-$FFFF,
 * no banking, no IRQ, mirroring fixed at boot.
 *
 * CHR access goes through the cartridge buffer. Writes are dropped for
 * CHR-ROM cartridges, stored for CHR-RAM.
 */
import type { Mapper } from '../../cart/mapper';
import type { Mirroring } from '../../cart/ines';

export class PonchoNromBanking implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper/NROM-style';

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
    private readonly chrIsRam: boolean,
    private readonly _mirroring: Mirroring,
  ) {}

  cpuRead(addr: number): number {
    if (addr < 0x8000 || this.prg.length === 0) return 0;
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }
  cpuWrite(_addr: number, _value: number): void { /* no banking */ }

  ppuRead(addr: number): number {
    if (addr >= 0x2000 || this.chr.length === 0) return 0;
    return this.chr[addr % this.chr.length]!;
  }
  ppuWrite(addr: number, value: number): void {
    if (!this.chrIsRam) return;
    if (addr >= 0x2000 || this.chr.length === 0) return;
    this.chr[addr % this.chr.length] = value & 0xff;
  }

  mirroring(): Mirroring { return this._mirroring; }

  notifyPpuA12(_level: 0 | 1): void { /* no IRQ */ }
  irqPending(): boolean { return false; }
  irqClear(): void { /* no-op */ }

  getSram(): Uint8Array | null { return null; }
  loadSram(_data: Uint8Array): void { /* no SRAM */ }
}
