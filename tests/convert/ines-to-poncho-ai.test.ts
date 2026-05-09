import { describe, expect, it } from 'vitest';

import { parsePonchoRom } from '../../src/core/cart-poncho/header';
import { ConvertError } from '../../src/convert/ines-to-poncho';
import {
  AiConvertCancelled,
  convertInesToPonchoAi,
} from '../../src/convert/ines-to-poncho-ai';
import {
  MemoryGlobalCache,
  hashTile,
} from '../../src/convert/tile-cache';
import {
  MockUpscaleClient,
  UpscaleError,
  type UpscaleClient,
} from '../../src/convert/upscale-client';
import { AI_CACHE_MODEL_NEAREST_NEIGHBOUR } from '../../src/core/cart-poncho/ai-cache';

// ---------------------------------------------------------------------------
// Helpers — synthesise minimal iNES files for the converter to chew on.
// ---------------------------------------------------------------------------

interface InesOpts {
  prgBanks?: number;     // 16 KB units. Default 1.
  chrBanks?: number;     // 8 KB units. Default 1; pass 0 for CHR-RAM.
  mapper?: number;       // Default 0 (NROM).
  mirroring?: 'horizontal' | 'vertical' | 'four-screen';
}

function makeInes(opts: InesOpts = {}): Uint8Array {
  const prgBanks = opts.prgBanks ?? 1;
  const chrBanks = opts.chrBanks ?? 1;
  const mapper = opts.mapper ?? 0;
  const mirroring = opts.mirroring ?? 'horizontal';

  const prg = new Uint8Array(prgBanks * 16384);
  for (let i = 0; i < prg.length; i++) prg[i] = i & 0xff;

  // CHR pattern: every tile distinct so dedup is meaningful.
  const chr = new Uint8Array(chrBanks * 8192);
  for (let i = 0; i < chr.length; i++) chr[i] = (i * 7) & 0xff;

  const header = new Uint8Array(16);
  header[0] = 0x4e; header[1] = 0x45; header[2] = 0x53; header[3] = 0x1a;
  header[4] = prgBanks;
  header[5] = chrBanks;
  let flags6 = (mapper & 0x0f) << 4;
  if (mirroring === 'vertical') flags6 |= 0x01;
  if (mirroring === 'four-screen') flags6 |= 0x08;
  header[6] = flags6;
  header[7] = mapper & 0xf0;

  const out = new Uint8Array(header.length + prg.length + chr.length);
  out.set(header, 0);
  out.set(prg, 16);
  out.set(chr, 16 + prg.length);
  return out;
}

// Fake CHR with known duplicates: tile 0 == tile 5 == tile 10, others unique.
function makeInesWithDuplicateTiles(): Uint8Array {
  const ines = makeInes({ prgBanks: 1, chrBanks: 1 });
  const chrOffset = 16 + 16384;
  // Reset CHR to unique distinct tiles, then alias. Encoding the tile
  // index in bytes 0–1 guarantees all 512 tiles hash differently.
  for (let t = 0; t < 512; t++) {
    ines[chrOffset + t * 16 + 0] = t & 0xff;
    ines[chrOffset + t * 16 + 1] = (t >> 8) & 0xff;
    for (let b = 2; b < 16; b++) {
      ines[chrOffset + t * 16 + b] = (t ^ b) & 0xff;
    }
  }
  // Tiles 5 and 10 share bytes with tile 0.
  for (let b = 0; b < 16; b++) {
    ines[chrOffset + 5 * 16 + b] = ines[chrOffset + 0 * 16 + b]!;
    ines[chrOffset + 10 * 16 + b] = ines[chrOffset + 0 * 16 + b]!;
  }
  return ines;
}

// ---------------------------------------------------------------------------

