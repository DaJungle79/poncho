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
 * NanoBanana — Google Gemini 2.5 Flash Image transport.
 *
 * Browser-only by design: PNG encode/decode rides on the platform Canvas
 * API. CLI / Node tooling sticks with `MockUpscaleClient` (or a future
 * Node-side codec) — running this client outside a browser throws a
 * clear error.
 *
 * Per-call shape:
 *   - render the 8×8 NES tile as RGBA using the supplied sub-palette
 *   - upscale 4× (32×32) with nearest-neighbour as a "primer" so the
 *     model has enough pixels to reason about
 *   - POST to `…:generateContent` with the primer + a directive prompt
 *   - extract the returned PNG, decode to RGBA, snap each pixel back to
 *     the closest pv (0..3) in the sub-palette → 1024-byte native tile
 *
 * Pixel values stay in the NES 0..3 range — the runtime still applies
 * palette through `paletteRam[subPalette*4 + pv]`. The "AI advantage"
 * is shape: smoother edges and gradients, not extra colours.
 *
 * Untestable without a real key + network. The pipeline tests exercise
 * the orchestrator with `MockUpscaleClient`; real transport correctness
 * is verified manually.
 */
export interface NanoBananaConfig {
  /** Google AI Studio API key. */
  apiKey: string;
  /** Override the model name (default: `gemini-2.5-flash-image`). */
  modelName?: string;
  /** Override fetch for testing / proxy. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Tweak the upscale prompt. Defaults to a pixel-art-friendly one. */
  prompt?: string;
}

const DEFAULT_PROMPT =
  'Upscale this 8×8 NES sprite 4× to 32×32 pixels. Smooth the edges, ' +
  'add subtle anti-aliasing, but keep the original 4-colour palette ' +
  'and silhouette. Output a PNG with exactly the same colours. No background changes.';

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class NanoBananaClient implements UpscaleClient {
  readonly modelId = AI_CACHE_MODEL_NANOBANANA_25_FLASH;

  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly prompt: string;

  constructor(config: NanoBananaConfig) {
    if (!config.apiKey) {
      throw new UpscaleError('NanoBananaClient requires an apiKey');
    }
    this.apiKey = config.apiKey;
    this.modelName = config.modelName ?? DEFAULT_MODEL;
    this.fetchImpl = config.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null as never);
    this.prompt = config.prompt ?? DEFAULT_PROMPT;
    if (!this.fetchImpl) {
      throw new UpscaleError('NanoBananaClient: no fetch available in this environment');
    }
  }

  async upscaleTile(nesTile: Uint8Array, subPalette: Uint8Array): Promise<Uint8Array> {
    if (nesTile.length !== 16) {
      throw new UpscaleError(`expected 16-byte NES tile, got ${nesTile.length}`);
    }
    if (subPalette.length < 4) {
      throw new UpscaleError(`expected sub-palette of ≥4 bytes, got ${subPalette.length}`);
    }
    if (typeof OffscreenCanvas === 'undefined') {
      throw new UpscaleError(
        'NanoBananaClient is browser-only — OffscreenCanvas not available',
      );
    }

    // Render NES tile → 32×32 RGBA primer (NN 4×).
    const primerRgba = renderTile32(nesTile, subPalette);
    const primerPngBase64 = await rgbaToPngBase64(primerRgba, 32, 32);

    const url = `${API_BASE}/${this.modelName}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      contents: [{
        parts: [
          { text: this.prompt },
          { inlineData: { mimeType: 'image/png', data: primerPngBase64 } },
        ],
      }],
    };

    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new UpscaleError(`Gemini API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json: GeminiResponse = await resp.json();
    const out = extractFirstImage(json);
    if (!out) {
      throw new UpscaleError('Gemini response contained no image part');
    }
    const decoded = await decodePngTo32(out);
    return snapToPaletteIndices(decoded, subPalette);
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ inlineData?: { data: string; mimeType?: string } }>;
    };
  }>;
}

function extractFirstImage(json: GeminiResponse): string | null {
  for (const cand of json.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (part.inlineData?.data) return part.inlineData.data;
    }
  }
  return null;
}

/**
 * Render an 8×8 NES tile as a 32×32 RGBA primer. Uses the NES master
 * palette indices in `subPalette` to pick canonical NES colours.
 */
