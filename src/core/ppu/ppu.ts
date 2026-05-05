/**
 * 2C02 PPU — Phase 4a (background rendering wired; sprites still pending).
 *
 * Execution model: the console run loop calls `tick()` three times per CPU
 * cycle. Each call advances the PPU by one dot, runs the per-dot rendering
 * pipeline if applicable, updates the dot/scanline counters, sets/clears
 * vblank at documented boundaries, and (when relevant) fires NMI.
 *
 * Background rendering pipeline (visible scanlines 0..239 + pre-render 261):
 *
 *   - Each 8-dot fetch group reads 4 bytes via the PPU bus:
 *       dot %8 == 1: nametable byte (tile index)
 *       dot %8 == 3: attribute byte (which 2 palette bits this tile uses)
 *       dot %8 == 5: low pattern plane for the current fine-Y row
 *       dot %8 == 7: high pattern plane
 *   - Coarse X advances at the end of each fetch group; fine Y / coarse Y
 *     advance at dot 256.
 *   - At dot 257 the fresh tile is reloaded into the shifters and the
 *     horizontal scroll bits of `t` are copied into `v`.
 *   - On the pre-render scanline at dots 280-304, the vertical scroll bits
 *     are copied from `t` into `v` (so the next frame starts in sync).
 *   - Dots 321-336 pre-fetch the first two tiles of the *next* scanline.
 *   - During visible scanlines, dots 1-256 also output one pixel each from
 *     the top of the shift registers.
 *
 * Reference: nesdev wiki "PPU rendering" + diagram at
 * https://www.nesdev.org/w/images/default/d/d1/Ntsc_timing.png
 *
 * Still deferred (see DEFERRED.md):
 *   - Sprite pipeline (eval, fetch, render, sprite-0 hit, overflow).
 *   - Odd-frame dot-skip on visible-scanline 0.
 *   - The "NMI suppression" race when $2002 is read on dot 1 of 241.
 */

import { NES_HEIGHT, NES_WIDTH, type FrameBuffer, createFrameBuffer } from '../../renderer/frame-buffer';
import type { CpuBus } from '../bus/cpu-bus';
import type { PpuBus } from '../bus/ppu-bus';
import { NES_PALETTE } from './palette';
import { PpuCtrl, PpuMask, PpuRegisters, PpuStatus } from './registers';

/**
 * Reverse the 8 bits of a byte. Used to apply the H-flip attribute to a
 * sprite's pattern bytes at fetch time, so the shifter can always drain
 * bits high-to-low regardless of orientation.
 */
function reverseByte(b: number): number {
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
  b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
  return b & 0xff;
}
import {
  DOTS_PER_SCANLINE,
  PRE_RENDER_SCANLINE,
  SCANLINES_PER_FRAME,
  VBLANK_CLEAR_DOT,
  VBLANK_FIRST_SCANLINE,
  VBLANK_SET_DOT,
} from './timing';

export class Ppu {
  // ----- Public state used by the renderer ----------------------------------

  /** 256x240 framebuffer; replaced with real pixels in Phase 4. */
  readonly framebuffer: FrameBuffer = createFrameBuffer(NES_WIDTH, NES_HEIGHT);

  /** Object Attribute Memory: 64 sprites × 4 bytes. */
  readonly oam = new Uint8Array(256);

  /** Register file plus internal latches. */
  readonly regs = new PpuRegisters();

  // ----- Wiring --------------------------------------------------------------

  private readonly bus: PpuBus;
  private nmiCallback: (() => void) | null = null;

  // ----- Timing --------------------------------------------------------------

  /** Current dot within the scanline (0..340). */
  private dot = 0;
  /** Current scanline (0..261). */
  private scanline = 0;
  /** Frame counter; useful for debug. */
  private frame = 0;

  // ----- NMI level tracker ---------------------------------------------------
  //
  // The CPU-visible NMI line is the AND of (vblank flag set) and (PPUCTRL
  // bit 7). The CPU latches a *rising edge* of that line and services the
  // interrupt at the next instruction boundary. We keep the previous level
  // here so we know when to fire the callback (and only fire once per edge).
  private nmiLine = false;

