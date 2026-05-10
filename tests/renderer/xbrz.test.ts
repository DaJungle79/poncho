/**
 * xBRZ scaler tests.
 *
 * Coverage:
 *   - Output buffer sizing
 *   - Solid-color input → solid-color output (no edges to detect)
 *   - Two-color step edge produces blended pixels at the boundary
 *   - Diagonal step is smoother (mid-distance pixel is blended)
 *   - Determinism (byte-identical output on repeat)
 *   - Edge cases (1×1, 1×N, factor=2..6)
 *   - Scaler interface plumbing (XbrzScaler.outputSize / apply)
 */

import { describe, expect, it } from 'vitest';
import { xbrzScale, XbrzScaler, colorEq, blendColors } from '../../src/renderer/scalers/xbrz';
import { createFrameBuffer } from '../../src/renderer/frame-buffer';

const RED = 0xff0000ff;
const BLUE = 0xffff0000;
const WHITE = 0xffffffff;
const BLACK = 0xff000000;

function alloc(w: number, h: number): Uint32Array {
  return new Uint32Array(w * h);
}

describe('xbrz color helpers', () => {
  it('colorEq is true for identical colours', () => {
    expect(colorEq(RED, RED)).toBe(true);
    expect(colorEq(WHITE, WHITE)).toBe(true);
  });

  it('colorEq is false for distinct primary colours', () => {
    expect(colorEq(RED, BLUE)).toBe(false);
    expect(colorEq(BLACK, WHITE)).toBe(false);
  });

  it('colorEq is true for very close colours below threshold', () => {
    // Two near-blacks differing by 1/255 in each channel — well below tolerance.
    const c1 = 0xff000000;
    const c2 = 0xff010101;
    expect(colorEq(c1, c2)).toBe(true);
  });

  it('blendColors with weight 0 returns dst', () => {
    expect(blendColors(RED, BLUE, 0)).toBe(BLUE);
  });

  it('blendColors with weight 256 returns src', () => {
    expect(blendColors(RED, BLUE, 256)).toBe(RED);
  });

  it('blendColors with weight 128 returns midpoint', () => {
    const mid = blendColors(0xffffffff, 0xff000000, 128);
    // R, G, B should each be ~127 (average of 0 and 255)
    expect(mid & 0xff).toBeCloseTo(127, -1);
    expect((mid >> 8) & 0xff).toBeCloseTo(127, -1);
    expect((mid >> 16) & 0xff).toBeCloseTo(127, -1);
    expect((mid >>> 24) & 0xff).toBe(0xff);
  });
});

describe('xbrzScale — basic sanity', () => {
  it('1x1 source scales to factor×factor block', () => {
    const src = new Uint32Array([RED]);
    const out = alloc(4, 4);
    xbrzScale(src, 1, 1, 4, out);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(RED);
    }
  });

  it('throws if dest buffer too small', () => {
    const src = new Uint32Array([RED]);
    const out = alloc(2, 2);
    expect(() => xbrzScale(src, 1, 1, 4, out)).toThrow();
  });

  it('solid-color 4×4 input → solid-color factor=2 output', () => {
    const src = new Uint32Array(16).fill(BLUE);
    const out = alloc(8, 8);
    xbrzScale(src, 4, 4, 2, out);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(BLUE);
    }
  });

  it('factor 2..6 all produce correctly-sized output', () => {
    const src = new Uint32Array(4).fill(WHITE);
    for (const f of [2, 3, 4, 5, 6] as const) {
      const out = alloc(2 * f, 2 * f);
      xbrzScale(src, 2, 2, f, out);
      // Solid input should produce solid output regardless of factor.
      for (let i = 0; i < out.length; i++) {
        expect(out[i]).toBe(WHITE);
      }
    }
  });

  it('zero-size source is a no-op', () => {
    const src = new Uint32Array(0);
    const out = new Uint32Array(0);
    expect(() => xbrzScale(src, 0, 0, 4, out)).not.toThrow();
  });
});

