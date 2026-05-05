/**
 * NTSC PPU frame timing constants.
 *
 * One frame is 262 scanlines × 341 dots = 89,342 dots, advancing at 3× the
 * CPU clock. The visible image is 256 × 240. Other scanlines exist purely
 * for timing (vblank, sprite eval, scroll register reload, etc.):
 *
 *   0..239   visible scanlines  — pixels are rendered here
 *   240      post-render        — idle, no PPU activity
 *   241..260 vertical blank     — vblank flag set, NMI may fire on dot 1/241
 *   261      pre-render         — clears vblank/sprite0/overflow, reloads
 *                                 scroll v from t at dots 280-304
 *
 * NMI is asserted at scanline 241, dot 1 (when PPUCTRL bit 7 is set);
 * cleared at scanline 261, dot 1. The PAL variant uses different counts
 * and is not modelled.
 *
 * Reference: nesdev wiki "PPU rendering" and "PPU frame timing".
 */

export const SCANLINES_PER_FRAME = 262;
export const DOTS_PER_SCANLINE = 341;
export const DOTS_PER_FRAME = SCANLINES_PER_FRAME * DOTS_PER_SCANLINE;

/** First and last scanlines of the visible image (inclusive). */
export const VISIBLE_FIRST_SCANLINE = 0;
export const VISIBLE_LAST_SCANLINE = 239;

/** The single idle "post-render" scanline between visible and vblank. */
export const POST_RENDER_SCANLINE = 240;

/** First and last vblank scanlines (inclusive). */
export const VBLANK_FIRST_SCANLINE = 241;
export const VBLANK_LAST_SCANLINE = 260;

/** Pre-render scanline: clears flags and (during rendering) reloads vert scroll. */
export const PRE_RENDER_SCANLINE = 261;

/** Dot at which the vblank flag is set (scanline 241). */
export const VBLANK_SET_DOT = 1;

/** Dot at which the vblank flag is cleared (scanline 261). */
export const VBLANK_CLEAR_DOT = 1;
