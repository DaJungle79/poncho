import type { InesRom, Mirroring } from '../cart/ines';
import type { Mapper } from '../cart/mapper';

export class Nrom implements Mapper {
  readonly id = 0;
  readonly name = 'NROM';

  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrIsRam: boolean;
  private readonly _mirroring: Mirroring;
  private readonly sram: Uint8Array;

  constructor(rom: InesRom) {
    this.prg = rom.prgRom;
    this.chrIsRam = rom.chrRom.length === 0;
    this.chr = this.chrIsRam ? new Uint8Array(8192) : rom.chrRom;
    this._mirroring = rom.header.mirroring;
    this.sram = new Uint8Array(8192);
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000];
    if (addr >= 0x8000) {
      const offset = (addr - 0x8000) % this.prg.length;
      return this.prg[offset];
    }
    return 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
    }
  }

  ppuRead(addr: number): number {
    return this.chr[addr & 0x1fff];
  }

  ppuWrite(addr: number, value: number): void {
    if (this.chrIsRam) this.chr[addr & 0x1fff] = value & 0xff;
  }

  mirroring(): Mirroring {
    return this._mirroring;
  }

  notifyPpuA12(_level: 0 | 1): void {}
  irqPending(): boolean { return false; }
  irqClear(): void {}

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(data: Uint8Array): void { this.sram.set(data.subarray(0, this.sram.length)); }
}
