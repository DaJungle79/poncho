import { describe, expect, it } from 'vitest';

import {
  AI_CACHE_MODEL_NANOBANANA_25_FLASH,
  AI_CACHE_VERSION,
  type AiCacheSection,
} from '../../src/core/cart-poncho/ai-cache';
import { PonchoCartridge } from '../../src/core/cart-poncho/cartridge';
import { parsePonchoRom } from '../../src/core/cart-poncho/header';
import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';

function makeSection(entryCount: number): AiCacheSection {
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const hash = new Uint8Array(16);
    const nesTile = new Uint8Array(16);
    const nativeTile = new Uint8Array(1024);
    for (let j = 0; j < 16; j++) hash[j] = ((i * 11) + j) & 0xff;
    for (let j = 0; j < 16; j++) nesTile[j] = ((i * 13) + j) & 0xff;
    for (let j = 0; j < 1024; j++) nativeTile[j] = ((i * 31) + j) & 0xff;
    entries.push({ hash, nesTile, nativeTile });
  }
  return {
    formatVersion: AI_CACHE_VERSION,
    model: AI_CACHE_MODEL_NANOBANANA_25_FLASH,
    entries,
  };
}

describe('PonchoROM with AI cache section — full round-trip', () => {
  it('writer embeds the section and parser locates it correctly', () => {
    const aiCache = makeSection(3);
    const rom = assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg: new Uint8Array(1024),
      chr: new Uint8Array(1024),
      aiCache,
    });

    const layout = parsePonchoRom(rom);
    expect(layout.header.flags.aiCachePresent).toBe(true);
    expect(layout.aiCacheByteLength).toBe(12 + 3 * 1056);
    expect(layout.aiCacheOffset).toBe(layout.chrOffset + layout.chrByteLength);
  });

  it('section sits between CHR and trailer when both are present', () => {
    const aiCache = makeSection(2);
    const trailer = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const rom = assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg: new Uint8Array(1024),
      chr: new Uint8Array(1024),
      aiCache,
      trailer,
    });

    const layout = parsePonchoRom(rom);
    expect(layout.header.flags.aiCachePresent).toBe(true);
    expect(layout.header.flags.trailerPresent).toBe(true);
    expect(layout.aiCacheOffset).toBe(layout.chrOffset + layout.chrByteLength);
    expect(layout.trailerOffset).toBe(layout.aiCacheOffset + layout.aiCacheByteLength);
    expect(layout.trailerByteLength).toBe(trailer.length);
    // Trailer bytes intact at the right offset.
    expect(rom[layout.trailerOffset]).toBe(0x01);
    expect(rom[layout.trailerOffset + 3]).toBe(0x04);
  });

  it('PonchoCartridge loads the AI cache section and exposes parsed entries', () => {
    const aiCache = makeSection(5);
    const rom = assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg: new Uint8Array(1024),
      chr: new Uint8Array(1024),
      aiCache,
    });

    const cart = new PonchoCartridge(rom);
    expect(cart.aiCache).not.toBeNull();
    expect(cart.aiCache!.entries.length).toBe(5);
    expect(cart.aiCache!.model).toBe(AI_CACHE_MODEL_NANOBANANA_25_FLASH);
    // Verify the bytes match the original entries.
    for (let i = 0; i < 5; i++) {
      expect(cart.aiCache!.entries[i]!.hash).toEqual(aiCache.entries[i]!.hash);
      expect(cart.aiCache!.entries[i]!.nativeTile[0])
        .toBe(aiCache.entries[i]!.nativeTile[0]);
    }
  });

  it('cart without AI cache section reports null for `cart.aiCache`', () => {
    const rom = assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg: new Uint8Array(1024),
      chr: new Uint8Array(1024),
    });
    const cart = new PonchoCartridge(rom);
    expect(cart.aiCache).toBeNull();
  });

  it('flags.aiCachePresent set without aiCache part throws on assemble', () => {
    expect(() => assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg: new Uint8Array(1024),
      chr: new Uint8Array(1024),
      flags: { upscaledMode: false, trailerPresent: false, aiCachePresent: true },
    })).toThrow(/no aiCache section provided/);
  });

  it('CRC32 over the body still matches when cache section is included', () => {
    const aiCache = makeSection(2);
    const rom = assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg: new Uint8Array(1024),
      chr: new Uint8Array(1024),
      aiCache,
    });
    // parsePonchoRom validates CRC by default — if it doesn't throw, CRC matches.
    expect(() => parsePonchoRom(rom)).not.toThrow();
  });
});
