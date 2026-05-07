/**
 * UxROM-style PonchoMapper variant. 16 KB switchable PRG bank at
 * $8000-$BFFF; the last 16 KB bank fixed at $C000-$FFFF. Bank-select
 * lives at any write to $8000-$FFFF; the low 4 bits select the bank.
 *
 * Originally UxROM masked the bank to 3 bits (8 banks); UOROM stretched
 * it to 4 bits (16 banks). We modulo by the actual bank count so both
 * sizes work.
 *
 * CHR-RAM by convention; CHR-ROM is rare on UxROM but supported via
 * the cartridge's chr buffer.
 */
import type { Mapper } from '../../cart/mapper';
import type { Mirroring } from '../../cart/ines';

export class PonchoUxromBanking implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper/UxROM-style';

  private readonly prgBankCount: number;
  private bank = 0;
  private readonly sram = new Uint8Array(8192);

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
    private readonly chrIsRam: boolean,
    private readonly _mirroring: Mirroring,
  ) {
    this.prgBankCount = Math.max(1, Math.floor(prg.length / 16384));
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000]!;
    if (addr < 0x8000 || this.prg.length === 0) return 0;
    if (addr < 0xc000) {
      const bank = this.bank % this.prgBankCount;
      return this.prg[bank * 16384 + (addr - 0x8000)] ?? 0;
    }
    return this.prg[(this.prgBankCount - 1) * 16384 + (addr - 0xc000)] ?? 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
      return;
    }
    if (addr >= 0x8000) {
      this.bank = value & 0x0f;
    }
  }

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

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }
}