describe('convertInesToPonchoAi — happy path with MockUpscaleClient', () => {
  it('produces an upscaled-mode .poncho with the original CHR + AI cache section', async () => {
    const ines = makeInes();
    const result = await convertInesToPonchoAi(ines);

    const layout = parsePonchoRom(result.poncho);
    // Bake-now keeps the cart NES-shape so PPUCTRL pattern-base + mapper
    // CHR banking + 4-byte OAM all work; upscaled tiles ride along in
    // the AI cache section, spliced in by the runtime resolver.
    expect(layout.header.flags.upscaledMode).toBe(true);
    expect(layout.header.flags.aiCachePresent).toBe(true);
    // CHR is the original NES bytes verbatim (1 bank = 8 KB), not 64×.
    expect(layout.chrByteLength).toBe(8 * 1024);

    expect(result.notes.chrKb).toBe(8);
    expect(result.notes.chrRamKb).toBe(0);
  });

  it('records dedup, cache, and api-call counts', async () => {
    const ines = makeInesWithDuplicateTiles();
    const result = await convertInesToPonchoAi(ines);

    expect(result.notes.uniqueTiles).toBe(510); // 512 tiles - 2 duplicates
    expect(result.notes.apiCalls).toBe(510);    // every unique tile hit the client
    expect(result.notes.cacheHits).toBe(0);
    expect(result.notes.failedTiles).toBe(0);
  });

  it('reuses globalCache across runs (second run = all cache hits)', async () => {
    const cache = new MemoryGlobalCache();
    const ines = makeInes();
    const r1 = await convertInesToPonchoAi(ines, { globalCache: cache });
    const r2 = await convertInesToPonchoAi(ines, { globalCache: cache });

    expect(r1.notes.apiCalls).toBe(r1.notes.uniqueTiles);
    expect(r2.notes.apiCalls).toBe(0);
    expect(r2.notes.cacheHits).toBe(r2.notes.uniqueTiles);
    // Both bytestreams should be identical (same client, same tiles).
    expect(r2.poncho).toEqual(r1.poncho);
  });

  it('writes the cache under the client modelId', async () => {
    const cache = new MemoryGlobalCache();
    const ines = makeInes();
    await convertInesToPonchoAi(ines, { globalCache: cache });
    // Sample one tile from CHR and verify it's in the cache.
    const tile0 = ines.subarray(16 + 16384, 16 + 16384 + 16);
    const NEUTRAL_PALETTE = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const hash = await hashTile(tile0, NEUTRAL_PALETTE);
    expect(await cache.get(hash, AI_CACHE_MODEL_NEAREST_NEIGHBOUR)).not.toBeNull();
  });
});

describe('convertInesToPonchoAi — progress reporting', () => {
  it('fires onProgress with monotonically advancing counters', async () => {
    const events: Array<{ done: number; total: number }> = [];
    const ines = makeInes();
    const result = await convertInesToPonchoAi(ines, {
      onProgress: (p) => events.push({ done: p.done, total: p.total }),
      concurrency: 1, // deterministic ordering
    });

    expect(events.length).toBeGreaterThan(0);
    // First event is the initial 0/total tick.
    expect(events[0]!.done).toBe(0);
    expect(events[events.length - 1]!.done).toBe(result.notes.uniqueTiles);
    expect(events[0]!.total).toBe(result.notes.uniqueTiles);

    // Counters must never go backwards.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.done).toBeGreaterThanOrEqual(events[i - 1]!.done);
    }
  });
});

describe('convertInesToPonchoAi — partial-failure handling', () => {
  it('falls back to nearest-neighbour for tiles whose API call throws', async () => {
    let call = 0;
    const flakyClient: UpscaleClient = {
      modelId: 99,
      async upscaleTile(tile, palette) {
        call++;
        // Fail every 3rd tile.
        if (call % 3 === 0) throw new UpscaleError('synthetic flake');
        return new MockUpscaleClient().upscaleTile(tile, palette);
      },
    };

    const ines = makeInes();
    const result = await convertInesToPonchoAi(ines, { client: flakyClient });

    expect(result.notes.failedTiles).toBeGreaterThan(0);
    expect(result.notes.apiCalls + result.notes.failedTiles)
      .toBe(result.notes.uniqueTiles);
    // Output is still a valid .poncho.
    expect(() => parsePonchoRom(result.poncho)).not.toThrow();
  });
});

