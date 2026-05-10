/**
 * iNES → PonchoROM (native-mode, AI-baked) — the "bake-now" conversion
 * pipeline.
 *
 * Workflow:
 *
 *   1. Parse iNES; reject CHR-RAM cartridges (they take the runtime path
 *      via `FileTileCache` + the AI cache section instead — see Phase 3).
 *   2. Walk the CHR-ROM as 16-byte tiles. Dedupe by content hash so the
 *      AI is asked once per unique tile, not once per occurrence.
 *   3. Feed each unique tile through the cache layers
 *      (file → global → client) with bounded concurrency. Per-tile
 *      failures fall back to nearest-neighbour so a flaky API doesn't
 *      break the whole conversion.
 *   4. Reassemble CHR by replacing each 16-byte NES tile with its
 *      1024-byte upscaled native tile (CHR grows 64×).
 *   5. Emit a native-mode `.poncho` (`upscaledMode = 0`). The upscaled
 *      pixels live in CHR proper; no AI cache section is needed because
 *      the tiles are already baked into the cartridge.
 *
 * Output is a self-contained `.poncho` that needs no further AI calls
 * to play — the network only runs once, at conversion time.
 *
 * `convertInesToPoncho` (the verbatim wrapper) stays untouched; this
 * module is its richer sibling.
 */

import { parseInes } from '../core/cart/ines';
import { crc32 } from '../core/cart-poncho/crc32';
import { encodeMapperSubmode } from '../core/cart-poncho/header';
import { assemblePonchoRom } from '../core/cart-poncho/writer';
import { NES_MASTER_PALETTE_RGBA } from '../core/ppu-ultra/nes-master-palette';

import {
  AI_CACHE_VERSION,
  type AiCacheEntry,
  type AiCacheSection,
} from '../core/cart-poncho/ai-cache';
import {
  ConvertError,
  MAPPER_TO_VARIANT,
  MIRRORING_TO_BOOT,
  SUPPORTED_MAPPER_NAMES,
  type ConvertNotes,
} from './ines-to-poncho';
import {
  MemoryGlobalCache,
  TILE_HASH_PALETTE,
  hashTile,
  hexToHash,
  type GlobalTileCache,
  type TileHashHex,
} from './tile-cache';
import { MockUpscaleClient, type UpscaleClient } from './upscale-client';

/** Counters surfaced through the progress callback. */
export interface AiConvertProgress {
  /** Number of unique tiles to process (after dedup). */
  total: number;
  /** Number of unique tiles whose upscale has been resolved. */
  done: number;
  /** Subset of `done` that came from the global cache (no API hit). */
  cached: number;
  /** Subset of `done` that were resolved via a successful API call. */
  apiCalls: number;
  /** Subset of `done` whose API call failed and fell back to NN. */
  failed: number;
}

export interface AiConvertOptions {
  /** Cartridge title (max 32 UTF-8 bytes). */
  title?: string;
  /**
   * Upscaler. Defaults to `MockUpscaleClient` (deterministic NN) — the
   * caller usually passes `NanoBananaClient` for real AI bake.
   */
  client?: UpscaleClient;
  /**
   * Cross-cart cache. Defaults to a fresh in-memory cache; pass an
   * IndexedDB-backed implementation in browser flows so previously
   * upscaled tiles are reused across conversions.
   */
  globalCache?: GlobalTileCache;
  /**
   * Max parallel API calls. Default 2 — Gemini's free tier rate-limits
   * aggressively at higher concurrency. Bump up for paid tiers.
   */
  concurrency?: number;
  /** Fired after each unique tile is resolved. UI hooks the progress bar. */
  onProgress?: (info: AiConvertProgress) => void;
  /**
   * Cancellation. When triggered the pipeline stops scheduling new
   * tiles and rejects with `AiConvertCancelled`. Tiles already cached
   * remain in `globalCache` for the next attempt.
   */
  signal?: AbortSignal;
}

export interface AiConvertNotes extends ConvertNotes {
  /** Unique NES tiles after dedup. */
  uniqueTiles: number;
  /** Tiles served from the global cache (no API hit). */
  cacheHits: number;
  /** Tiles resolved via a successful API call. */
  apiCalls: number;
  /** Tiles whose API call failed and fell back to nearest-neighbour. */
  failedTiles: number;
  /**
   * Tiles that the user cancelled before reaching — substituted with
   * nearest-neighbour. Lets you bake the first N tiles, hit Cancel, and
   * still get a playable `.poncho` to inspect the partial result.
   */
  cancelledTiles: number;
  /** True when the user hit Cancel mid-bake. */
  cancelled: boolean;
}

