/**
 * `XbrzUpscaleClient` tests — palette-aware xBRZ at the UpscaleClient
 * boundary (Phase 3 of v0.5).
 *
 * Coverage:
 *   - 1024-byte output for any 16-byte tile + 4-byte sub-palette
 *   - All output bytes are valid pv values (0..255)
 *   - Determinism — same input → byte-identical output
 *   - Sub-palette change with same tile bytes → different output
 *     (snap-back is sub-palette-aware)
 *   - Solid-pv tiles snap to legacy pv 0..3 slots
 *   - Tiles with diagonal edges produce extended-palette pv values
 *     (pv 4..255 — proves the snap is reaching the ramps)
 *   - Registry plumbing — `xbrz-4x-snap` resolves to XbrzUpscaleClient
 *   - preflight() doesn't throw
 */

import { describe, expect, it } from 'vitest';
import { XbrzUpscaleClient } from '../../src/runtime/xbrz-upscale-client';
import { AI_CACHE_MODEL_XBRZ_4X } from '../../src/core/cart-poncho/ai-cache';

function makeTile(rows: number[]): Uint8Array {
  // rows[] is 8 ints, each interpreted as a row of 8 NES pixels in
  // pv 0..3 packed as 2bpp NCHW (plane 0 + plane 1).
  if (rows.length !== 8) throw new Error('makeTile expects 8 rows');
  const out = new Uint8Array(16);
  for (let y = 0; y < 8; y++) {
    let p0 = 0, p1 = 0;
    const rowVal = rows[y]!;
    for (let x = 0; x < 8; x++) {
      const pv = (rowVal >> (x * 4)) & 0x3;
      const bit = 7 - x;
      if (pv & 1) p0 |= 1 << bit;
      if (pv & 2) p1 |= 1 << bit;
    }
    out[y] = p0;
    out[y + 8] = p1;
  }
  return out;
}

const SOLID_PV0_TILE = new Uint8Array(16); // all 0 → pv 0 everywhere
const SOLID_PV1_TILE = new Uint8Array(16);
SOLID_PV1_TILE.fill(0xff, 0, 8); // plane 0 all 1s, plane 1 all 0s → pv 1
const SOLID_PV2_TILE = new Uint8Array(16);
SOLID_PV2_TILE.fill(0xff, 8, 16); // plane 1 all 1s → pv 2
const SOLID_PV3_TILE = new Uint8Array(16).fill(0xff); // both planes 1 → pv 3

// A common NES sub-palette — black bg, three primary-ish colours.
const SUB_PALETTE: Uint8Array = new Uint8Array([0x0f, 0x16, 0x1a, 0x30]);

