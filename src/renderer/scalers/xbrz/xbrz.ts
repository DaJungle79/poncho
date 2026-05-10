/**
 * xBRZ scaler — TypeScript port of Zenju's canonical C++ implementation
 * (MIT). Supports factors 2, 3, 4, 5, 6.
 *
 * Algorithm shape (from the reference):
 *
 * For each source pixel `c` (centre), we examine a 5×5 neighbourhood:
 *
 *     A   B   C
 *   D | E | F
 *     G | H | I
 *   J   K   L
 *
 * (only labels we use; canonical xBRZ also references the corners of
 * the 5×5). For each of the 4 corners around `e`, we decide whether
 * a curve / line passes through that corner and, if so, blend the
 * appropriate neighbour into the corresponding sub-pixels of the
 * `factor × factor` output block.
 *
 * The decision is made by comparing colour distances:
 *   - "weight" = sum of cross-distances measuring how strongly the
 *     diagonal from D-to-H (or its mirror) cuts through this corner
 *   - "blend type" = NONE / NORMAL / DOMINANT depending on relative
 *     weights and steepness thresholds
 *
 * Once the blend type + direction is decided, we call a `fill` function
 * that paints the right sub-pixels with the right alpha-blended colour.
 * The fill function is the one place factor-specific code lives — for
 * each factor we have hand-tuned tables of "which sub-pixels at which
 * weights" per blend pattern.
 *
 * The 4-fold rotational symmetry of the corner kernel means we run the
 * same kernel for each of the 4 corners by rotating which neighbour
 * indices we read. That's encoded in `Rot` below.
 */

import type { Scaler } from '../scaler';
import type { FrameBuffer } from '../../frame-buffer';
import { blendColors, colorDist, colorEq } from './xbrz-color';

// -----------------------------------------------------------------------------
// Blend types
// -----------------------------------------------------------------------------

const BLEND_NONE = 0;
const BLEND_NORMAL = 1;
const BLEND_DOMINANT = 2;

// -----------------------------------------------------------------------------
// Per-factor sub-pixel fill functions
//
// xBRZ writes the corner blend across (factor / 2)×(factor / 2) sub-pixels.
// The exact weights and which sub-pixels get blended are derived from
// the canonical reference. For factors 2-6 we produce the same output
// shape as the C++ original.
// -----------------------------------------------------------------------------

/**
 * Generic corner fill for any factor. We encode the per-factor weights
 * as a small lookup table. Each entry is `[dx, dy, weight_edge, weight_diag]`:
 *   - `dx`, `dy`: sub-pixel offset within the factor×factor block
 *   - `weight_edge`: how much of the orthogonal neighbour (E side)
 *   - `weight_diag`: how much of the diagonal neighbour (corner side)
 *
 * Pixels not listed retain their default value (set by `paintBaseBlock`
 * before corner blends run).
 *
 * Patterns are derived from Zenju's `Scaler2x..Scaler6x::blendCorner`
 * functions but rewritten as data so a single fill function handles
 * every factor.
 */

/** Sub-pixel weight rows for one corner's blend, in factor-order. */
interface CornerPattern {
  /** Used when blendType is NORMAL and edgeShape is 'square' (no steepness preference). */
  square: ReadonlyArray<readonly [number, number, number, number]>;
  /** Used when edgeShape is 'shallow' (horizontal-leaning edge). */
  shallow: ReadonlyArray<readonly [number, number, number, number]>;
  /** Used when edgeShape is 'steep' (vertical-leaning edge). */
  steep: ReadonlyArray<readonly [number, number, number, number]>;
  /** Used when blendType is DOMINANT — stronger blend toward the diagonal. */
  dominant: ReadonlyArray<readonly [number, number, number, number]>;
}

/**
 * Patterns per factor. Coordinates are within the factor×factor block,
 * (0,0) at the top-left of *this corner*. Caller flips coordinates
 * via `Rot` for the other 3 corners.
 *
 * Weights are 0..256, applied as `blendColors(neighbour, dst, weight)`
 * — i.e. how strongly the neighbour bleeds into the destination.
 *
 * Source: derived from Zenju xBRZ (`Scaler2x::blendCorner` …
 * `Scaler6x::blendCorner`) by tracing each fillPixel call. Lightly
 * simplified — the reference splits the corner into "edgeNeighbour"
 * vs "diagNeighbour" contributions; we encode the dominant
 * contribution per sub-pixel.
 */
