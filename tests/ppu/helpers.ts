import { PpuBus } from '../../src/core/bus/ppu-bus';
import type { Mirroring } from '../../src/core/cart/ines';
import type { Mapper } from '../../src/core/cart/mapper';
import { Ppu } from '../../src/core/ppu/ppu';

/**
 * A minimal mapper for PPU tests: 8 KiB of CHR-RAM and a software-settable
 * mirroring mode. Lets tests poke pattern-table bytes directly without
 * loading a real cartridge.
 */
export class TestMapper implements Mapper {
  readonly id = 0;
  readonly name = 'Test';

  readonly chr = new Uint8Array(0x2000);
  private mirror: Mirroring;

  constructor(mirror: Mirroring = 'horizontal') {
    this.mirror = mirror;
  }

  setMirroring(m: Mirroring): void { this.mirror = m; }

  cpuRead(_addr: number): number { return 0; }
  cpuWrite(_addr: number, _value: number): void {}
  ppuRead(addr: number): number { return this.chr[addr & 0x1fff]; }
  ppuWrite(addr: number, value: number): void { this.chr[addr & 0x1fff] = value & 0xff; }
  mirroring(): Mirroring { return this.mirror; }
  notifyPpuA12(_level: 0 | 1): void {}
  irqPending(): boolean { return false; }
  irqClear(): void {}
  getSram(): Uint8Array | null { return null; }
  loadSram(_data: Uint8Array): void {}
}

export interface PpuHarness {
  ppu: Ppu;
  bus: PpuBus;
  mapper: TestMapper;
  /** Number of times the NMI callback has fired. */
  nmiCount: () => number;
  /** Tick the PPU n dots. Returns the number of frames completed. */
  tickDots(n: number): number;
  /** Tick until the PPU reaches scanline `s`, dot `d`. Returns dots ticked. */
  tickUntil(scanline: number, dot: number): number;
}

export function makePpu(mirror: Mirroring = 'horizontal'): PpuHarness {
  const mapper = new TestMapper(mirror);
  const bus = new PpuBus();
  // Wrap mapper so PpuBus can read it. PpuBus expects a Cartridge, so we
  // construct a lookalike inline.
  bus.setCartridge({ mapper, rom: null as unknown as never });
  const ppu = new Ppu(bus);
  ppu.reset();

  let nmis = 0;
  ppu.setNmiCallback(() => { nmis++; });

  return {
    ppu,
    bus,
    mapper,
    nmiCount: () => nmis,
    tickDots(n: number): number {
      let frames = 0;
      for (let i = 0; i < n; i++) if (ppu.tick()) frames++;
      return frames;
    },
    tickUntil(scanline: number, dot: number): number {
      let count = 0;
      const safetyLimit = 89_342 * 4;
      while (
        (ppu.currentScanline() !== scanline || ppu.currentDot() !== dot) &&
        count < safetyLimit
      ) {
        ppu.tick();
        count++;
      }
      return count;
    },
  };
}
