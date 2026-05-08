/**
 * Tile cache — the unified lookup layer used by both AI pipelines.
 *
 * Cache architecture (Phase 1):
 *
 *   ┌─ in-memory file-cache (per cart) ────────┐
 *   │  Built from a cart's AI cache section on  │
 *   │  load. Lookup: O(1). Mutated as the AI    │
 *   │  worker delivers tiles; serialised back   │
 *   │  to the .poncho file on save triggers.    │
 *   └─────────────────┬─────────────────────────┘
 *                     │ miss
 *                     ▼
 *   ┌─ global cache (cross-cart, IndexedDB) ───┐
 *   │  Same hash key → same upscaled tile,     │
 *   │  regardless of which ROM produced it.    │
 *   │  Persists across browser sessions.       │
 *   └─────────────────┬─────────────────────────┘
 *                     │ miss
 *                     ▼
 *   ┌─ UpscaleClient (network or fallback) ────┐
 *   │  Fires the API call (slow). Or returns   │
 *   │  the deterministic 4×4 NN upscale.       │
 *   └───────────────────────────────────────────┘
 *
 * On a successful AI result, write to BOTH layers (file-cache for
 * portability; global-cache for cross-game reuse).
 *
 * The global-cache implementation is provided externally — Phase 1
 * ships a `MemoryGlobalCache` for tests; Phase 2/3 add `IDBGlobalCache`
 * (browser) and `FsGlobalCache` (CLI).
 */

import type { AiCacheEntry, AiCacheSection } from '../core/cart-poncho/ai-cache';
import {
  AI_CACHE_VERSION,
  AI_CACHE_MODEL_UNSPECIFIED,
} from '../core/cart-poncho/ai-cache';
import type { UpscaleClient } from './upscale-client';

/** Hex string of a 16-byte SHA-256-truncated-128 hash. Used as a Map key. */
export type TileHashHex = string;

/** Storage backend for cache entries that survive across cartridges. */
export interface GlobalTileCache {
  get(hash: TileHashHex, modelId: number): Promise<Uint8Array | null>;
  put(hash: TileHashHex, modelId: number, nativeTile: Uint8Array): Promise<void>;
  /** Diagnostic: total cached entries across all models. */
  size(): Promise<number>;
}

/**
 * Trivial in-memory implementation of `GlobalTileCache`. Phase 1 default;
 * Phase 2/3 swap in IndexedDB / fs-backed versions.
 */
export class MemoryGlobalCache implements GlobalTileCache {
  private readonly store = new Map<string, Uint8Array>();
  private key(hash: TileHashHex, modelId: number): string {
    return `${modelId}:${hash}`;
  }
  async get(hash: TileHashHex, modelId: number): Promise<Uint8Array | null> {
    return this.store.get(this.key(hash, modelId)) ?? null;
  }
  async put(hash: TileHashHex, modelId: number, nativeTile: Uint8Array): Promise<void> {
    this.store.set(this.key(hash, modelId), nativeTile);
  }
  async size(): Promise<number> {
    return this.store.size;
  }
}

/**
 * Per-cart in-memory cache, seeded from the cartridge's AI cache section.
 * Tracks dirty state so the runtime knows when to write back.
 */
export class FileTileCache {
  private readonly map = new Map<TileHashHex, AiCacheEntry>();
  private dirty = false;
  /** Model id that produced the current entries. Set on first add or by `loadFromSection`. */
  private model: number;

  constructor(modelId: number = AI_CACHE_MODEL_UNSPECIFIED) {
    this.model = modelId;
  }

  /**
   * Seed from a parsed AI cache section. Entries whose model doesn't
   * match the active model are dropped (stale relative to current
   * upscaler choice — runtime treats them as cache misses, regenerates).
   */
  loadFromSection(section: AiCacheSection, activeModelId: number): void {
    this.model = activeModelId;
    this.map.clear();
    if (section.model !== activeModelId) {
      // Different model produced these entries. Discard for runtime use,
      // but DO NOT mark dirty — we want the on-disk entries preserved
      // until they're actually overwritten by new upscales.
      return;
    }
    for (const e of section.entries) {
      this.map.set(hashToHex(e.hash), e);
    }
  }

  get(hash: TileHashHex): Uint8Array | null {
    return this.map.get(hash)?.nativeTile ?? null;
  }