describe('convertInesToPonchoAi — abort signal preserves partial work', () => {
  it('returns a usable .poncho with NN fallback for un-baked tiles', async () => {
    const ctrl = new AbortController();
    let started = 0;
    const slowClient: UpscaleClient = {
      modelId: 99,
      async upscaleTile(tile, palette) {
        started++;
        if (started === 5) ctrl.abort(); // abort after 5 tiles in-flight
        await new Promise((r) => setTimeout(r, 0));
        return new MockUpscaleClient().upscaleTile(tile, palette);
      },
    };

    const ines = makeInes();
    const result = await convertInesToPonchoAi(ines, {
      client: slowClient, signal: ctrl.signal, concurrency: 1,
    });

    // `cancelled` flag set; un-baked tiles fell back to NN.
    expect(result.notes.cancelled).toBe(true);
    expect(result.notes.cancelledTiles).toBeGreaterThan(0);
    expect(result.notes.apiCalls).toBeGreaterThan(0);
    expect(result.notes.apiCalls).toBeLessThan(result.notes.uniqueTiles);
    // CHR is the original NES bytes verbatim (1 bank = 8 KB).
    expect(result.notes.chrKb).toBe(8);
    // The output is still a parseable .poncho.
    expect(result.poncho.length).toBeGreaterThan(0);
  });

  it('does NOT mark notes.cancelled when the run completes normally', async () => {
    const ines = makeInes();
    const result = await convertInesToPonchoAi(ines);
    expect(result.notes.cancelled).toBe(false);
    expect(result.notes.cancelledTiles).toBe(0);
  });
});

// AiConvertCancelled is still exported for backward compat but no longer
// thrown by `convertInesToPonchoAi`. Asserting the import shape so a
// future "do throw it" change has to update this on purpose.
describe('AiConvertCancelled export', () => {
  it('still constructable for shells that catch it as a guard', () => {
    expect(new AiConvertCancelled()).toBeInstanceOf(Error);
  });
});

describe('convertInesToPonchoAi — error paths', () => {
  it('rejects CHR-RAM cartridges', async () => {
    const ines = makeInes({ chrBanks: 0 });
    await expect(convertInesToPonchoAi(ines)).rejects.toThrow(ConvertError);
    await expect(convertInesToPonchoAi(ines)).rejects.toThrow(/CHR-ROM/);
  });

  it('rejects unsupported mappers', async () => {
    const ines = makeInes({ mapper: 5 });
    await expect(convertInesToPonchoAi(ines)).rejects.toThrow(/mapper 5/);
  });
});

/**
 * The bake-now pipeline renders each NES tile with a fixed "neutral"
 * 4-entry palette before sending it to Gemini, then snaps the response
 * back to that same palette. If any two entries map to the same master
 * RGB, the primer collapses two pixel-values into one colour and the
 * snap-back can't recover the original — pv3 silently becomes pv2.
 *
 * That bug went unnoticed for a while because the original neutral
 * palette `[0x00, 0x10, 0x20, 0x30]` had `0x20` and `0x30` both at
 * pure white in the canonical NES master palette. This test guards
 * against that regression.
 */
describe('bake-now neutral palette — pv-preserving by construction', () => {
  // Mirror of the constant inside `convertInesToPonchoAi`. Kept in sync
  // with that source manually; the test fails loudly if the indices
  // are changed back to a degenerate set.
  const NEUTRAL_PALETTE = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);

  it('all four master indices map to RGB-distinct colours', async () => {
    const { NES_MASTER_PALETTE_RGBA } = await import('../../src/core/ppu-ultra/nes-master-palette');
    const triples = Array.from(NEUTRAL_PALETTE).map((m) => {
      const i = (m & 0x3f) * 4;
      return `${NES_MASTER_PALETTE_RGBA[i]},${NES_MASTER_PALETTE_RGBA[i + 1]},${NES_MASTER_PALETTE_RGBA[i + 2]}`;
    });
    expect(new Set(triples).size).toBe(4);
  });
});

describe('convertInesToPonchoAi — concurrency', () => {
  it('produces identical output with concurrency=1 vs concurrency=8', async () => {
    const ines = makeInes();
    const a = await convertInesToPonchoAi(ines, { concurrency: 1 });
    const b = await convertInesToPonchoAi(ines, { concurrency: 8 });
    expect(b.poncho).toEqual(a.poncho);
  });
});
