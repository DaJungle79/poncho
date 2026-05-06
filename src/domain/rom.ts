/**
 * Shared, platform-agnostic ROM types.
 *
 * Anything that lives here is pure data + interface — no DOM, no Node,
 * no `crypto`/`fetch`/`indexedDB` references. Every shell (web, Electron,
 * eventual native) can import these without pulling in browser
 * implementations.
 */

/**
 * A ROM that has been validated and is ready to load into the emulator.
 */
export interface LoadedRom {
  /** Display label (filename, URL basename, etc.). */
  readonly name: string;
  /** Source descriptor — useful for "last loaded" tracking. */
  readonly source: string;
  /** Raw iNES bytes. */
  readonly data: Uint8Array;
}

/**
 * Display metadata about a ROM, returned by RomInfoClient.
 */
export interface RomMeta {
  /** Display title — e.g. "The Legend of Zelda". */
  title: string;
  /** Short subtitle (region, revision, etc.) — e.g. "USA · Rev A". Null hides it. */
  subtitle: string | null;
  /** Optional rich fields populated by remote sources. */
  year?: number;
  publisher?: string;
  developer?: string;
  genre?: string;
  /** Where the metadata came from. Useful for debugging. */
  source: 'cache' | 'remote' | 'filename';
}

/**
 * A pluggable RomInfoClient backend. Implementations talk to whichever
 * remote service / local DAT mirror you want.
 */
export interface RomInfoSource {
  readonly name: string;
  /**
   * Look up metadata. Return `null` if not found (we'll try the next
   * source). Throw on transient errors (the client will swallow + try
   * the next source).
   */
  fetch(args: { hash: string; filename: string }): Promise<RomMeta | null>;
}

/**
 * Public summary of a ROM stored in the user's persistent ROM library
 * (browser IndexedDB on the web, on-disk JSON on desktop, etc.).
 *
 * Bytes are deliberately excluded — keep this lightweight for listing.
 */
export interface StoredRomEntry {
  name: string;
  size: number;
  /** Unix timestamp (ms) when the ROM was added. */
  addedAt: number;
}
