/**
 * Runtime AI upscale worker — the lazy-bake counterpart to the bake-now
 * pipeline (`convertInesToPonchoAi`). Used when a Poncho-NES cartridge
 * has CHR-RAM: tiles are uploaded by PRG at runtime, so we can't bake
 * them up-front. Instead, the renderer calls `resolveSync(tile, palette)`
 * each frame:
 *
 *   - If the upscaled tile is already cached (in-memory or seeded from
 *     the cartridge's `aiCache` section), it's returned immediately and
 *     the renderer paints it as a 32×32 native tile.
 *   - If not, the worker schedules an async fetch (file → global → API
 *     client), the call returns null, and the renderer falls back to
 *     nearest-neighbour for that tile *for this frame only*. When the
 *     async fetch completes, the result is stored in the cache and the
 *     next frame picks it up — tiles "pop in" as they're upscaled.
 *
 * The worker dedupes in-flight requests by raw (tile + palette) bytes,
 * so a tile rendered every frame only triggers one API call.
 *
 * Two parallel indices:
 *
 *   - `byRaw`  (rawKey → native tile) — hot-path lookup, no hashing.
 *     Built up as tiles are resolved.
 *   - `byHash` (TileHashHex → native tile) — populated when seeding
 *     from the cartridge's AI cache section. Promoted into `byRaw` on
 *     first runtime query (one sync SHA-256 per unique tile, then free
 *     forever).
 *
 * `entries` (rawKey → { nesTile, native, hash }) is the source-of-truth
 * for serialisation back into a `.poncho` file. The web shell's periodic
 * flush + unload hooks call `toSection()` and write the bytes into the
 * cartridge's AI cache slot.
 */

import {
  AI_CACHE_VERSION,
  type AiCacheSection,
} from '../core/cart-poncho/ai-cache';
import {
  TILE_HASH_PALETTE,
  hashTileSync,
  hashToHex,
  hexToHash,
  type GlobalTileCache,
  type TileHashHex,
} from '../convert/tile-cache';
import type { UpscaleClient } from '../convert/upscale-client';

export interface UpscaleWorkerConfig {
  /** AI client. Use `MockUpscaleClient` for tests / no-key fallback. */
  client: UpscaleClient;
  /** Optional cross-cart cache (IDB on web; in-memory in tests). */
  globalCache?: GlobalTileCache | null;
  /** Optional seed from a cartridge's parsed `aiCache` section. */
  seed?: AiCacheSection | null;
  /**
   * Fired whenever a previously-pending tile becomes ready. The renderer
   * uses this as a "framebuffer is now stale" signal — typically just
   * triggers a redraw. Optional; the cache is always consistent on next
   * read, so missing this notification only affects timing.
   */
  onTileReady?: () => void;
  /** Override scheduler (tests). Defaults to `queueMicrotask`. */
  schedule?: (fn: () => void) => void;
}

interface CacheEntry {
  nesTile: Uint8Array;     // 16 bytes — kept so we can serialise back
  subPalette: Uint8Array;  // 4 bytes — kept for the same reason
  native: Uint8Array;      // 1024 bytes
  hash: TileHashHex;
}

export class UpscaleWorker {
  private readonly client: UpscaleClient;
  private readonly globalCache: GlobalTileCache | null;
  private readonly onTileReady: (() => void) | null;
  private readonly schedule: (fn: () => void) => void;

  private readonly byRaw = new Map<string, Uint8Array>();
  private readonly byHash = new Map<TileHashHex, Uint8Array>();
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Set<string>();
  private dirty = false;
  /** Tiles still in-flight (for diagnostics + UI status). */
  pendingCount(): number { return this.pending.size; }
  /** Tiles upscaled and cached (for diagnostics + UI status). */
  readyCount(): number { return this.byRaw.size; }

  constructor(config: UpscaleWorkerConfig) {
    this.client = config.client;
    this.globalCache = config.globalCache ?? null;
    this.onTileReady = config.onTileReady ?? null;
    this.schedule = config.schedule
      ?? (typeof queueMicrotask !== 'undefined'
        ? (fn) => queueMicrotask(fn)
        : (fn) => Promise.resolve().then(fn));

    if (config.seed) {
      // Always load the seed regardless of `seed.model` — even when the
      // active client's modelId differs. Reasons:
      //   - AI-baked CHR-ROM carts ship a NanoBanana cache; users
      //     without an API key load with MockClient, but we still want
      //     them to see the AI tiles.
      //   - Misses still go through the active client; on success the
      //     new entry overwrites by hash. Stale model entries get
      //     replaced lazily, never destructively purged.
      for (const e of config.seed.entries) {
        this.byHash.set(hashToHex(e.hash), e.nativeTile);
      }
    }
  }

