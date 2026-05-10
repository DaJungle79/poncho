/**
 * Color distance + alpha blend helpers for xBRZ.
 *
 * The canonical xBRZ uses a YCbCr-weighted distance metric so its edge
 * detection matches human perception (red-vs-green is more "different"
 * than red-vs-orange even when their RGB Manhattan distance is similar).
 *
 * Pixel layout matches `FrameBuffer.data`: `0xAABBGGRR` packed
 * little-endian. Helpers operate on 32-bit ints throughout — no
 * un-packing per-pixel; we strip channels with shifts.
 *
 * Reference: Zenju's xBRZ (MIT). Default constants picked to match the
 * reference implementation byte-for-byte so test outputs can be
 * compared against the C++ reference.
 */

/** YCbCr distance threshold below which two pixels are considered "equal" for pattern matching. */
export const EQUAL_COLOR_TOLERANCE = 30 * 30; // squared distance to avoid sqrt on hot path

/** Steepness threshold for "thin diagonal edge" detection. */
export const DOMINANT_DIRECTION_THRESHOLD = 3.6;
export const STEEP_DIRECTION_THRESHOLD = 2.2;

/**
 * YCbCr weights from the canonical xBRZ. Tuned against the perceptual
 * sensitivity of the human visual system; Y (luma) dominates, then Cb,
 * then Cr.
 */
const W_Y = 48;
const W_CB = 7;
const W_CR = 6;

/**
 * Squared YCbCr distance between two ABGR pixels. Returns an integer
 * suitable for direct comparison with `EQUAL_COLOR_TOLERANCE` (also a
 * squared value, so no sqrt anywhere on the hot path).
 *
 * The exact formula is the same as Zenju's `dist_YCbCr` minus the
 * final `sqrt` — squared distances compose multiplicatively under
 * threshold comparison so we can drop the sqrt for free.
 */
export function colorDist(a: number, b: number): number {
  const ar = a & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = (a >> 16) & 0xff;
  const br = b & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = (b >> 16) & 0xff;

  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;

  // Y  = 0.299R + 0.587G + 0.114B
  // Cb = -0.168736R - 0.331264G + 0.5B
  // Cr = 0.5R - 0.418688G - 0.081312B
  // Distances scale linearly with channel deltas, so we compute:
  //   dY  = 0.299*dr + 0.587*dg + 0.114*db
  //   dCb = -0.168736*dr - 0.331264*dg + 0.5*db
  //   dCr = 0.5*dr - 0.418688*dg - 0.081312*db
  // Then weighted-sum the squared deltas. Constants pre-multiplied
  // by 1024 to stay in integer arithmetic.
  const dY = (306 * dr + 601 * dg + 117 * db) >> 10;        // 0.299/0.587/0.114 * 1024
  const dCb = ((-173 * dr - 339 * dg + 512 * db) >> 10);    // -0.168736 / -0.331264 / 0.5
  const dCr = ((512 * dr - 429 * dg - 83 * db) >> 10);      // 0.5 / -0.418688 / -0.081312

  return W_Y * dY * dY + W_CB * dCb * dCb + W_CR * dCr * dCr;
}

/** Two pixels considered "equal" by xBRZ's threshold. */
export function colorEq(a: number, b: number): boolean {
  return colorDist(a, b) < EQUAL_COLOR_TOLERANCE;
}

/**
 * Alpha-blend `dst` toward `src` by `weight / 256`. Returns the new
 * 32-bit ABGR. Matches Zenju's `gradientRGB` shape — preserves the
 * destination's alpha verbatim (we always emit 0xff there anyway).
 *
 * `weight` is an integer 0..256.
 */
export function blendColors(src: number, dst: number, weight: number): number {
  if (weight === 0) return dst;
  if (weight === 256) return src;
  const sr = src & 0xff, sg = (src >> 8) & 0xff, sb = (src >> 16) & 0xff;
  const dr = dst & 0xff, dg = (dst >> 8) & 0xff, db = (dst >> 16) & 0xff;
  const r = (dr * (256 - weight) + sr * weight) >> 8;
  const g = (dg * (256 - weight) + sg * weight) >> 8;
  const b = (db * (256 - weight) + sb * weight) >> 8;
  return 0xff000000 | (b << 16) | (g << 8) | r;
}
