import { describe, expect, it } from 'vitest';

import {
  AI_CACHE_ENTRY_BYTES,
  AI_CACHE_MAGIC,
  AI_CACHE_MODEL_NANOBANANA_25_FLASH,
  AI_CACHE_MODEL_UNSPECIFIED,
  AI_CACHE_SECTION_HEADER_BYTES,
  AI_CACHE_VERSION,
  AiCacheError,
  aiCacheSectionLength,
  parseAiCacheSection,
  writeAiCacheSection,
  type AiCacheEntry,
  type AiCacheSection,
} from '../../src/core/cart-poncho/ai-cache';

function mkEntry(seed: number): AiCacheEntry {
  const hash = new Uint8Array(16);
  const nesTile = new Uint8Array(16);
  const nativeTile = new Uint8Array(1024);
  for (let i = 0; i < 16; i++) hash[i] = (seed * 7 + i) & 0xff;
  for (let i = 0; i < 16; i++) nesTile[i] = (seed * 13 + i) & 0xff;
  for (let i = 0; i < 1024; i++) nativeTile[i] = (seed * 31 + i) & 0xff;
  return { hash, nesTile, nativeTile };
}

describe('AI cache section — constants', () => {
  it('exposes the canonical sizes', () => {
    expect(AI_CACHE_SECTION_HEADER_BYTES).toBe(12);
    expect(AI_CACHE_ENTRY_BYTES).toBe(1056);
    expect(aiCacheSectionLength(0)).toBe(12);
    expect(aiCacheSectionLength(1)).toBe(12 + 1056);
    expect(aiCacheSectionLength(100)).toBe(12 + 100 * 1056);
  });

  it('magic is ASCII "AICH"', () => {
    expect(String.fromCharCode(...AI_CACHE_MAGIC)).toBe('AICH');
  });
});

describe('AI cache section — write / parse round trip', () => {
  it('round-trips a 0-entry section', () => {
    const section: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NANOBANANA_25_FLASH,
      entries: [],
    };
    const bytes = writeAiCacheSection(section);
    expect(bytes.length).toBe(12);
    const parsed = parseAiCacheSection(bytes, 0, bytes.length);
    expect(parsed.formatVersion).toBe(AI_CACHE_VERSION);
    expect(parsed.model).toBe(AI_CACHE_MODEL_NANOBANANA_25_FLASH);
    expect(parsed.entries.length).toBe(0);
  });

  it('round-trips a 3-entry section preserving every byte', () => {
    const section: AiCacheSection = {
      formatVersion: AI_CACHE_VERSION,
      model: AI_CACHE_MODEL_NANOBANANA_25_FLASH,
      entries: [mkEntry(1), mkEntry(2), mkEntry(3)],
    };
    const bytes = writeAiCacheSection(section);
    expect(bytes.length).toBe(aiCacheSectionLength(3));
    const parsed = parseAiCacheSection(bytes, 0, bytes.length);
    expect(parsed.entries.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(parsed.entries[i]!.hash).toEqual(section.entries[i]!.hash);
      expect(parsed.entries[i]!.nesTile).toEqual(section.entries[i]!.nesTile);
      expect(parsed.entries[i]!.nativeTile).toEqual(section.entries[i]!.nativeTile);
    }
  });

  it('parses the section at a non-zero offset (e.g. inside a .poncho)', () => {
    const section: AiCacheSection = {
      formatVersion: 1,
      model: AI_CACHE_MODEL_UNSPECIFIED,
      entries: [mkEntry(42)],
    };
    const sectionBytes = writeAiCacheSection(section);
    // Embed the section at offset 100 in a larger buffer.
    const surround = new Uint8Array(100 + sectionBytes.length + 50);
    surround.set(sectionBytes, 100);
    const parsed = parseAiCacheSection(surround, 100, sectionBytes.length);
    expect(parsed.entries.length).toBe(1);
    expect(parsed.entries[0]!.nativeTile[0]).toBe(section.entries[0]!.nativeTile[0]);
  });
});

describe('AI cache section — error paths', () => {
  it('throws on bad magic', () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x42, 0x42, 0x42, 0x42], 0); // wrong magic
    expect(() => parseAiCacheSection(bytes, 0, 12)).toThrow(AiCacheError);
  });

  it('throws when length is shorter than the section header', () => {
    expect(() => parseAiCacheSection(new Uint8Array(8), 0, 8)).toThrow(/too short/);
  });

  it('throws when declared entry count exceeds available bytes', () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x41, 0x49, 0x43, 0x48], 0);
    new DataView(bytes.buffer).setUint32(8, 5, true); // declares 5 entries
    expect(() => parseAiCacheSection(bytes, 0, 12)).toThrow(/declares 5 entries/);
  });

  it('writer rejects entries with wrong-length buffers', () => {
    const bad = mkEntry(0);
    bad.hash = new Uint8Array(8); // wrong size
    expect(() => writeAiCacheSection({
      formatVersion: 1, model: 0, entries: [bad],
    })).toThrow(/16 bytes/);
  });
});
