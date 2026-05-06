/**
 * RomInfo client — looks up display metadata (title, region, revision,
 * etc.) for a loaded ROM and caches the result by SHA-1 hash so each
 * ROM is identified exactly once per browser, no matter how many times
 * the file is reloaded.
 *
 * Lookup order:
 *   1. localStorage cache, keyed by SHA-1 of the raw `.nes` bytes.
 *   2. Each registered remote source, in registration order. The first
 *      source that returns non-null wins. Sources can throw on transient
 *      errors and the next one is tried; only completed nulls cause
 *      progression.
 *   3. Fallback: parse the filename ourselves. Always succeeds with at
 *      least a title (the filename minus extension and brackets).
 *
 * No remote source is wired by default — see the `RomInfoSource`
 * interface and add one with `addSource(...)` if/when you want to talk
 * to ScreenScraper, TheGamesDB, a self-hosted JSON, etc.
 */
import type { LoadedRom, RomInfoSource, RomMeta } from '../domain/rom';

// Re-export so existing callers keep working without an import update.
export type { RomMeta, RomInfoSource };

const CACHE_KEY_PREFIX = 'poncho.rominfo.';

export class RomInfoClient {
  private readonly sources: RomInfoSource[] = [];

  constructor(private readonly storage: Storage = window.localStorage) {}

  /**
   * Register a remote source. Sources are tried in the order added —
   * earliest wins. Add the most authoritative source first.
   */
  addSource(source: RomInfoSource): void {
    this.sources.push(source);
  }

  /**
   * Resolve metadata for a loaded ROM. Always returns a `RomMeta` —
   * even if every remote source fails, the filename-parser fallback
   * guarantees at least a title.
   */
  async lookup(rom: LoadedRom): Promise<RomMeta> {
    const hash = await sha1Hex(rom.data);

    const cached = this.readCache(hash);
    if (cached) return { ...cached, source: 'cache' };

    for (const source of this.sources) {
      try {
        const meta = await source.fetch({ hash, filename: rom.name });
        if (meta) {
          const tagged: RomMeta = { ...meta, source: 'remote' };
          this.writeCache(hash, tagged);
          return tagged;
        }
      } catch {
        // Transient errors fall through to the next source.
      }
    }

    const fallback = parseFilename(rom.name);
    this.writeCache(hash, fallback);
    return fallback;
  }

  /** Inspect the cache directly (e.g. for debug panels). */
  readCache(hash: string): RomMeta | null {
    try {
      const raw = this.storage.getItem(CACHE_KEY_PREFIX + hash);
      return raw ? (JSON.parse(raw) as RomMeta) : null;
    } catch {
      return null;
    }
  }

  /** Wipe a single ROM's cache entry. */
  forget(hash: string): void {
    try { this.storage.removeItem(CACHE_KEY_PREFIX + hash); } catch {}
  }

  /** Wipe every cached ROM entry (across the whole cache). */
  clear(): void {
    try {
      const keys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k && k.startsWith(CACHE_KEY_PREFIX)) keys.push(k);
      }
      for (const k of keys) this.storage.removeItem(k);
    } catch {}
  }

  private writeCache(hash: string, meta: RomMeta): void {
    try {
      this.storage.setItem(CACHE_KEY_PREFIX + hash, JSON.stringify(meta));
    } catch {
      // Quota exceeded, private mode, etc. — we just won't cache.
    }
  }
}

// ----- SHA-1 ---------------------------------------------------------------

/**
 * Compute the SHA-1 of `data` and return its hex string. Uses Web
 * Crypto (available in every modern browser and Node ≥ 19). Returns
 * 40 lowercase hex characters.
 *
 * The slice copy materializes an ArrayBuffer-backed view (TypeScript's
 * `crypto.subtle.digest` typing rejects a view that could be backed by
 * a SharedArrayBuffer). For ROM-sized inputs the one-time copy is
 * negligible.
 */
export async function sha1Hex(data: Uint8Array): Promise<string> {
  const fresh = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  const buf = await crypto.subtle.digest('SHA-1', fresh);
  let out = '';
  const view = new Uint8Array(buf);
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

// ----- Filename parsing ----------------------------------------------------

/**
 * Parse a ROM filename for a title + subtitle. Handles the standard
 * No-Intro / GoodNES naming conventions used by every ROM organizer:
 *
 *   "Contra (USA).nes"
 *     → title="Contra", subtitle="USA"
 *
 *   "The Legend of Zelda (USA) (Rev A).nes"
 *     → title="The Legend of Zelda", subtitle="USA · Rev A"
 *
 *   "Mighty Bomb Jack (E) [!].nes"
 *     → title="Mighty Bomb Jack", subtitle="Europe"
 *     (the [!] verification flag is dropped — not user-facing info)
 *
 *   "Super Mario Bros. 3 (USA) (Disney's Movie Stars Edition).nes"
 *     → title="Super Mario Bros. 3", subtitle="USA · Disney's Movie Stars Edition"
 */
export function parseFilename(filename: string): RomMeta {
  // Defensive percent-decode in case the caller hands us an URL-encoded
  // name. URLs typically pass through `decodeURIComponent` already by
  // the time they reach us, but doing it here keeps the parser robust
  // for direct callers.
  let decoded = filename;
  try { decoded = decodeURIComponent(filename); } catch { /* invalid escape — keep raw */ }
  // Drop the extension.
  const stem = decoded.replace(/\.nes$/i, '');

  // Title = the stem with every (parens) and [bracket] stripped out.
  // Robust against filenames that lead with brackets like "[Homebrew] X".
  const title = stem
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Pull out every parenthesized + bracketed segment.
  const segments: string[] = [];
  for (const m of stem.matchAll(/\(([^)]+)\)|\[([^\]]+)\]/g)) {
    const text = (m[1] ?? m[2] ?? '').trim();
    if (!text) continue;
    // Drop No-Intro verification flags and similar non-display markers.
    if (text === '!' || /^!.*$/.test(text)) continue;
    segments.push(expandRegion(text));
  }

  const subtitle = segments.length > 0 ? segments.join(' · ') : null;
  return { title, subtitle, source: 'filename' };
}

/**
 * Expand short region codes ("U", "E", "J", "JE", etc.) to the
 * full names. Anything we don't recognize passes through unchanged
 * (so revision strings like "Rev A" or "v1.1" still display).
 */
function expandRegion(text: string): string {
  const norm = text.toUpperCase();
  switch (norm) {
    case 'U': case 'USA':              return 'USA';
    case 'E': case 'EU': case 'EUR':   return 'Europe';
    case 'J': case 'JP': case 'JPN':   return 'Japan';
    case 'W':                          return 'World';
    case 'UE': case 'EU':              return 'USA · Europe';
    case 'JU':                         return 'Japan · USA';
    case 'JE':                         return 'Japan · Europe';
    case 'F': case 'FR':               return 'France';
    case 'G': case 'GE':               return 'Germany';
    case 'I': case 'IT':               return 'Italy';
    case 'S': case 'SP':               return 'Spain';
    case 'NL':                         return 'Netherlands';
    case 'SC':                         return 'Scandinavia';
    case 'B': case 'BR':               return 'Brazil';
    case 'A': case 'AU':               return 'Australia';
    case 'K': case 'KR':               return 'Korea';
    case 'CH': case 'CHN':             return 'China';
    case 'TW':                         return 'Taiwan';
    default:                           return text;
  }
}
