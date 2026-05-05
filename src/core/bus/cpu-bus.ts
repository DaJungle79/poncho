/**
 * The CPU's view of memory.
 *
 * Address map:
 *   $0000-$1FFF  2 KiB internal RAM (mirrored every $0800)
 *   $2000-$3FFF  PPU registers ($2000-$2007 mirrored every 8 bytes)
 *   $4000-$4017  APU + I/O registers (incl. $4014 OAM DMA, $4016/$4017 pads)
 *   $4018-$401F  CPU test mode (unused on retail)
 *   $4020-$FFFF  Cartridge space — mapper-controlled
 *
 * `setOamDmaCallback` is the hook that Nes uses to stall the CPU for ~514
 * cycles when $4014 is written: the bus performs the bulk PPU OAM transfer
 * synchronously, then invokes the callback so the CPU can park itself for
 * the right number of cycles.
 */
import type { Apu } from '../apu/apu';
import type { Cartridge } from '../cart/cartridge';
import type { Controller } from '../input/controller';
import type { Ppu } from '../ppu/ppu';

export class CpuBus {
  readonly ram = new Uint8Array(0x0800);
  cartridge: Cartridge | null = null;

  private oamDmaCallback: () => void = () => {};

  constructor(
    private readonly ppu: Ppu,
    private readonly apu: Apu,
    private readonly controller1: Controller,
    private readonly controller2: Controller,
  ) {}

  setCartridge(cart: Cartridge | null): void {
    this.cartridge = cart;
  }

  /**
   * Register a callback invoked after each $4014 write. Nes uses this to
   * stall the CPU for the canonical 513/514 cycles consumed by OAM DMA.
   */
  setOamDmaCallback(cb: () => void): void {
    this.oamDmaCallback = cb;
  }

  read(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x2000) return this.ram[addr & 0x07ff];
    if (addr < 0x4000) return this.ppu.cpuRead(0x2000 | (addr & 0x7));
    if (addr === 0x4016) return this.controller1.read();
    if (addr === 0x4017) return this.controller2.read();
    if (addr < 0x4020) return this.apu.cpuRead(addr);
    return this.cartridge?.mapper.cpuRead(addr) ?? 0;
  }

  write(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr < 0x2000) {
      this.ram[addr & 0x07ff] = value;
      return;
    }
    if (addr < 0x4000) {
      this.ppu.cpuWrite(0x2000 | (addr & 0x7), value);
      return;
    }
    if (addr === 0x4014) {
      this.ppu.oamDma(this, value);
      this.oamDmaCallback();
      return;
    }
    if (addr === 0x4016) {
      this.controller1.writeStrobe(value);
      this.controller2.writeStrobe(value);
      return;
    }
    if (addr < 0x4020) {
      this.apu.cpuWrite(addr, value);
      return;
    }
    this.cartridge?.mapper.cpuWrite(addr, value);
  }
}
