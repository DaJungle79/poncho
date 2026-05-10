/**
 * `XbrzUpscaleClient` — palette-aware xBRZ wrapped as an `UpscaleClient`.
 * Phase 3 of v0.5.
 *
 * This is the "headline feature" of v0.5: a deterministic real-time
 * scaler whose output snaps cleanly into Phase 4.6's extended
 * sub-palette and is cacheable in the `.poncho` AI cache section.
 * Every other emulator's xBRZ runs at the post-render display layer
 * (RGB pixels straight to canvas, never persisted). Here we run
 * xBRZ on a per-tile primer, snap each output RGB to an extended
 * pv value, and feed the result through the same UpscaleClient
 * boundary the v0.4 ML candidates used.
 *
 * Pipeline per tile:
 *
 *   1. `renderPrimer`              — 16-byte NES tile + 4-byte sub-palette
 *                                    → 8×8 RGBA in real sub-palette colours
 *   2. xBRZ 4×                     — 8×8 RGBA → 32×32 RGBA
 *                                    (with edge clamping at the tile boundary —
 *                                    "Option A" from the v0.5 plan; output is
 *                                    deterministic per-tile)
 *   3. `buildExtendedSubPalette`   — 4 sub-palette indices + master palette
 *                                    → 256-entry RGBA snap target
 *   4. `snapToExtendedPalette` ×1024 — each output pixel → pv 0..255
 *
 * Output: 1024-byte pv tile, ready for `PonchoCartridge.aiCache`,
 * `PpuUltra.renderScanlineUpscaled` resolver-hit branch, runtime
 * worker write-back.
 *
 * Notes / out-of-scope:
 *   - 5×5 xBRZ kernel reads up to 2 pixels outside the tile. We rely
 *     on `xbrzScale`'s built-in `srcAt` clamping — output along the
 *     1-pixel tile border is slightly over-smoothed vs. a "true"
 *     cross-tile xBRZ but the inner 30×30 is identical, and the
 *     per-tile determinism is what makes write-back meaningful.
 *   - Cross-base blends (e.g. pv=1 of base 1 ↔ pv=2 of base 2) snap
 *     to the closer ramp — the perceptual hue shift on those edges
 *     is documented in the v0.5 plan as "deferred to Phase 3 of v0.6"
 *     (the cross-base blend ramps).
 */

import {
  buildExtendedSubPalette,
  snapToExtendedPalette,
} from './extended-palette';
import { NES_MASTER_PALETTE_RGBA } from '../core/ppu-ultra/nes-master-palette';
import { renderPrimer } from '../convert/clients/onnx-upscale-client';
import { AI_CACHE_MODEL_XBRZ_4X } from '../core/cart-poncho/ai-cache';
import { xbrzScale } from '../renderer/scalers/xbrz';
import { UpscaleError, type UpscaleClient } from '../convert/upscale-client';

const NATIVE_TILE_SIZE = 32;
const PRIMER_SIZE = 8;

/**
 * Pre-pack the canonical NES master palette into ABGR Uint32 form
 * once per process. `buildExtendedSubPalette` reads master entries
 * via `master[idx]` and indexes 0..63 (sub-palette entries hold NES
 * 6-bit master indices). Cached because every tile uses the same
 * master.
 */
