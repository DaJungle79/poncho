import { describe, expect, it } from 'vitest';

import {
  AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
  AI_CACHE_VERSION,
  type AiCacheEntry,
  type AiCacheSection,
} from '../../src/core/cart-poncho/ai-cache';
import { PonchoCartridge } from '../../src/core/cart-poncho/cartridge';
import { parsePonchoRom } from '../../src/core/cart-poncho/header';
import {
  mergeAiCacheSections,
  repackPonchoWithAiCache,
} from '../../src/core/cart-poncho/repack';
import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';

/** Stand-in numeric model id for test fixtures (was the NanoBanana
 *  constant; the registry now uses string ids per `UpscaleModel.id` and
 *  each model picks its own `cacheModelId` for the section header). */
const SAMPLE_REGISTERED_MODEL = 1;

function mkEntry(seed: number): AiCacheEntry {
  const hash = new Uint8Array(16);
  const nesTile = new Uint8Array(16);
  const nativeTile = new Uint8Array(1024);
  for (let i = 0; i < 16; i++) hash[i] = (seed * 7 + i) & 0xff;
  for (let i = 0; i < 16; i++) nesTile[i] = (seed * 13 + i) & 0xff;
  for (let i = 0; i < 1024; i++) nativeTile[i] = (seed * 31 + i) & 0xff;
  return { hash, nesTile, nativeTile };
}

function makeCart(opts: { aiCache?: AiCacheSection; trailer?: Uint8Array } = {}): Uint8Array {
  return assemblePonchoRom({
    title: 'TestCart',
    palette: makePalette([[0, 0, 0]]),
    prg: new Uint8Array(2048),
    chr: new Uint8Array(1024),
    chrRamKb: 0,
    sourceInesCrc32: 0xdeadbeef,
    ...(opts.aiCache ? { aiCache: opts.aiCache } : {}),
    ...(opts.trailer ? { trailer: opts.trailer } : {}),
  });
}

describe('repackPonchoWithAiCache — embeds + parses', () => {
  it('adds an AI cache section to a cart that had none', () => {
    const original = makeCart();
    const fresh: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
      entries: [mkEntry(1), mkEntry(2)],
    };
    const updated = repackPonchoWithAiCache(original, fresh);

    const layout = parsePonchoRom(updated);
    expect(layout.header.flags.aiCachePresent).toBe(true);
    const cart = new PonchoCartridge(updated);
    expect(cart.aiCache!.entries.length).toBe(2);
    expect(cart.aiCache!.model).toBe(AI_CACHE_MODEL_NEAREST_NEIGHBOUR);
  });

  it('preserves the trailer when one was present', () => {
    const trailer = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const original = makeCart({ trailer });
    const fresh: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
      entries: [mkEntry(1)],
    };
    const updated = repackPonchoWithAiCache(original, fresh);

    const layout = parsePonchoRom(updated);
    expect(layout.header.flags.trailerPresent).toBe(true);
    expect(layout.trailerByteLength).toBe(trailer.length);
    expect(updated[layout.trailerOffset]).toBe(0xde);
  });

  it('preserves header fields (title, sourceInesCrc32, mapper) verbatim', () => {
    const original = makeCart();
    const layoutOrig = parsePonchoRom(original);
    const fresh: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
      entries: [mkEntry(0)],
    };
    const updated = repackPonchoWithAiCache(original, fresh);

    const layoutNew = parsePonchoRom(updated);
    expect(layoutNew.header.title).toBe(layoutOrig.header.title);
    expect(layoutNew.header.sourceInesCrc32).toBe(layoutOrig.header.sourceInesCrc32);
    expect(layoutNew.header.mapperId).toBe(layoutOrig.header.mapperId);
    expect(layoutNew.header.mapperSubmode).toBe(layoutOrig.header.mapperSubmode);
  });
});

describe('mergeAiCacheSections — model-aware union', () => {
  it('unions entries when model matches; fresh wins on hash collision', () => {
    const sharedHashSeed = 5;
    const existing: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: 1,
      entries: [mkEntry(sharedHashSeed), mkEntry(2)],
    };
    // Fresh entry with same hash as existing's first; different native tile.
    const newFirst = mkEntry(sharedHashSeed);
    newFirst.nativeTile = new Uint8Array(1024).fill(0xff);
    const fresh: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: 1,
      entries: [newFirst, mkEntry(7)],
    };

    const merged = mergeAiCacheSections(existing, fresh);
    expect(merged.entries.length).toBe(3);
    // Find the entry matching sharedHashSeed and verify fresh's native tile won.
    const conflictHash = mkEntry(sharedHashSeed).hash;
    const found = merged.entries.find((e) =>
      e.hash.every((b, i) => b === conflictHash[i]),
    );
    expect(found!.nativeTile[0]).toBe(0xff);
  });

  it('drops existing entries when models differ', () => {
    const existing: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
      entries: [mkEntry(1), mkEntry(2)],
    };
    const fresh: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: SAMPLE_REGISTERED_MODEL,
      entries: [mkEntry(7)],
    };
    const merged = mergeAiCacheSections(existing, fresh);
    expect(merged.model).toBe(SAMPLE_REGISTERED_MODEL);
    expect(merged.entries.length).toBe(1);
  });

  it('returns fresh as-is when there is no existing section', () => {
    const fresh: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: 1,
      entries: [mkEntry(1)],
    };
    const merged = mergeAiCacheSections(null, fresh);
    expect(merged.entries.length).toBe(1);
  });
});

describe('repackPonchoWithAiCache — round-trip through merge', () => {
  it('second repack adds new entries while preserving existing ones', () => {
    const start = makeCart();
    const round1: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: 1,
      entries: [mkEntry(1), mkEntry(2)],
    };
    const after1 = repackPonchoWithAiCache(start, round1);

    const round2: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: 1,
      entries: [mkEntry(3)],
    };
    const after2 = repackPonchoWithAiCache(after1, round2);

    const cart = new PonchoCartridge(after2);
    expect(cart.aiCache!.entries.length).toBe(3); // 1 + 2 + 3
  });
});
