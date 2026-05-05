/**
 * CNROM — iNES mapper 3.
 *
 * The simplest of the bank-switching cartridges. PRG ROM is fixed (16 KiB
 * mirrored or 32 KiB straight) and the only programmable feature is the CHR
 * bank: the entire $8000-$FFFF range is a write-only bank-select register
 * whose low bits choose which 8 KiB of CHR ROM is exposed at $0000-$1FFF.
 *
 * Originally the bank-select was 2 bits (max 32 KiB CHR), but later carts
 * stretched it to 4 or 8 bits. We modulo by the actual CHR-bank count to
 * support both.
 *
 * Mirroring is fixed by the iNES header — CNROM has no on-board mirror
 * control. PRG-RAM at $6000-$7FFF is included so blargg-style test ROMs
 * (which all expect 8 KiB of work RAM) function correctly.
 *
 * Reference: nesdev wiki "CNROM".
 */
import type { InesRom, Mirroring } from '../cart/ines';
import type { Mapper } from '../cart/mapper';

export class Cnrom implements Mapper {
  readonly id = 3;
  readonly name = 'CNROM';

  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrIsRam: boolean;
  private readonly _mirroring: Mirroring;
  private readonly chrBankCount: number;
  private readonly sram = new Uint8Array(8192);
  private chrBank = 0;

  constructor(rom: InesRom) {
    this.prg = rom.prgRom;
    this.chrIsRam = rom.chrRom.length === 0;
    this.chr = this.chrIsRam ? new Uint8Array(8192) : rom.chrRom;
    this._mirroring = rom.header.mirroring;
    this.chrBankCount = Math.max(1, Math.floor(this.chr.length / 8192));
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000];
    if (addr >= 0x8000) return this.prg[(addr - 0x8000) % this.prg.length];
    return 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
      return;
    }
    if (addr >= 0x8000) {
      // Bank select. Only the low bits matter; we modulo by the number of
      // banks we actually have so partial-mask writes still resolve.
      this.chrBank = value % this.chrBankCount;
    }
  }

  ppuRead(addr: number): number {
    return this.chr[(this.chrBank * 8192 + (addr & 0x1fff)) % this.chr.length];
  }

  ppuWrite(addr: number, value: number): void {
    if (this.chrIsRam) {
      this.chr[(this.chrBank * 8192 + (addr & 0x1fff)) % this.chr.length] = value & 0xff;
    }
  }

  mirroring(): Mirroring { return this._mirroring; }

  notifyPpuA12(_level: 0 | 1): void {}
  irqPending(): boolean { return false; }
  irqClear(): void {}

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(data: Uint8Array): void { this.sram.set(data.subarray(0, this.sram.length)); }
}
