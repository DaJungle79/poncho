import { describe, expect, it } from 'vitest';

import {
  EXTENDED_PALETTE_SIZE,
  RAMP_BASE1_START,
  RAMP_BASE2_START,
  RAMP_BASE3_START,
  RAMP_BASE_SHADE,
  RAMP_LENGTH,
  buildExtendedSubPalette,
  snapToExtendedPalette,
} from '../../src/runtime/extended-palette';

/**
 * Build a tiny master palette where entry i has RGB = (i, i*2, i*3),
 * alpha 0xff. Pack into the same ABGR layout PpuUltra uses internally:
 * `(a << 24) | (b << 16) | (g << 8) | r`. Lets tests assert exact
 * pixel values by index.
 */
function makeMaster(count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const r = (i * 3) & 0xff;
    const g = (i * 5) & 0xff;
    const b = (i * 7) & 0xff;
    out[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
}

function unpack(rgba: number): { r: number; g: number; b: number; a: number } {
  return {
    r: rgba & 0xff,
    g: (rgba >> 8) & 0xff,
    b: (rgba >> 16) & 0xff,
    a: (rgba >> 24) & 0xff,
  };
}

describe('buildExtendedSubPalette — layout', () => {
  it('produces a 256-entry palette', () => {
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);
    expect(ext.length).toBe(EXTENDED_PALETTE_SIZE);
  });

  it('legacy pv 0..3 mirror the NES sub-palette entries verbatim', () => {
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);
    expect(ext[0]).toBe(master[0x0f]);
    expect(ext[1]).toBe(master[0x16]);
    expect(ext[2]).toBe(master[0x2a]);
    expect(ext[3]).toBe(master[0x12]);
  });

  it('the ramp-base shade equals the base colour', () => {
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);
    expect(ext[RAMP_BASE1_START + RAMP_BASE_SHADE]).toBe(master[0x16]);
    expect(ext[RAMP_BASE2_START + RAMP_BASE_SHADE]).toBe(master[0x2a]);
    expect(ext[RAMP_BASE3_START + RAMP_BASE_SHADE]).toBe(master[0x12]);
  });

  it('shade 0 of every ramp is black; shade 83 is white', () => {
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);
    for (const start of [RAMP_BASE1_START, RAMP_BASE2_START, RAMP_BASE3_START]) {
      const dark = unpack(ext[start]!);
      expect(dark.r).toBe(0);
      expect(dark.g).toBe(0);
      expect(dark.b).toBe(0);
      const light = unpack(ext[start + RAMP_LENGTH - 1]!);
      expect(light.r).toBe(0xff);
      expect(light.g).toBe(0xff);
      expect(light.b).toBe(0xff);
    }
  });

  it('ramp luminance is monotonic across each ramp', () => {
    // For a non-grayscale base, the per-channel values may not all be
    // monotonic individually (each channel ramps at a different rate),
    // but the *sum* (a fair luminance proxy) should never decrease.
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);

    for (const start of [RAMP_BASE1_START, RAMP_BASE2_START, RAMP_BASE3_START]) {
      let prev = -1;
      for (let s = 0; s < RAMP_LENGTH; s++) {
        const c = unpack(ext[start + s]!);
        const lum = c.r + c.g + c.b;
        expect(lum).toBeGreaterThanOrEqual(prev);
        prev = lum;
      }
    }
  });

  it('uses the alpha channel from the base colour', () => {
    // Master palette entries typically carry alpha 0xff; the ramp
    // should preserve that across all shades.
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);
    for (let i = 0; i < EXTENDED_PALETTE_SIZE; i++) {
      expect((ext[i]! >> 24) & 0xff).toBe(0xff);
    }
  });

  it('throws when sub-palette is too short', () => {
    const master = makeMaster(64);
    expect(() => buildExtendedSubPalette(new Uint8Array(3), master)).toThrow();
  });

  it('throws when master palette is empty', () => {
    expect(() => buildExtendedSubPalette(new Uint8Array(4), new Uint32Array(0))).toThrow();
  });
});

describe('snapToExtendedPalette', () => {
  it('snaps an exact-match RGB to a pv that yields that exact colour', () => {
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);

    // Pick a known colour: the base of the base-1 ramp at pv 45.
    // pv 1 (legacy) maps to the same RGB, so the snapper may pick
    // either — the test asserts equality of the resulting *colour*,
    // not the specific pv index.
    const targetPv = RAMP_BASE1_START + RAMP_BASE_SHADE;
    const c = ext[targetPv]!;
    const r = c & 0xff, g = (c >> 8) & 0xff, b = (c >> 16) & 0xff;

    const snapped = snapToExtendedPalette(r, g, b, ext);
    expect(ext[snapped]).toBe(c);
  });

  it('snaps to the closest entry when the input does not match exactly', () => {
    const master = makeMaster(64);
    const sub = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);
    const ext = buildExtendedSubPalette(sub, master);

    // Pure black is shade 0 of every ramp (and ext[0] = master[0x0f]).
    // Master[0x0f] = (45, 75, 105) per `makeMaster`, so closest match
    // for (0, 0, 0) is one of the shade-0 entries.
    const idx = snapToExtendedPalette(0, 0, 0, ext);
    const c = unpack(ext[idx]!);
    expect(c.r).toBe(0);
    expect(c.g).toBe(0);
    expect(c.b).toBe(0);
  });
});
