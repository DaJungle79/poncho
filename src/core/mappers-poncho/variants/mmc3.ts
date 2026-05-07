/**
 * MMC3-style PonchoMapper variant. PRG/CHR banking with sub-1-KB CHR
 * granularity and a scanline-rate IRQ counter driven by filtered PPU
 * A12 transitions.
 *
 * Register map (mirror within $8000-$FFFF based on bit 0 of address):
 *
 *   $8000 (even)  Bank Select
 *                 bits 0-2: which R0-R7 bank reg $8001 will overwrite
 *                 bit  6:   PRG bank mode
 *                 bit  7:   CHR bank mode
 *   $8001 (odd)   Bank Data — write into the R-register selected above
 *   $A000 (even)  Mirroring (0 = vertical, 1 = horizontal); ignored on
 *                 four-screen carts
 *   $A001 (odd)   PRG-RAM protect (lazily honoured)
 *   $C000 (even)  IRQ counter latch
 *   $C001 (odd)   IRQ counter reload — next clock loads from latch
 *   $E000 (even)  IRQ disable + ack
 *   $E001 (odd)   IRQ enable
 *
 * IRQ logic (per filtered A12 0→1 transition):
 *   - reload-pending OR counter == 0   →  counter := latch
 *   - else                             →  counter -= 1
 *   - if (after) counter == 0 AND IRQ enabled → assert IRQ line
 */
import type { Mapper } from '../../cart/mapper';
import type { Mirroring } from '../../cart/ines';

const A12_FILTER_DOTS = 10;

export class PonchoMmc3Banking implements Mapper {
  readonly id = 1;
  readonly name = 'PonchoMapper/MMC3-style';

  private readonly prgBankCount8k: number;
  private readonly chrBankCount1k: number;
  private readonly sram = new Uint8Array(8192);
  private readonly fourScreen: boolean;
  private mirror: Mirroring;

  private bankSelect = 0;
  private readonly banks = new Uint8Array(8);

  private irqLatch = 0;
  private irqCounter = 0;
  private irqReload = false;
  private irqEnabled = false;
  private irqLine = false;

  private a12: 0 | 1 = 0;
  private a12LowDots = A12_FILTER_DOTS;

  constructor(
    private readonly prg: Uint8Array,
    private readonly chr: Uint8Array,
    private readonly chrIsRam: boolean,
    bootMirroring: Mirroring,
  ) {
    this.prgBankCount8k = Math.max(1, Math.floor(prg.length / 8192));
    this.chrBankCount1k = Math.max(1, Math.floor(chr.length / 1024));
    this.fourScreen = bootMirroring === 'four-screen';
    this.mirror = bootMirroring;
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
    if (addr < 0x8000) return;

    const isOdd = (addr & 1) !== 0;
    const region = addr & 0xe000;
    if (region === 0x8000) {
      if (!isOdd) {
        this.bankSelect = value;
      } else {
        const reg = this.bankSelect & 0x07;
        this.banks[reg] = (reg === 6 || reg === 7) ? value & 0x3f : value;
      }
    } else if (region === 0xa000) {
      if (!isOdd && !this.fourScreen) {
        this.mirror = (value & 1) ? 'horizontal' : 'vertical';
      }
    } else if (region === 0xc000) {
      if (!isOdd) {
        this.irqLatch = value;
      } else {
        this.irqCounter = 0;
        this.irqReload = true;
      }
    } else if (region === 0xe000) {
      if (!isOdd) {
        this.irqEnabled = false;
        this.irqLine = false;
      } else {
        this.irqEnabled = true;
      }
    }
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

  mirroring(): Mirroring { return this.mirror; }

  notifyPpuA12(level: 0 | 1): void {
    if (level === 1 && this.a12 === 0) {
      if (this.a12LowDots >= A12_FILTER_DOTS) {
        this.clockIrqCounter();
      }
      this.a12LowDots = 0;
    }
    this.a12 = level;
  }

  /** PPU calls this once per dot; tracks how long A12 has been low. */
  tickPpu(): void {
    if (this.a12 === 0 && this.a12LowDots < 0xffff) this.a12LowDots++;
  }

  irqPending(): boolean { return this.irqLine; }
  irqClear(): void { this.irqLine = false; }

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }

  private clockIrqCounter(): void {
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else {
      this.irqCounter--;
    }
    if (this.irqCounter === 0 && this.irqEnabled) {
      this.irqLine = true;
    }
  }

  private prgOffset(addr: number): number {
    const off = addr - 0x8000;
    const slot = (off >>> 13) & 3;
    const swap = (this.bankSelect & 0x40) !== 0;
    let bank: number;
    switch (slot) {
      case 0: bank = swap ? this.prgBankCount8k - 2 : this.banks[6]!; break;
      case 1: bank = this.banks[7]!; break;
      case 2: bank = swap ? this.banks[6]! : this.prgBankCount8k - 2; break;
      case 3: bank = this.prgBankCount8k - 1; break;
      default: bank = 0;
    }
    return ((bank % this.prgBankCount8k) * 8192) + (off & 0x1fff);
  }

  private chrOffset(addr: number): number {
    const slot = (addr >>> 10) & 7;
    const swap = (this.bankSelect & 0x80) !== 0;
    let bank: number;
    if (!swap) {
      switch (slot) {
        case 0: bank = (this.banks[0]! & 0xfe); break;
        case 1: bank = (this.banks[0]! & 0xfe) | 1; break;
        case 2: bank = (this.banks[1]! & 0xfe); break;
        case 3: bank = (this.banks[1]! & 0xfe) | 1; break;
        case 4: bank = this.banks[2]!; break;
        case 5: bank = this.banks[3]!; break;
        case 6: bank = this.banks[4]!; break;
        case 7: bank = this.banks[5]!; break;
        default: bank = 0;
      }
    } else {
      switch (slot) {
        case 0: bank = this.banks[2]!; break;
        case 1: bank = this.banks[3]!; break;
        case 2: bank = this.banks[4]!; break;
        case 3: bank = this.banks[5]!; break;
        case 4: bank = (this.banks[0]! & 0xfe); break;
        case 5: bank = (this.banks[0]! & 0xfe) | 1; break;
        case 6: bank = (this.banks[1]! & 0xfe); break;
        case 7: bank = (this.banks[1]! & 0xfe) | 1; break;
        default: bank = 0;
      }
    }
    return ((bank % this.chrBankCount1k) * 1024) + (addr & 0x3ff);
  }
}
