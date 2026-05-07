/**
 * CNROM-style PonchoMapper variant. PRG fixed (16 KB mirrored or 32 KB
 * straight); the entire $8000-$FFFF range is a write-only bank-select
 * register that picks an 8 KB CHR bank at $0000-$1FFF.
 *
 * Originally CNROM was 2 bits of bank select (max 32 KB CHR); later
 * stretched to 4 or 8 bits. We modulo by the actual bank count.
 *
 * Mirroring is fixed at boot. PRG-RAM at $6000-$7FFF for compatibility
 * with test ROMs that expect work RAM.
 */
import type { Mapper } from '../../cart/mapper';
import type { Mirroring } from '../../cart/ines';

export class PonchoCnromBanking implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper/CNROM-style';

  private readonly chrBankCount: number;
  private chrBank = 0;
  private readonly sram = new Uint8Array(8192);

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
    private readonly chrIsRam: boolean,
    private readonly _mirroring: Mirroring,
  ) {
    this.chrBankCount = Math.max(1, Math.floor(chr.length / 8192));
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000]!;
    if (addr < 0x8000 || this.prg.length === 0) return 0;
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
      return;
    }
    if (addr >= 0x8000) {
      this.chrBank = value % this.chrBankCount;
    }
  }

  ppuRead(addr: number): number {
    if (addr >= 0x2000 || this.chr.length === 0) return 0;
    return this.chr[(this.chrBank * 8192 + (addr & 0x1fff)) % this.chr.length]!;
  }

  ppuWrite(addr: number, value: number): void {
    if (!this.chrIsRam) return;
    if (addr >= 0x2000 || this.chr.length === 0) return;
    this.chr[(this.chrBank * 8192 + (addr & 0x1fff)) % this.chr.length] = value & 0xff;
  }

  mirroring(): Mirroring { return this._mirroring; }

  notifyPpuA12(_level: 0 | 1): void { /* no IRQ */ }
  irqPending(): boolean { return false; }
  irqClear(): void { /* no-op */ }

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }
}
