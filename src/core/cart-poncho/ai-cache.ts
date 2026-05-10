/**
 * PonchoROM AI cache section.
 *
 * An optional section between CHR and the (also optional) trailer that
 * stores AI-upscaled CHR tiles produced at runtime (CHR-RAM lazy bake) or
 * at conversion time (CHR-ROM bake-now). Gated by `flags.aiCachePresent`
 * (bit 2) in the 64-byte header.
 *
 * Layout — all integers little-endian:
 *
 *   4 bytes   magic 'AICH'  (0x41 0x49 0x43 0x48)
 *   2 bytes   format version (= 1)
 *   2 bytes   model identifier (0 = unspecified, 0xff = nearest-neighbour, future
 *             local-model ids assigned as they ship — see ai-cache.ts constants)
 *   4 bytes   entry count N
 *   ─── per entry (1056 bytes) ───
 *     16 bytes   SHA-256-truncated-128 of (16-byte NES tile ++ 16-byte sub-palette indices)
 *     16 bytes   raw NES tile bytes (verifier — protects against stale entries
 *                if the cartridge's CHR data changes underneath the cache)
 *     1024 bytes upscaled 32×32 8 bpp Poncho tile (row-major)
 *
 * The runtime treats entries with a model that doesn't match the
 * currently-configured upscaler as cache misses (forces re-upscale).
 * Stale entries are kept in the file until overwritten — no destructive
 * purge, so toggling models doesn't lose work.
 */

export const AI_CACHE_MAGIC = Object.freeze([0x41, 0x49, 0x43, 0x48] as const);
export const AI_CACHE_VERSION = 1;

/**
 * Stable identifiers for upscaler models. New entries get a new id;
 * the runtime keys cache validity on this so model iteration doesn't
 * silently mix old + new outputs.
 *
 * Slot allocation policy:
 *   - 0          unspecified (legacy carts, never produced fresh)
 *   - 1..0xfe    local-model entries, allocated as each ships
 *   - 0xff       deterministic nearest-neighbour fallback
 */
export const AI_CACHE_MODEL_UNSPECIFIED = 0;
/** Real-ESRGAN-x4plus — first registered local model (Phase 5a). */
export const AI_CACHE_MODEL_ESRGAN_X4_PLUS = 1;
export const AI_CACHE_MODEL_SPAN_X4_CH48 = 2;
export const AI_CACHE_MODEL_XBRZ_4X = 3;
export const AI_CACHE_MODEL_NEAREST_NEIGHBOUR = 0xff;

const SECTION_HEADER_BYTES = 4 + 2 + 2 + 4; // magic + version + model + count = 12
const ENTRY_BYTES = 16 + 16 + 1024;          // hash + nesTile + nativeTile = 1056

/** Byte counts surfaced for tests + the writer. */
export const AI_CACHE_SECTION_HEADER_BYTES = SECTION_HEADER_BYTES;
export const AI_CACHE_ENTRY_BYTES = ENTRY_BYTES;

export class AiCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiCacheError';
  }
}

/**
 * Single tile entry. Buffers are owned by the parser (subarrays into the
 * source `.poncho` data); writers accept any 16/16/1024-byte arrays.
 */
export interface AiCacheEntry {
  /** 16-byte SHA-256-truncated-128 over (NES tile + sub-palette). */
  hash: Uint8Array;
  /** 16-byte raw NES tile bytes (planar, plane 0 then plane 1). */
  nesTile: Uint8Array;
  /** 1024-byte 32×32 8 bpp upscaled tile. */
  nativeTile: Uint8Array;
}

export interface AiCacheSection {
  /** Format version (currently 1). */
  formatVersion: number;
  /** Which model produced these entries. */
  model: number;
  entries: AiCacheEntry[];
}

/**
 * Parse the AI cache section starting at `offset` in `data` for `length`
 * bytes. Returns the parsed section. Throws `AiCacheError` on bad magic
 * or self-inconsistent length.
 */
export function parseAiCacheSection(
  data: Uint8Array,
  offset: number,
  length: number,
): AiCacheSection {
  if (length < SECTION_HEADER_BYTES) {
    throw new AiCacheError(
      `AI cache section too short: ${length} bytes (need at least ${SECTION_HEADER_BYTES})`,
    );
  }
  for (let i = 0; i < 4; i++) {
    if (data[offset + i] !== AI_CACHE_MAGIC[i]) {
      throw new AiCacheError('AI cache section: bad magic (expected ASCII "AICH")');
    }
  }
  const view = new DataView(data.buffer, data.byteOffset + offset, length);
  const formatVersion = view.getUint16(4, true);
  const model = view.getUint16(6, true);
  const entryCount = view.getUint32(8, true);

  const expected = SECTION_HEADER_BYTES + entryCount * ENTRY_BYTES;
  if (expected > length) {
    throw new AiCacheError(
      `AI cache section: declares ${entryCount} entries (need ${expected} bytes), only ${length} available`,
    );
  }

  const entries: AiCacheEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const eOff = offset + SECTION_HEADER_BYTES + i * ENTRY_BYTES;
    entries.push({
      hash:       data.subarray(eOff,        eOff + 16),
      nesTile:    data.subarray(eOff + 16,   eOff + 32),
      nativeTile: data.subarray(eOff + 32,   eOff + ENTRY_BYTES),
    });
  }

  return { formatVersion, model, entries };
}

/**
 * Compute the byte length of an AI cache section, given an entry count.
 * Used by the writer to size buffers up-front.
 */
export function aiCacheSectionLength(entryCount: number): number {
  return SECTION_HEADER_BYTES + entryCount * ENTRY_BYTES;
}

/**
 * Serialise an AI cache section into a freshly-allocated `Uint8Array`.
 * Does NOT include the surrounding `.poncho` header — the writer passes
 * the result to `assemblePonchoRom` which composes the full file.
 */
export function writeAiCacheSection(section: AiCacheSection): Uint8Array {
  const total = aiCacheSectionLength(section.entries.length);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = AI_CACHE_MAGIC[0];
  out[1] = AI_CACHE_MAGIC[1];
  out[2] = AI_CACHE_MAGIC[2];
  out[3] = AI_CACHE_MAGIC[3];
  view.setUint16(4, section.formatVersion & 0xffff, true);
  view.setUint16(6, section.model & 0xffff, true);
  view.setUint32(8, section.entries.length, true);

  for (let i = 0; i < section.entries.length; i++) {
    const e = section.entries[i]!;
    if (e.hash.length !== 16) {
      throw new AiCacheError(`entry ${i}: hash must be 16 bytes (got ${e.hash.length})`);
    }
    if (e.nesTile.length !== 16) {
      throw new AiCacheError(`entry ${i}: nesTile must be 16 bytes (got ${e.nesTile.length})`);
    }
    if (e.nativeTile.length !== 1024) {
      throw new AiCacheError(`entry ${i}: nativeTile must be 1024 bytes (got ${e.nativeTile.length})`);
    }
    const eOff = SECTION_HEADER_BYTES + i * ENTRY_BYTES;
    out.set(e.hash,       eOff);
    out.set(e.nesTile,    eOff + 16);
    out.set(e.nativeTile, eOff + 32);
  }

  return out;
}