let cachedMasterPacked: Uint32Array | null = null;
function packedMasterPalette(): Uint32Array {
  if (cachedMasterPacked) return cachedMasterPacked;
  const count = (NES_MASTER_PALETTE_RGBA.length / 4) | 0;
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const r = NES_MASTER_PALETTE_RGBA[i * 4 + 0]!;
    const g = NES_MASTER_PALETTE_RGBA[i * 4 + 1]!;
    const b = NES_MASTER_PALETTE_RGBA[i * 4 + 2]!;
    const a = NES_MASTER_PALETTE_RGBA[i * 4 + 3]!;
    out[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  cachedMasterPacked = out;
  return out;
}

export class XbrzUpscaleClient implements UpscaleClient {
  readonly modelId: number = AI_CACHE_MODEL_XBRZ_4X;

  /**
   * Cache of (sub-palette key) → 256-entry extended palette. Building
   * the table is the single most expensive step per tile (Phase 4
   * Oklab interpolation does 252 lerpOklab calls = ~2500 transcendental
   * operations). Tiles in the same scene reuse the same sub-palette,
   * so caching cuts the per-tile cost roughly in half. Bounded eviction
   * — we only ever see 4 BG sub-palettes + 4 sprite sub-palettes per
   * cart, so a ~32-entry LRU is safe even for malicious inputs.
   */
  private readonly extCache = new Map<string, Uint32Array>();

  /** Reused scratch buffers — avoids per-tile Uint32Array allocs. */
  private readonly primerU32 = new Uint32Array(PRIMER_SIZE * PRIMER_SIZE);
  private readonly xbrzOut = new Uint32Array(NATIVE_TILE_SIZE * NATIVE_TILE_SIZE);

  /** No setup cost — preflight is a no-op for the deterministic xBRZ path. */
  async preflight(): Promise<void> {
    // Intentional no-op. xBRZ has no model file, no async init.
  }

  async upscaleTile(nesTile: Uint8Array, subPalette: Uint8Array): Promise<Uint8Array> {
    if (nesTile.length !== 16) {
      throw new UpscaleError(`expected 16-byte NES tile, got ${nesTile.length}`);
    }
    if (subPalette.length < 4) {
      throw new UpscaleError(`expected sub-palette of ≥4 bytes, got ${subPalette.length}`);
    }

    // 1. Render 8×8 RGBA primer in real sub-palette colours.
    const primerRgba = renderPrimer(nesTile, subPalette, PRIMER_SIZE);

    // 2. Convert byte-RGBA → packed Uint32 input for xbrzScale (reuse scratch).
    const primerU32 = this.primerU32;
    for (let i = 0; i < primerU32.length; i++) {
      const r = primerRgba[i * 4]!;
      const g = primerRgba[i * 4 + 1]!;
      const b = primerRgba[i * 4 + 2]!;
      const a = primerRgba[i * 4 + 3]!;
      primerU32[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }

    // 3. Run xBRZ 4× → 32×32 packed Uint32 (reuse scratch).
    const xbrzOut = this.xbrzOut;
    xbrzScale(primerU32, PRIMER_SIZE, PRIMER_SIZE, 4, xbrzOut);

    // 4. Build (or look up) the extended sub-palette table.
    const ext = this.getExtendedPalette(subPalette);

    // 5. Per-pixel snap → 1024-byte pv tile.
    const out = new Uint8Array(NATIVE_TILE_SIZE * NATIVE_TILE_SIZE);
    for (let i = 0; i < out.length; i++) {
      const c = xbrzOut[i]!;
      const r = c & 0xff;
      const g = (c >> 8) & 0xff;
      const b = (c >> 16) & 0xff;
      out[i] = snapToExtendedPalette(r, g, b, ext);
    }
    return out;
  }

  /** LRU-ish cache (size-bounded) over the 4-byte sub-palette key. */
  private getExtendedPalette(subPalette: Uint8Array): Uint32Array {
    const key =
      String.fromCharCode(subPalette[0]!) +
      String.fromCharCode(subPalette[1]!) +
      String.fromCharCode(subPalette[2]!) +
      String.fromCharCode(subPalette[3]!);
    const hit = this.extCache.get(key);
    if (hit) return hit;
    const sub4 = subPalette.slice(0, 4);
    const ext = buildExtendedSubPalette(sub4, packedMasterPalette());
    if (this.extCache.size >= 32) {
      // Cheap "drop oldest" eviction. Map preserves insertion order.
      const firstKey = this.extCache.keys().next().value;
      if (firstKey !== undefined) this.extCache.delete(firstKey);
    }
    this.extCache.set(key, ext);
    return ext;
  }
}