export interface AiConvertResult {
  poncho: Uint8Array;
  notes: AiConvertNotes;
}

export class AiConvertCancelled extends Error {
  constructor() {
    super('AI conversion cancelled');
    this.name = 'AiConvertCancelled';
  }
}

/** Bake an iNES cartridge into a native-mode `.poncho` with AI-upscaled CHR. */
export async function convertInesToPonchoAi(
  inesBytes: Uint8Array,
  opts: AiConvertOptions = {},
): Promise<AiConvertResult> {
  const ines = parseInes(inesBytes);

  const variant = MAPPER_TO_VARIANT[ines.header.mapper];
  if (variant === undefined) {
    throw new ConvertError(
      `iNES mapper ${ines.header.mapper} is not supported by the PonchoMapper. ` +
      `Supported: ${SUPPORTED_MAPPER_NAMES}.`,
    );
  }
  if (ines.header.hasTrainer) {
    throw new ConvertError('iNES file has a trainer block; not supported.');
  }

  // CHR-RAM games take the runtime path. Rejecting at the boundary keeps
  // bake-now's invariants simple (always real CHR; native output).
  const isChrRam = inesBytes[5] === 0;
  if (isChrRam) {
    throw new ConvertError(
      'AI bake-now requires CHR-ROM. CHR-RAM cartridges upscale at runtime ' +
      'instead — convert without --ai and the AI cache section will fill in ' +
      'as you play.',
    );
  }

  const chr = ines.chrRom;
  if (chr.length === 0 || chr.length % 16 !== 0) {
    throw new ConvertError(
      `CHR-ROM size ${chr.length} bytes is not a positive multiple of 16.`,
    );
  }
  const tileCount = chr.length / 16;

  const client: UpscaleClient = opts.client ?? new MockUpscaleClient();
  const globalCache = opts.globalCache ?? new MemoryGlobalCache();
  const concurrency = Math.max(1, opts.concurrency ?? 2);

  // Pre-flight the model before the per-tile loop. If the runtime can't
  // even initialise (model file missing, WASM/WebGPU init failure, shape
  // mismatch in the ONNX export), bail loudly with a single error
  // instead of letting `upscaleTile`'s per-tile catch silently
  // NN-fallback every tile — which renders identically to a "successful"
  // bake at the byte level but is actually pure nearest-neighbour.
  if (client.preflight) {
    try {
      await client.preflight();
    } catch (err) {
      throw new ConvertError(
        `AI upscale model failed to initialise — ${(err as Error).message ?? String(err)}. ` +
        `No tiles were processed; the conversion was aborted to avoid producing a pure ` +
        `nearest-neighbour bake disguised as an AI bake.`,
      );
    }
  }

  // Bake-time dedup: hash by tile bytes + the shared `TILE_HASH_PALETTE`
  // constant. Sub-palette context is unknown at conversion (one tile
  // renders with many palettes during play), so we send the AI a fixed
  // neutral palette and let the runtime apply the actual palette as
  // before. The runtime resolver also uses `TILE_HASH_PALETTE` for
  // hashing so its lookups hit our cache entries.
  const NEUTRAL_PALETTE = TILE_HASH_PALETTE;

  // Walk all tiles, build hash → unique-tile-index map.
  type TileGroup = { hash: TileHashHex; bytes: Uint8Array };
  const tileHashes: TileHashHex[] = new Array(tileCount);
  const groups: TileGroup[] = [];
  const groupIdx = new Map<TileHashHex, number>();
  for (let i = 0; i < tileCount; i++) {
    const tileBytes = chr.subarray(i * 16, (i + 1) * 16);
    const hash = await hashTile(tileBytes, NEUTRAL_PALETTE);
    tileHashes[i] = hash;
    if (!groupIdx.has(hash)) {
      groupIdx.set(hash, groups.length);
      groups.push({ hash, bytes: tileBytes });
    }
  }

  let done = 0;
  let cached = 0;
  let apiCalls = 0;
  let failed = 0;
  let cancelledTiles = 0;
  const upscaled = new Map<TileHashHex, Uint8Array>();

  const reportProgress = (): void => {
    opts.onProgress?.({ total: groups.length, done, cached, apiCalls, failed });
  };
  reportProgress();

  // Bounded-concurrency pump. Each worker pulls indices off the shared
  // cursor; first error or abort short-circuits the rest.
  let cursor = 0;
  let cancelled = false;
  const checkAbort = (): void => {
    if (opts.signal?.aborted) cancelled = true;
  };

  const worker = async (): Promise<void> => {
    while (true) {
      checkAbort();
      if (cancelled) return;
      const i = cursor++;
      if (i >= groups.length) return;
      const group = groups[i]!;

      const fromGlobal = await globalCache.get(group.hash, client.modelId);
      if (fromGlobal !== null) {
        upscaled.set(group.hash, fromGlobal);
        cached++;
      } else {
        try {
          const native = await client.upscaleTile(group.bytes, NEUTRAL_PALETTE);
          if (native.length !== 1024) {
            throw new Error(`upscaler returned ${native.length} bytes (expected 1024)`);
          }
          upscaled.set(group.hash, native);
          await globalCache.put(group.hash, client.modelId, native);
          apiCalls++;
        } catch {
          // Per-tile fallback: NN expansion. The conversion still
          // completes; failed tiles render the same as no-AI mode.
          // Models that need to abort the whole bake (e.g. unrecoverable
          // GPU error) should throw a non-`UpscaleError` and let it
          // propagate via this catch — extend with a fatal-error type
          // when the first such case shows up.
          upscaled.set(group.hash, nearestNeighbourUpscale(group.bytes));
          failed++;
        }
      }

      done++;
      reportProgress();
    }
  };

  const pumps: Promise<void>[] = [];
  const pumpCount = Math.min(concurrency, groups.length);
  for (let i = 0; i < pumpCount; i++) pumps.push(worker());
  await Promise.all(pumps);

  // Cancellation is non-fatal: fill the remaining unresolved unique
  // tiles with nearest-neighbour so the user gets a playable `.poncho`
  // for whatever was upscaled before they hit Cancel.
  if (cancelled) {
    for (const group of groups) {
      if (!upscaled.has(group.hash)) {
        upscaled.set(group.hash, nearestNeighbourUpscale(group.bytes));
        cancelledTiles++;
      }
    }
    reportProgress();
  }

  // Build the AI cache section — one entry per unique tile. The
  // .poncho output keeps the *original* 16-byte NES CHR intact so all
  // NES-shape mechanisms (PPUCTRL.bgPatternBase, mapper CHR banking,
  // 256-byte $4014 OAM DMA, 4-byte sprite OAM) work normally; the
  // upscaled bytes ride along in the cache section and are spliced in
  // by the runtime resolver per-tile during render.
  const aiCacheEntries: AiCacheEntry[] = groups.map((group) => ({
    hash: hexToHash(group.hash),
    nesTile: new Uint8Array(group.bytes),
    nativeTile: upscaled.get(group.hash)!,
  }));
  const aiCache: AiCacheSection = {
    formatVersion: AI_CACHE_VERSION,
    model: client.modelId,
    entries: aiCacheEntries,
  };

  const bootMirroring = MIRRORING_TO_BOOT[ines.header.mirroring] ?? 0;
  const warnings: string[] = [];
  if (ines.header.mirroring === 'four-screen' && variant !== 4) {
    warnings.push(
      'Four-screen mirroring requires cart-supplied 4 KB VRAM — PpuUltra ' +
      'currently only handles two physical pages, so wide scrolling may glitch.',
    );
  }

  const sourceCrc = crc32(inesBytes);

  const poncho = assemblePonchoRom({
    title: opts.title?.slice(0, 32) ?? '',
    flags: { upscaledMode: true, trailerPresent: false, aiCachePresent: true },
    mapperId: 1,
    mapperSubmode: encodeMapperSubmode({ bankingVariant: variant, bootMirroring }),
    chrRamKb: 0,
    sourceInesCrc32: sourceCrc,
    palette: NES_MASTER_PALETTE_RGBA,
    prg: ines.prgRom,
    chr: ines.chrRom,
    aiCache,
  });

  return {
    poncho,
    notes: {
      sourceMapper: ines.header.mapper,
      bankingVariant: variant,
      sourceMirroring: ines.header.mirroring,
      hasBattery: ines.header.hasBattery,
      prgKb: ines.prgRom.length / 1024,
      chrKb: ines.chrRom.length / 1024,
      chrRamKb: 0,
      paletteEntries: NES_MASTER_PALETTE_RGBA.length / 4,
      warnings,
      uniqueTiles: groups.length,
      cacheHits: cached,
      apiCalls,
      failedTiles: failed,
      cancelledTiles,
      cancelled,
    },
  };
}

/** Fallback when an AI call fails for one tile. Mirrors `MockUpscaleClient`. */
function nearestNeighbourUpscale(nesTile: Uint8Array): Uint8Array {
  const out = new Uint8Array(1024);
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
        out[row] = pv; out[row + 1] = pv; out[row + 2] = pv; out[row + 3] = pv;
      }
    }
  }
  return out;
}
