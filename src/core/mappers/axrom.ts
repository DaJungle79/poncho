/**
 * AxROM — iNES mapper 7.
 *
 * Used by Battletoads, Marble Madness, RC Pro-Am, Solstice, and ~75
 * commercial titles. Two distinguishing features over UxROM:
 *   - 32-KiB PRG bank covering the *entire* $8000-$FFFF (not split).
 *   - Mirroring is *programmable* per write: bit 4 of the bank-select
 *     byte selects single-screen-low (0) or single-screen-high (1).
 *     There is no horizontal/vertical mode here.
 *
 * Memory map:
 *   $6000-$7FFF   PRG-RAM (8 KiB) — included for compatibility, even
 *                 though most AxROM cartridges had no work RAM.
 *   $8000-$FFFF   32 KiB PRG bank — switchable.
 *   $0000-$1FFF   CHR-RAM (8 KiB).
 *
 * Bank-select byte ($8000-$FFFF):
 *   bits 0-2: PRG bank index (0..7 → up to 256 KiB PRG)
 *   bit  4  : nametable mirroring (0 = single-low, 1 = single-high)
 *
 * Reference: nesdev wiki "AxROM".
 */
import type { InesRom, Mirroring } from '../cart/ines';
import type { Mapper } from '../cart/mapper';

export class Axrom implements Mapper {
  readonly id = 7;
  readonly name = 'AxROM';

  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly sram = new Uint8Array(8192);
  private readonly prgBankCount32k: number;

  /** Currently selected 32-KiB PRG bank (low 3 bits of last write). */
  private bank = 0;
  /** Active single-screen mirroring (toggled via bit 4 of bank-select). */
  private mirror: Mirroring = 'single-low';

  constructor(rom: InesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom.length === 0 ? new Uint8Array(8192) : rom.chrRom;
    this.prgBankCount32k = Math.max(1, Math.floor(rom.prgRom.length / 32768));
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000];
    if (addr >= 0x8000) {
      const bank = this.bank % this.prgBankCount32k;
      return this.prg[bank * 32768 + (addr - 0x8000)];
    }
    return 0;
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

  ppuRead(addr: number): number { return this.chr[addr & 0x1fff]; }
  ppuWrite(addr: number, value: number): void { this.chr[addr & 0x1fff] = value & 0xff; }

  mirroring(): Mirroring { return this.mirror; }

  notifyPpuA12(_l: 0 | 1): void {}
  irqPending(): boolean { return false; }
  irqClear(): void {}

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }
}
