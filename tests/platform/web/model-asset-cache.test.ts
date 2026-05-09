import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebModelAssetCache } from '../../../src/platform/web/model-asset-cache';

/**
 * Tests for the browser-side model-asset cache. We mock both
 * `globalThis.caches` (the Cache Storage API) and `globalThis.fetch`
 * so the test runs deterministically in Node — no real network, no
 * real cache.
 */

interface FakeCache {
  store: Map<string, Response>;
  match(url: string): Promise<Response | undefined>;
  put(url: string, resp: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<Array<{ url: string }>>;
}

function makeFakeCache(): FakeCache {
  const store = new Map<string, Response>();
  return {
    store,
    async match(url) {
      const r = store.get(url);
      return r ? r.clone() : undefined;
    },
    async put(url, resp) {
      const buf = await resp.arrayBuffer();
      store.set(url, new Response(buf, { headers: resp.headers, status: resp.status }));
    },
    async delete(url) {
      return store.delete(url);
    },
    async keys() {
      return [...store.keys()].map((u) => ({ url: u }));
    },
  };
}

const realCaches = (globalThis as { caches?: unknown }).caches;
const realFetch = (globalThis as { fetch?: typeof fetch }).fetch;
let fakeCacheInstance: FakeCache;

beforeEach(() => {
  fakeCacheInstance = makeFakeCache();
  (globalThis as unknown as { caches: { open: (name: string) => Promise<FakeCache> } }).caches = {
    async open(_name: string) {
      return fakeCacheInstance;
    },
  };
});

afterEach(() => {
  if (realCaches === undefined) {
    delete (globalThis as { caches?: unknown }).caches;
  } else {
    (globalThis as { caches: unknown }).caches = realCaches;
  }
  if (realFetch === undefined) {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  } else {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  }
});

function bytesResponse(bytes: ArrayBuffer, contentLength?: number): Response {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  return new Response(bytes, { status: 200, headers });
}

describe('WebModelAssetCache.load — fetch + cache', () => {
  it('fetches on miss, caches the response, returns the bytes', async () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const fetchFn = vi.fn(async () => bytesResponse(buf, 5));
    (globalThis as { fetch: typeof fetch }).fetch = fetchFn as unknown as typeof fetch;

    const cache = new WebModelAssetCache();
    const result = await cache.load('https://example.com/m.onnx');
    expect(new Uint8Array(result)).toEqual(new Uint8Array(buf));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Cached after the first call.
    expect(await cache.has('https://example.com/m.onnx')).toBe(true);
  });

  it('returns the cached copy on hit without hitting fetch', async () => {
    const buf = new Uint8Array([10, 20, 30]).buffer;
    let fetchCalls = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      fetchCalls++;
      return bytesResponse(buf, 3);
    }) as unknown as typeof fetch;

    const cache = new WebModelAssetCache();
    await cache.load('https://example.com/m.onnx');
    await cache.load('https://example.com/m.onnx'); // expect cache hit
    expect(fetchCalls).toBe(1);
  });

  it('fires onProgress with fromCache=true on cache hit', async () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => bytesResponse(buf, 4)) as unknown as typeof fetch;

    const cache = new WebModelAssetCache();
    await cache.load('https://example.com/m.onnx'); // prime

    const events: Array<{ loaded: number; total: number | null; fromCache: boolean }> = [];
    await cache.load('https://example.com/m.onnx', {
      onProgress: (p) => events.push(p),
    });
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ loaded: 4, total: 4, fromCache: true });
  });

  it('throws on HTTP error', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch;

    const cache = new WebModelAssetCache();
    await expect(cache.load('https://example.com/missing.onnx')).rejects.toThrow(/404/);
  });

  it('does not cache failed fetches', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('500', { status: 500 })) as unknown as typeof fetch;

    const cache = new WebModelAssetCache();
    await expect(cache.load('https://example.com/x.onnx')).rejects.toThrow();
    expect(await cache.has('https://example.com/x.onnx')).toBe(false);
  });
});

describe('WebModelAssetCache.has / remove / getInfo / list', () => {
  it('has returns false for unknown URLs', async () => {
    const cache = new WebModelAssetCache();
    expect(await cache.has('https://example.com/never.onnx')).toBe(false);
  });

  it('remove drops both the binary and the meta sidecar', async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      bytesResponse(buf, 3)) as unknown as typeof fetch;

    const cache = new WebModelAssetCache();
    await cache.load('https://example.com/m.onnx');
    expect(await cache.has('https://example.com/m.onnx')).toBe(true);

    await cache.remove('https://example.com/m.onnx');
    expect(await cache.has('https://example.com/m.onnx')).toBe(false);
    expect(await cache.getInfo('https://example.com/m.onnx')).toBeNull();
  });

  it('getInfo returns size + cachedAt after a fetch', async () => {
    const buf = new Uint8Array(7).fill(0xff).buffer;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      bytesResponse(buf, 7)) as unknown as typeof fetch;

    const before = Date.now();
    const cache = new WebModelAssetCache();
    await cache.load('https://example.com/m.onnx');
    const info = await cache.getInfo('https://example.com/m.onnx');
    expect(info).not.toBeNull();
    expect(info!.size).toBe(7);
    expect(info!.cachedAt).toBeGreaterThanOrEqual(before);
  });

  it('list enumerates each cached entry once (not the meta sidecars)', async () => {
    const buf = new Uint8Array([0, 1, 2]).buffer;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      bytesResponse(buf, 3)) as unknown as typeof fetch;

    const cache = new WebModelAssetCache();
    await cache.load('https://example.com/a.onnx');
    await cache.load('https://example.com/b.onnx');

    const all = await cache.list();
    const urls = all.map((e) => e.url).sort();
    expect(urls).toEqual([
      'https://example.com/a.onnx',
      'https://example.com/b.onnx',
    ]);
  });
});