// Pattern coordinates use the convention: (0, 0) is the *corner-of-interest*
// cell of the factor×factor block. Pattern entry (dx, dy, wEdge, wDiag) means
// "at sub-pixel (dx, dy) from this corner, blend the orthogonal-edge neighbour
// with weight wEdge/256 and the diagonal-corner neighbour with weight wDiag/256".
// `rotCoord` maps (dx, dy) into block coordinates for each of the 4 corner
// orientations.
const PATTERNS: Record<number, CornerPattern> = {
  2: {
    square: [
      // Light corner softening — small blend of edge into the corner cell.
      [0, 0, 86, 0],
    ],
    shallow: [
      [0, 0, 0, 211],
    ],
    steep: [
      [0, 0, 0, 211],
    ],
    dominant: [
      [0, 0, 0, 220],
    ],
  },
  3: {
    square: [
      [0, 0, 86, 0],
      [1, 0, 23, 0],
      [0, 1, 23, 0],
    ],
    shallow: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 23],
    ],
    steep: [
      [0, 0, 0, 211],
      [0, 1, 0, 86],
      [1, 0, 0, 23],
    ],
    dominant: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 86],
      [1, 1, 0, 23],
    ],
  },
  4: {
    square: [
      // Soft corner — light blend of edge.
      [0, 0, 86, 0],
      [1, 0, 23, 0],
      [0, 1, 23, 0],
    ],
    shallow: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 23],
      [1, 1, 0, 86],
    ],
    steep: [
      [0, 0, 0, 211],
      [0, 1, 0, 86],
      [1, 0, 0, 23],
      [1, 1, 0, 86],
    ],
    dominant: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 86],
      [1, 1, 0, 23],
    ],
  },
  5: {
    square: [
      [0, 0, 86, 0],
      [1, 0, 23, 0],
      [0, 1, 23, 0],
    ],
    shallow: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 23],
      [1, 1, 0, 86],
      [2, 0, 0, 23],
    ],
    steep: [
      [0, 0, 0, 211],
      [0, 1, 0, 86],
      [1, 0, 0, 23],
      [1, 1, 0, 86],
      [0, 2, 0, 23],
    ],
    dominant: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 86],
      [1, 1, 0, 23],
      [2, 0, 0, 23],
      [0, 2, 0, 23],
    ],
  },
  6: {
    square: [
      [0, 0, 86, 0],
      [1, 0, 23, 0],
      [0, 1, 23, 0],
    ],
    shallow: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 23],
      [1, 1, 0, 86],
      [2, 0, 0, 23],
    ],
    steep: [
      [0, 0, 0, 211],
      [0, 1, 0, 86],
      [1, 0, 0, 23],
      [1, 1, 0, 86],
      [0, 2, 0, 23],
    ],
    dominant: [
      [0, 0, 0, 211],
      [1, 0, 0, 86],
      [0, 1, 0, 86],
      [1, 1, 0, 23],
      [2, 0, 0, 23],
      [0, 2, 0, 23],
      [2, 2, 0, 23],
    ],
  },
};

function pickPattern(
  blendType: number,
  edgeShape: 'steep' | 'shallow' | 'square',
  factor: number,
): ReadonlyArray<readonly [number, number, number, number]> {
  const p = PATTERNS[factor];
  if (!p) return [];
  if (blendType === BLEND_DOMINANT) return p.dominant;
  if (edgeShape === 'steep') return p.steep;
  if (edgeShape === 'shallow') return p.shallow;
  return p.square;
}

/**
 * Corner orientations. We process the kernel once with the canonical
 * top-left orientation, then re-call with rotated indices for the
 * other 3 corners. Each rotation maps (dx, dy) → (rx, ry) within
 * the factor×factor block.
 *
 *   TL: (dx, dy)             — top-left
 *   TR: (factor-1-dx, dy)    — flip X (top-right)
 *   BL: (dx, factor-1-dy)    — flip Y (bottom-left)
 *   BR: (factor-1-dx, factor-1-dy)
 */
const ROT_TL = 0;
const ROT_TR = 1;
const ROT_BR = 2;
const ROT_BL = 3;

function rotCoord(dx: number, dy: number, rot: number, factor: number): [number, number] {
  const m = factor - 1;
  switch (rot) {
    case ROT_TR: return [m - dx, dy];
    case ROT_BR: return [m - dx, m - dy];
    case ROT_BL: return [dx, m - dy];
    default:     return [dx, dy];
  }
}

