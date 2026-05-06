/**
 * The 64-entry NES master palette converted to flat RGBA bytes.
 * Used by Poncho-NES when running an iNES ROM in NES-compat mode —
 * the cartridge has no master palette of its own (iNES has no palette
 * data section), so the runtime supplies the canonical 2C02 palette
 * for `PpuUltra.setMasterPalette()` to consume.
 *
 * Source: `src/core/ppu/palette.ts` (`NES_PALETTE`, ABGR-packed
 * Uint32). We unpack into the RGBA byte order Poncho-NES master
 * palettes use.
 */

import { NES_PALETTE } from '../ppu/palette';

export const NES_MASTER_PALETTE_RGBA: Uint8Array = (() => {
  const out = new Uint8Array(NES_PALETTE.length * 4);
  for (let i = 0; i < NES_PALETTE.length; i++) {
    const v = NES_PALETTE[i]!;
    // ABGR (LE): byte 0 = R, byte 1 = G, byte 2 = B, byte 3 = A.
    out[i * 4 + 0] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
})();
