/**
 * Console detection registry. The shell hands ROM bytes to
 * `detectConsole`; the first registered factory whose `detect()`
 * returns true wins. Adding a new console is a one-line change here:
 * push a new factory.
 */

import { isPonchoRom } from '../core/cart-poncho/header';
import type { ConsoleFactory } from './console';
import { Nes } from './nes';
import { PonchoNes } from './poncho-nes';
import { NES_SPEC, PONCHO_NES_SPEC } from './specs';

/** The standard iNES magic: `NES\x1A`. */
function isInes(data: Uint8Array): boolean {
  return data.length >= 4
      && data[0] === 0x4e
      && data[1] === 0x45
      && data[2] === 0x53
      && data[3] === 0x1a;
}

/**
 * Order matters: more-specific magics first. PonchoROM uses `PNCH`
 * which is unambiguous, so order is largely cosmetic, but stable
 * ordering keeps detection deterministic if we ever add a format
 * that overlaps with another.
 */
export const CONSOLE_FACTORIES: ReadonlyArray<ConsoleFactory> = Object.freeze([
  {
    spec: PONCHO_NES_SPEC,
    detect: isPonchoRom,
    create: () => new PonchoNes(),
  },
  {
    spec: NES_SPEC,
    detect: isInes,
    create: () => new Nes(),
  },
]);

export function detectConsole(data: Uint8Array): ConsoleFactory | null {
  for (const factory of CONSOLE_FACTORIES) {
    if (factory.detect(data)) return factory;
  }
  return null;
}
