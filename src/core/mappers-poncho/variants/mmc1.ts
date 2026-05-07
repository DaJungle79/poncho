/**
 * MMC1-style PonchoMapper variant. Serial register-loading protocol —
 * five writes to $8000-$FFFF accumulate one bit each (LSB → high end of
 * a 5-bit shift register), with the fifth write committing the value
 * to the register selected by address bits 13-14:
 *
 *   $8000-$9FFF → control       (mirroring + PRG/CHR mode)
 *   $A000-$BFFF → CHR bank 0
 *   $C000-$DFFF → CHR bank 1
 *   $E000-$FFFF → PRG bank
 *
 * Writing any value with bit 7 set immediately resets the shift register
 * and OR's $0C into control (forcing PRG mode 3 — last bank fixed at
 * $C000).
 *
 * Control register:
 *   bits 0-1 mirroring   (0 single-low, 1 single-high, 2 vertical, 3 horiz)
 *   bits 2-3 PRG mode    (0/1 = 32K bank @ $8000;
 *                         2  = first 16K fixed @ $8000, switch @ $C000;
 *                         3  = switch @ $8000, last 16K fixed @ $C000)
 *   bit  4   CHR mode    (0 = single 8K bank, 1 = two 4K banks)
 *
 * 8 KB PRG-RAM at $6000-$7FFF.
 */
import type { Mapper } from '../../cart/mapper';
import type { Mirroring } from '../../cart/ines';

const SHIFT_RESET = 0x10;

export class PonchoMmc1Banking implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper/MMC1-style';

  private readonly prgBankCount: number;
  private readonly sram = new Uint8Array(8192);

  private shift = SHIFT_RESET;
  private control = 0x0c; // boots in PRG mode 3
  private chrBank0 = 0;
  private chrBank1 = 0;
  private prgBank = 0;
  private _mirroring: Mirroring;

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
    private readonly chrIsRam: boolean,
    bootMirroring: Mirroring,
  ) {
    this.prgBankCount = Math.max(1, Math.floor(prg.length / 16384));
    this._mirroring = bootMirroring;
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000]!;
    if (addr >= 0x8000) return this.prg[this.prgOffset(addr)] ?? 0;
    return 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
      return;
    }
    if (addr >= 0x8000) this.serialWrite(addr, value);
  }

  ppuRead(addr: number): number {
    if (addr >= 0x2000 || this.chr.length === 0) return 0;
    return this.chr[this.chrOffset(addr)] ?? 0;
  }

  ppuWrite(addr: number, value: number): void {
    if (!this.chrIsRam) return;
    if (addr >= 0x2000 || this.chr.length === 0) return;
    this.chr[this.chrOffset(addr)] = value & 0xff;
  }

  mirroring(): Mirroring { return this._mirroring; }

  notifyPpuA12(_level: 0 | 1): void { /* no IRQ */ }
  irqPending(): boolean { return false; }
  irqClear(): void { /* no-op */ }

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }

  private serialWrite(addr: number, value: number): void {
    if (value & 0x80) {
      this.shift = SHIFT_RESET;
      this.control |= 0x0c;
      return;
    }
    const ready = (this.shift & 1) !== 0;
    this.shift = (this.shift >>> 1) | ((value & 1) << 4);
    if (ready) {
      const target = (addr >>> 13) & 0x03;
      const data = this.shift & 0x1f;
      switch (target) {
        case 0: this.writeControl(data); break;
        case 1: this.chrBank0 = data; break;
        case 2: this.chrBank1 = data; break;
        case 3: this.prgBank = data & 0x0f; break;
      }
      this.shift = SHIFT_RESET;
    }
  }

  private writeControl(data: number): void {
    this.control = data;
    switch (data & 0x03) {
      case 0: this._mirroring = 'single-low'; break;
      case 1: this._mirroring = 'single-high'; break;
      case 2: this._mirroring = 'vertical'; break;
      case 3: this._mirroring = 'horizontal'; break;
    }
  }

  private prgOffset(addr: number): number {
    const offset = addr - 0x8000;
    const mode = (this.control >>> 2) & 0x03;
    switch (mode) {
      case 0:
      case 1: {
        const bank = this.prgBank & 0x0e;
        return ((bank * 16384) + offset) % this.prg.length;
      }
      case 2: {
        if (offset < 0x4000) return offset;
        return ((this.prgBank * 16384) + (offset - 0x4000)) % this.prg.length;
      }
      case 3:
      default: {
        if (offset < 0x4000) return ((this.prgBank * 16384) + offset) % this.prg.length;
        return ((this.prgBankCount - 1) * 16384) + (offset - 0x4000);
      }
    }
  }

  private chrOffset(addr: number): number {
    const offset = addr & 0x1fff;
    const mode = (this.control >>> 4) & 0x01;
    if (mode === 0) {
      const bank = this.chrBank0 & 0x1e;
      return ((bank * 4096) + offset) % this.chr.length;
    }
    if (offset < 0x1000) {
      return ((this.chrBank0 * 4096) + offset) % this.chr.length;
    }
    return ((this.chrBank1 * 4096) + (offset - 0x1000)) % this.chr.length;
  }
}
