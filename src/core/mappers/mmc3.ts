/**
 * MMC3 — iNES mapper 4.
 *
 * The most common bank-switching chip on the NES. Drives Super Mario Bros 3,
 * Mega Man 3-6, Kirby's Adventure, Crystalis, and roughly 568 commercial
 * cartridges. Two notable features beyond plain bank switching:
 *
 *   1. Per-1-KiB CHR banking with two layout modes, mixed with a couple of
 *      special "double-wide" 2-KiB banks at the top or bottom.
 *   2. A scanline-rate IRQ driven by transitions on PPU A12 (with a
 *      "A12-low filter" that ignores the rapid toggles internal to a
 *      single fetch group, so the counter only ticks once per scanline).
 *
 * Register map (mirror within $8000-$FFFF based on bit 0 of the address):
 *
 *   $8000 (even)  Bank Select.
 *                 bits 0-2: which R0-R7 bank register $8001 will overwrite
 *                 bit  6:   PRG bank mode (0 = R6 at $8000 / second-to-last
 *                                          fixed at $C000;
 *                           1 = second-to-last fixed at $8000 / R6 at $C000)
 *                 bit  7:   CHR bank mode (0 = two 2-KiB at $0000, four
 *                                          1-KiB at $1000;
 *                           1 = swapped — four 1-KiB at $0000, two 2-KiB
 *                           at $1000)
 *   $8001 (odd)   Bank Data — load value into the register selected above.
 *   $A000 (even)  Mirroring (0 = vertical, 1 = horizontal).
 *                 Ignored on cartridges hard-wired for four-screen.
 *   $A001 (odd)   PRG-RAM protect (mostly historical — we honor it lazily).
 *   $C000 (even)  IRQ counter latch.
 *   $C001 (odd)   IRQ counter reload — next clock will load from latch.
 *   $E000 (even)  IRQ disable + acknowledge any pending IRQ.
 *   $E001 (odd)   IRQ enable.
 *
 * IRQ logic (per filtered A12 0->1 transition):
 *   - If counter is 0 OR a reload is pending, counter := latch.
 *   - Else counter--.
 *   - If counter is now 0 AND IRQs are enabled, the IRQ line is asserted.
 *
 * Reference: nesdev wiki "MMC3" + "MMC3 IRQ".
 */
import type { InesRom, Mirroring } from '../cart/ines';
import type { Mapper } from '../cart/mapper';

/** Minimum dots A12 must be low before a rising edge counts as "real". */
const A12_FILTER_DOTS = 10;

export class Mmc3 implements Mapper {
  readonly id = 4;
  readonly name = 'MMC3';

  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrIsRam: boolean;
  private readonly sram = new Uint8Array(8192);
  private readonly prgBankCount8k: number;
  private readonly chrBankCount1k: number;

  // ----- $8000 / $8001: bank select + bank data -----------------------------
  /** Last byte written to $8000. Bits 0-2 select which R-register to load,
   *  bit 6 selects PRG layout, bit 7 selects CHR layout. */
  private bankSelect = 0;
  /** R0-R7. R0/R1 are 2-KiB CHR banks; R2-R5 are 1-KiB CHR banks; R6/R7
   *  are 8-KiB PRG banks. */
  private readonly banks = new Uint8Array(8);

  // ----- $A000 mirroring + four-screen handling -----------------------------
  private mirror: Mirroring;
  private readonly fourScreen: boolean;

  // ----- IRQ counter --------------------------------------------------------
  private irqLatch = 0;
  private irqCounter = 0;
  private irqReload = false;
  private irqEnabled = false;
  private irqLine = false;

  // ----- A12 filter state ---------------------------------------------------
  private a12: 0 | 1 = 0;
  private a12LowDots = A12_FILTER_DOTS; // assume long-low at startup

  constructor(rom: InesRom) {
    this.prg = rom.prgRom;
    this.chrIsRam = rom.chrRom.length === 0;
    this.chr = this.chrIsRam ? new Uint8Array(8192) : rom.chrRom;
    this.fourScreen = rom.header.mirroring === 'four-screen';
    this.mirror = rom.header.mirroring;
    this.prgBankCount8k = Math.max(1, Math.floor(rom.prgRom.length / 8192));
    this.chrBankCount1k = Math.max(1, Math.floor(this.chr.length / 1024));
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
    if (addr < 0x8000) return;

    const isOdd = (addr & 1) !== 0;
    const region = addr & 0xe000;
    if (region === 0x8000) {
      if (!isOdd) {
        this.bankSelect = value;
      } else {
        const reg = this.bankSelect & 0x07;
        // R6/R7 are 6-bit (top 2 bits ignored on real chip); CHR regs (R0-R5)
        // accept full byte. We mask R6/R7 here for robustness.
        this.banks[reg] = (reg === 6 || reg === 7) ? value & 0x3f : value;
      }
    } else if (region === 0xa000) {
      if (!isOdd) {
        // Mirroring control is ignored on four-screen carts.
        if (!this.fourScreen) {
          this.mirror = (value & 1) ? 'horizontal' : 'vertical';
        }
      } else {
        // PRG-RAM protect — bits 6-7. We don't enforce strictly.
      }
    } else if (region === 0xc000) {
      if (!isOdd) {
        this.irqLatch = value;
      } else {
        // Setting reload causes the next clock to reload counter from latch.
        this.irqCounter = 0;
        this.irqReload = true;
      }
    } else if (region === 0xe000) {
      if (!isOdd) {
        // Disable + acknowledge.
        this.irqEnabled = false;
        this.irqLine = false;
      } else {
        this.irqEnabled = true;
      }
    }
  }

