/**
 * PonchoMapper — the Poncho-NES cartridge mapper.
 *
 * The chip dispatches to one of several **banking variants** selected
 * at construction from the PonchoROM header's `mapper_submode` low byte.
 * Each variant lives in its own module under `./variants/` and mirrors
 * the equivalent iNES mapper's behaviour, but takes the cartridge's
 * pre-allocated CHR buffer (CHR-ROM or CHR-RAM) and boot mirroring as
 * constructor inputs rather than parsing an iNES blob.
 *
 * Variant numbers match their iNES counterparts for clarity:
 *
 *   0  NROM-style    flat mirror, no banking
 *   1  MMC1-style    serial control, PRG/CHR mode swap, runtime mirroring
 *   2  UxROM-style   16 KB switchable @ $8000, fixed last bank @ $C000
 *   3  CNROM-style   CHR-bank select via any $8000-$FFFF write
 *   4  MMC3-style    PRG/CHR banking + scanline IRQ
 *   7  AxROM-style   32 KB PRG bank + single-screen mirror control
 */

import type { BankingVariant, BootMirroring } from '../cart-poncho/header';
import type { Mapper } from '../cart/mapper';
import type { Mirroring } from '../cart/ines';

import { PonchoNromBanking } from './variants/nrom';
import { PonchoUxromBanking } from './variants/uxrom';
import { PonchoMmc1Banking } from './variants/mmc1';
import { PonchoCnromBanking } from './variants/cnrom';
import { PonchoMmc3Banking } from './variants/mmc3';
import { PonchoAxromBanking } from './variants/axrom';

export interface PonchoMapperOptions {
  /** True when `chr` is CHR-RAM (writable). False for CHR-ROM (writes dropped). */
  writable?: boolean;
  /** Banking-variant selector from `mapper_submode` low byte. Defaults to 0 (NROM-style). */
  bankingVariant?: BankingVariant;
  /** Boot-time nametable mirroring, from `mapper_submode` bits 8-9. Defaults to 0 (horizontal). */
  bootMirroring?: BootMirroring;
}

const VARIANT_NAMES: Record<BankingVariant, string> = {
  0: 'NROM-style',
  1: 'MMC1-style',
  2: 'UxROM-style',
  3: 'CNROM-style',
  4: 'MMC3-style',
  7: 'AxROM-style',
};

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

  /** The active variant — owns all per-variant state. */
  private readonly inner: Mapper;

  constructor(
    prg: Uint8Array,
    chr: Uint8Array,
    options: PonchoMapperOptions = {},
  ) {
    this.bankingVariant = options.bankingVariant ?? 0;
    const writable = options.writable === true;
    const mirroring = BOOT_MIRRORING[options.bootMirroring ?? 0];

    this.inner = createInner(this.bankingVariant, prg, chr, writable, mirroring);
    this.name = `PonchoMapper/${VARIANT_NAMES[this.bankingVariant]}`;
  }

  cpuRead(addr: number): number { return this.inner.cpuRead(addr); }
  cpuWrite(addr: number, value: number): void { this.inner.cpuWrite(addr, value); }

  ppuRead(addr: number): number { return this.inner.ppuRead(addr); }
  ppuWrite(addr: number, value: number): void { this.inner.ppuWrite(addr, value); }

  mirroring(): Mirroring { return this.inner.mirroring(); }

  notifyPpuA12(level: 0 | 1): void { this.inner.notifyPpuA12(level); }
  irqPending(): boolean { return this.inner.irqPending(); }
  irqClear(): void { this.inner.irqClear(); }

  getSram(): Uint8Array | null { return this.inner.getSram(); }
  loadSram(data: Uint8Array): void { this.inner.loadSram(data); }
}

function createInner(
  variant: BankingVariant,
  prg: Uint8Array,
  chr: Uint8Array,
  chrIsRam: boolean,
  mirroring: Mirroring,
): Mapper {
  switch (variant) {
    case 0: return new PonchoNromBanking(prg, chr, chrIsRam, mirroring);
    case 1: return new PonchoMmc1Banking(prg, chr, chrIsRam, mirroring);
    case 2: return new PonchoUxromBanking(prg, chr, chrIsRam, mirroring);
    case 3: return new PonchoCnromBanking(prg, chr, chrIsRam, mirroring);
    case 4: return new PonchoMmc3Banking(prg, chr, chrIsRam, mirroring);
    case 7: return new PonchoAxromBanking(prg, chr, chrIsRam, mirroring);
  }
}