  put(hash: TileHashHex, nesTile: Uint8Array, nativeTile: Uint8Array): void {
    if (hash.length !== 32) {
      throw new Error(`tile hash hex must be 32 chars (got ${hash.length})`);
    }
    if (nesTile.length !== 16) {
      throw new Error(`nesTile must be 16 bytes (got ${nesTile.length})`);
    }
    if (nativeTile.length !== 1024) {
      throw new Error(`nativeTile must be 1024 bytes (got ${nativeTile.length})`);
    }
    const hashBytes = hexToHash(hash);
    this.map.set(hash, { hash: hashBytes, nesTile, nativeTile });
    this.dirty = true;
  }

  isDirty(): boolean { return this.dirty; }
  clearDirty(): void { this.dirty = false; }
  size(): number { return this.map.size; }

  /** Snapshot the current cache as a `.poncho`-writable section. */
  toSection(): AiCacheSection {
    return {
      formatVersion: AI_CACHE_VERSION,
      model: this.model,
      entries: Array.from(this.map.values()),
    };
  }
}

/**
 * High-level facade: file-cache → global-cache → upscaler. Hides the
 * layering from callers that just want "give me an upscaled tile".
 */
export interface TileCacheLayers {
  file: FileTileCache;
  global: GlobalTileCache;
  client: UpscaleClient;
}

/**
 * Get an upscaled tile, walking file → global → client. Promotes results
 * up the layers on the way back so subsequent lookups are faster.
 *
 * The `subPalette` array is hashed in to differentiate identical NES
 * tile bytes rendered with different palettes (which produce different
 * upscaled outputs).
 */
export async function getOrUpscaleTile(
  layers: TileCacheLayers,
  nesTile: Uint8Array,
  subPalette: Uint8Array,
): Promise<Uint8Array> {
  const hashHex = await hashTile(nesTile, subPalette);

  // File-cache (per-cart, in memory) — cheapest.
  const fromFile = layers.file.get(hashHex);
  if (fromFile !== null) return fromFile;

  // Global cache (IndexedDB / on-disk).
  const fromGlobal = await layers.global.get(hashHex, layers.client.modelId);
  if (fromGlobal !== null) {
    layers.file.put(hashHex, nesTile, fromGlobal);
    return fromGlobal;
  }

  // Miss everywhere — call the AI.
  const upscaled = await layers.client.upscaleTile(nesTile, subPalette);
  await layers.global.put(hashHex, layers.client.modelId, upscaled);
  layers.file.put(hashHex, nesTile, upscaled);
  return upscaled;
}

// ---------------------------------------------------------------------------
// Tile hashing
// ---------------------------------------------------------------------------

/**
 * Hash a NES tile + sub-palette into a 16-byte SHA-256-truncated-128
 * digest, returned as a 32-char lowercase hex string. Same NES bytes +
 * palette → same hash; different palette → different hash (so the same
 * tile rendered with different sub-palettes upscales separately).
 *
 * Uses the Web Crypto API (available in browsers + Node ≥ 19). Falls
 * back to a pure-JS SHA-256 implementation in environments that don't
 * provide it (mostly older Node — vitest uses Node 20+ so this is
 * defensive; we ship the fallback for safety).
 */
export async function hashTile(
  nesTile: Uint8Array,
  subPalette: Uint8Array,
): Promise<TileHashHex> {
  const buf = new Uint8Array(nesTile.length + subPalette.length);
  buf.set(nesTile, 0);
  buf.set(subPalette, nesTile.length);

  let digestBytes: Uint8Array;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const ab = await crypto.subtle.digest('SHA-256', buf);
    digestBytes = new Uint8Array(ab);
  } else {
    digestBytes = sha256Sync(buf);
  }
  return hashToHex(digestBytes.subarray(0, 16));
}

/** Convert a 16-byte hash to a 32-char lowercase hex string. */
export function hashToHex(bytes: Uint8Array): TileHashHex {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/** Inverse of `hashToHex`. */
export function hexToHash(hex: TileHashHex): Uint8Array {
  if (hex.length !== 32) {
    throw new Error(`hex must be 32 chars (got ${hex.length})`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure-JS SHA-256 fallback (RFC 6234)
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number { return (x >>> n) | (x << (32 - n)); }

function sha256Sync(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const padLen = ((input.length + 9 + 63) & ~63) - input.length;
  const buf = new Uint8Array(input.length + padLen);
  buf.set(input);
  buf[input.length] = 0x80;
  // Length in bits, big-endian, last 8 bytes.
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 4, bitLen >>> 0, false);
  view.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000), false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let chunk = 0; chunk < buf.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(chunk + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!;
    let e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i]!, false);
  return out;
}