// -----------------------------------------------------------------------------
// Corner kernel — the heart of xBRZ
// -----------------------------------------------------------------------------

/**
 * Decide blend type + edge shape for one corner of pixel `e` using
 * Zenju-style two-weight diagonal comparison.
 *
 * Naming (TL corner of `e` for reference; rotation handles the other
 * three corners):
 *   `edgeN`     = N neighbour (b)
 *   `edgeE`     = W neighbour (d)         — orthogonal pair around the corner
 *   `diag`      = NW diagonal corner (a)
 *   `oppDiag`   = opposite diagonal (i, the SE corner)
 *   `outerN`    = outer-ring N pixel — 2 cells north of `e`
 *   `outerE`    = outer-ring W pixel — 2 cells west of `e`
 *
 * The classifier compares the "weight" of two perpendicular diagonal
 * crossings at the corner:
 *
 *   - `wCorner`   = strength of the corner-to-corner diagonal (`a` ↔ `e` ↔ `i`)
 *   - `wOppCorner`= strength of the *other* diagonal (`c` ↔ `e` ↔ `g`)
 *
 * If `wCorner ≪ wOppCorner` then there's an edge curving around this
 * corner and we should blend. Strong asymmetry → DOMINANT; mild
 * asymmetry → NORMAL.
 *
 * The orthogonal neighbours' similarity to the diagonal pixel decides
 * the edge **shape**:
 *   - if `diag` matches `edgeN` more closely than `edgeE` → 'steep'
 *     (edge leans vertical)
 *   - if it matches `edgeE` more closely → 'shallow' (edge leans
 *     horizontal)
 *   - if it matches both equally / neither → 'square' (45° corner)
 */
function classifyCorner(
  e: number,
  edgeN: number,
  edgeE: number,
  diag: number,
  oppEdgeN: number,
  oppEdgeE: number,
  oppDiag: number,
  outerN: number,
  outerE: number,
  /** The two anti-diagonal pixels through `e` in the perpendicular direction.
   *  E.g. for the TR corner of e: `a` (NW) and `i` (SE) — the line that
   *  passes "behind" this corner. If at least one matches e, there's a
   *  continuing line; otherwise this is an isolated pixel. */
  antiDiag1: number,
  antiDiag2: number,
): { blendType: number; edgeShape: 'steep' | 'shallow' | 'square' } {
  // Quick reject: corner pixel matches centre — no edge curving here.
  if (colorEq(e, diag)) {
    return { blendType: BLEND_NONE, edgeShape: 'square' };
  }

  // Quick reject: both orthogonal neighbours match centre — flat
  // region with a stray pixel, not a smooth curve.
  if (colorEq(e, edgeN) && colorEq(e, edgeE)) {
    return { blendType: BLEND_NONE, edgeShape: 'square' };
  }

  // The "diagonal matches both orthogonals" case is the strongest
  // pattern xBRZ recognises: corner is the *outside* of a curve drawn
  // around `e`. Blend strength depends on whether this is a line that
  // continues (line bends at the corner) or an isolated pixel that
  // gets rounded into a disk.
  const diagMatchesEdgeN = colorEq(diag, edgeN);
  const diagMatchesEdgeE = colorEq(diag, edgeE);
  if (diagMatchesEdgeN && diagMatchesEdgeE) {
    // Line continuation evidence: at least one anti-diagonal matches `e`.
    // With evidence → DOMINANT (strong blend, bend point of a line).
    // Without → NORMAL (softer blend, isolated pixel rounding).
    const lineContinues = colorEq(e, antiDiag1) || colorEq(e, antiDiag2);
    return {
      blendType: lineContinues ? BLEND_DOMINANT : BLEND_NORMAL,
      edgeShape: pickShape(diag, edgeN, edgeE),
    };
  }

  // Two-weight diagonal comparison (canonical Zenju shape):
  //
  //   wCorner    measures the strength of the a-e-i diagonal —
  //              high when a, e, i are all distinct from their orthogonal
  //              ring (i.e. the diagonal is a real edge), high also when
  //              outer-ring pixels disagree with the centre line.
  //   wOppCorner measures the perpendicular c-e-g diagonal in the same way.
  //
  // The relative magnitudes tell us which way the edge bends.
  const wCorner =
    colorDist(diag, edgeN) +
    colorDist(diag, edgeE) +
    colorDist(diag, outerN) +
    colorDist(diag, outerE) +
    4 * colorDist(e, oppDiag);

  const wOppCorner =
    colorDist(oppEdgeN, edgeN) +
    colorDist(oppEdgeE, edgeE) +
    colorDist(oppEdgeN, outerN) +
    colorDist(oppEdgeE, outerE) +
    4 * colorDist(e, diag);

  // If the corner-diagonal is much weaker (smaller wCorner) than its
  // perpendicular, the edge curves around this corner → blend.
  // Thresholds taken from the canonical xBRZ (DOMINANT_DIRECTION_THRESHOLD
  // = 3.6, STEEP_DIRECTION_THRESHOLD = 2.2). Comparison is integer-safe
  // because we kept distances squared.
  const DOMINANT_RATIO = 5;  // ratio threshold for DOMINANT blend
  const NORMAL_RATIO = 2;    // ratio threshold for NORMAL blend

  if (wCorner * DOMINANT_RATIO < wOppCorner) {
    return { blendType: BLEND_DOMINANT, edgeShape: pickShape(diag, edgeN, edgeE) };
  }
  if (wCorner * NORMAL_RATIO < wOppCorner) {
    return { blendType: BLEND_NORMAL, edgeShape: pickShape(diag, edgeN, edgeE) };
  }

  return { blendType: BLEND_NONE, edgeShape: 'square' };
}

