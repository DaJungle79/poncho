/**
 * The contract every virtual console implements. Picks a set of chips
 * from `src/core/`, wires them together, and exposes a uniform surface
 * that the shell drives without caring which console is running.
 *
 * Each composition file (e.g. `nes.ts`, `poncho-nes.ts`) instantiates
 * its own CPU/PPU/APU/buses/mappers and returns a `Console`. The shell
 * picks which composition via a `ConsoleFactory` (see below).
 */

import type { FrameBuffer } from '../renderer/frame-buffer';
import type { ControllerSource } from '../core/input/source';

export interface Console {
  /** Run until vblank-start; returns the freshly rendered framebuffer. */
  runFrame(): FrameBuffer;

  /** Warm reset (CPU/PPU/APU re-initialised, cartridge stays). */
  reset(): void;

  /** Parse + mount a cartridge image. Throws if the format is rejected. */
  loadRom(data: Uint8Array): void;

  /** Detach the cartridge. The console can still tick (placeholder pattern). */
  unload(): void;

  /** Wire a controller source to player 1 or 2. `null` clears it. */
  setController(player: 1 | 2, source: ControllerSource | null): void;
}

/**
 * Factory + format detector for one console. Registered with the
 * detection registry; the shell calls `detect()` on each factory until
 * one matches, then `create()` to instantiate.
 */
export interface ConsoleFactory {
  readonly id: string;
  detect(data: Uint8Array): boolean;
  create(): Console;
}
