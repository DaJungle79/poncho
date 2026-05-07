/**
 * Poncho-NES CPU bus. The address map will diverge from the NES once
 * the PonchoMapper grows its native register set ($8000-$FFFF, per
 * `docs/poncho-rom.md`).
 *
 * Address map:
 *   $0000-$1FFF  2 KiB internal RAM (mirrored every $0800)
 *   $2000-$3FFF  PPU registers (currently a stub on the Ultra PPU)
 *   $4000-$4017  APU + I/O (incl. $4014 OAM DMA, $4016/$4017 pads)
 *   $4018-$401F  reserved (unused)
 *   $4020-$FFFF  Cartridge — PonchoMapper-controlled
 */

import type { Apu } from '../apu/apu';
import type { PonchoCartridge } from '../cart-poncho/cartridge';
import type { Controller } from '../input/controller';
import type { PpuUltra } from '../ppu-ultra/ppu-ultra';

export class PonchoCpuBus {
  readonly ram = new Uint8Array(0x0800);
  cartridge: PonchoCartridge | null = null;

  private oamDmaCallback: () => void = () => {};

  constructor(
    private readonly ppu: PpuUltra,
    private readonly apu: Apu,
    private readonly controller1: Controller,
    private readonly controller2: Controller,
  ) {}

  setCartridge(cart: PonchoCartridge | null): void {
    this.cartridge = cart;
  }

  setOamDmaCallback(cb: () => void): void {
    this.oamDmaCallback = cb;
  }

  read(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x2000) return this.ram[addr & 0x07ff]!;
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