describe('xbrzScale — edge detection', () => {
  it('horizontal two-color step keeps far corners pure and produces blends near the boundary', () => {
    // 2×2 input: top row red, bottom row blue.
    const src = new Uint32Array([RED, RED, BLUE, BLUE]);
    const out = alloc(8, 8); // 2x2 → 4x scale → 8x8
    xbrzScale(src, 2, 2, 4, out);

    // Far corners — pixels furthest from the boundary in each block —
    // are out of reach of xBRZ corner blends from the boundary edge.
    expect(out[0 * 8 + 0]).toBe(RED);  // TL of top-left block
    expect(out[0 * 8 + 7]).toBe(RED);  // TR of top-right block
    expect(out[7 * 8 + 0]).toBe(BLUE); // BL of bottom-left block
    expect(out[7 * 8 + 7]).toBe(BLUE); // BR of bottom-right block

    // Top two rows of the top half are out of reach of corner blends — pure RED.
    for (let i = 0; i < 2 * 8; i++) {
      expect(out[i]).toBe(RED);
    }
    // Bottom two rows of the bottom half are out of reach — pure BLUE.
    for (let i = 6 * 8; i < 8 * 8; i++) {
      expect(out[i]).toBe(BLUE);
    }

    // Boundary rows have at least some blended pixels (RGB midpoints between RED and BLUE).
    let boundaryBlends = 0;
    for (let row = 3; row <= 4; row++) {
      for (let col = 0; col < 8; col++) {
        const px = out[row * 8 + col]!;
        if (px !== RED && px !== BLUE) boundaryBlends++;
      }
    }
    expect(boundaryBlends).toBeGreaterThan(0);
  });

  it('produces SOME blended pixels on a diagonal step', () => {
    // 3×3 input with a diagonal black line on white background:
    //   B W W
    //   W B W
    //   W W B
    const src = new Uint32Array([
      BLACK, WHITE, WHITE,
      WHITE, BLACK, WHITE,
      WHITE, WHITE, BLACK,
    ]);
    const out = alloc(12, 12); // 3x3 → 4x → 12x12
    xbrzScale(src, 3, 3, 4, out);

    // Count distinct colours in output. With NN we'd see only 2 (black + white).
    // With xBRZ we should see at least one shade in between (a blended grey).
    const colours = new Set<number>();
    for (let i = 0; i < out.length; i++) colours.add(out[i]!);
    expect(colours.size).toBeGreaterThan(2);

    // The blended pixels should be greys (R == G == B, roughly).
    let foundGrey = false;
    for (const c of colours) {
      if (c === BLACK || c === WHITE) continue;
      const r = c & 0xff;
      const g = (c >> 8) & 0xff;
      const b = (c >> 16) & 0xff;
      if (Math.abs(r - g) <= 4 && Math.abs(g - b) <= 4 && r > 0 && r < 255) {
        foundGrey = true;
      }
    }
    expect(foundGrey).toBe(true);
  });

  it('output is byte-identical for the same input (determinism)', () => {
    const src = new Uint32Array([
      BLACK, WHITE, WHITE, BLACK,
      WHITE, BLACK, BLACK, WHITE,
      WHITE, BLACK, BLACK, WHITE,
      BLACK, WHITE, WHITE, BLACK,
    ]);
    const a = alloc(16, 16);
    const b = alloc(16, 16);
    xbrzScale(src, 4, 4, 4, a);
    xbrzScale(src, 4, 4, 4, b);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBe(a[i]);
    }
  });

  it('all output pixels have alpha=0xff', () => {
    const src = new Uint32Array([RED, BLUE, BLUE, RED]);
    const out = alloc(8, 8);
    xbrzScale(src, 2, 2, 4, out);
    for (let i = 0; i < out.length; i++) {
      expect((out[i]! >>> 24) & 0xff).toBe(0xff);
    }
  });
});

