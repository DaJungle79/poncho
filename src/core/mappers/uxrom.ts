/**
 * UxROM — iNES mapper 2.
 *
 * The "U" comes from the discrete-logic chip designation (UNROM/UOROM).
 * Used by Castlevania, Mega Man, Duck Tales, Contra, and several hundred
 * other titles. One of the simpler bank-switchers:
 *
 *   $6000-$7FFF   8 KiB PRG-RAM (some carts) — we always provide it for
 *                 compatibility with test ROMs that expect work RAM.
 *   $8000-$BFFF   16 KiB PRG bank — switchable via writes to any
 *                 address in $8000-$FFFF. The low bits select the bank.
 *   $C000-$FFFF   16 KiB PRG bank — fixed to the last bank in ROM.
 *
 * CHR is RAM (8 KiB) — no CHR-ROM banks. Mirroring is hardwired by the
 * iNES header (no mapper register controls it).
 *
 * Reference: nesdev wiki "UxROM".
 */
import type { InesRom, Mirroring } from '../cart/ines';
import type { Mapper } from '../cart/mapper';

export class Uxrom implements Mapper {
  readonly id = 2;
  readonly name = 'UxROM';

  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly _mirroring: Mirroring;
  private readonly prgBankCount: number;
  private readonly sram = new Uint8Array(8192);

  /** Currently selected PRG bank (0..15) for the $8000-$BFFF window. */
  private bank = 0;

  constructor(rom: InesRom) {
    this.prg = rom.prgRom;
    // CHR-ROM is rare on UxROM; default to 8 KiB CHR-RAM.
    this.chr = rom.chrRom.length === 0 ? new Uint8Array(8192) : rom.chrRom;
    this._mirroring = rom.header.mirroring;
    this.prgBankCount = Math.max(1, Math.floor(rom.prgRom.length / 16384));
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000];
    if (addr >= 0x8000 && addr < 0xc000) {
      const bank = this.bank % this.prgBankCount;
      return this.prg[bank * 16384 + (addr - 0x8000)];
    }
    if (addr >= 0xc000) {
      // Fixed last 16K bank.
      return this.prg[(this.prgBankCount - 1) * 16384 + (addr - 0xc000)];
    }
    return 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
      return;
    }
    if (addr >= 0x8000) {
      // Bank select. Original UxROM uses the low 3 bits; UOROM uses 4.
      // We mask by (count - 1) only when the count is a power of two; the
      // safer fallback is `value % count` in cpuRead.
      this.bank = value & 0x0f;
    }
  }

  ppuRead(addr: number): number { return this.chr[addr & 0x1fff]; }
  ppuWrite(addr: number, value: number): void { this.chr[addr & 0x1fff] = value & 0xff; }

  mirroring(): Mirroring { return this._mirroring; }

  notifyPpuA12(_l: 0 | 1): void {}
  irqPending(): boolean { return false; }
  irqClear(): void {}

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }
}
