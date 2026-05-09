import { describe, expect, it } from 'vitest';

import {
  AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
  AI_CACHE_MODEL_UNSPECIFIED,
  AI_CACHE_VERSION,
  type AiCacheSection,
} from '../../src/core/cart-poncho/ai-cache';
import {
  FileTileCache,
  MemoryGlobalCache,
  getOrUpscaleTile,
  hashTile,
  hashToHex,
  hexToHash,
} from '../../src/convert/tile-cache';
import { MockUpscaleClient, type UpscaleClient } from '../../src/convert/upscale-client';

/** Stand-in numeric model id for test fixtures. */
const SAMPLE_REGISTERED_MODEL = 1;

const SAMPLE_TILE = (() => {
  const t = new Uint8Array(16);
  for (let i = 0; i < 8; i++) t[i] = 0xaa; // plane 0
  for (let i = 8; i < 16; i++) t[i] = 0x55; // plane 1
  return t;
})();
const SAMPLE_PALETTE = new Uint8Array([0x0f, 0x16, 0x30, 0x10]);

describe('hashTile', () => {
  it('produces 32-character lowercase hex', async () => {
    const h = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic — same tile + palette → same hash', async () => {
    const h1 = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    const h2 = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    expect(h1).toBe(h2);
  });

  it('changes when the NES tile changes', async () => {
    const t2 = new Uint8Array(SAMPLE_TILE);
    t2[0] ^= 0xff;
    const h1 = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    const h2 = await hashTile(t2, SAMPLE_PALETTE);
    expect(h1).not.toBe(h2);
  });

  it('changes when the sub-palette changes (palette-aware dedup)', async () => {
    const p2 = new Uint8Array(SAMPLE_PALETTE);
    p2[0] ^= 0xff;
    const h1 = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    const h2 = await hashTile(SAMPLE_TILE, p2);
    expect(h1).not.toBe(h2);
  });
});

describe('hashToHex / hexToHash', () => {
  it('round-trips a 16-byte buffer', () => {
    const buf = new Uint8Array(16);
    for (let i = 0; i < 16; i++) buf[i] = i * 17;
    expect(hexToHash(hashToHex(buf))).toEqual(buf);
  });

  it('rejects hex of the wrong length', () => {
    expect(() => hexToHash('abc')).toThrow(/32 chars/);
  });
});

describe('MockUpscaleClient', () => {
  it('produces a 1024-byte tile via 4×4 nearest-neighbour expansion', async () => {
    const client = new MockUpscaleClient();
    const out = await client.upscaleTile(SAMPLE_TILE, SAMPLE_PALETTE);
    expect(out.length).toBe(1024);
    // Top-left NES pixel: plane0[0] bit 7 = 1, plane1[0] bit 7 = 0 → pv = 1.
    // 4×4 block at top-left should all be 1.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(out[y * 32 + x]).toBe(1);
      }
    }
  });

  it('uses the nearest-neighbour model id', () => {
    expect(new MockUpscaleClient().modelId).toBe(AI_CACHE_MODEL_NEAREST_NEIGHBOUR);
  });

  it('rejects wrong-sized NES tiles', async () => {
    const client = new MockUpscaleClient();
    await expect(client.upscaleTile(new Uint8Array(15), SAMPLE_PALETTE)).rejects.toThrow();
  });
});

describe('MemoryGlobalCache', () => {
  it('stores + retrieves keyed by (hash, model)', async () => {
    const cache = new MemoryGlobalCache();
    const tile = new Uint8Array(1024);
    tile[0] = 0x42;
    await cache.put('abcd1234'.repeat(4), 1, tile);
    expect(await cache.get('abcd1234'.repeat(4), 1)).toEqual(tile);
    expect(await cache.get('abcd1234'.repeat(4), 2)).toBeNull(); // different model
    expect(await cache.size()).toBe(1);
  });

  it('returns null for unknown keys', async () => {
    const cache = new MemoryGlobalCache();
    expect(await cache.get('00'.repeat(16), 1)).toBeNull();
  });
});

