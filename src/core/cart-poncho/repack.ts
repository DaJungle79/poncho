/**
 * Self-upgrading file support — given an original `.poncho` and a fresh
 * AI cache section produced by the runtime upscale worker, build a new
 * `.poncho` byte stream with the cache section embedded (or merged with
 * a previously-embedded one).
 *
 * The merge rule: same model → union of entries (fresh wins on hash
 * collision). Different model → existing entries are dropped (the
 * section field can only carry one model id; the next session can
 * re-upscale with the new model). Old entries on disk are NOT
 * proactively deleted — they survive across sessions until a write-back
 * actually replaces them.
 *
 * Used by the web shell's periodic-flush + cart-unload hooks; available
 * to other shells via the same module.
 */

import {
  parseAiCacheSection,
  type AiCacheEntry,
  type AiCacheSection,
} from './ai-cache';
import {
  parsePonchoRom,
  type PonchoRomLayout,
} from './header';
import { assemblePonchoRom } from './writer';
import { hashToHex } from '../../convert/tile-cache';

/**
 * Take the original `.poncho` bytes + a fresh runtime AI cache snapshot
 * and return a new `.poncho` byte stream with the merged cache section
 * embedded. Header fields, palette, PRG, CHR, and trailer are preserved
 * verbatim (no re-encoding).
 */
export function repackPonchoWithAiCache(
  originalBytes: Uint8Array,
  freshCache: AiCacheSection,
): Uint8Array {
  const layout = parsePonchoRom(originalBytes);

  const existing = readExistingCacheSection(originalBytes, layout);
  const merged = mergeAiCacheSections(existing, freshCache);

  const palette = originalBytes.subarray(
    layout.paletteOffset,
    layout.paletteOffset + layout.paletteByteLength,
  );
  const prg = originalBytes.subarray(
    layout.prgOffset,
    layout.prgOffset + layout.prgByteLength,
  );
  const chr = originalBytes.subarray(
    layout.chrOffset,
    layout.chrOffset + layout.chrByteLength,
  );
  const trailer = layout.trailerByteLength > 0
    ? originalBytes.subarray(
        layout.trailerOffset,
        layout.trailerOffset + layout.trailerByteLength,
      )
    : undefined;

  return assemblePonchoRom({
    title: layout.header.title,
    flags: { ...layout.header.flags, aiCachePresent: true },
    mapperId: layout.header.mapperId,
    mapperSubmode: layout.header.mapperSubmode,
    prgRamKb: layout.header.prgRamKb,
    chrRamKb: layout.header.chrRamKb,
    tvSystem: layout.header.tvSystem,
    region: layout.header.region,
    sourceInesCrc32: layout.header.sourceInesCrc32,
    palette,
    prg,
    chr,
    aiCache: merged,
    ...(trailer ? { trailer } : {}),
  });
}

/**
 * Union two cache sections by hash. Fresh entries win on collision.
 * Existing entries from a different model are dropped — the section
 * format only carries one model id at a time.
 */
export function mergeAiCacheSections(
  existing: AiCacheSection | null,
  fresh: AiCacheSection,
): AiCacheSection {
  const byHash = new Map<string, AiCacheEntry>();
  if (existing && existing.model === fresh.model) {
    for (const e of existing.entries) {
      byHash.set(hashToHex(e.hash), e);
    }
  }
  for (const e of fresh.entries) {
    byHash.set(hashToHex(e.hash), e);
  }
  return {
    formatVersion: fresh.formatVersion,
    model: fresh.model,
    entries: Array.from(byHash.values()),
  };
}

function readExistingCacheSection(
  data: Uint8Array,
  layout: PonchoRomLayout,
): AiCacheSection | null {
  if (!layout.header.flags.aiCachePresent || layout.aiCacheByteLength === 0) {
    return null;
  }
  return parseAiCacheSection(data, layout.aiCacheOffset, layout.aiCacheByteLength);
}
