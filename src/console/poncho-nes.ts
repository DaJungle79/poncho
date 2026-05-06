import { Apu } from '../core/apu/apu';
import { PonchoCpuBus } from '../core/bus-poncho/cpu-bus';
import { Cartridge } from '../core/cart/cartridge';
import { parseInes } from '../core/cart/ines';
import { PonchoCartridge } from '../core/cart-poncho/cartridge';
import { isPonchoRom } from '../core/cart-poncho/header';
import { Cpu } from '../core/cpu/cpu';
import { Controller } from '../core/input/controller';
import type { ControllerSource } from '../core/input/source';
import { NES_MASTER_PALETTE_RGBA } from '../core/ppu-ultra/nes-master-palette';
import { PpuUltra } from '../core/ppu-ultra/ppu-ultra';
import type { FrameBuffer } from '../renderer/frame-buffer';
import type { Console } from './console';
import type { Cartridge as InesCartridge } from '../core/cart/cartridge';

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
 * Most of the chip is still a stub (PPU registers, mapper banking,
 * OAM, scrolling) — features come online with each new test ROM
 * generator. See `docs/poncho-rom.md` for the build order.
 */
export class PonchoNes implements Console {
  readonly cpu: Cpu;
  readonly ppu: PpuUltra;
  readonly apu: Apu;
  readonly cpuBus: PonchoCpuBus;
  readonly controller1 = new Controller();
  readonly controller2 = new Controller();
  /** Loaded cartridge — either a native PonchoROM or an iNES (compat-mode) cart. */
  cartridge: PonchoCartridge | InesCartridge | null = null;

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
    if (isPonchoRom(data)) {
      // Native PonchoROM.
      const cart = new PonchoCartridge(data);
      this.cartridge = cart;
      this.cpuBus.setCartridge(cart);
      this.ppu.setNesCompat(false);
      this.ppu.setMasterPalette(cart.palette);
      this.ppu.setChr(cart.chr);
      this.ppu.setChrReader(null);
    } else {
      // Treat as iNES → NES-compat sub-mode. The Ultra PPU walks 8×8
      // 2bpp tiles via the cartridge mapper, paints each NES pixel as
      // a 4×4 block. PRG runs unchanged.
      const ines = parseInes(data);
      const cart = new Cartridge(ines);
      this.cartridge = cart;
      this.cpuBus.setCartridge(cart);
      this.ppu.setNesCompat(true);
      this.ppu.setMasterPalette(NES_MASTER_PALETTE_RGBA);
      this.ppu.setChr(null);
      this.ppu.setChrReader((addr) => cart.mapper.ppuRead(addr & 0x3fff));
    }
    this.reset();
  }

  unload(): void {
    this.cartridge = null;
    this.cpuBus.setCartridge(null);
    this.ppu.setChr(null);
    this.ppu.setChrReader(null);
    this.ppu.setNesCompat(false);
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