  // ----- PPU side -----------------------------------------------------------

  ppuRead(addr: number): number { return this.chr[this.chrOffset(addr)]; }

  ppuWrite(addr: number, value: number): void {
    if (this.chrIsRam) this.chr[this.chrOffset(addr)] = value & 0xff;
  }

  mirroring(): Mirroring { return this.mirror; }

  /**
   * Per-dot tick from the PPU. Used to track how long A12 has been low,
   * which controls whether the next 0->1 transition is treated as a
   * "real" rising edge by the IRQ counter.
   */
  tickPpu(): void {
    if (this.a12 === 0 && this.a12LowDots < 0xffff) {
      this.a12LowDots++;
    }
  }

  /**
   * A12 line edge from the PPU bus. On a filtered rising edge, clock the
   * IRQ counter.
   */
  notifyPpuA12(level: 0 | 1): void {
    if (level === 1 && this.a12 === 0) {
      if (this.a12LowDots >= A12_FILTER_DOTS) {
        this.clockIrqCounter();
      }
      this.a12LowDots = 0;
    }
    this.a12 = level;
  }

  irqPending(): boolean { return this.irqLine; }
  irqClear(): void { this.irqLine = false; }

  getSram(): Uint8Array | null { return this.sram; }
  loadSram(d: Uint8Array): void { this.sram.set(d.subarray(0, this.sram.length)); }

  // -------------------------------------------------------------------------
  // IRQ counter clocking — internal
  // -------------------------------------------------------------------------

  /**
   * Standard MMC3 IRQ tick (post-revision-A behavior, which most games
   * target):
   *   - reload-pending OR counter == 0  →  counter := latch
   *   - else                            →  counter -= 1
   *   - if (after the above) counter == 0 AND IRQ enabled → assert IRQ
   */
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

  // -------------------------------------------------------------------------
  // Bank-offset math
  // -------------------------------------------------------------------------

  /** CPU $8000-$FFFF -> byte offset into `prg`. */
  private prgOffset(addr: number): number {
    const off = addr - 0x8000;
    const slot = (off >>> 13) & 3; // 8-KiB slot 0..3
    const swap = (this.bankSelect & 0x40) !== 0;
    let bank: number;
    switch (slot) {
      case 0: bank = swap ? this.prgBankCount8k - 2 : this.banks[6]; break;
      case 1: bank = this.banks[7]; break;
      case 2: bank = swap ? this.banks[6] : this.prgBankCount8k - 2; break;
      case 3: bank = this.prgBankCount8k - 1; break;
      default: bank = 0;
    }
    return ((bank % this.prgBankCount8k) * 8192) + (off & 0x1fff);
  }

  /**
   * PPU $0000-$1FFF -> byte offset into `chr`. The 8-KiB pattern table
   * window splits into 8 × 1-KiB slots. R0/R1 are "2-KiB" banks but we
   * model them as adjacent 1-KiB pairs by clearing the low bit and
   * appending +0/+1 for the upper/lower KB.
   */
  private chrOffset(addr: number): number {
    const slot = (addr >>> 10) & 7;
    const swap = (this.bankSelect & 0x80) !== 0;
    let bank: number;
    if (!swap) {
      // CHR mode 0: two 2-KiB at $0000-$0FFF, four 1-KiB at $1000-$1FFF
      switch (slot) {
        case 0: bank = (this.banks[0] & 0xfe); break;
        case 1: bank = (this.banks[0] & 0xfe) | 1; break;
        case 2: bank = (this.banks[1] & 0xfe); break;
        case 3: bank = (this.banks[1] & 0xfe) | 1; break;
        case 4: bank = this.banks[2]; break;
        case 5: bank = this.banks[3]; break;
        case 6: bank = this.banks[4]; break;
        case 7: bank = this.banks[5]; break;
        default: bank = 0;
      }
    } else {
      // CHR mode 1: four 1-KiB at $0000-$0FFF, two 2-KiB at $1000-$1FFF
      switch (slot) {
        case 0: bank = this.banks[2]; break;
        case 1: bank = this.banks[3]; break;
        case 2: bank = this.banks[4]; break;
        case 3: bank = this.banks[5]; break;
        case 4: bank = (this.banks[0] & 0xfe); break;
        case 5: bank = (this.banks[0] & 0xfe) | 1; break;
        case 6: bank = (this.banks[1] & 0xfe); break;
        case 7: bank = (this.banks[1] & 0xfe) | 1; break;
        default: bank = 0;
      }
    }
    return ((bank % this.chrBankCount1k) * 1024) + (addr & 0x3ff);
  }
}
