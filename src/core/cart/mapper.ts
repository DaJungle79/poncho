import type { Mirroring } from './ines';

export interface Mapper {
  readonly id: number;
  readonly name: string;

  cpuRead(addr: number): number;
  cpuWrite(addr: number, value: number): void;

  ppuRead(addr: number): number;
  ppuWrite(addr: number, value: number): void;

  /** Current nametable mirroring (mappers can change this at runtime). */
  mirroring(): Mirroring;

  /**
   * Called by PpuBus on every PPU bus access where bit 12 of the address
   * differs from the previous access — i.e. an A12 line edge. MMC3 uses
   * the rising edge to clock its IRQ counter (with a low-time filter
   * driven by `tickPpu`); other mappers no-op.
   */
  notifyPpuA12(level: 0 | 1): void;

  /**
   * Called by Ppu once per dot. Optional — only mappers that need a
   * per-dot clock (MMC3 for the A12 low-time filter, MMC5 for its scanline
   * counter) override this. Default no-op for everyone else.
   */
  tickPpu?(): void;

  /** True for one CPU cycle when the mapper wants to assert IRQ. */
  irqPending(): boolean;
  irqClear(): void;

  /** Persisted SRAM bytes (battery saves) — null when not present. */
  getSram(): Uint8Array | null;
  loadSram(data: Uint8Array): void;
}
