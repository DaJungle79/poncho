/**
 * AxROM-style PonchoMapper variant. 32 KB switchable PRG bank covers
 * the entire $8000-$FFFF window (no fixed bank). Mirroring is
 * runtime-controlled per write: bit 4 of the bank-select byte picks
 * single-screen-low (0) or single-screen-high (1).
 *
 * Bank-select byte ($8000-$FFFF):
 *   bits 0-2: PRG bank (up to 256 KB PRG)
 *   bit  4 : nametable single-low/single-high
 *
 * 8 KB PRG-RAM at $6000-$7FFF for compatibility.
 */
import type { Mapper } from '../../cart/mapper';
import type { Mirroring } from '../../cart/ines';

export class PonchoAxromBanking implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper/AxROM-style';

  private readonly prgBankCount32k: number;
  private bank = 0;
  private mirror: Mirroring;
  private readonly sram = new Uint8Array(8192);

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
    private readonly chrIsRam: boolean,
    bootMirroring: Mirroring,
  ) {
    this.prgBankCount32k = Math.max(1, Math.floor(prg.length / 32768));
    // AxROM is single-screen-only; default to the boot mirroring if it's
    // single-screen, otherwise 'single-low' (the chip's reset state).
    this.mirror = bootMirroring === 'single-high' ? 'single-high' : 'single-low';
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000]!;
    if (addr < 0x8000 || this.prg.length === 0) return 0;
    const bank = this.bank % this.prgBankCount32k;
    return this.prg[bank * 32768 + (addr - 0x8000)] ?? 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
      return;
    }
    if (addr >= 0x8000) {
      this.bank = value & 0x07;
      this.mirror = (value & 0x10) ? 'single-high' : 'single-low';
    }
  }

  ppuRead(addr: number): number {
    if (addr >= 0x2000 || this.chr.length === 0) return 0;
    return this.chr[addr & 0x1fff]!;
  }
  ppuWrite(addr: number, value: number): void {
    if (!this.chrIsRam) return;
    if (addr >= 0x2000 || this.chr.length === 0) return;
    this.chr[addr & 0x1fff] = value & 0xff;
  }

  mirroring(): Mirroring { return this.mirror; }

  notifyPpuA12(_level: 0 | 1): void { /* no IRQ */ }
  irqPending(): boolean { return false; }
  irqClear(): void { /* no-op */ }

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }
}