describe('FileTileCache', () => {
  it('seeds from a section whose model matches the active model', () => {
    const file = new FileTileCache(SAMPLE_REGISTERED_MODEL);
    const hash = new Uint8Array(16); hash[0] = 0xaa;
    const nesTile = new Uint8Array(16); nesTile[0] = 0xbb;
    const nativeTile = new Uint8Array(1024); nativeTile[0] = 0xcc;
    const section: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: SAMPLE_REGISTERED_MODEL,
      entries: [{ hash, nesTile, nativeTile }],
    };
    file.loadFromSection(section, SAMPLE_REGISTERED_MODEL);
    expect(file.size()).toBe(1);
    expect(file.get(hashToHex(hash))).toEqual(nativeTile);
    expect(file.isDirty()).toBe(false); // loading isn't dirty
  });

  it('discards entries whose model does not match the active model', () => {
    const file = new FileTileCache(SAMPLE_REGISTERED_MODEL);
    const hash = new Uint8Array(16);
    const section: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NEAREST_NEIGHBOUR, // different model
      entries: [{ hash, nesTile: new Uint8Array(16), nativeTile: new Uint8Array(1024) }],
    };
    file.loadFromSection(section, SAMPLE_REGISTERED_MODEL);
    expect(file.size()).toBe(0); // entries discarded
    expect(file.isDirty()).toBe(false); // not dirty — old entries preserved on disk
  });

  it('puts mark cache dirty; toSection returns the snapshot', () => {
    const file = new FileTileCache(SAMPLE_REGISTERED_MODEL);
    const hash = '00'.repeat(16);
    expect(file.isDirty()).toBe(false);
    file.put(hash, new Uint8Array(16), new Uint8Array(1024));
    expect(file.isDirty()).toBe(true);

    const section = file.toSection();
    expect(section.formatVersion).toBe(AI_CACHE_VERSION);
    expect(section.model).toBe(SAMPLE_REGISTERED_MODEL);
    expect(section.entries.length).toBe(1);

    file.clearDirty();
    expect(file.isDirty()).toBe(false);
  });

  it('rejects malformed put inputs', () => {
    const file = new FileTileCache();
    expect(() => file.put('short', new Uint8Array(16), new Uint8Array(1024))).toThrow(/32 chars/);
    expect(() => file.put('00'.repeat(16), new Uint8Array(15), new Uint8Array(1024))).toThrow(/16 bytes/);
    expect(() => file.put('00'.repeat(16), new Uint8Array(16), new Uint8Array(512))).toThrow(/1024 bytes/);
  });
});

describe('getOrUpscaleTile — layered cache lookup', () => {
  it('hits the file cache without calling global or client', async () => {
    let clientCalls = 0;
    const client: UpscaleClient = {
      modelId: AI_CACHE_MODEL_UNSPECIFIED,
      async upscaleTile() { clientCalls++; return new Uint8Array(1024); },
    };
    const file = new FileTileCache(AI_CACHE_MODEL_UNSPECIFIED);
    const fileTile = new Uint8Array(1024); fileTile[0] = 0xaa;
    const hash = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    file.put(hash, SAMPLE_TILE, fileTile);

    let globalGets = 0;
    const global = new MemoryGlobalCache();
    const origGet = global.get.bind(global);
    global.get = async (...args) => { globalGets++; return origGet(...args); };

    const result = await getOrUpscaleTile({ file, global, client }, SAMPLE_TILE, SAMPLE_PALETTE);
    expect(result).toEqual(fileTile);
    expect(globalGets).toBe(0);
    expect(clientCalls).toBe(0);
  });

  it('hits the global cache, promotes to file cache', async () => {
    let clientCalls = 0;
    const client: UpscaleClient = {
      modelId: 7,
      async upscaleTile() { clientCalls++; return new Uint8Array(1024); },
    };
    const globalTile = new Uint8Array(1024); globalTile[0] = 0xbb;
    const global = new MemoryGlobalCache();
    const hash = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    await global.put(hash, 7, globalTile);
    const file = new FileTileCache(7);

    const result = await getOrUpscaleTile({ file, global, client }, SAMPLE_TILE, SAMPLE_PALETTE);
    expect(result).toEqual(globalTile);
    expect(clientCalls).toBe(0);
    // Promoted into file cache.
    expect(file.get(hash)).toEqual(globalTile);
  });

  it('falls through to the client; promotes to both layers', async () => {
    let clientCalls = 0;
    const aiTile = new Uint8Array(1024); aiTile[42] = 0xcc;
    const client: UpscaleClient = {
      modelId: 1,
      async upscaleTile() { clientCalls++; return aiTile; },
    };
    const global = new MemoryGlobalCache();
    const file = new FileTileCache(1);

    const result = await getOrUpscaleTile({ file, global, client }, SAMPLE_TILE, SAMPLE_PALETTE);
    expect(result).toEqual(aiTile);
    expect(clientCalls).toBe(1);

    const hash = await hashTile(SAMPLE_TILE, SAMPLE_PALETTE);
    expect(await global.get(hash, 1)).toEqual(aiTile);
    expect(file.get(hash)).toEqual(aiTile);

    // Second call → file-cache hit, no API.
    await getOrUpscaleTile({ file, global, client }, SAMPLE_TILE, SAMPLE_PALETTE);
    expect(clientCalls).toBe(1);
  });
});
