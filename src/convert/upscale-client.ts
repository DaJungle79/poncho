/**
 * Upscale client — the single tile-shaped boundary that the bake-now
 * pipeline (`convertInesToPonchoAi`) and the runtime worker
 * (`UpscaleWorker`) call into.
 *
 * The interface is deliberately narrow: 16-byte NES tile in, 1024-byte
 * Poncho native tile out. Batching, caching, retry, model-specific
 * config, and prompt construction are all the *caller's* concern — the
 * client itself is just a transform. This keeps the seam clean for
 * very different upscalers (deterministic NN, locally-hosted ESRGAN /
 * ONNX-on-WebGPU, future cloud APIs) to plug in without rewiring the
 * pipeline.
 *
 * Models register themselves via the registry in
 * [`upscale-registry.ts`](./upscale-registry.ts). The active selection
 * (one for CHR-ROM bake-now, one for CHR-RAM runtime — see
 * `config.ai`) drives which factory `App` invokes.
 */

import { AI_CACHE_MODEL_NEAREST_NEIGHBOUR } from '../core/cart-poncho/ai-cache';

export class UpscaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpscaleError';
  }
}

export interface UpscaleClient {
  /**
   * Stable numeric id for the model behind this client. Stored in the
   * AI cache section's header so the runtime can spot stale entries
   * when the user switches models. Each registered `UpscaleModel`
   * supplies its own id; reuse the same constants in `ai-cache.ts`.
   */
  readonly modelId: number;

  /**
   * Upscale a single 8×8 NES tile (16-byte 2 bpp planar) into a 32×32
   * Poncho tile (1024-byte 8 bpp linear, pv 0..3 today; future
   * extended-palette work will widen the range). `subPalette` carries
   * 4 NES master indices for context — RGB-output models render the
   * input through this palette before inference.
   *
   * Throws `UpscaleError` on failure. Callers catch and fall back to
   * nearest-neighbour for that tile (or substitute, depending on policy).
   */
  upscaleTile(nesTile: Uint8Array, subPalette: Uint8Array): Promise<Uint8Array>;

  /**
   * Optional pre-flight: load weights, create the inference session,
   * verify the runtime is usable. Bake-now callers invoke this before
   * the per-tile loop so a missing model file or broken WebGPU surface
   * fails the whole conversion loudly instead of silently
   * NN-fallbacking every tile (which looks identical to a successful
   * bake). Implementations that have no setup cost (e.g. NN) leave
   * this unset.
   *
   * Throws `UpscaleError` on hard failure.
   */
  preflight?(): Promise<void>;
}

/**
 * Deterministic 4×4 nearest-neighbour upscale. The default / fallback
 * client — same per-pixel transform as PpuUltra's runtime upscaled-CHR
 * render path, just baked into a tile so the same code path can route
 * "no AI configured" through the cache layers without special-casing.
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
