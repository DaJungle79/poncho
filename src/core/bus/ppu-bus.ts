import type { Cartridge } from '../cart/cartridge';

/**
 * PPU memory map.
 *   $0000-$1FFF  pattern tables  (cartridge CHR)
 *   $2000-$2FFF  nametables      (2KB on-board VRAM, mirrored per cart)
 *   $3F00-$3F1F  palette RAM     (with mirrors of $3F10/$14/$18/$1C)
 *
 * Mirroring is delegated to the mapper since some cartridges (e.g. MMC1)
 * change it at runtime.
 */
export class PpuBus {
  readonly vram = new Uint8Array(0x0800);
  readonly palette = new Uint8Array(0x20);
  cartridge: Cartridge | null = null;

  /** Last A12 level seen on the bus. Used to detect rising/falling edges
   *  for the MMC3 (and friends) IRQ counter. */
  private lastA12: 0 | 1 = 0;

  setCartridge(cart: Cartridge | null): void {
    this.cartridge = cart;
    this.lastA12 = 0;
  }

  read(addr: number): number {
    addr &= 0x3fff;
    this.notifyA12(addr);
    if (addr < 0x2000) return this.cartridge?.mapper.ppuRead(addr) ?? 0;
    if (addr < 0x3f00) return this.vram[this.mirrorNametable(addr)];
    return this.palette[this.mirrorPalette(addr)];
  }

  write(addr: number, value: number): void {
    addr &= 0x3fff;
    value &= 0xff;
    this.notifyA12(addr);
    if (addr < 0x2000) {
      this.cartridge?.mapper.ppuWrite(addr, value);
      return;
    }
    if (addr < 0x3f00) {
      this.vram[this.mirrorNametable(addr)] = value;
      return;
    }
    this.palette[this.mirrorPalette(addr)] = value;
  }

  /**
   * Per-dot tick from the PPU. Forwards to the mapper if it cares (MMC3
   * uses this to count the "A12 has been low" duration that filters its
   * IRQ counter clocking). No-op for mappers that don't override.
   */
  tickMapper(): void {
    this.cartridge?.mapper.tickPpu?.();
  }

  /** Detect an A12 edge; tell the mapper when one happens. */
  private notifyA12(addr: number): void {
    const a12: 0 | 1 = ((addr >>> 12) & 1) as 0 | 1;
    if (a12 !== this.lastA12) {
      this.cartridge?.mapper.notifyPpuA12(a12);
      this.lastA12 = a12;
    }
  }

  private mirrorNametable(addr: number): number {
    const mode = this.cartridge?.mapper.mirroring() ?? 'horizontal';
    const idx = (addr - 0x2000) & 0x0fff;
    const table = (idx >>> 10) & 0x3;
    const offset = idx & 0x3ff;
    let physical = 0;
    switch (mode) {
      case 'horizontal':
        // Tables 0,1 share $0000; tables 2,3 share $0400.
        physical = (table >> 1) * 0x400;
        break;
      case 'vertical':
        // Tables 0,2 share $0000; tables 1,3 share $0400.
        physical = (table & 1) * 0x400;
        break;
      case 'single-low':
        physical = 0;
        break;
      case 'single-high':
        physical = 0x400;
        break;
      case 'four-screen':
        // Cart-provided extra VRAM. Until a four-screen mapper lands, fall
        // back to vertical so we don't crash on rare four-screen carts.
        physical = (table & 1) * 0x400;
        break;
    }
    return physical + offset;
  }

  private mirrorPalette(addr: number): number {
    let idx = (addr - 0x3f00) & 0x1f;
    if ((idx & 0x13) === 0x10) idx &= ~0x10;
    return idx;
  }
}
