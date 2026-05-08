import { describe, expect, it, vi } from 'vitest';

import {
  AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
  AI_CACHE_VERSION,
  type AiCacheSection,
} from '../../src/core/cart-poncho/ai-cache';
import {
  MemoryGlobalCache,
  hashTileSync,
  hexToHash,
} from '../../src/convert/tile-cache';
import {
  MockUpscaleClient,
  UpscaleError,
  type UpscaleClient,
} from '../../src/convert/upscale-client';
import { UpscaleWorker } from '../../src/runtime/upscale-worker';

const SAMPLE_TILE = (() => {
  const t = new Uint8Array(16);
  for (let i = 0; i < 8; i++) t[i] = 0xaa;
  for (let i = 8; i < 16; i++) t[i] = 0x55;
  return t;
})();
const SAMPLE_PAL = new Uint8Array([0x0f, 0x16, 0x30, 0x10]);

/** Drain microtasks + a settle tick. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('UpscaleWorker — first-time miss and async resolution', () => {
  it('returns null on first call, then resolves the tile in the background', async () => {
    const w = new UpscaleWorker({ client: new MockUpscaleClient() });
    expect(w.resolveSync(SAMPLE_TILE, SAMPLE_PAL)).toBeNull();
    expect(w.pendingCount()).toBe(1);
    await flush();
    expect(w.pendingCount()).toBe(0);
    expect(w.readyCount()).toBe(1);

    const result = w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1024);
  });

  it('dedupes in-flight requests by raw bytes', async () => {
    let calls = 0;
    const slowClient: UpscaleClient = {
      modelId: 99,
      async upscaleTile(t, p) { calls++; return new MockUpscaleClient().upscaleTile(t, p); },
    };
    const w = new UpscaleWorker({ client: slowClient });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    expect(w.pendingCount()).toBe(1);
    await flush();
    expect(calls).toBe(1);
  });

  it('different palettes hash separately and trigger separate fetches', async () => {
    let calls = 0;
    const client: UpscaleClient = {
      modelId: 99,
      async upscaleTile(t, p) { calls++; return new MockUpscaleClient().upscaleTile(t, p); },
    };
    const w = new UpscaleWorker({ client });
    const pal2 = new Uint8Array([0x0f, 0x16, 0x30, 0x20]); // 1 byte differs
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    w.resolveSync(SAMPLE_TILE, pal2);
    await flush();
    expect(calls).toBe(2);
  });
});

describe('UpscaleWorker — global cache promotion', () => {
  it('serves from globalCache without invoking the client', async () => {
    let clientCalls = 0;
    const client: UpscaleClient = {
      modelId: 7,
      async upscaleTile() { clientCalls++; return new Uint8Array(1024).fill(42); },
    };
    const cache = new MemoryGlobalCache();
    const seeded = new Uint8Array(1024).fill(0x77);
    const hash = hashTileSync(SAMPLE_TILE, SAMPLE_PAL);
    await cache.put(hash, 7, seeded);

    const w = new UpscaleWorker({ client, globalCache: cache });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();
    expect(clientCalls).toBe(0);
    const result = w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    expect(result![0]).toBe(0x77);
  });

  it('writes new tiles to globalCache on success', async () => {
    const client = new MockUpscaleClient();
    const cache = new MemoryGlobalCache();
    const w = new UpscaleWorker({ client, globalCache: cache });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();

    const hash = hashTileSync(SAMPLE_TILE, SAMPLE_PAL);
    expect(await cache.get(hash, AI_CACHE_MODEL_NEAREST_NEIGHBOUR)).not.toBeNull();
  });
});

describe('UpscaleWorker — disk seed', () => {
  it('serves seeded entries on first query without an API call', async () => {
    const native = new Uint8Array(1024).fill(0xab);
    const hash = hashTileSync(SAMPLE_TILE, SAMPLE_PAL);
    const seed: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
      entries: [{ hash: hexToHash(hash), nesTile: SAMPLE_TILE, nativeTile: native }],
    };
    let clientCalls = 0;
    const client: UpscaleClient = {
      modelId: AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
      async upscaleTile() { clientCalls++; return new Uint8Array(1024); },
    };
    const w = new UpscaleWorker({ client, seed });

    // First query: should hit the seed map sync (no async fetch).
    const result = w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    expect(result).not.toBeNull();
    expect(result![0]).toBe(0xab);
    await flush();
    expect(clientCalls).toBe(0);
  });

  it('ignores seeded entries from a different model', async () => {
    const native = new Uint8Array(1024).fill(0xab);
    const hash = hashTileSync(SAMPLE_TILE, SAMPLE_PAL);
    const seed: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: 1, // nanobanana
      entries: [{ hash: hexToHash(hash), nesTile: SAMPLE_TILE, nativeTile: native }],
    };
    const client = new MockUpscaleClient(); // modelId = NEAREST_NEIGHBOUR
    const w = new UpscaleWorker({ client, seed });

    expect(w.resolveSync(SAMPLE_TILE, SAMPLE_PAL)).toBeNull();
    await flush();
    // Worker fetched fresh — disk entries for the other model preserved.
    expect(w.readyCount()).toBe(1);
    expect(w.resolveSync(SAMPLE_TILE, SAMPLE_PAL)![0]).not.toBe(0xab);
  });
});

describe('UpscaleWorker — onTileReady + dirty', () => {
  it('fires onTileReady when a fetch completes and marks dirty', async () => {
    const onTileReady = vi.fn();
    const w = new UpscaleWorker({ client: new MockUpscaleClient(), onTileReady });
    expect(w.isDirty()).toBe(false);
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();
    expect(onTileReady).toHaveBeenCalledTimes(1);
    expect(w.isDirty()).toBe(true);

    w.clearDirty();
    expect(w.isDirty()).toBe(false);
  });
});

describe('UpscaleWorker — failure handling', () => {
  it('drops pending entries when the client throws (next call retries)', async () => {
    let calls = 0;
    const flaky: UpscaleClient = {
      modelId: 99,
      async upscaleTile() {
        calls++;
        if (calls < 2) throw new UpscaleError('flake');
        return new Uint8Array(1024).fill(0x55);
      },
    };
    const w = new UpscaleWorker({ client: flaky });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();
    expect(w.pendingCount()).toBe(0);
    expect(w.readyCount()).toBe(0);

    // Retry — second call succeeds.
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();
    expect(w.readyCount()).toBe(1);
    expect(w.resolveSync(SAMPLE_TILE, SAMPLE_PAL)![0]).toBe(0x55);
  });

  it('resolveSync never throws even if the client misbehaves', () => {
    const bad: UpscaleClient = {
      modelId: 99,
      async upscaleTile() { throw new Error('nope'); },
    };
    const w = new UpscaleWorker({ client: bad });
    expect(() => w.resolveSync(SAMPLE_TILE, SAMPLE_PAL)).not.toThrow();
  });
});

describe('UpscaleWorker — prompt forwarding', () => {
  it('forwards constructor `prompt` to client.upscaleTile', async () => {
    let seen: string | undefined = '<sentinel>';
    const client: UpscaleClient = {
      modelId: 99,
      async upscaleTile(_t, _p, prompt) { seen = prompt; return new Uint8Array(1024); },
    };
    const w = new UpscaleWorker({ client, prompt: 'CTOR_PROMPT' });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();
    expect(seen).toBe('CTOR_PROMPT');
  });

  it('setPrompt swaps the prompt for subsequent tile fetches', async () => {
    const seen: Array<string | undefined> = [];
    const client: UpscaleClient = {
      modelId: 99,
      async upscaleTile(_t, _p, prompt) { seen.push(prompt); return new Uint8Array(1024); },
    };
    const w = new UpscaleWorker({ client });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();
    w.setPrompt('SWAPPED');
    // Different tile so it isn't cached.
    const otherTile = new Uint8Array(SAMPLE_TILE);
    otherTile[0] ^= 0xff;
    w.resolveSync(otherTile, SAMPLE_PAL);
    await flush();
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe('SWAPPED');
  });
});

describe('UpscaleWorker — toSection (write-back)', () => {
  it('serialises completed entries with their hash + nesTile + native', async () => {
    const w = new UpscaleWorker({ client: new MockUpscaleClient() });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();

    const section = w.toSection();
    expect(section.formatVersion).toBe(AI_CACHE_VERSION);
    expect(section.model).toBe(AI_CACHE_MODEL_NEAREST_NEIGHBOUR);
    expect(section.entries.length).toBe(1);
    const e = section.entries[0]!;
    expect(e.hash.length).toBe(16);
    expect(e.nesTile).toEqual(SAMPLE_TILE);
    expect(e.nativeTile.length).toBe(1024);
  });

  it('excludes still-pending requests from toSection', async () => {
    const neverResolve: UpscaleClient = {
      modelId: 99,
      upscaleTile: () => new Promise(() => { /* never */ }),
    };
    const w = new UpscaleWorker({ client: neverResolve });
    w.resolveSync(SAMPLE_TILE, SAMPLE_PAL);
    await flush();
    expect(w.toSection().entries.length).toBe(0);
  });
});
