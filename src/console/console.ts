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
 *
 * The `spec` is the single source of truth for the console's hardware
 * capabilities — consumed by the UI (console-picker, status panels)
 * and rendered into the README. Keep it accurate.
 */
export interface ConsoleFactory {
  readonly spec: ConsoleSpec;
  detect(data: Uint8Array): boolean;
  create(): Console;
}

/**
 * Hardware + identity description for one console. Pure data — no
 * runtime behavior.
 */
export interface ConsoleSpec {
  /** Stable internal identifier, e.g. `'nes'`, `'poncho-nes'`. */
  id: string;
  /** Short display name, e.g. `'NES'`. */
  name: string;
  /** Full display name. */
  fullName: string;
  /** One-line marketing description. */
  shortDesc: string;
  /** Original real-hardware release year (omitted for virtual consoles). */
  releaseYear?: number;
  /**
   * `'working'` runs games today, considered stable.
   * `'beta'` boots and renders, but feature gaps remain (sprite-0 hit,
   * 8×16 sprites, mapper-IRQ accuracy, etc.).
   */
  status: 'working' | 'beta';

  cpu: CpuSpec;
  ppu: PpuSpec;
  apu: ApuSpec;
  cart: CartSpec;
}

export interface CpuSpec {
  name: string;
  clockMhz: number;
  notes?: string;
}

export interface PpuSpec {
  name: string;
  resolution: { width: number; height: number };
  /** Master-palette size: integer (NES 64) or `'rgba'` for per-ROM 32-bit. */
  paletteMaster: number | 'rgba';
  /** Total colours simultaneously visible. */
  colorsOnScreen: number;
  palettes: { background: number; sprite: number; entriesPerPalette: number };
  /** Native sprite tile size. */
  spriteSize: { width: number; height: number };
  /** Maximum sprites in OAM. */
  spritesTotal: number;
  /** Hardware limit per scanline. */
  spritesPerLine: number;
  notes?: string;
}

export interface ApuSpec {
  name: string;
  channels: string[];
  notes?: string;
}

export interface CartSpec {
  format: string;
  /** Header magic bytes, displayed as text or hex (e.g. `'NES\\x1A'`). */
  magic: string;
  /** How many distinct mappers the runtime supports. */
  mappersSupported: number;
  notes?: string;
}