  // ----- Sprite state (per scanline) ----------------------------------------
  //
  // Real chip evaluates sprites for scanline N+1 during dots 65-256 of
  // scanline N, then fetches their pattern bytes during dots 257-320. We
  // simplify: at dot 1 of each visible scanline we eval + fetch in bulk for
  // the *current* scanline. Visually this is the same; the only games that
  // care about the precise timing are ones that also need sub-cycle timing.
  //
  // `spriteSecondaryOam` mirrors the chip's 32-byte secondary OAM (up to 8
  // sprites × 4 bytes). Eval clears it, then the first 8 OAM entries whose
  // Y range covers the current scanline are copied in. The 9th hit sets
  // `SpriteOverflow` and stops eval.
  //
  // After fetch, the 8 slots have their pattern bytes (with H-flip applied
  // at fetch time so we can shift normally), attribute byte, and X counter.
  // The X counter ticks down each visible dot; once it hits 0, the sprite's
  // 8-bit pattern shifters drain one bit per dot.

  /** Secondary OAM: 8 sprites × 4 bytes, populated each scanline. */
  private spriteSecondaryOam = new Uint8Array(32);
  /** Number of sprites currently in secondary OAM (0..8). */
  private spriteCount = 0;
  /**
   * Index in secondary OAM where sprite 0 lives this scanline, or -1 if
   * sprite 0 didn't make the cut. Drives sprite-0 hit detection.
   */
  private spriteZeroSlot = -1;
  /** Pattern shifter low plane per slot (8-bit). */
  private spritePatternLo = new Uint8Array(8);
  /** Pattern shifter high plane per slot (8-bit). */
  private spritePatternHi = new Uint8Array(8);
  /** Attribute byte per slot. */
  private spriteAttributes = new Uint8Array(8);
  /** X counter per slot — counts down each visible dot until 0, then output. */
  private spriteXCounters = new Uint8Array(8);

  constructor(bus: PpuBus) {
    this.bus = bus;
  }

