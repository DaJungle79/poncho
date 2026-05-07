/**
 * PonchoMapper — the Poncho-NES cartridge mapper.
 *
 * The chip dispatches to one of several **banking variants** selected
 * at cartridge construction from the PonchoROM header's `mapper_submode`
 * (low byte). Each variant defines how the $4020-$FFFF cartridge
 * window maps onto the PRG buffer; CHR access, mirroring, and IRQ
 * handling are common across variants and stay on this class.
 *
 * Variant numbers match their iNES-mapper analogues for clarity:
 *
 *   0  NROM-style    flat mirroring of PRG across $8000-$FFFF, no banking
 *   2  UxROM-style   16 KB switchable @ $8000-$BFFF, fixed last bank
 *                    @ $C000-$FFFF; bank-select on any write to $8000-$FFFF
 *   1  MMC1-style    (Phase 8 — not yet implemented)
 *   3  CNROM-style   (Phase 8 — not yet implemented)
 *   4  MMC3-style    (Phase 8 — not yet implemented)
 *   7  AxROM-style   (Phase 8 — not yet implemented)
 *
 * Mirroring is delivered from the header's boot value (decoded by
 * `decodeMapperSubmode`); mappers with runtime mirroring control
 * (MMC1 / AxROM) override it once PRG configures them.
 */

import type { BankingVariant, BootMirroring } from '../cart-poncho/header';
import type { Mapper } from '../cart/mapper';
import type { Mirroring } from '../cart/ines';

export interface PonchoMapperOptions {
  /** True when `chr` is CHR-RAM (writable). False for CHR-ROM (writes dropped). */
  writable?: boolean;
  /** Banking-variant selector from `mapper_submode` low byte. Defaults to 0 (NROM-style). */
  bankingVariant?: BankingVariant;
  /** Boot-time nametable mirroring, from `mapper_submode` bits 8-9. Defaults to 0 (horizontal). */
  bootMirroring?: BootMirroring;
}

/**
 * Per-variant strategy for the $4020-$FFFF cartridge window. Variant
 * choices that need state (e.g. UxROM's bank register) keep it inside
 * the strategy; the PonchoMapper just delegates.
 */
interface PrgWindow {
  cpuRead(addr: number): number;
  cpuWrite(addr: number, value: number): void;
}

/**
 * NROM-style: PRG mirrors flat across $8000-$FFFF. Writes ignored.
 * Used for converted iNES NROM games and as the default fallback.
 */
class NromPrgWindow implements PrgWindow {
  constructor(private readonly prg: Uint8Array) {}
  cpuRead(addr: number): number {
    if (addr < 0x8000 || this.prg.length === 0) return 0;
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }
  cpuWrite(_addr: number, _value: number): void { /* no banking */ }
}

/**
 * UxROM-style: 16 KB switchable bank at $8000-$BFFF, fixed last 16 KB
 * at $C000-$FFFF. Any write to $8000-$FFFF latches the low bits of the
 * value as the new bank index.
 *
 * The bank-count modulo (rather than a fixed mask) handles non-power-of-two
 * PRG sizes correctly, matching the iNES Uxrom mapper's behaviour.
 */
class UxromPrgWindow implements PrgWindow {
  private bank = 0;
  private readonly bankCount: number;

  constructor(private readonly prg: Uint8Array) {
    this.bankCount = Math.max(1, Math.floor(prg.length / 16384));
  }

  cpuRead(addr: number): number {
    if (addr < 0x8000 || this.prg.length === 0) return 0;
    if (addr < 0xc000) {
      const bank = this.bank % this.bankCount;
      return this.prg[bank * 16384 + (addr - 0x8000)] ?? 0;
    }
    return this.prg[(this.bankCount - 1) * 16384 + (addr - 0xc000)] ?? 0;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x8000) {
      // Original UxROM uses low 3 bits, UOROM 4 bits. The mod in cpuRead
      // tolerates either — store the raw low-nibble.
      this.bank = value & 0x0f;
    }
  }
}

const VARIANT_NAMES: Record<BankingVariant, string> = {
  0: 'NROM-style',
  1: 'MMC1-style',
  2: 'UxROM-style',
  3: 'CNROM-style',
  4: 'MMC3-style',
  7: 'AxROM-style',
};

/** PonchoMapper does NOT support these variants yet — Phase 8 of v0.3.0. */
const NOT_YET_IMPLEMENTED: ReadonlySet<BankingVariant> = new Set([1, 3, 4, 7]);

const BOOT_MIRRORING: Record<BootMirroring, Mirroring> = {
  0: 'horizontal',
  1: 'vertical',
  2: 'four-screen',
  3: 'single-low',
};

export class PonchoMapper implements Mapper {
  readonly id = 1;
  readonly name: string;
  readonly bankingVariant: BankingVariant;

  private readonly chrWritable: boolean;
  private readonly window: PrgWindow;
  private readonly _mirroring: Mirroring;

  constructor(
    prg: Uint8Array,
    private readonly chr: Uint8Array,
    options: PonchoMapperOptions = {},
  ) {
    this.chrWritable = options.writable === true;
    this.bankingVariant = options.bankingVariant ?? 0;
    const bootMirroring = options.bootMirroring ?? 0;

    if (NOT_YET_IMPLEMENTED.has(this.bankingVariant)) {
      throw new Error(
        `PonchoMapper banking variant ${this.bankingVariant} ` +
        `(${VARIANT_NAMES[this.bankingVariant]}) is not yet implemented`,
      );
    }

    this.window = createPrgWindow(this.bankingVariant, prg);
    this.name = `PonchoMapper/${VARIANT_NAMES[this.bankingVariant]}`;
    this._mirroring = BOOT_MIRRORING[bootMirroring];
  }

  cpuRead(addr: number): number  { return this.window.cpuRead(addr); }
  cpuWrite(addr: number, value: number): void { this.window.cpuWrite(addr, value); }

  ppuRead(addr: number): number {
    if (addr >= 0x2000 || this.chr.length === 0) return 0;
    return this.chr[addr % this.chr.length]!;
  }

  ppuWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    if (addr >= 0x2000 || this.chr.length === 0) return;
    this.chr[addr % this.chr.length] = value & 0xff;
  }

  mirroring(): Mirroring  { return this._mirroring; }

  notifyPpuA12(_level: 0 | 1): void { /* MMC3 lands in Phase 8 */ }
  irqPending(): boolean { return false; }
  irqClear(): void { /* no-op */ }

  getSram(): Uint8Array | null { return null; }
  loadSram(_data: Uint8Array): void { /* no battery save yet */ }
}

function createPrgWindow(variant: BankingVariant, prg: Uint8Array): PrgWindow {
  switch (variant) {
    case 0: return new NromPrgWindow(prg);
    case 2: return new UxromPrgWindow(prg);
    default:
      throw new Error(`unreachable: variant ${variant} should have been rejected earlier`);
  }
}
