/**
 * PPU register definitions and internal state.
 *
 * The PPU exposes 8 CPU-visible registers at $2000-$2007 (mirrored every 8
 * bytes through $3FFF). Behind those are several internal latches the CPU
 * cannot read directly but which are essential for correct emulation:
 *
 *   v  (15 bits)  current VRAM address; used by the background fetch
 *                 pipeline and by $2007 reads/writes.
 *   t  (15 bits)  temporary VRAM address; loaded by writes to $2000/$2005/
 *                 $2006 and copied to v at specific points in the frame.
 *   x  (3 bits)   fine X scroll (sub-tile horizontal offset).
 *   w  (1 bit)    write toggle, used by $2005 and $2006 to alternate
 *                 between two halves; reset by $2002 reads.
 *
 * Layout of v / t (15 bits, low to high):
 *
 *   bit 14:  unused (only 14 bits of v are bus-facing)
 *   bits 12-14: fine Y scroll  (3 bits)
 *   bits 10-11: nametable      (2 bits)
 *   bits  5-9 : coarse Y scroll (5 bits)
 *   bits  0-4 : coarse X scroll (5 bits)
 *
 * Reference: nesdev wiki "PPU registers" + "PPU scrolling".
 */

// =============================================================================
// $2000 PPUCTRL — write-only
// =============================================================================

export const enum PpuCtrl {
  /** Bits 0-1: base nametable select (00:$2000 01:$2400 10:$2800 11:$2C00). */
  Nametable = 0x03,
  /** Bit 2: $2007 increment. 0 = +1 (across), 1 = +32 (down). */
  VramIncrement = 0x04,
  /** Bit 3: sprite pattern table when 8x8 sprites. 0 = $0000, 1 = $1000. */
  SpritePatternTable = 0x08,
  /** Bit 4: background pattern table. 0 = $0000, 1 = $1000. */
  BackgroundPatternTable = 0x10,
  /** Bit 5: sprite size. 0 = 8x8, 1 = 8x16 (uses both pattern tables). */
  SpriteSize = 0x20,
  /** Bit 6: master/slave. Wired up on Famicom only; ignored on NES carts. */
  MasterSlave = 0x40,
  /** Bit 7: generate NMI at the start of vblank. */
  NmiEnable = 0x80,
}

// =============================================================================
// $2001 PPUMASK — write-only
// =============================================================================

export const enum PpuMask {
  Grayscale = 0x01,
  ShowBackgroundLeft = 0x02,
  ShowSpritesLeft = 0x04,
  ShowBackground = 0x08,
  ShowSprites = 0x10,
  EmphasizeRed = 0x20,
  EmphasizeGreen = 0x40,
  EmphasizeBlue = 0x80,
}

// =============================================================================
// $2002 PPUSTATUS — read-only (top 3 bits live; bottom 5 are open bus)
// =============================================================================

export const enum PpuStatus {
  /** Bit 5: sprite-overflow flag (set during sprite eval, cleared at pre-render). */
  SpriteOverflow = 0x20,
  /** Bit 6: sprite 0 hit flag (set when sprite 0 overlaps an opaque bg pixel). */
  SpriteZeroHit = 0x40,
  /** Bit 7: vblank in progress. */
  VBlank = 0x80,
}

// =============================================================================
// PpuRegisters — all the state, public for tests/diagnostics
// =============================================================================

export class PpuRegisters {
  // ----- CPU-visible registers ------------------------------------------------

  /** $2000 PPUCTRL — last value written. */
  ctrl = 0;
  /** $2001 PPUMASK — last value written. */
  mask = 0;
  /** $2002 PPUSTATUS — top 3 bits real, bottom 5 are open bus on read. */
  status = 0;
  /** $2003 OAMADDR — index into OAM for $2004. */
  oamAddr = 0;

  // ----- Internal latches -----------------------------------------------------

  /** Current VRAM address (15 bits). */
  v = 0;
  /** Temporary VRAM address (15 bits). */
  t = 0;
  /** Fine X scroll (3 bits). */
  x = 0;
  /** Two-write toggle for $2005/$2006. Reset by $2002 reads. */
  w = 0;
  /** $2007 read buffer. See Ppu.readData for the quirk it implements. */
  readBuffer = 0;

  /**
   * "Open bus" latch — every CPU write to a PPU register stores its value
   * here. Reads of write-only registers return this; reads of $2002 use
   * its low 5 bits. The real chip's latch decays in microseconds; we just
   * keep the most recent value, which is what software relies on.
   */
  openBus = 0;

  // ----- Background fetch pipeline -----------------------------------------
  //
  // Background rendering happens in 8-dot fetch groups. During each group
  // four bus reads pull the data for ONE tile:
  //   dots 1,3,5,7 (relative): nametable, attribute, pattern lo, pattern hi.
  // Those bytes land in `bgFetch.*`. At the start of the next 8-dot group
  // (and after pre-fetch at dot 257 + 321), the latches are loaded into
  // the high byte of the 16-bit shift registers (bgShift.*), while the
  // low byte continues to scroll out to the screen one bit per dot.
  //
  // Attribute bits are 2-bit per tile but each tile sources just one bit
  // pair. We hold those two bits in latches (bgLatch.*), then on every
  // dot replicate them into `bgShift.attribLo/Hi` (8-bit shifters) so the
  // palette select for the current pixel always sits at the same bit
  // position as the pattern.

  /** Latched fetch bytes for the *next* tile being decoded. */
  bgFetch = {
    /** Nametable byte (tile index). */
    nt: 0,
    /** Attribute byte: the 2-bit palette select for THIS tile (0..3). */
    at: 0,
    /** Low plane of the 8-row tile pattern (current fine-Y row). */
    ptLo: 0,
    /** High plane of the 8-row tile pattern. */
    ptHi: 0,
  };

  /**
   * Pattern + attribute shift registers used to clock pixels out one per
   * dot. Pattern shifters are 16-bit (top 8 bits drain to the screen,
   * bottom 8 bits hold the freshly-loaded next tile). Attribute shifters
   * are 8-bit; each dot a fresh latch bit is shifted in.
   */
  bgShift = {
    patternLo: 0,
    patternHi: 0,
    attribLo: 0,
    attribHi: 0,
  };

  /** 1-bit attribute latches, replicated into bgShift.attribLo/Hi every shift. */
  bgLatch = {
    attribLo: 0,
    attribHi: 0,
  };
}