function renderTile32(nesTile: Uint8Array, subPalette: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 0; y < 8; y++) {
    const p0 = nesTile[y]!;
    const p1 = nesTile[y + 8]!;
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      const pv = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1);
      const masterIdx = subPalette[pv]! & 0x3f;
      const r = NES_RGB[masterIdx * 3 + 0]!;
      const g = NES_RGB[masterIdx * 3 + 1]!;
      const b = NES_RGB[masterIdx * 3 + 2]!;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const px = ((y * 4 + dy) * 32 + (x * 4 + dx)) * 4;
          rgba[px] = r; rgba[px + 1] = g; rgba[px + 2] = b; rgba[px + 3] = 0xff;
        }
      }
    }
  }
  return rgba;
}

async function rgbaToPngBase64(rgba: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, w, h);
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  // base64 — chunk to avoid stack overflow on big arrays (small here, but cheap).
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode(...buf.subarray(i, Math.min(i + 0x8000, buf.length)));
  }
  return btoa(s);
}

async function decodePngTo32(base64: string): Promise<Uint8ClampedArray> {
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const blob = new Blob([buf as BlobPart], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, 32, 32);
  return ctx.getImageData(0, 0, 32, 32).data;
}

/**
 * Snap a 32×32 RGBA buffer back to pv 0..3 by finding the closest
 * NES-master-palette colour for each pixel from the supplied sub-palette.
 */
function snapToPaletteIndices(rgba: Uint8ClampedArray, subPalette: Uint8Array): Uint8Array {
  const out = new Uint8Array(1024);
  const pr = [0, 0, 0, 0], pg = [0, 0, 0, 0], pb = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const m = subPalette[i]! & 0x3f;
    pr[i] = NES_RGB[m * 3]!;
    pg[i] = NES_RGB[m * 3 + 1]!;
    pb[i] = NES_RGB[m * 3 + 2]!;
  }
  for (let p = 0; p < 1024; p++) {
    const r = rgba[p * 4]!, g = rgba[p * 4 + 1]!, b = rgba[p * 4 + 2]!;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 4; i++) {
      const dr = r - pr[i]!, dg = g - pg[i]!, db = b - pb[i]!;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    out[p] = best;
  }
  return out;
}

// Inline NES master palette (R,G,B per entry × 64). Mirrors
// `NES_MASTER_PALETTE_RGBA` but as a flat RGB triple table for distance work.
const NES_RGB = new Uint8Array([
  0x62,0x62,0x62, 0x00,0x1f,0xb2, 0x24,0x04,0xc8, 0x52,0x00,0xb2,
  0x73,0x00,0x76, 0x80,0x00,0x24, 0x73,0x0b,0x00, 0x52,0x28,0x00,
  0x24,0x44,0x00, 0x00,0x57,0x00, 0x00,0x5c,0x00, 0x00,0x53,0x24,
  0x00,0x3c,0x76, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00,
  0xab,0xab,0xab, 0x0d,0x57,0xff, 0x4b,0x30,0xff, 0x8a,0x13,0xff,
  0xbc,0x08,0xd6, 0xd2,0x12,0x69, 0xc7,0x2e,0x00, 0x9d,0x54,0x00,
  0x60,0x7b,0x00, 0x20,0x98,0x00, 0x00,0xa3,0x00, 0x00,0x99,0x42,
  0x00,0x7d,0xb4, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00,
  0xff,0xff,0xff, 0x53,0xae,0xff, 0x90,0x85,0xff, 0xd3,0x65,0xff,
  0xff,0x57,0xff, 0xff,0x5d,0xcf, 0xff,0x77,0x57, 0xfa,0x9e,0x00,
  0xbd,0xc7,0x00, 0x7a,0xe7,0x00, 0x43,0xf6,0x11, 0x26,0xef,0x7e,
  0x2c,0xd5,0xf6, 0x4e,0x4e,0x4e, 0x00,0x00,0x00, 0x00,0x00,0x00,
  0xff,0xff,0xff, 0xb6,0xe1,0xff, 0xce,0xd1,0xff, 0xe9,0xc3,0xff,
  0xff,0xbc,0xff, 0xff,0xbd,0xf4, 0xff,0xc6,0xc3, 0xff,0xd5,0x9a,
  0xe9,0xe6,0x81, 0xce,0xf4,0x81, 0xb6,0xfb,0x9a, 0xa9,0xfa,0xc3,
  0xa9,0xf0,0xf4, 0xb8,0xb8,0xb8, 0x00,0x00,0x00, 0x00,0x00,0x00,
]);
