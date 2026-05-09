/**
 * Browser-side `ModelAssetCache` — persistent across reloads via the
 * Cache Storage API. Keys by URL, stores the response body + a small
 * sidecar JSON entry recording size + timestamp so the manage-models
 * UI can list cached files without poking at every entry.
 *
 * Why Cache Storage and not IndexedDB:
 *   - Cache Storage is request/response shaped — perfect for
 *     URL-keyed binary blobs (the `Response` already carries the
 *     bytes + headers; we just put + match).
 *   - Binary in IndexedDB is fine but the API is more ceremony
 *     (transactions, object stores) for the same shape.
 *   - Cache Storage is purged less aggressively by browsers in
 *     "clear site data" / quota-pressure paths than IndexedDB.
 *
 * Sidecar entries live at synthetic URLs of the form
 * `meta:<encodedRealUrl>` so they share the same Cache instance with
 * the binary entries. Lets `list()` walk the cache once and return
 * every model's metadata.
 */

import type {
  CachedModelInfo,
  ModelAssetCache,
  ModelLoadOptions,
  ModelLoadProgress,
} from '../types';

const CACHE_NAME = 'poncho-model-assets-v1';
const META_PREFIX = 'meta:';

interface MetaSidecar {
  size: number;
  cachedAt: number;
}

export class WebModelAssetCache implements ModelAssetCache {
  /**
   * `caches` may not exist (older browsers, http context without
   * secure origin, some test environments). Callers always check
   * `platform.modelAssetCache !== null` so a missing implementation
   * just routes through the no-cache fallback.
   */
  private get cachesApi(): CacheStorage | null {
    if (typeof caches === 'undefined') return null;
    return caches;
  }

  async has(url: string): Promise<boolean> {
    const cache = await this.openCache();
    if (!cache) return false;
    const match = await cache.match(url);
    return match !== undefined;
  }

  async load(url: string, opts: ModelLoadOptions = {}): Promise<ArrayBuffer> {
    const cache = await this.openCache();
    if (cache) {
      const hit = await cache.match(url);
      if (hit) {
        const buf = await hit.arrayBuffer();
        opts.onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, fromCache: true });
        return buf;
      }
    }

    // Fetch live, stream for progress, cache the response on success.
    const fetchInit: RequestInit = {};
    if (opts.signal) fetchInit.signal = opts.signal;
    const fetchResp = await fetch(url, fetchInit);
    if (!fetchResp.ok) {
      throw new Error(`ModelAssetCache: ${url} → HTTP ${fetchResp.status}`);
    }
    const total = parseContentLength(fetchResp.headers.get('content-length'));

    let buf: ArrayBuffer;
    if (opts.onProgress && fetchResp.body) {
      buf = await drainWithProgress(fetchResp.body, total, opts.onProgress);
    } else {
      buf = await fetchResp.arrayBuffer();
    }

    if (cache) {
      // Cache writes don't need to block the caller — but we must
      // await so a follow-up `has()` returns true synchronously.
      await cache.put(url, new Response(buf, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }));
      const meta: MetaSidecar = { size: buf.byteLength, cachedAt: Date.now() };
      await cache.put(META_PREFIX + url, new Response(JSON.stringify(meta), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return buf;
  }

  async remove(url: string): Promise<void> {
    const cache = await this.openCache();
    if (!cache) return;
    await cache.delete(url);
    await cache.delete(META_PREFIX + url);
  }

  async getInfo(url: string): Promise<CachedModelInfo | null> {
    const cache = await this.openCache();
    if (!cache) return null;
    const metaResp = await cache.match(META_PREFIX + url);
    if (!metaResp) {
      // No sidecar — but the binary might exist (older format / put-without-meta).
      const binResp = await cache.match(url);
      if (!binResp) return null;
      const buf = await binResp.arrayBuffer();
      return { url, size: buf.byteLength, cachedAt: 0 };
    }
    try {
      const meta = (await metaResp.json()) as MetaSidecar;
      return { url, size: meta.size, cachedAt: meta.cachedAt };
    } catch {
      return null;
    }
  }

  async list(): Promise<CachedModelInfo[]> {
    const cache = await this.openCache();
    if (!cache) return [];
    const requests = await cache.keys();
    const out: CachedModelInfo[] = [];
    for (const req of requests) {
      const reqUrl = req.url;
      if (!reqUrl.startsWith(META_PREFIX) && !looksLikeMeta(reqUrl)) {
        // Non-meta entry. Look up its sidecar.
        const realUrl = stripBase(reqUrl);
        const info = await this.getInfo(realUrl);
        if (info) out.push(info);
      }
    }
    return out;
  }

  private async openCache(): Promise<Cache | null> {
    const api = this.cachesApi;
    if (!api) return null;
    try {
      return await api.open(CACHE_NAME);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseContentLength(header: string | null): number | null {
  if (!header) return null;
  const n = parseInt(header, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function drainWithProgress(
  body: ReadableStream<Uint8Array>,
  total: number | null,
  onProgress: (p: ModelLoadProgress) => void,
): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  // Always fire an initial 0/total event so progress UIs can render
  // immediately rather than waiting for the first chunk to arrive.
  onProgress({ loaded: 0, total, fromCache: false });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total, fromCache: false });
  }
  // Combine into a contiguous ArrayBuffer.
  const combined = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    combined.set(c, off);
    off += c.byteLength;
  }
  return combined.buffer;
}

/**
 * The browser stores Cache Storage entries with their full URL — the
 * meta prefix may have been folded into a `meta:https://…` style
 * absolute URL or kept as a relative key, depending on the page's
 * origin. Detect either shape.
 */
function looksLikeMeta(url: string): boolean {
  return url.includes(META_PREFIX) && url.indexOf(META_PREFIX) < 8;
}

function stripBase(url: string): string {
  // The Cache Storage normalises some keys to absolute URLs; strip
  // the document origin if present so callers can compare against
  // the original `url` they passed to `load()`.
  if (typeof location === 'undefined') return url;
  const origin = location.origin;
  return url.startsWith(origin) ? url.slice(origin.length) : url;
}
