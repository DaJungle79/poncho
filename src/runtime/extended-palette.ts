/**
 * Extended sub-palette generator — Phase 4.6 of v0.4.
 *
 * The on-cart palette in upscaled-mode is still a NES-shape 4-entry
 * sub-palette (4 master indices). PpuUltra's render path used to mask
 * `pv & 3` so each tile pixel could only carry one of those 4 colours.
 * Phase 4.6 lifts that cap by *expanding* each sub-palette into a
 * 256-entry RGBA table built deterministically from the four base
 * colours, with shading ramps that give AI-baked tiles room to express
 * gradients, anti-aliased edges, and material highlights without
 * changing the cartridge's runtime palette state.
 *
 * Encoding (also documented in `docs/poncho-rom.md`):
 *
 *   - **pv 0..3**       sub-palette entries 0..3 verbatim (NES legacy).
 *                       Existing AI caches (built before Phase 4.6) only
 *                       used pv 0..3, so they continue to render
 *                       correctly without any format-version bump.
 *
 *   - **pv 4..87**      84-entry shading ramp of *base 1* (sub-palette
 *                       entry 1). shade index = pv - 4 (range 0..83).
 *                       Linear RGB interpolation: shade 0 = black,
 *                       shade 41 = base 1, shade 83 = white.
 *
 *   - **pv 88..171**    same shape, ramp of *base 2*. base at pv 129.
 *
 *   - **pv 172..255**   same shape, ramp of *base 3*. base at pv 213.
 *
 * The runtime sub-palette is whatever's in `paletteRam` for that
 * sub-palette index. Switching sub-palettes during play picks new base
 * colours → triggers a fresh extended-palette regeneration. Same tile
 * bytes can render with completely different mood across sub-palettes.
 *
 * Output is `Uint32Array(256)` with each entry packed as the same ABGR
 * layout PpuUltra uses internally: `(a << 24) | (b << 16) | (g << 8) | r`.
 */

/** Total entries in an extended sub-palette. */
export const EXTENDED_PALETTE_SIZE = 256;

/** Ramp bounds and base-shade index. Exported for tests + render-path lookup. */
export const RAMP_LENGTH = 84;
export const RAMP_BASE_SHADE = 41; // shade index where the ramp's base colour sits

/** Layout: pv ranges per ramp. */
export const RAMP_BASE1_START = 4;
export const RAMP_BASE2_START = 88;
export const RAMP_BASE3_START = 172;

/**
 * Build a 256-entry extended sub-palette from four NES master indices.
 *
 *   subPalette  4-byte buffer, NES-shape — the four entries from
 *               `paletteRam[subPaletteIndex * 4 + 0..3]`.
 *   master      32-bit RGBA palette (the cartridge's master palette,
 *               same layout PpuUltra uses internally).
 */
export function buildExtendedSubPalette(
  subPalette: Uint8Array,
  master: Uint32Array,
): Uint32Array {
  if (subPalette.length < 4) {
    throw new Error(`buildExtendedSubPalette: sub-palette must have ≥4 entries, got ${subPalette.length}`);
  }
  const masterLen = master.length;
  if (masterLen === 0) {
    throw new Error('buildExtendedSubPalette: master palette is empty');
  }

  const out = new Uint32Array(EXTENDED_PALETTE_SIZE);

  // Legacy slots — pv 0..3 mirror the NES sub-palette directly so old
  // (pre-4.6) AI caches still render correctly.
  for (let i = 0; i < 4; i++) {
    out[i] = master[subPalette[i]! % masterLen]!;
  }

  // Three ramps for the three "real" bases (entry 0 is universal-BG;
  // shading ramps for it would render mostly-transparent in sprite
  // mode and confuse BG mode, so we skip).
  fillRamp(out, RAMP_BASE1_START, master[subPalette[1]! % masterLen]!);
  fillRamp(out, RAMP_BASE2_START, master[subPalette[2]! % masterLen]!);
  fillRamp(out, RAMP_BASE3_START, master[subPalette[3]! % masterLen]!);

  return out;
}

/**
 * Write `RAMP_LENGTH` (84) consecutive entries starting at `start`,
 * forming a black → base → white linear ramp through the base colour
 * at shade `RAMP_BASE_SHADE` (= 41).
 *
 * Below the base shade: linear blend from black to base.
 * Above the base shade: linear blend from base to white.
 */
function fillRamp(out: Uint32Array, start: number, baseRgba: number): void {
  const r = baseRgba & 0xff;
  const g = (baseRgba >> 8) & 0xff;
  const b = (baseRgba >> 16) & 0xff;
  const a = (baseRgba >> 24) & 0xff;

  for (let shade = 0; shade < RAMP_LENGTH; shade++) {
    let nr: number, ng: number, nb: number;
    if (shade <= RAMP_BASE_SHADE) {
      // Black at shade 0 → base at shade RAMP_BASE_SHADE.
      const t = shade / RAMP_BASE_SHADE; // 0..1
      nr = Math.round(r * t);
      ng = Math.round(g * t);
      nb = Math.round(b * t);
    } else {
      // Base at shade RAMP_BASE_SHADE → white at shade RAMP_LENGTH-1.
      const t = (shade - RAMP_BASE_SHADE) / (RAMP_LENGTH - 1 - RAMP_BASE_SHADE);
      nr = Math.round(r + (255 - r) * t);
      ng = Math.round(g + (255 - g) * t);
      nb = Math.round(b + (255 - b) * t);
    }
    out[start + shade] = ((a << 24) | (nb << 16) | (ng << 8) | nr) >>> 0;
  }
}

/**
 * Helper for the snap-back side: given a target RGB, find the closest
 * pv value in an extended sub-palette. Used by RGB-output upscale
 * clients (e.g. ESRGAN/ONNX) to map model output back to a tile's
 * 8 bpp pv stream. Returns the exact pv that minimises sum-of-squares
 * distance in RGB space.
 */
export function snapToExtendedPalette(
  r: number,
  g: number,
  b: number,
  extended: Uint32Array,
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < extended.length; i++) {
    const c = extended[i]!;
    const er = c & 0xff;
    const eg = (c >> 8) & 0xff;
    const eb = (c >> 16) & 0xff;
    const dr = r - er, dg = g - eg, db = b - eb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
