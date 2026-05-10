/**
 * MMPX scaler tests.
 *
 * Coverage:
 *   - Output buffer sizing + factor=2 invariant
 *   - Solid-color input → solid-color output (no edges)
 *   - Output pixels are always copies of source pixels (no synthesis)
 *   - Edge step preserves both source colors at sharp transitions
 *   - Diagonal stair pattern → corner cleanup (specific neighbour copy)
 *   - Determinism
 *   - Scaler interface plumbing
 */

import { describe, expect, it } from 'vitest';
import { mmpxScale, MmpxScaler } from '../../src/renderer/scalers/mmpx';
import { createFrameBuffer } from '../../src/renderer/frame-buffer';

const RED = 0xff0000ff;
const BLUE = 0xffff0000;
const GREEN = 0xff00ff00;
const WHITE = 0xffffffff;
const BLACK = 0xff000000;

function alloc(w: number, h: number): Uint32Array {
  return new Uint32Array(w * h);
}

describe('mmpxScale — basic sanity', () => {
  it('1x1 source scales to 2x2 of the same colour', () => {
    const src = new Uint32Array([RED]);
    const out = alloc(2, 2);
    mmpxScale(src, 1, 1, out);
    expect(Array.from(out)).toEqual([RED, RED, RED, RED]);
  });

  it('throws on too-small dest buffer', () => {
    const src = new Uint32Array([RED]);
    const out = alloc(1, 1);
    expect(() => mmpxScale(src, 1, 1, out)).toThrow();
  });

  it('throws on too-small source buffer', () => {
    const src = new Uint32Array(2);
    const out = alloc(8, 8);
    expect(() => mmpxScale(src, 4, 4, out)).toThrow();
  });

  it('solid color 4x4 → solid color 8x8', () => {
    const src = new Uint32Array(16).fill(GREEN);
    const out = alloc(8, 8);
    mmpxScale(src, 4, 4, out);
    for (let i = 0; i < 64; i++) {
      expect(out[i]).toBe(GREEN);
    }
  });

  it('zero-size source is a no-op', () => {
    const src = new Uint32Array(0);
    const out = new Uint32Array(0);
    expect(() => mmpxScale(src, 0, 0, out)).not.toThrow();
  });
});

describe('mmpxScale — copy-only invariant', () => {
  it('every output pixel equals one of the source pixels (no synthesis)', () => {
    // 3×3 input with diagonal pattern.
    const src = new Uint32Array([
      RED,   GREEN, BLUE,
      GREEN, RED,   GREEN,
      BLUE,  GREEN, RED,
    ]);
    const out = alloc(6, 6);
    mmpxScale(src, 3, 3, out);

    const sourceColors = new Set(src);
    for (let i = 0; i < out.length; i++) {
      expect(sourceColors.has(out[i]!)).toBe(true);
    }
  });

  it('two-colour pattern produces only those two colours in output', () => {
    const src = new Uint32Array([
      WHITE, BLACK, WHITE,
      BLACK, WHITE, BLACK,
      WHITE, BLACK, WHITE,
    ]);
    const out = alloc(6, 6);
    mmpxScale(src, 3, 3, out);

    for (let i = 0; i < out.length; i++) {
      expect(out[i] === WHITE || out[i] === BLACK).toBe(true);
    }
  });

  it('all output pixels have alpha=0xff', () => {
    const src = new Uint32Array([RED, BLUE, BLUE, RED]);
    const out = alloc(4, 4);
    mmpxScale(src, 2, 2, out);
    for (let i = 0; i < out.length; i++) {
      expect((out[i]! >>> 24) & 0xff).toBe(0xff);
    }
  });
});

describe('mmpxScale — edge behaviour', () => {
  it('horizontal step (top white / bottom black) — clean transition, no blends', () => {
    const src = new Uint32Array([
      WHITE, WHITE,
      BLACK, BLACK,
    ]);
    const out = alloc(4, 4);
    mmpxScale(src, 2, 2, out);
    // First 2 rows = WHITE, last 2 rows = BLACK.
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        expect(out[r * 4 + c]).toBe(WHITE);
      }
    }
    for (let r = 2; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(out[r * 4 + c]).toBe(BLACK);
      }
    }
  });

  it('vertical step (left white / right black) — clean transition', () => {
    const src = new Uint32Array([
      WHITE, BLACK,
      WHITE, BLACK,
    ]);
    const out = alloc(4, 4);
    mmpxScale(src, 2, 2, out);
    for (let r = 0; r < 4; r++) {
      expect(out[r * 4 + 0]).toBe(WHITE);
      expect(out[r * 4 + 1]).toBe(WHITE);
      expect(out[r * 4 + 2]).toBe(BLACK);
      expect(out[r * 4 + 3]).toBe(BLACK);
    }
  });

  it('determinism — same input → byte-identical output across runs', () => {
    const src = new Uint32Array([
      BLACK, WHITE, WHITE, BLACK,
      WHITE, BLACK, BLACK, WHITE,
      WHITE, BLACK, BLACK, WHITE,
      BLACK, WHITE, WHITE, BLACK,
    ]);
    const a = alloc(8, 8);
    const b = alloc(8, 8);
    mmpxScale(src, 4, 4, a);
    mmpxScale(src, 4, 4, b);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBe(a[i]);
    }
  });

  it('diagonal stair smooths the inner corner', () => {
    // L-shaped corner:
    //   B B
    //   B W
    // The TL corner of W has pattern: a=B, b=B, d=B, e=W → there's an
    // edge configuration MMPX should detect. The TL output sub-pixel
    // of the W pixel should be replaced with B (corner is "cut").
    const src = new Uint32Array([
      BLACK, BLACK,
      BLACK, WHITE,
    ]);
    const out = alloc(4, 4);
    mmpxScale(src, 2, 2, out);
    // Output TL corner of the W block (row 2 col 2) should be BLACK
    // (the corner cut). The other 3 sub-pixels of the W block remain
    // WHITE.
    expect(out[2 * 4 + 2]).toBe(BLACK);
    expect(out[2 * 4 + 3]).toBe(WHITE);
    expect(out[3 * 4 + 2]).toBe(WHITE);
    expect(out[3 * 4 + 3]).toBe(WHITE);
  });
});

describe('MmpxScaler — Scaler interface adapter', () => {
  it('outputSize doubles both dimensions', () => {
    const s = new MmpxScaler();
    expect(s.outputSize(256, 240)).toEqual({ width: 512, height: 480 });
  });

  it('apply() routes to mmpxScale and produces a populated output', () => {
    const input = createFrameBuffer(2, 2);
    input.data[0] = RED;
    input.data[1] = BLUE;
    input.data[2] = BLUE;
    input.data[3] = RED;
    const output = createFrameBuffer(4, 4);
    new MmpxScaler().apply(input, output);
    let nonZero = 0;
    for (let i = 0; i < output.data.length; i++) {
      if (output.data[i] !== 0) nonZero++;
    }
    expect(nonZero).toBe(16);
  });

  it('name is mmpx-2x', () => {
    expect(new MmpxScaler().name).toBe('mmpx-2x');
  });

  it('scale is 2', () => {
    expect(new MmpxScaler().scale).toBe(2);
  });
});

describe('mmpxScale — registry plumbing', () => {
  it('createScaler returns an MmpxScaler for mmpx-2x', async () => {
    const { createScaler } = await import('../../src/renderer/scalers');
    const s = createScaler('mmpx-2x');
    expect(s.name).toBe('mmpx-2x');
    expect(s.scale).toBe(2);
  });
});