describe('XbrzUpscaleClient', () => {
  const client = new XbrzUpscaleClient();

  it('modelId matches AI_CACHE_MODEL_XBRZ_4X', () => {
    expect(client.modelId).toBe(AI_CACHE_MODEL_XBRZ_4X);
  });

  it('preflight() does not throw', async () => {
    await expect(client.preflight!()).resolves.not.toThrow;
  });

  it('produces 1024-byte output for solid pv0 tile', async () => {
    const out = await client.upscaleTile(SOLID_PV0_TILE, SUB_PALETTE);
    expect(out.length).toBe(1024);
  });

  it('all output bytes are valid pv 0..255', async () => {
    const tile = makeTile([
      0x33333330, 0x33333300, 0x33333000, 0x33330000,
      0x33300000, 0x33000000, 0x30000000, 0x00000000,
    ]);
    const out = await client.upscaleTile(tile, SUB_PALETTE);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(255);
    }
  });

  it('solid pv0 tile maps to pv 0 everywhere', async () => {
    const out = await client.upscaleTile(SOLID_PV0_TILE, SUB_PALETTE);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0);
    }
  });

  it('solid pv1 tile maps to pv 1 everywhere', async () => {
    const out = await client.upscaleTile(SOLID_PV1_TILE, SUB_PALETTE);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(1);
    }
  });

  it('solid pv2 tile maps to pv 2 everywhere', async () => {
    const out = await client.upscaleTile(SOLID_PV2_TILE, SUB_PALETTE);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(2);
    }
  });

  it('solid pv3 tile maps to pv 3 everywhere', async () => {
    const out = await client.upscaleTile(SOLID_PV3_TILE, SUB_PALETTE);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(3);
    }
  });

  it('determinism — same input produces byte-identical output', async () => {
    const tile = makeTile([
      0x12000000, 0x01200000, 0x00120000, 0x00012000,
      0x00001200, 0x00000120, 0x00000012, 0x00000001,
    ]);
    const a = await client.upscaleTile(tile, SUB_PALETTE);
    const b = await client.upscaleTile(tile, SUB_PALETTE);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBe(a[i]);
    }
  });

  it('different sub-palettes produce different output for the same tile', async () => {
    const tile = makeTile([
      0x12000000, 0x01200000, 0x00120000, 0x00012000,
      0x00001200, 0x00000120, 0x00000012, 0x00000001,
    ]);
    const palA = new Uint8Array([0x0f, 0x16, 0x1a, 0x30]);
    const palB = new Uint8Array([0x0f, 0x21, 0x29, 0x35]);
    const a = await client.upscaleTile(tile, palA);
    const b = await client.upscaleTile(tile, palB);
    let differ = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { differ = true; break; }
    }
    expect(differ).toBe(true);
  });

  it('diagonal edge tile produces extended-palette pv values (pv > 3)', async () => {
    // Diagonal pv1 line on pv0 background — xBRZ should produce edge
    // blends, snap-back maps them into the base-1 ramp (pv 4..87).
    const tile = makeTile([
      0x10000000, 0x01000000, 0x00100000, 0x00010000,
      0x00001000, 0x00000100, 0x00000010, 0x00000001,
    ]);
    const out = await client.upscaleTile(tile, SUB_PALETTE);
    let extendedCount = 0;
    let pv4to87Count = 0;
    for (let i = 0; i < out.length; i++) {
      const pv = out[i]!;
      if (pv > 3) extendedCount++;
      if (pv >= 4 && pv <= 87) pv4to87Count++;
    }
    expect(extendedCount).toBeGreaterThan(0);
    expect(pv4to87Count).toBeGreaterThan(0); // base-1 ramp engaged
  });

  it('rejects malformed tile size', async () => {
    const bad = new Uint8Array(15);
    await expect(client.upscaleTile(bad, SUB_PALETTE)).rejects.toThrow(/16-byte/);
  });

  it('rejects sub-palette shorter than 4 bytes', async () => {
    const shortPal = new Uint8Array([0x0f, 0x16, 0x1a]);
    await expect(client.upscaleTile(SOLID_PV0_TILE, shortPal)).rejects.toThrow(/sub-palette/);
  });
});

describe('XbrzUpscaleClient — registry plumbing', () => {
  it('xbrz-4x-snap resolves via createUpscaleClient', async () => {
    const { createUpscaleClient } = await import('../../src/convert/upscale-registry');
    const { client, model, usedFallback } = createUpscaleClient(
      'xbrz-4x-snap',
      'rom-bake',
      {},
    );
    expect(usedFallback).toBe(false);
    expect(model.id).toBe('xbrz-4x-snap');
    expect(client.modelId).toBe(AI_CACHE_MODEL_XBRZ_4X);
  });

  it('xbrz-4x-snap is the DEFAULT_UPSCALE_MODEL_ID', async () => {
    const { DEFAULT_UPSCALE_MODEL_ID } = await import('../../src/convert/upscale-registry');
    expect(DEFAULT_UPSCALE_MODEL_ID).toBe('xbrz-4x-snap');
  });

  it('xbrz-4x-snap is listed in listUpscaleModels', async () => {
    const { listUpscaleModels } = await import('../../src/convert/upscale-registry');
    const ids = listUpscaleModels().map((m) => m.id);
    expect(ids).toContain('xbrz-4x-snap');
    expect(ids).toContain('nearest-neighbour');
  });
});
