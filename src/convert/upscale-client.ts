/**
 * AI tile upscaler — the single boundary that pipelines (CHR-ROM
 * conversion-time, CHR-RAM runtime worker, tests) call into.
 *
 * Implementations:
 *   - `MockUpscaleClient` — deterministic 4×4 nearest-neighbour expansion.
 *     Used by tests and as the safe fallback when no API key is configured.
 *   - `NanoBananaClient` — wraps Google's Gemini 2.5 Flash Image API.
 *     Skeleton today (no real network call); Phase 2/3 of the v0.4 plan
 *     wires up the actual transport.
 *
 * The interface is deliberately tile-shaped (16-byte NES tile in,
 * 1024-byte Poncho tile out). Batching, caching, and rate-limiting are
 * the *caller's* concern — the client itself is just a transform.
 */

import {
  AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
  AI_CACHE_MODEL_NANOBANANA_25_FLASH,
} from '../core/cart-poncho/ai-cache';

export class UpscaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpscaleError';
  }
}

export interface UpscaleClient {
  /**
   * Stable id for the model behind this client. Stored in the AI cache
   * section's header so the runtime can invalidate stale entries when
   * the user switches models.
   */
  readonly modelId: number;

  /**
   * Upscale a single 8×8 NES tile (16-byte 2 bpp planar) into a 32×32
   * Poncho tile (1024-byte 8 bpp linear). Sub-palette indices give the
   * client context for picking colours; pv 0 = transparent / universal-BG.
   *
   * Throws `UpscaleError` on transport failure. Callers catch + fall back
   * to nearest-neighbour for that tile (or substitute, depending on policy).
   */
  upscaleTile(nesTile: Uint8Array, subPalette: Uint8Array): Promise<Uint8Array>;
}

/**
 * Deterministic 4×4 nearest-neighbour upscale. Used by tests + when the
 * user hasn't configured an API key. Same per-pixel transform as
 * PpuUltra's runtime upscaled-CHR render path, just baked into a tile.
 */
export class MockUpscaleClient implements UpscaleClient {
  readonly modelId = AI_CACHE_MODEL_NEAREST_NEIGHBOUR;

  async upscaleTile(nesTile: Uint8Array, _subPalette: Uint8Array): Promise<Uint8Array> {
    if (nesTile.length !== 16) {
      throw new UpscaleError(`expected 16-byte NES tile, got ${nesTile.length}`);
    }
    const out = new Uint8Array(1024);
    // Decode 8×8 2 bpp → 32×32 8 bpp via 4×4 block replication.
    for (let y = 0; y < 8; y++) {
      const plane0 = nesTile[y]!;
      const plane1 = nesTile[y + 8]!;
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x;
        const pv = ((plane0 >> bit) & 1) | (((plane1 >> bit) & 1) << 1);
        const dy0 = y * 4;
        const dx0 = x * 4;
        for (let dy = 0; dy < 4; dy++) {
          const row = (dy0 + dy) * 32 + dx0;
          out[row + 0] = pv;
          out[row + 1] = pv;
          out[row + 2] = pv;
          out[row + 3] = pv;
        }
      }
    }
    return out;
  }
}

/**
 * Skeleton for the nanobanana / Gemini 2.5 Flash Image client. Phase 2
 * fills in the actual transport (PNG encode, HTTPS POST, decode).
 */
export interface NanoBananaConfig {
  /** Google AI Studio API key. */
  apiKey: string;
  /** Override the model name string (default: `gemini-2.5-flash-image`). */
  modelName?: string;
  /** Optional fetch override for testing / proxy. */
  fetch?: typeof fetch;
}

export class NanoBananaClient implements UpscaleClient {
  readonly modelId = AI_CACHE_MODEL_NANOBANANA_25_FLASH;

  constructor(_config: NanoBananaConfig) {
    // Phase 2: store apiKey, modelName, fetch.
    // Phase 2: wire up actual API transport.
  }

  async upscaleTile(_nesTile: Uint8Array, _subPalette: Uint8Array): Promise<Uint8Array> {
    throw new UpscaleError(
      'NanoBananaClient.upscaleTile not yet implemented — wire up in v0.4 Phase 2',
    );
  }
}
