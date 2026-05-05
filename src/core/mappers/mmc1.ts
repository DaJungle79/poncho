/**
 * MMC1 — iNES mapper 1.
 *
 * MMC1 was Nintendo's first big bank-switcher (Zelda, Metroid, Castlevania II,
 * Final Fantasy, Mega Man 2, etc.). It exposes four 5-bit registers, all of
 * which are loaded *serially* through any write to $8000-$FFFF.
 *
 * Serial protocol:
 *   The chip has a 5-bit shift register seeded with `0b10000`. Each CPU
 *   write to $8000-$FFFF feeds bit 0 of the value into the high end of the
 *   shift register. The low bit of the shift register being set means the
 *   register is "full" (5 writes done): on that fifth write, the accumulated
 *   value is committed to the register chosen by bits 13-14 of the address:
 *
 *     $8000-$9FFF → control
 *     $A000-$BFFF → CHR bank 0
 *     $C000-$DFFF → CHR bank 1
 *     $E000-$FFFF → PRG bank
 *
 *   Writing any value with bit 7 set immediately resets the shift register
 *   *and* forces PRG mode 3 (the most common boot configuration).
 *
 * Control register layout (5 bits):
 *   bits 0-1  Mirroring   (0 single-low, 1 single-high, 2 vertical, 3 horizontal)
 *   bits 2-3  PRG mode    (0,1 = 32K bank at $8000;
 *                          2  = first 16K fixed at $8000, switch at $C000;
 *                          3  = switch at $8000, last 16K fixed at $C000)
 *   bit  4    CHR mode    (0 = single 8K bank, 1 = two 4K banks)
 *
 * Other notes:
 *   - 8 KiB of PRG-RAM at $6000-$7FFF (battery-backed in many carts).
 *   - CHR may be ROM or 8 KiB of RAM (when the iNES header reports 0 banks).
 *   - In 8K CHR mode the low bit of CHR bank 0 is masked off.
 *   - In 32K PRG mode the low bit of PRG bank is masked off.
 *
 * Reference: nesdev wiki "MMC1".
 */
import type { InesRom, Mirroring } from '../cart/ines';
import type { Mapper } from '../cart/mapper';

const SHIFT_RESET = 0x10;

export class Mmc1 implements Mapper {
  readonly id = 1;
  readonly name = 'MMC1';

  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrIsRam: boolean;
  private readonly sram = new Uint8Array(8192);
  private readonly prgBankCount: number;

  // Serial shift register. Starts "empty" with bit 4 set; once bit 0 is set
  // (i.e. shifted right 4 times) the next write commits the value.
  private shift = SHIFT_RESET;

  // Control register (default boots PRG mode 3 = last bank fixed at $C000).
  private control = 0x0c;
  private chrBank0 = 0;
  private chrBank1 = 0;
  private prgBank = 0;

  private _mirroring: Mirroring;

  constructor(rom: InesRom) {
    this.prg = rom.prgRom;
    this.chrIsRam = rom.chrRom.length === 0;
    this.chr = this.chrIsRam ? new Uint8Array(8192) : rom.chrRom;
    this.prgBankCount = Math.max(1, Math.floor(rom.prgRom.length / 16384));
    this._mirroring = rom.header.mirroring;
  }

  // ----- CPU side -----------------------------------------------------------

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) return this.sram[addr - 0x6000];
    if (addr >= 0x8000) return this.prg[this.prgOffset(addr)];
    return 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.sram[addr - 0x6000] = value & 0xff;
      return;
    }
    if (addr >= 0x8000) {
      this.serialWrite(addr, value);
    }
  }

  // ----- PPU side -----------------------------------------------------------

  ppuRead(addr: number): number {
    return this.chr[this.chrOffset(addr)];
  }

  ppuWrite(addr: number, value: number): void {
    if (this.chrIsRam) this.chr[this.chrOffset(addr)] = value & 0xff;
  }

  mirroring(): Mirroring { return this._mirroring; }

  notifyPpuA12(_level: 0 | 1): void {}
  irqPending(): boolean { return false; }
  irqClear(): void {}

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(data: Uint8Array): void { this.sram.set(data.subarray(0, this.sram.length)); }

  // ----- Serial register protocol -------------------------------------------

  /**
   * Process a write to $8000-$FFFF. If bit 7 is set, reset the shift
   * register and force PRG mode 3. Otherwise feed bit 0 into the shift
   * register; on the fifth bit, commit the accumulated 5-bit value to the
   * register selected by the address.
   */
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

  // ----- Bank-offset math ---------------------------------------------------

  /** Translate a CPU address $8000-$FFFF to a byte offset into PRG ROM. */
  private prgOffset(addr: number): number {
    const offset = addr - 0x8000;
    const mode = (this.control >>> 2) & 0x03;
    switch (mode) {
      case 0:
      case 1: {
        // 32K mode: ignore the low bit of prgBank, swap a 32K window in at $8000.
        const bank = this.prgBank & 0x0e;
        return ((bank * 16384) + offset) % this.prg.length;
      }
      case 2: {
        // First 16K fixed at $8000; switch the second 16K via prgBank.
        if (offset < 0x4000) return offset;
        return ((this.prgBank * 16384) + (offset - 0x4000)) % this.prg.length;
      }
      case 3:
      default: {
        // Switch the first 16K via prgBank; last 16K fixed at $C000.
        if (offset < 0x4000) return ((this.prgBank * 16384) + offset) % this.prg.length;
        return ((this.prgBankCount - 1) * 16384) + (offset - 0x4000);
      }
    }
  }

  /** Translate a PPU address $0000-$1FFF to a byte offset into CHR. */
  private chrOffset(addr: number): number {
    const offset = addr & 0x1fff;
    const mode = (this.control >>> 4) & 0x01;
    if (mode === 0) {
      // 8K mode: drop the low bit of chrBank0, take a contiguous 8K window.
      const bank = this.chrBank0 & 0x1e;
      return ((bank * 4096) + offset) % this.chr.length;
    }
    if (offset < 0x1000) {
      return ((this.chrBank0 * 4096) + offset) % this.chr.length;
    }
    return ((this.chrBank1 * 4096) + (offset - 0x1000)) % this.chr.length;
  }
}