  /** Wire a callback that should call `cpu.triggerNmi()` on the rising edge. */
  setNmiCallback(cb: () => void): void {
    this.nmiCallback = cb;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  reset(): void {
    this.regs.ctrl = 0;
    this.regs.mask = 0;
    this.regs.status = 0;
    this.regs.oamAddr = 0;
    this.regs.v = 0;
    this.regs.t = 0;
    this.regs.x = 0;
    this.regs.w = 0;
    this.regs.readBuffer = 0;
    this.regs.openBus = 0;
    this.dot = 0;
    this.scanline = 0;
    this.frame = 0;
    this.nmiLine = false;

    this.spriteCount = 0;
    this.spriteZeroSlot = -1;
    this.spriteSecondaryOam.fill(0);
    this.spritePatternLo.fill(0);
    this.spritePatternHi.fill(0);
    this.spriteAttributes.fill(0);
    this.spriteXCounters.fill(0);
  }

  // ===========================================================================
  // Tick
  // ===========================================================================

  /**
   * Advance the PPU by one dot. Returns `true` on the dot that starts
   * vblank (the natural moment at which the host should blit a finished
   * frame).
   *
   * Order: advance the dot/scanline counters FIRST, then apply timing-
   * driven flag changes for the dot we just advanced INTO. This puts the
   * vblank-set side effect at the *leading* edge of dot 1 of scanline 241,
   * matching the documented "VBlank flag is set at dot 1 of scanline 241"
   * timing. After-the-fact reads of $2002 within the same CPU cycle that
   * advanced into dot 1 will see the new flag.
   */
  tick(): boolean {
    this.dot++;
    if (this.dot >= DOTS_PER_SCANLINE) {
      this.dot = 0;
      this.scanline++;
      if (this.scanline >= SCANLINES_PER_FRAME) {
        this.scanline = 0;
        this.frame++;
      }
    }

    // Per-dot mapper hook (MMC3 uses this for its A12-low filter).
    this.bus.tickMapper();

    let frameEnd = false;
    if (this.scanline === VBLANK_FIRST_SCANLINE && this.dot === VBLANK_SET_DOT) {
      this.regs.status |= PpuStatus.VBlank;
      frameEnd = true;
    } else if (this.scanline === PRE_RENDER_SCANLINE && this.dot === VBLANK_CLEAR_DOT) {
      // Pre-render: clear vblank + sprite-0 hit + overflow.
      this.regs.status &= ~(
        PpuStatus.VBlank | PpuStatus.SpriteZeroHit | PpuStatus.SpriteOverflow
      );
    }

    this.renderTick();

    this.updateNmiLine();
    return frameEnd;
  }

  // ===========================================================================
  // Per-dot rendering pipeline (Phase 4a — backgrounds only)
  // ===========================================================================

  /**
   * Drives the per-dot rendering work for visible + pre-render scanlines.
   * Skipped entirely when neither background nor sprites are enabled.
   *
   *   dot 0:           idle
   *   dot 1..256:      output one pixel; on each 8-dot boundary fetch the
   *                    next tile's nt/at/pt bytes; coarse-X++ at dot 8/16/…
   *   dot 256:         vertical Y increment (fine-Y, coarse-Y, nametable)
   *   dot 257:         reload shifters; copy horizontal scroll t→v
   *   dot 280..304:    (pre-render only) copy vertical scroll t→v
   *   dot 321..336:    pre-fetch first two tiles of the next scanline
   *   dot 337..340:    two extra nametable byte fetches (used by MMC5 IRQs)
   */
  private renderTick(): void {
    const isVisibleScanline = this.scanline < 240;
    const isPreRender = this.scanline === PRE_RENDER_SCANLINE;
    if (!isVisibleScanline && !isPreRender) return;

    const renderingOn =
      (this.regs.mask & (PpuMask.ShowBackground | PpuMask.ShowSprites)) !== 0;
    if (!renderingOn) {
      // Rendering off: paint the universal background colour for visible dots
      // so the framebuffer doesn't show stale/garbage from the previous frame.
      if (isVisibleScanline && this.dot >= 1 && this.dot <= 256) {
        const bg = this.bus.read(0x3f00) & 0x3f;
        const x = this.dot - 1;
        this.framebuffer.data[this.scanline * NES_WIDTH + x] = NES_PALETTE[bg];
      }
      return;
    }

    // ----- Sprite eval + fetch for the current visible scanline -------------
    //
    // Real silicon evaluates during dots 65-256 of the *previous* scanline
    // and fetches at dots 257-320. We do both in one shot at dot 1 here for
    // simplicity. Most games don't notice; ones that mid-scanline-modify OAM
    // will need the dot-by-dot version added later.
    if (isVisibleScanline && this.dot === 1) {
      this.evalSprites();
      this.fetchSpritePatterns();
    }

    // ----- Visible / pre-render fetches and pixel output --------------------

    if ((this.dot >= 1 && this.dot <= 256) || (this.dot >= 321 && this.dot <= 336)) {
      // Output one pixel (visible scanlines, dots 1..256 only).
      if (isVisibleScanline && this.dot <= 256) this.composePixel();

      // 8-dot fetch sequence. Step number is (dot - 1) % 8.
      switch ((this.dot - 1) & 0x07) {
        case 0:
          this.reloadBgShifters();
          this.regs.bgFetch.nt = this.bus.read(0x2000 | (this.regs.v & 0x0fff));
          break;
        case 2:
          this.regs.bgFetch.at = this.fetchAttributeBits();
          break;
        case 4:
          this.regs.bgFetch.ptLo = this.fetchPatternByte(0);
          break;
        case 6:
          this.regs.bgFetch.ptHi = this.fetchPatternByte(1);
          break;
        case 7:
          this.incrementCoarseX();
          break;
      }

      this.shiftBgRegisters();
      // Sprite shifters tick every visible dot — even non-output dots, so
      // 8x8 sprites that started at the very left of the scanline drain
      // out properly.
      if (isVisibleScanline && this.dot <= 256) this.shiftSpriteRegisters();
    }

    if (this.dot === 256) this.incrementY();

    if (this.dot === 257) {
      this.reloadBgShifters();
      this.copyHorizontalScroll();
    }

    if (isPreRender && this.dot >= 280 && this.dot <= 304) {
      this.copyVerticalScroll();
    }
  }

  /**
   * Read the attribute byte for the tile at the current `v`, then extract
   * the 2-bit palette select for *this* 16x16 quadrant.
   *
   *   attribute address: $23C0 | (v & $0C00) | ((v >> 4) & $38) | ((v >> 2) & $07)
   *   quadrant select  : ((v >> 4) & 4) | (v & 2)   → 0, 2, 4, or 6 (shift)
   */
  private fetchAttributeBits(): number {
    const v = this.regs.v;
    const atAddr =
      0x23c0 | (v & 0x0c00) | ((v >> 4) & 0x38) | ((v >> 2) & 0x07);
    const at = this.bus.read(atAddr);
    const shift = ((v >> 4) & 4) | (v & 2);
    return (at >> shift) & 0x03;
  }

  /** Read one plane (lo/hi) of the 8-byte pattern for the current row. */
  private fetchPatternByte(plane: 0 | 1): number {
    const fineY = (this.regs.v >> 12) & 0x07;
    const tableBase = this.regs.ctrl & PpuCtrl.BackgroundPatternTable ? 0x1000 : 0x0000;
    const addr = tableBase + this.regs.bgFetch.nt * 16 + fineY + (plane === 1 ? 8 : 0);
    return this.bus.read(addr);
  }

  /**
   * Copy the just-fetched tile bytes into the low half of the pattern shift
   * registers, and load the attribute latches with the current 2-bit
   * palette select. The shift registers' top byte is what's currently being
   * drained to the screen.
   */
  private reloadBgShifters(): void {
    const r = this.regs;
    r.bgShift.patternLo = (r.bgShift.patternLo & 0xff00) | r.bgFetch.ptLo;
    r.bgShift.patternHi = (r.bgShift.patternHi & 0xff00) | r.bgFetch.ptHi;
    r.bgLatch.attribLo = r.bgFetch.at & 1;
    r.bgLatch.attribHi = (r.bgFetch.at >> 1) & 1;
  }

  /**
   * Shift all four background registers by one bit per dot. The attribute
   * shifters are 8-bit and are constantly fed from the latch (so the same
   * 2-bit palette select stays in front of every pixel of the current tile).
   */
  private shiftBgRegisters(): void {
    if (!(this.regs.mask & PpuMask.ShowBackground)) return;
    const r = this.regs;
    r.bgShift.patternLo = (r.bgShift.patternLo << 1) & 0xffff;
    r.bgShift.patternHi = (r.bgShift.patternHi << 1) & 0xffff;
    r.bgShift.attribLo = ((r.bgShift.attribLo << 1) | r.bgLatch.attribLo) & 0xff;
    r.bgShift.attribHi = ((r.bgShift.attribHi << 1) | r.bgLatch.attribHi) & 0xff;
  }

  /**
   * Compute the bg pixel + sprite pixel for the current dot, mux them
   * with the documented priority + sprite-0-hit logic, and write the
   * resulting NES colour into the framebuffer.
   *
   * Mux table (P = priority bit of sprite attributes; 0 = in front, 1 = behind):
   *   bg=0  sp=0  → universal bg ($3F00)
   *   bg=0  sp!=0 → sprite
   *   bg!=0 sp=0  → bg
   *   bg!=0 sp!=0 → sprite if P=0, bg if P=1
   *
   * Sprite-0 hit: set when the sprite-0 slot's pixel is opaque, the bg
   * pixel is opaque, leftmost-8 masking allows it, and we're not on dot
   * 256 (real chip limit). The flag stays set until pre-render scanline.
   */
  private composePixel(): void {
    const x = this.dot - 1;
    const y = this.scanline;
    const fbIndex = y * NES_WIDTH + x;

    // ----- Background pixel --------------------------------------------------
    let bgPixel = 0;
    let bgPalette = 0;
    const showBg = (this.regs.mask & PpuMask.ShowBackground) !== 0;
    const showBgLeft = (this.regs.mask & PpuMask.ShowBackgroundLeft) !== 0;
    if (showBg && (x >= 8 || showBgLeft)) {
      const bit = 0x8000 >> this.regs.x;
      const lo = (this.regs.bgShift.patternLo & bit) !== 0 ? 1 : 0;
      const hi = (this.regs.bgShift.patternHi & bit) !== 0 ? 1 : 0;
      bgPixel = (hi << 1) | lo;
      const ab = 0x80 >> this.regs.x;
      const al = (this.regs.bgShift.attribLo & ab) !== 0 ? 1 : 0;
      const ah = (this.regs.bgShift.attribHi & ab) !== 0 ? 1 : 0;
      bgPalette = (ah << 1) | al;
    }

    // ----- Sprite pixel ------------------------------------------------------
    let spPixel = 0;
    let spPalette = 0;
    let spBehindBg = false;
    let spIsZero = false;
    const showSp = (this.regs.mask & PpuMask.ShowSprites) !== 0;
    const showSpLeft = (this.regs.mask & PpuMask.ShowSpritesLeft) !== 0;
    if (showSp && (x >= 8 || showSpLeft)) {
      for (let i = 0; i < this.spriteCount; i++) {
        if (this.spriteXCounters[i] !== 0) continue;
        const lo = (this.spritePatternLo[i] & 0x80) !== 0 ? 1 : 0;
        const hi = (this.spritePatternHi[i] & 0x80) !== 0 ? 1 : 0;
        const pixel = (hi << 1) | lo;
        if (pixel === 0) continue;
        spPixel = pixel;
        spPalette = this.spriteAttributes[i] & 0x03;
        spBehindBg = (this.spriteAttributes[i] & 0x20) !== 0;
        spIsZero = i === this.spriteZeroSlot;
        break;
      }
    }

    // ----- Mux + sprite-0 hit ------------------------------------------------
    let paletteAddr: number;
    if (bgPixel === 0 && spPixel === 0) {
      paletteAddr = 0x3f00;
    } else if (bgPixel === 0) {
      paletteAddr = 0x3f10 + (spPalette << 2) + spPixel;
    } else if (spPixel === 0) {
      paletteAddr = 0x3f00 + (bgPalette << 2) + bgPixel;
    } else {
      // Both opaque: priority decides; sprite-0 hit may fire.
      if (spIsZero && x !== 255) {
        this.regs.status |= PpuStatus.SpriteZeroHit;
      }
      paletteAddr = spBehindBg
        ? 0x3f00 + (bgPalette << 2) + bgPixel
        : 0x3f10 + (spPalette << 2) + spPixel;
    }

    const colour = this.bus.read(paletteAddr) & 0x3f;
    this.framebuffer.data[fbIndex] = NES_PALETTE[colour];
  }

  // ===========================================================================
  // Sprite evaluation, pattern fetch, shifting
  // ===========================================================================

  /**
   * Scan all 64 OAM entries for ones that overlap this scanline; copy the
   * first 8 into secondary OAM. Set `SpriteOverflow` on the 9th hit.
   *
   * OAM byte 0 is the sprite's Y position MINUS 1 (the chip displays the
   * sprite starting at Y+1). So a sprite at byte0=Y is on scanline N if
   * 1 <= (N - Y) <= spriteHeight; the row within the sprite is (N - Y - 1).
   */
  private evalSprites(): void {
    this.spriteCount = 0;
    this.spriteZeroSlot = -1;
    this.spriteSecondaryOam.fill(0xff);

    const height = this.regs.ctrl & PpuCtrl.SpriteSize ? 16 : 8;

    for (let i = 0; i < 64; i++) {
      const y = this.oam[i * 4];
      const diff = this.scanline - y;
      if (diff < 1 || diff > height) continue;

      if (this.spriteCount >= 8) {
        // Real chip's overflow detection has a documented bug at this
        // point, but the simplified "set on the 9th hit" covers nearly
        // every game.
        this.regs.status |= PpuStatus.SpriteOverflow;
        break;
      }

      const dst = this.spriteCount * 4;
      this.spriteSecondaryOam[dst + 0] = y;
      this.spriteSecondaryOam[dst + 1] = this.oam[i * 4 + 1];
      this.spriteSecondaryOam[dst + 2] = this.oam[i * 4 + 2];
      this.spriteSecondaryOam[dst + 3] = this.oam[i * 4 + 3];
      if (i === 0) this.spriteZeroSlot = this.spriteCount;
      this.spriteCount++;
    }
  }

  /**
   * Read pattern bytes for each sprite in secondary OAM, applying V-flip
   * (by inverting the row index) and H-flip (by reversing each byte) at
   * fetch time so the shifter can drain bits the same way every line.
   *
   *   8x8 mode  : tile index = OAM byte 1; pattern table from PPUCTRL bit 3.
   *   8x16 mode : tile bit 0 selects pattern table; tile & 0xFE plus a
   *               +1 row offset for the second 8-row half.
   */
  private fetchSpritePatterns(): void {
    const height = this.regs.ctrl & PpuCtrl.SpriteSize ? 16 : 8;

    // Empty unused slots — pattern bytes 0 = transparent.
    for (let i = 0; i < 8; i++) {
      this.spritePatternLo[i] = 0;
      this.spritePatternHi[i] = 0;
      this.spriteAttributes[i] = 0;
      this.spriteXCounters[i] = 0xff;
    }

    for (let i = 0; i < this.spriteCount; i++) {
      const base = i * 4;
      const y = this.spriteSecondaryOam[base + 0];
      const tile = this.spriteSecondaryOam[base + 1];
      const attr = this.spriteSecondaryOam[base + 2];
      const x = this.spriteSecondaryOam[base + 3];

      let row = this.scanline - y - 1;
      if (attr & 0x80) row = height - 1 - row; // V-flip

      let addr: number;
      if (height === 8) {
        const tableBase = this.regs.ctrl & PpuCtrl.SpritePatternTable ? 0x1000 : 0x0000;
        addr = tableBase + tile * 16 + row;
      } else {
        // 8x16: bit 0 of tile selects the pattern table; bits 1-7 select
        // the 16-pixel-tall pair of tiles.
        const tableBase = (tile & 1) ? 0x1000 : 0x0000;
        const tileTop = tile & 0xfe;
        addr =
          tableBase +
          tileTop * 16 +
          (row >= 8 ? 16 : 0) +
          (row & 7);
      }

      let lo = this.bus.read(addr);
      let hi = this.bus.read(addr + 8);
      if (attr & 0x40) {
        lo = reverseByte(lo);
        hi = reverseByte(hi);
      }

      this.spritePatternLo[i] = lo;
      this.spritePatternHi[i] = hi;
      this.spriteAttributes[i] = attr;
      this.spriteXCounters[i] = x;
    }
  }

  /**
   * Per-dot maintenance for sprite shifters:
   *   - X counter > 0: decrement (sprite hasn't "started" yet at this dot)
   *   - X counter == 0: shift one bit out of the pattern shifters
   * After 8 shifts the shifter is naturally empty (zeros) so the sprite
   * stops contributing pixels for the rest of the scanline.
   */
  private shiftSpriteRegisters(): void {
    if (!(this.regs.mask & PpuMask.ShowSprites)) return;
    for (let i = 0; i < 8; i++) {
      if (this.spriteXCounters[i] > 0) {
        this.spriteXCounters[i]--;
      } else {
        this.spritePatternLo[i] = (this.spritePatternLo[i] << 1) & 0xff;
        this.spritePatternHi[i] = (this.spritePatternHi[i] << 1) & 0xff;
      }
    }
  }

  /**
   * Coarse-X increment with horizontal nametable wrap.
   *   if coarse X == 31:  wrap to 0 and toggle nametable bit 10.
   *   else:                coarse X += 1.
   */
  private incrementCoarseX(): void {
    if ((this.regs.v & 0x001f) === 31) {
      this.regs.v = (this.regs.v & ~0x001f) ^ 0x0400;
    } else {
      this.regs.v = (this.regs.v + 1) & 0x7fff;
    }
  }

  /**
   * Y increment at dot 256. Fine-Y goes 0..7; on overflow coarse-Y advances
   * 0..29 (rows 30 and 31 are reserved for attribute table on real chips,
   * so the increment skips them with a vertical nametable toggle).
   */
  private incrementY(): void {
    let v = this.regs.v;
    if ((v & 0x7000) !== 0x7000) {
      v = (v + 0x1000) & 0x7fff; // fine Y++
    } else {
      v &= ~0x7000;
      let coarseY = (v >> 5) & 0x1f;
      if (coarseY === 29) {
        coarseY = 0;
        v ^= 0x0800; // toggle vertical nametable
      } else if (coarseY === 31) {
        coarseY = 0;
      } else {
        coarseY = (coarseY + 1) & 0x1f;
      }
      v = (v & ~0x03e0) | (coarseY << 5);
    }
    this.regs.v = v;
  }

  /** Copy horizontal scroll bits (coarse X + horizontal nametable) from t to v. */
  private copyHorizontalScroll(): void {
    this.regs.v = (this.regs.v & ~0x041f) | (this.regs.t & 0x041f);
  }

  /** Copy vertical scroll bits (fine Y + vertical nametable + coarse Y) from t to v. */
  private copyVerticalScroll(): void {
    this.regs.v = (this.regs.v & ~0x7be0) | (this.regs.t & 0x7be0);
  }

  /**
   * NMI is asserted continuously while (vblank flag) AND (PPUCTRL bit 7).
   * The CPU latches the *rising* edge. We model that here: on transition
   * false→true, fire the callback once; on transition true→false (or
   * VBlank getting cleared by a $2002 read), drop the level so the next
   * vblank can fire NMI again.
   */
  private updateNmiLine(): void {
    const level =
      (this.regs.status & PpuStatus.VBlank) !== 0 &&
      (this.regs.ctrl & PpuCtrl.NmiEnable) !== 0;
    if (level && !this.nmiLine) {
      this.nmiCallback?.();
    }
    this.nmiLine = level;
  }

  // ===========================================================================
  // CPU register reads ($2000–$2007 — already mirrored by the CPU bus)
  // ===========================================================================

  cpuRead(addr: number): number {
    const reg = addr & 0x7;
    switch (reg) {
      case 2: return this.readStatus();
      case 4: return this.readOamData();
      case 7: return this.readData();
      default:
        // $2000/$2001/$2003/$2005/$2006 are write-only; reads return open bus.
        return this.regs.openBus;
    }
  }

  cpuWrite(addr: number, value: number): void {
    value &= 0xff;
    this.regs.openBus = value;
    const reg = addr & 0x7;
    switch (reg) {
      case 0: return this.writeCtrl(value);
      case 1: return this.writeMask(value);
      case 3: this.regs.oamAddr = value; return;
      case 4: return this.writeOamData(value);
      case 5: return this.writeScroll(value);
      case 6: return this.writeAddr(value);
      case 7: return this.writeData(value);
    }
  }

  // ----- $2000 PPUCTRL --------------------------------------------------------

  /**
   * Writing PPUCTRL stores the byte and also patches the nametable-select
   * bits into t. NMI-enable transitions can immediately fire NMI if vblank
   * is currently set, so we re-evaluate the line.
   */
  private writeCtrl(value: number): void {
    this.regs.ctrl = value;
    // t: ....BA.. ........ ← d: ......BA  (nametable select bits)
    this.regs.t = (this.regs.t & 0xf3ff) | ((value & 0x03) << 10);
    this.updateNmiLine();
  }

  // ----- $2001 PPUMASK --------------------------------------------------------

  private writeMask(value: number): void {
    this.regs.mask = value;
  }

  // ----- $2002 PPUSTATUS ------------------------------------------------------

  /**
   * $2002 read:
   *   1. Top 3 bits come from `status`.
   *   2. Bottom 5 bits are open-bus (we use the latch).
   *   3. Reading clears VBlank.
   *   4. Reading resets the $2005/$2006 write toggle (w).
   * The NMI line drops because VBlank just cleared.
   */
  private readStatus(): number {
    const result = (this.regs.status & 0xe0) | (this.regs.openBus & 0x1f);
    this.regs.status &= ~PpuStatus.VBlank;
    this.regs.w = 0;
    this.updateNmiLine();
    return result;
  }

  // ----- $2004 OAMDATA --------------------------------------------------------

  private readOamData(): number {
    return this.oam[this.regs.oamAddr];
  }

  /**
   * OAMDATA writes store the byte at OAMADDR and post-increment OAMADDR.
   * Bits 2-4 of byte 2 (sprite attributes) are unimplemented in real OAM
   * and read back as 0; we mask them off here so reads stay consistent.
   */
  private writeOamData(value: number): void {
    if ((this.regs.oamAddr & 0x03) === 0x02) value &= 0xe3;
    this.oam[this.regs.oamAddr] = value;
    this.regs.oamAddr = (this.regs.oamAddr + 1) & 0xff;
  }

  // ----- $2005 PPUSCROLL ------------------------------------------------------

  /**
   * Two-write scroll register.
   *   First  write (w=0): X scroll. Bits 7..3 → coarse X (t bits 4..0);
   *                      bits 2..0 → fine X (the standalone `x` latch).
   *   Second write (w=1): Y scroll. Bits 2..0 → fine Y (t bits 14..12);
   *                      bits 7..3 → coarse Y (t bits 9..5).
   */
  private writeScroll(value: number): void {
    if (this.regs.w === 0) {
      this.regs.t = (this.regs.t & 0xffe0) | (value >>> 3);
      this.regs.x = value & 0x07;
      this.regs.w = 1;
    } else {
      this.regs.t =
        (this.regs.t & 0x8c1f) |
        ((value & 0x07) << 12) |
        ((value & 0xf8) << 2);
      this.regs.w = 0;
    }
  }

  // ----- $2006 PPUADDR --------------------------------------------------------

  /**
   * Two-write address latch.
   *   First write  (w=0): high byte. Bits 5..0 go into t bits 13..8;
   *                       bit 14 is forced to 0 (only 14-bit addresses).
   *   Second write (w=1): low byte → t bits 7..0; then v ← t.
   */
  private writeAddr(value: number): void {
    if (this.regs.w === 0) {
      this.regs.t = (this.regs.t & 0x00ff) | ((value & 0x3f) << 8);
      this.regs.w = 1;
    } else {
      this.regs.t = (this.regs.t & 0xff00) | value;
      this.regs.v = this.regs.t;
      this.regs.w = 0;
    }
  }

  // ----- $2007 PPUDATA --------------------------------------------------------

  /**
   * $2007 read goes through a one-byte buffer for everything below the
   * palette ($0000-$3EFF): the byte the CPU receives is the previous one
   * read, and the buffer captures the new byte for next time.
   *
   * Palette reads ($3F00-$3FFF) bypass the buffer (return immediately) but
   * still update it with the byte from the nametable mirror underneath the
   * palette (i.e. addr - $1000), which a few games rely on.
   *
   * Both paths advance v by 1 or 32 per PPUCTRL VramIncrement.
   */
  private readData(): number {
    const addr = this.regs.v & 0x3fff;
    let result: number;
    if (addr >= 0x3f00) {
      result = this.bus.read(addr);
      this.regs.readBuffer = this.bus.read(addr - 0x1000);
    } else {
      result = this.regs.readBuffer;
      this.regs.readBuffer = this.bus.read(addr);
    }
    this.advanceVramAddr();
    return result;
  }

  private writeData(value: number): void {
    this.bus.write(this.regs.v & 0x3fff, value);
    this.advanceVramAddr();
  }

  /** v += (PPUCTRL bit 2 ? 32 : 1); 15-bit wrap. */
  private advanceVramAddr(): void {
    const inc = this.regs.ctrl & PpuCtrl.VramIncrement ? 32 : 1;
    this.regs.v = (this.regs.v + inc) & 0x7fff;
  }

  // ===========================================================================
  // OAM DMA ($4014)
  // ===========================================================================

  /**
   * Bulk-copy 256 bytes from CPU memory at `page << 8` into OAM. Real
   * hardware spreads this across 514 cycles (513 if entered on an even
   * cycle); the CPU bus is responsible for stalling. This routine just
   * performs the data movement.
   */
  oamDma(cpuBus: CpuBus, page: number): void {
    const base = (page & 0xff) << 8;
    for (let i = 0; i < 256; i++) {
      let value = cpuBus.read(base + i);
      if ((this.regs.oamAddr & 0x03) === 0x02) value &= 0xe3;
      this.oam[this.regs.oamAddr] = value;
      this.regs.oamAddr = (this.regs.oamAddr + 1) & 0xff;
    }
  }

  // ===========================================================================
  // Diagnostics
  // ===========================================================================

  currentDot(): number { return this.dot; }
  currentScanline(): number { return this.scanline; }
  currentFrame(): number { return this.frame; }
  isInVblank(): boolean { return (this.regs.status & PpuStatus.VBlank) !== 0; }

}
