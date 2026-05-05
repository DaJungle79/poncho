import { Apu } from './apu/apu';
import { CpuBus } from './bus/cpu-bus';
import { PpuBus } from './bus/ppu-bus';
import { Cartridge } from './cart/cartridge';
import { parseInes } from './cart/ines';
import { Cpu } from './cpu/cpu';
import { Controller } from './input/controller';
import type { ControllerSource } from './input/source';
import { Ppu } from './ppu/ppu';
import type { FrameBuffer } from '../renderer/frame-buffer';

/**
 * Top-level console. Wires the CPU, PPU, APU, buses, controllers, and
 * cartridge together.
 *
 * Per-cycle synchronization model:
 *   - The CPU ticks the rest of the system *before* every bus access via
 *     a tickCallback (set on construction). One callback = one CPU cycle.
 *   - On each call we tick the APU once and the PPU three times.
 *   - The PPU returns `true` from tick() at vblank-start; we latch that
 *     into `frameComplete`, so `runFrame()` can return the freshly
 *     rendered buffer at the right moment.
 *   - This way mid-instruction reads of $2002, register writes that race
 *     vblank, and OAM DMA all see the right state at the right cycle.
 */
export class Nes {
  readonly cpu: Cpu;
  readonly ppu: Ppu;
  readonly apu: Apu;
  readonly cpuBus: CpuBus;
  readonly ppuBus: PpuBus;
  readonly controller1 = new Controller();
  readonly controller2 = new Controller();
  cartridge: Cartridge | null = null;

  /** Set by the tick callback at vblank-start, read+cleared by runFrame. */
  private frameComplete = false;

  constructor() {
    this.ppuBus = new PpuBus();
    this.ppu = new Ppu(this.ppuBus);
    this.apu = new Apu();
    this.cpuBus = new CpuBus(this.ppu, this.apu, this.controller1, this.controller2);
    this.cpu = new Cpu(this.cpuBus);
    this.ppu.setNmiCallback(() => this.cpu.triggerNmi());

    // The DMC channel reads sample bytes from CPU memory; route those
    // through the CPU bus so any mapper-controlled banking is honored.
    this.apu.setDmcReader((addr) => this.cpuBus.read(addr));

    // The per-cycle heartbeat. Called once per CPU cycle, *before* the bus
    // access that defines the cycle. Each callback advances the rest of
    // the system: APU 1×, PPU 3×.
    this.cpu.setTickCallback(() => {
      this.apu.tick();
      if (this.ppu.tick()) this.frameComplete = true;
      if (this.ppu.tick()) this.frameComplete = true;
      if (this.ppu.tick()) this.frameComplete = true;
    });

    // OAM DMA: 256 reads + 256 writes + 1-2 alignment cycles. The bulk
    // byte-copy already happened inside the PPU when $4014 was written;
    // we use the legacy stall path to "park" the CPU for the right cycle
    // count, with the per-cycle tick callback advancing PPU/APU during
    // those parked cycles. (See per-byte rework — task #33.)
    this.cpuBus.setOamDmaCallback(() => {
      this.cpu.stall(513 + (this.cpu.cycles() & 1));
    });
  }

  loadRom(data: Uint8Array): void {
    const rom = parseInes(data);
    this.cartridge = new Cartridge(rom);
    this.cpuBus.setCartridge(this.cartridge);
    this.ppuBus.setCartridge(this.cartridge);
    this.reset();
  }

  unload(): void {
    this.cartridge = null;
    this.cpuBus.setCartridge(null);
    this.ppuBus.setCartridge(null);
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

  /**
   * Run one CPU instruction (or one interrupt service / stall cycle).
   * The PPU and APU are ticked from inside the CPU's bus accesses, so
   * by the time this returns the entire system has advanced together.
   * Returns the number of CPU cycles consumed.
   *
   * Mapper IRQs (e.g. MMC3's scanline counter) are polled before each
   * CPU step so the line is accurate at instruction boundaries.
   */
  step(): number {
    // IRQ pin is the OR of mapper IRQ (MMC3 scanline counter, etc.) and
    // APU IRQ (frame counter end + DMC sample-end). Polled at instruction
    // boundaries — close enough for game-level accuracy.
    const irq = (this.cartridge?.mapper.irqPending() ?? false) || this.apu.irqPending();
    this.cpu.setIrqLine(irq);
    return this.cpu.step();
  }

  /**
   * Run until the PPU has just entered vblank (frame finished). Returns
   * the freshly populated framebuffer. Without a cartridge the loop
   * still ticks the PPU directly so the placeholder pattern animates.
   */
  runFrame(): FrameBuffer {
    if (!this.cartridge) {
      for (let i = 0; i < 89_342; i++) {
        if (this.ppu.tick()) break;
      }
      return this.ppu.framebuffer;
    }
    this.frameComplete = false;
    while (!this.frameComplete) this.cpu.step();
    return this.ppu.framebuffer;
  }
}