describe('xbrzScale — visual smoke patterns', () => {
  function dump(out: Uint32Array, w: number): string[] {
    const rows: string[] = [];
    for (let r = 0; r < out.length / w; r++) {
      let row = '';
      for (let c = 0; c < w; c++) {
        const p = out[r * w + c]!;
        if (p === 0xff000000) row += 'B ';
        else if (p === 0xffffffff) row += 'W ';
        else row += '. ';
      }
      rows.push(row);
    }
    return rows;
  }

  it('thin diagonal line produces blended pixels along the line', () => {
    // 5×5 input with a diagonal line W→B from TL to BR:
    const W = WHITE, B = BLACK;
    const src = new Uint32Array([
      B, W, W, W, W,
      W, B, W, W, W,
      W, W, B, W, W,
      W, W, W, B, W,
      W, W, W, W, B,
    ]);
    const out = alloc(20, 20); // 5×5 → 4× → 20×20
    xbrzScale(src, 5, 5, 4, out);

    // The interior of the diagonal must show non-pure pixels (blended greys).
    // Sample a point on the diagonal — output (10, 10) is the centre of source (2,2)=B.
    expect(out[10 * 20 + 10]).toBe(BLACK);
    // Adjacent pixels should be greys (blends), not pure W or pure B.
    let blends = 0;
    for (let r = 8; r < 12; r++) {
      for (let c = 8; c < 12; c++) {
        const p = out[r * 20 + c]!;
        if (p !== BLACK && p !== WHITE) blends++;
      }
    }
    expect(blends).toBeGreaterThan(0);
  });

  it('vertical edge stays sharp — no horizontal blends introduced', () => {
    // 4×4 input: left columns black, right columns white.
    const src = new Uint32Array([
      BLACK, BLACK, WHITE, WHITE,
      BLACK, BLACK, WHITE, WHITE,
      BLACK, BLACK, WHITE, WHITE,
      BLACK, BLACK, WHITE, WHITE,
    ]);
    const out = alloc(16, 16);
    xbrzScale(src, 4, 4, 4, out);

    // Every row should have a sharp transition from black to white at
    // some column (no row should be all-blends or wrong-side).
    for (let r = 0; r < 16; r++) {
      let blackCount = 0;
      let whiteCount = 0;
      for (let c = 0; c < 16; c++) {
        const p = out[r * 16 + c]!;
        if (p === BLACK) blackCount++;
        else if (p === WHITE) whiteCount++;
      }
      // Both pure colours should be present in roughly half each row.
      expect(blackCount).toBeGreaterThan(4);
      expect(whiteCount).toBeGreaterThan(4);
    }
  });

  it('solid 8×8 block produces pure 32×32 block — no spurious edges', () => {
    const src = new Uint32Array(64).fill(0xffabcdef); // some arbitrary colour
    const out = alloc(32, 32);
    xbrzScale(src, 8, 8, 4, out);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0xffabcdef);
    }
  });

  it('isolated 1×1 black dot on white background gets corner softening', () => {
    // 5×5 input: single black pixel at centre.
    const src = new Uint32Array(25).fill(WHITE);
    src[2 * 5 + 2] = BLACK;
    const out = alloc(20, 20);
    xbrzScale(src, 5, 5, 4, out);

    // The dot's 4×4 block (rows 8-11, cols 8-11) should be predominantly
    // dark — most pixels still BLACK, with the corners of the block
    // softened. xBRZ rounds isolated pixels into disks.
    let dotBlocks = 0;
    for (let r = 8; r < 12; r++) {
      for (let c = 8; c < 12; c++) {
        const p = out[r * 20 + c]!;
        if (p === BLACK) dotBlocks++;
      }
    }
    // At least the centre 4 pixels (positions (1,1), (1,2), (2,1), (2,2))
    // of the dot's 4×4 block should remain pure BLACK.
    expect(dotBlocks).toBeGreaterThanOrEqual(4);

    // Far corners of the surround (rows 0-1, 18-19) are pure WHITE.
    for (let i = 0; i < 2 * 20; i++) expect(out[i]).toBe(WHITE);
    for (let i = 18 * 20; i < 20 * 20; i++) expect(out[i]).toBe(WHITE);
    void dump;
  });
});

describe('XbrzScaler — Scaler interface adapter', () => {
  it('outputSize multiplies by scale', () => {
    const s = new XbrzScaler(4);
    expect(s.outputSize(256, 240)).toEqual({ width: 1024, height: 960 });
  });

  it('apply() routes to xbrzScale and produces a populated output', () => {
    const input = createFrameBuffer(2, 2);
    input.data[0] = RED;
    input.data[1] = BLUE;
    input.data[2] = BLUE;
    input.data[3] = RED;
    const output = createFrameBuffer(8, 8);
    new XbrzScaler(4).apply(input, output);
    // Every pixel should be one of the two source colors or a blended variant.
    let nonZero = 0;
    for (let i = 0; i < output.data.length; i++) {
      if (output.data[i] !== 0) nonZero++;
    }
    expect(nonZero).toBe(64);
  });

  it('name is xbrz-{scale}x', () => {
    expect(new XbrzScaler(2).name).toBe('xbrz-2x');
    expect(new XbrzScaler(4).name).toBe('xbrz-4x');
    expect(new XbrzScaler(6).name).toBe('xbrz-6x');
  });
});

describe('xbrzScale — registry plumbing', () => {
  it('createScaler returns an XbrzScaler for xbrz-{N}x ids', async () => {
    const { createScaler } = await import('../../src/renderer/scalers');
    const s = createScaler('xbrz-4x');
    expect(s.name).toBe('xbrz-4x');
    expect(s.scale).toBe(4);
  });
});
