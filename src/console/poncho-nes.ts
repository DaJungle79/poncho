import { Apu } from '../core/apu/apu';
import { PonchoCpuBus } from '../core/bus-poncho/cpu-bus';
import { PonchoCartridge } from '../core/cart-poncho/cartridge';
import { isPonchoRom, PonchoRomError } from '../core/cart-poncho/header';
import { Cpu } from '../core/cpu/cpu';
import { Controller } from '../core/input/controller';
import type { ControllerSource } from '../core/input/source';
import { PpuUltra } from '../core/ppu-ultra/ppu-ultra';
import type { FrameBuffer } from '../renderer/frame-buffer';
import type { Console } from './console';

/**
 * Top-level Poncho-NES console. Composition of:
 *   - 2A03 CPU (shared with NES — same 6502 core)
 *   - 2A03 APU (shared with NES)
 *   - 2C02-Ultra PPU (1024 × 960, 32-bit RGBA palette)
 *   - PonchoCpuBus (Poncho-flavoured address map)
 *   - PonchoMapper (cart-poncho)
 *
 * The per-cycle synchronisation model is identical to the NES: the
 * CPU is the master clock, every CPU cycle ticks the APU once and the
 * PPU three times via `cpu.tickCallback`. The PPU's `tick()` returns
 * `true` at the dot that begins vblank — we latch that so `runFrame()`
 * can return at the right moment.
 *
 * Accepts only `.poncho` ROMs. iNES files are routed to the classic
 * NES console by `detectConsole`. Features come online with each new
 * test ROM generator — see `docs/poncho-rom.md` for the build order.
 */
export class PonchoNes implements Console {
  readonly cpu: Cpu;
  readonly ppu: PpuUltra;
  readonly apu: Apu;
  readonly cpuBus: PonchoCpuBus;
  readonly controller1 = new Controller();
  readonly controller2 = new Controller();
  cartridge: PonchoCartridge | null = null;

  /** Set by the tick callback at vblank-start; read+cleared by runFrame. */
  private frameComplete = false;

  constructor() {
    this.ppu = new PpuUltra();
    this.apu = new Apu();
    this.cpuBus = new PonchoCpuBus(this.ppu, this.apu, this.controller1, this.controller2);
    this.cpu = new Cpu(this.cpuBus);

    this.apu.setDmcReader((addr) => this.cpuBus.read(addr));

    // PPU vblank → CPU NMI. PRG that sets PPUCTRL bit 7 receives an NMI
    // at the start of every vblank.
    this.ppu.setNmiCallback(() => this.cpu.triggerNmi());

    // Per-cycle heartbeat. Same shape as Nes: each CPU cycle advances
    // APU 1× and PPU 3×.
    this.cpu.setTickCallback(() => {
      this.apu.tick();
      if (this.ppu.tick()) this.frameComplete = true;
      if (this.ppu.tick()) this.frameComplete = true;
      if (this.ppu.tick()) this.frameComplete = true;
    });

    // OAM DMA stall (513/514 cycles). PpuUltra.oamDma is a stub today,
    // but we wire the stall path now so PRG that pokes $4014 cycles
    // correctly without special-casing.
    this.cpuBus.setOamDmaCallback(() => {
      this.cpu.stall(513 + (this.cpu.cycles() & 1));
    });
  }

  loadRom(data: Uint8Array): void {
    if (!isPonchoRom(data)) {
      throw new PonchoRomError('Poncho-NES only loads .poncho ROMs');
    }
    const cart = new PonchoCartridge(data);
    this.cartridge = cart;
    this.cpuBus.setCartridge(cart);
    this.ppu.setMasterPalette(cart.palette);
    this.ppu.setChr(cart.chr);
    this.reset();
  }

  unload(): void {
    this.cartridge = null;
    this.cpuBus.setCartridge(null);
    this.ppu.setChr(null);
  }

  reset(): void {
    this.ppu.reset();
    this.apu.reset();
    this.cpu.reset();
    this.frameComplete = false;
  }

  setController(player: 1 | 2, source: ControllerSource | null): void {
    (player === 1 ? this.controller1 : this.controller2).setSource(source);
  }

  step(): number {
    const irq = (this.cartridge?.mapper.irqPending() ?? false) || this.apu.irqPending();
    this.cpu.setIrqLine(irq);
    return this.cpu.step();
  }

  runFrame(): FrameBuffer {
    if (!this.cartridge) {
      while (!this.ppu.tick()) { /* spin */ }
      return this.ppu.framebuffer;
    }
    this.frameComplete = false;
    while (!this.frameComplete) this.step();
    return this.ppu.framebuffer;
  }
}