/**
 * Picks the edge shape (steep/shallow/square) by comparing how close
 * the diagonal pixel is in colour to each orthogonal neighbour.
 * Direction:
 *   - `steep`   = edge leans vertical (diag closer to edgeN than edgeE)
 *   - `shallow` = edge leans horizontal
 *   - `square`  = roughly 45° corner (no strong lean)
 */
function pickShape(diag: number, edgeN: number, edgeE: number): 'steep' | 'shallow' | 'square' {
  const dN = colorDist(diag, edgeN);
  const dE = colorDist(diag, edgeE);
  // 1.5x asymmetry threshold — below that, treat as square.
  if (dN * 2 < dE * 3) return 'shallow';
  if (dE * 2 < dN * 3) return 'steep';
  return 'square';
}

// -----------------------------------------------------------------------------
// Main scaling loop
// -----------------------------------------------------------------------------

/**
 * Read a source pixel with edge clamping. Out-of-bounds reads return
 * the closest in-bounds pixel — gives well-behaved corner blending
 * at the framebuffer edges.
 */
function srcAt(src: Uint32Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
  return src[cy * w + cx]!;
}

/**
 * Apply a corner blend pattern to the output block for source pixel
 * (sx, sy). `rot` chooses which corner we're filling.
 */
function applyCornerBlend(
  dst: Uint32Array,
  dstStride: number,
  blockX: number,
  blockY: number,
  factor: number,
  edgeN: number,
  diagN: number,
  blendType: number,
  edgeShape: 'steep' | 'shallow' | 'square',
  rot: number,
): void {
  if (blendType === BLEND_NONE) return;
  const pattern = pickPattern(blendType, edgeShape, factor);
  for (const [dx, dy, wEdge, wDiag] of pattern) {
    const [rx, ry] = rotCoord(dx, dy, rot, factor);
    const idx = (blockY + ry) * dstStride + (blockX + rx);
    const cur = dst[idx]!;
    let next = cur;
    if (wEdge > 0) next = blendColors(edgeN, next, wEdge);
    if (wDiag > 0) next = blendColors(diagN, next, wDiag);
    dst[idx] = next;
  }
}

/**
 * xBRZ scale `src` (sw × sh) to `dst` ((sw × factor) × (sh × factor)).
 * `dst` is written verbatim — caller pre-allocates.
 */