  /**
   * Hot-path resolver. Returns the upscaled native tile for the given
   * NES tile bytes + sub-palette, or `null` if it isn't ready yet.
   *
   * On miss, schedules an async fetch (via global cache + AI client).
   * Subsequent calls with the same key short-circuit until the fetch
   * resolves — no duplicate API calls.
   *
   * IMPORTANT: this method must NOT throw — the renderer calls it in
   * the inner loop. Errors during fetch are swallowed and logged via
   * the dropped pending key (next frame retries naturally).
   */
  resolveSync(nesTile: Uint8Array, subPalette: Uint8Array): Uint8Array | null {
    if (nesTile.length !== 16) return null;
    if (subPalette.length < 4) return null;
    const key = makeRawKey(nesTile, subPalette);

    const fast = this.byRaw.get(key);
    if (fast) return fast;

    // Disk-seeded entries live in `byHash`. Hash sync once, promote to
    // `byRaw` if found, then mirror in `entries` so write-back keeps
    // the seeded tile (with its full nesTile + palette context).
    //
    // Cache key is `(tile bytes, TILE_HASH_PALETTE)` — same fixed
    // neutral palette used by `convertInesToPonchoAi`, so bake-now
    // tiles hash to the same key the resolver looks up. The actual
    // runtime sub-palette is forwarded only as AI primer context.
    const hash = hashTileSync(nesTile, TILE_HASH_PALETTE);
    const seeded = this.byHash.get(hash);
    if (seeded) {
      this.byRaw.set(key, seeded);
      this.entries.set(key, {
        nesTile: nesTile.slice(),
        subPalette: subPalette.slice(0, 4),
        native: seeded,
        hash,
      });
      return seeded;
    }

    if (!this.pending.has(key)) {
      this.pending.add(key);
      // Snapshot the bytes — caller may mutate the buffers we received.
      const tileSnap = nesTile.slice();
      const palSnap = subPalette.slice(0, 4);
      this.schedule(() => { void this.fetchAsync(tileSnap, palSnap, key, hash); });
    }
    return null;
  }

  private async fetchAsync(
    nesTile: Uint8Array,
    subPalette: Uint8Array,
    key: string,
    hash: TileHashHex,
  ): Promise<void> {
    try {
      let native: Uint8Array | null = null;

      if (this.globalCache) {
        native = await this.globalCache.get(hash, this.client.modelId);
      }
      if (!native) {
        native = await this.client.upscaleTile(nesTile, subPalette);
        if (!native || native.length !== 1024) {
          throw new Error(`upscaler returned ${native?.length ?? 0} bytes`);
        }
        if (this.globalCache) {
          await this.globalCache.put(hash, this.client.modelId, native);
        }
      }

      this.byRaw.set(key, native);
      this.byHash.set(hash, native);
      this.entries.set(key, { nesTile, subPalette, native, hash });
      this.dirty = true;
      this.onTileReady?.();
    } catch {
      // Swallow — next render frame will re-queue. Could add a
      // backoff/blacklist in Phase 4 if a tile fails repeatedly.
    } finally {
      this.pending.delete(key);
    }
  }

  isDirty(): boolean { return this.dirty; }
  clearDirty(): void { this.dirty = false; }

  /**
   * Snapshot the current upscaled tiles as an `AiCacheSection` for
   * serialisation. Only entries with full (tile + palette) context are
   * included — disk-seeded entries that were never touched by runtime
   * queries are omitted (they're already on disk; the writer merges).
   */
  toSection(): AiCacheSection {
    const out: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: this.client.modelId,
      entries: [],
    };
    for (const e of this.entries.values()) {
      out.entries.push({
        hash: hexToHash(e.hash),
        nesTile: e.nesTile,
        nativeTile: e.native,
      });
    }
    return out;
  }
}

/**
 * Build the in-memory cache key from raw bytes. 20-char binary string —
 * each byte becomes a single charCode. Avoids per-frame hashing and
 * works as a Map key without GC churn.
 */
function makeRawKey(nesTile: Uint8Array, subPalette: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += String.fromCharCode(nesTile[i]!);
  for (let i = 0; i < 4; i++) s += String.fromCharCode(subPalette[i]!);
  return s;
}