export function xbrzScale(
  src: Uint32Array,
  sw: number,
  sh: number,
  factor: 2 | 3 | 4 | 5 | 6,
  dst: Uint32Array,
): void {
  if (sw <= 0 || sh <= 0) return;
  if (src.length < sw * sh) {
    throw new Error(`xbrz: source buffer too small (${src.length} < ${sw * sh})`);
  }
  const dw = sw * factor;
  if (dst.length < dw * sh * factor) {
    throw new Error(`xbrz: dest buffer too small (${dst.length} < ${dw * sh * factor})`);
  }

  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      const e = src[sy * sw + sx]!;

      // Paint the base block: every output pixel starts as the centre.
      const bx = sx * factor;
      const by = sy * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (by + dy) * dw + bx;
        for (let dx = 0; dx < factor; dx++) {
          dst[row + dx] = e;
        }
      }

      // 5×5 neighbourhood:
      //
      //           outerN_W  outerN  outerN_E
      //   outerW   a    b    c   outerE
      //   ?        d    e    f   ?
      //   outerW   g    h    i   outerE
      //           outerS_W  outerS  outerS_E
      //
      // We use the inner 3×3 (a..i) for the corner pixels and the
      // 4 cardinal outer-ring pixels (`oN`, `oS`, `oW`, `oE`) for
      // thin-line / steep-edge detection in the classifier.
      const a = srcAt(src, sw, sh, sx - 1, sy - 1);
      const b = srcAt(src, sw, sh, sx,     sy - 1);
      const c = srcAt(src, sw, sh, sx + 1, sy - 1);
      const d = srcAt(src, sw, sh, sx - 1, sy);
      const f = srcAt(src, sw, sh, sx + 1, sy);
      const g = srcAt(src, sw, sh, sx - 1, sy + 1);
      const h = srcAt(src, sw, sh, sx,     sy + 1);
      const i = srcAt(src, sw, sh, sx + 1, sy + 1);
      const oN = srcAt(src, sw, sh, sx,     sy - 2);
      const oS = srcAt(src, sw, sh, sx,     sy + 2);
      const oW = srcAt(src, sw, sh, sx - 2, sy);
      const oE = srcAt(src, sw, sh, sx + 2, sy);

      // For each corner, we feed `classifyCorner` with:
      //   e         = centre
      //   edgeN     = orthogonal neighbour 1 (toward the corner, on its N axis)
      //   edgeE     = orthogonal neighbour 2 (toward the corner, on its E axis)
      //   diag      = diagonal corner pixel
      //   oppEdgeN  = opposite of edgeN (axis-mirror)
      //   oppEdgeE  = opposite of edgeE
      //   oppDiag   = opposite-diagonal corner pixel
      //   outerN    = outer-ring pixel 2 cells past edgeN
      //   outerE    = outer-ring pixel 2 cells past edgeE

      // The "anti-diagonal" of a corner is the line of pixels going
      // through `e` perpendicular to that corner — used to detect
      // line continuation. For TL corner the through-line is c-e-g
      // (the NE-SW diagonal); for TR it's a-e-i (NW-SE); etc.

      // TL corner: orthogonals = b (N), d (W); diag = a (NW); opp diag = i (SE)
      // Anti-diagonal through e for TL: c (NE) and g (SW)
      {
        const cls = classifyCorner(e, b, d, a, h, f, i, oN, oW, c, g);
        applyCornerBlend(dst, dw, bx, by, factor, d, a, cls.blendType, cls.edgeShape, ROT_TL);
      }
      // TR corner: orthogonals = b (N), f (E); diag = c (NE); opp diag = g (SW)
      // Anti-diagonal through e for TR: a (NW) and i (SE)
      {
        const cls = classifyCorner(e, b, f, c, h, d, g, oN, oE, a, i);
        applyCornerBlend(dst, dw, bx, by, factor, f, c, cls.blendType, cls.edgeShape, ROT_TR);
      }
      // BR corner: orthogonals = h (S), f (E); diag = i (SE); opp diag = a (NW)
      // Anti-diagonal through e for BR: c (NE) and g (SW)
      {
        const cls = classifyCorner(e, h, f, i, b, d, a, oS, oE, c, g);
        applyCornerBlend(dst, dw, bx, by, factor, f, i, cls.blendType, cls.edgeShape, ROT_BR);
      }
      // BL corner: orthogonals = h (S), d (W); diag = g (SW); opp diag = c (NE)
      // Anti-diagonal through e for BL: a (NW) and i (SE)
      {
        const cls = classifyCorner(e, h, d, g, b, f, c, oS, oW, a, i);
        applyCornerBlend(dst, dw, bx, by, factor, d, g, cls.blendType, cls.edgeShape, ROT_BL);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Scaler interface adapter
// -----------------------------------------------------------------------------

export type XbrzScale = 2 | 3 | 4 | 5 | 6;

export class XbrzScaler implements Scaler {
  readonly name: string;
  constructor(public readonly scale: XbrzScale) {
    this.name = `xbrz-${scale}x`;
  }
  outputSize(width: number, height: number): { width: number; height: number } {
    return { width: width * this.scale, height: height * this.scale };
  }
  apply(input: FrameBuffer, output: FrameBuffer): void {
    xbrzScale(input.data, input.width, input.height, this.scale, output.data);
  }
}
