/**
 * 2C02-Ultra. BG + sprites + scrolling + NMI grade.
 *
 * Frame timing matches the original 2C02: 341 dots × 262 scanlines.
 * Vblank starts at scanline 241, dot 1 (`tick()` returns true on that
 * dot, sets PPUSTATUS bit 7, and fires NMI when enabled). The pre-render
 * scanline (line 261) clears vblank + sprite-0 hit + sprite overflow.
 *
 * Memory map (PPU bus, 14-bit — wider addressing arrives with the
 * native sprite/palette/nametable expansion):
 *   $0000-$1FFF  CHR (pattern tables) — fetched via the cartridge mapper
 *   $2000-$2FFF  Nametable VRAM (32×30 tile indices + 64-byte attribute
 *                table per nametable; single-screen $2000 for now)
 *   $3F00-$3F1F  Palette RAM (4 BG + 4 sprite sub-palettes, 4 bytes each)
 *
 * Implemented register file (all CPU $2000-$3FFF accesses route here,
 * 8-byte mirror window):
 *   $2000  PPUCTRL   — base nametable, VRAM increment, pattern bases,
 *                      sprite size, NMI enable
 *   $2001  PPUMASK   — BG/sprite enable, left-edge clipping, greyscale,
 *                      colour emphasis (state stored; render honors
 *                      the show-BG / show-sprites bits)
 *   $2002  PPUSTATUS — vblank, sprite-0 hit, sprite overflow; reading
 *                      clears vblank + the $2005/$2006 write toggle
 *   $2003  OAMADDR   — OAM write pointer
 *   $2004  OAMDATA   — read/write OAM at OAMADDR (auto-increment)
 *   $2005  PPUSCROLL — two-write X then Y (toggle shared with $2006)
 *   $2006  PPUADDR   — two-write VRAM address (toggle shared with $2005)
 *   $2007  PPUDATA   — write to VRAM at current address; auto-increment
 *
 * Tile pixel values are 8 bpp (one byte per pixel). Until palette RAM
 * grows to 256 entries per sub-palette, the renderer masks pixels
 * `& 3` to fit the NES-shaped 4-entry sub-palettes; the file format
 * is already 8 bpp so growing the palette later is additive.
 *
 * `renderFrame()` is called automatically at vblank-start (just before
 * `tick()` returns true). It also exists as a public method so tests
 * and conversion tooling can render deterministically without running
 * the full frame timing loop.
 */

import type { Mirroring } from '../cart/ines';
import { createFrameBuffer, type FrameBuffer } from '../../renderer/frame-buffer';

export const ULTRA_WIDTH = 1024;
export const ULTRA_HEIGHT = 960;

const DOTS_PER_SCANLINE = 341;
const SCANLINES_PER_FRAME = 262;
const VBLANK_SCANLINE = 241;
const VBLANK_DOT = 1;

const TILE_COLS = 32;
const TILE_ROWS = 30;
const TILE_PX = 32;
const TILE_BYTES = TILE_PX * TILE_PX;     // 1024 (8 bpp)
const NAMETABLE_SIZE = 1024;              // 32×30 tile indices + 64-byte attribute table
const NAMETABLE_RAM_SIZE = NAMETABLE_SIZE * 2;
const PALETTE_RAM_SIZE = 32;
const PALETTE_RAM_BASE = 0x3f00;
const SPRITE_PALETTE_OFFSET = 16;          // $3F10 in palette RAM
const OAM_SIZE = 512;                      // 64 sprites × 8 bytes (Poncho-NES)
const OAM_BYTES_PER_SPRITE = 8;
const SPRITE_COUNT = OAM_SIZE / OAM_BYTES_PER_SPRITE;
const SPRITE_PX = 32;                      // v1: 32×32 sprites only
const SOURCE_WIDTH = TILE_COLS * TILE_PX;  // 1024 — single nametable's pixel width
const SOURCE_HEIGHT = TILE_ROWS * TILE_PX; // 960  — single nametable's pixel height
const PRE_RENDER_SCANLINE = SCANLINES_PER_FRAME - 1; // line 261

export class PpuUltra {
  readonly framebuffer: FrameBuffer;

  /** NES-shaped palette RAM (32 bytes). Each byte indexes the master palette. */
  readonly paletteRam = new Uint8Array(PALETTE_RAM_SIZE);

  /**
   * Nametable VRAM. Two physical 1 KB pages (= two NES nametables) cover
   * the four logical nametables ($2000/$2400/$2800/$2C00) under the
   * usual horizontal/vertical mirroring schemes. Four-screen carts
   * provide their own extra VRAM (handled in a future phase via the
   * mapper); single-low / single-high collapse to one page.
   */
  readonly nametableRam = new Uint8Array(NAMETABLE_RAM_SIZE);

  /** Active nametable mirroring. Set by the composition from `mapper.mirroring()`. */
  private nametableMirroring: Mirroring = 'horizontal';

  /**
   * Sprite RAM. 64 sprites × 8 bytes — y(16), x(16), tile(16), attr,
   * size — see `docs/poncho-rom.md` for the field layout.
   */
  readonly oamRam = new Uint8Array(OAM_SIZE);

  /** OAM write address. 9-bit (0–511) so writes can fill the full OAM. */
  private oamAddr = 0;

  private dot = 0;
  private scanline = 0;

  /** Master palette as ABGR-packed Uint32 (Canvas2D-friendly). */
  private masterPalette = new Uint32Array(0);

  /** $2006-latched 14-bit VRAM address for $2007 access. */
  private vramAddr = 0;
  /**
   * Two-write toggle, shared by $2005 (PPUSCROLL) and $2006 (PPUADDR).
   * 0 = first write expected (X scroll / address hi). 1 = second write
   * expected (Y scroll / address lo). Reading $2002 resets it to 0.
   */
  private addrLatch: 0 | 1 = 0;
  /** Auto-increment after each $2007 access (1 horizontal, 32 vertical). */
  private vramIncrement = 1;

  // ----- $2000 PPUCTRL decoded -----
  nmiEnabled = false;
  spriteSize16 = false;
  bgPatternBase = 0;
  spritePatternBase = 0;
  /** Base nametable (0..3). For now we render from $2000 only. */
  baseNametable = 0;

  // ----- $2001 PPUMASK decoded -----
  showBackground = true;
  showSprites = true;
  /** Cached raw byte; render uses the decoded fields above. */
  maskByte = 0;

  // ----- $2002 PPUSTATUS bits -----
  private vblankFlag = false;
  private sprite0Hit = false;
  private spriteOverflow = false;

  // ----- $2005 PPUSCROLL latched scroll values -----
  private scrollX = 0;
  /** Y scroll, raw byte. */
  private scrollY = 0;

  /** NMI delivery callback. Wired by the composition to cpu.triggerNmi(). */
  private nmiCallback: (() => void) | null = null;

  /** CHR-ROM bytes. The mapper hands them in directly; banking lands when a test ROM needs more. */
  private chr: Uint8Array | null = null;

  /** Universal-BG colour, cached so empty/no-CHR frames stay cheap. */
  private bgColor = 0xff000000;

  constructor() {
    this.framebuffer = createFrameBuffer(ULTRA_WIDTH, ULTRA_HEIGHT);
    // OAM defaults to 0xFF on power-on — same convention as the original
    // 2C02. With y_hi = 0xFF, every uninitialised sprite has Y ≥ 0xFF00,
    // far off-screen, so the sprite renderer naturally skips them until
    // PRG installs real entries.
    this.oamRam.fill(0xff);
  }

  setMasterPalette(rgba: Uint8Array): void {
    const count = (rgba.length / 4) | 0;
    this.masterPalette = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const r = rgba[i * 4 + 0]!;
      const g = rgba[i * 4 + 1]!;
      const b = rgba[i * 4 + 2]!;
      const a = rgba[i * 4 + 3]!;
      this.masterPalette[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    this.refreshBgColor();
  }

  setChr(chr: Uint8Array | null): void {
    this.chr = chr;
  }

  /**
   * Configure how logical nametables ($2000/$2400/$2800/$2C00) map onto
   * the two physical 1 KB nametable pages. Driven by `mapper.mirroring()`
   * at cartridge load and updated whenever a runtime-configurable mapper
   * (MMC1, AxROM) flips the mode.
   */
  setMirroring(m: Mirroring): void {
    this.nametableMirroring = m;
  }

  setNmiCallback(cb: (() => void) | null): void {
    this.nmiCallback = cb;
  }

  reset(): void {
    this.dot = 0;
    this.scanline = 0;
    this.paletteRam.fill(0);
    this.nametableRam.fill(0);
    this.oamRam.fill(0xff);
    this.oamAddr = 0;
    this.vramAddr = 0;
    this.addrLatch = 0;
    this.vramIncrement = 1;
    this.nmiEnabled = false;
    this.spriteSize16 = false;
    this.bgPatternBase = 0;
    this.spritePatternBase = 0;
    this.baseNametable = 0;
    this.showBackground = true;
    this.showSprites = true;
    this.maskByte = 0;
    this.vblankFlag = false;
    this.sprite0Hit = false;
    this.spriteOverflow = false;
    this.scrollX = 0;
    this.scrollY = 0;
    // Note: chr stays set across reset (wired by loadRom, not by PRG).
    this.refreshBgColor();
    this.framebuffer.data.fill(this.bgColor);
  }

  cpuRead(addr: number): number {
    const reg = 0x2000 | (addr & 0x07);
    if (reg === 0x2002) {
      // PPUSTATUS — bit 7 vblank, bit 6 sprite-0 hit, bit 5 sprite overflow.
      // Reading also clears the vblank flag and the $2005/$2006 toggle.
      const v =
        (this.vblankFlag      ? 0x80 : 0) |
        (this.sprite0Hit      ? 0x40 : 0) |
        (this.spriteOverflow  ? 0x20 : 0);
      this.vblankFlag = false;
      this.addrLatch = 0;
      return v;
    }
    if (reg === 0x2004) return this.oamRam[this.oamAddr]!;
    return 0;
  }

  cpuWrite(addr: number, value: number): void {
    const reg = 0x2000 | (addr & 0x07);
    const v = value & 0xff;
    switch (reg) {
      case 0x2000:
        // PPUCTRL.
        this.baseNametable     = v & 0x03;
        this.vramIncrement     = (v & 0x04) !== 0 ? 32 : 1;
        this.spritePatternBase = (v & 0x08) !== 0 ? 0x1000 : 0x0000;
        this.bgPatternBase     = (v & 0x10) !== 0 ? 0x1000 : 0x0000;
        this.spriteSize16      = (v & 0x20) !== 0;
        this.nmiEnabled        = (v & 0x80) !== 0;
        return;
      case 0x2001:
        // PPUMASK. We track all bits but the renderer only honours the
        // BG/sprite enables for now.
        this.maskByte       = v;
        this.showBackground = (v & 0x08) !== 0;
        this.showSprites    = (v & 0x10) !== 0;
        return;
      case 0x2003:
        this.oamAddr = v;
        return;
      case 0x2004:
        this.oamRam[this.oamAddr] = v;
        this.oamAddr = (this.oamAddr + 1) % OAM_SIZE;
        return;
      case 0x2005:
        // PPUSCROLL — first write = X, second = Y. Shares the latch
        // toggle with $2006.
        if (this.addrLatch === 0) {
          this.scrollX = v;
          this.addrLatch = 1;
        } else {
          this.scrollY = v;
          this.addrLatch = 0;
        }
        return;
      case 0x2006:
        if (this.addrLatch === 0) {
          this.vramAddr = ((v & 0x3f) << 8) | (this.vramAddr & 0x00ff);
          this.addrLatch = 1;
        } else {
          this.vramAddr = (this.vramAddr & 0xff00) | v;
          this.addrLatch = 0;
        }
        return;
      case 0x2007:
        this.vramWrite(this.vramAddr & 0x3fff, v);
        this.vramAddr = (this.vramAddr + this.vramIncrement) & 0x7fff;
        return;
      default:
        return;
    }
  }

  /**
   * OAM DMA: copy 512 sequential bytes from CPU memory at `(page << 8)`
   * into OAM, starting at the current `oamAddr` and wrapping. The CPU's
   * stall budget for this is set in the composition (Poncho-NES uses
   * the legacy 513/514 stall — slightly under-counted for 512 bytes,
   * tightened when timing accuracy matters).
   */
  oamDma(bus: { read(addr: number): number }, page: number): void {
    const base = (page & 0xff) << 8;
    let dst = this.oamAddr;
    for (let i = 0; i < OAM_SIZE; i++) {
      this.oamRam[dst] = bus.read(base + i) & 0xff;
      dst = (dst + 1) % OAM_SIZE;
    }
  }

  /**
   * Advance one PPU dot. On the dot that begins vblank: render the
   * frame, set PPUSTATUS bit 7, fire NMI when enabled, and return
   * `true`. On the pre-render scanline's first dot: clear the vblank
   * + sprite-0 hit + sprite-overflow flags.
   */
  tick(): boolean {
    const isVblankEntry = this.scanline === VBLANK_SCANLINE && this.dot === VBLANK_DOT;
    const isPreRender   = this.scanline === PRE_RENDER_SCANLINE && this.dot === VBLANK_DOT;

    if (isVblankEntry) {
      this.renderFrame();
      this.vblankFlag = true;
      if (this.nmiEnabled) this.nmiCallback?.();
    }
    if (isPreRender) {
      this.vblankFlag = false;
      this.sprite0Hit = false;
      this.spriteOverflow = false;
    }

    this.dot++;
    if (this.dot >= DOTS_PER_SCANLINE) {
      this.dot = 0;
      this.scanline++;
      if (this.scanline >= SCANLINES_PER_FRAME) this.scanline = 0;
    }

    return isVblankEntry;
  }

  /**
   * Walk the BG layer and write each pixel into the framebuffer.
   * Public so tests + conversion tools can render without running
   * the dot/scanline timing loop.
   */
  renderFrame(): void {
    if (this.masterPalette.length === 0) {
      this.framebuffer.data.fill(this.bgColor);
      return;
    }
    if (this.chr === null || this.chr.length === 0) {
      // No CHR wired — every tile fetches as 0, so the entire screen
      // resolves to the universal BG colour.
      this.framebuffer.data.fill(this.bgColor);
      return;
    }

    const fb = this.framebuffer.data;
    const width = ULTRA_WIDTH;
    const universalBg = this.bgColor;
    const pal = this.paletteRam;
    const master = this.masterPalette;
    const masterLen = master.length;
    const chr = this.chr;
    const chrLen = chr.length;
    const sx = this.scrollX;
    const sy = this.scrollY;

    if (this.showBackground) {
      // Effective scroll combines PPUCTRL.baseNametable with the $2005
      // scroll values: horizontally, NT0↔NT1 lay side-by-side at one
      // SOURCE_WIDTH offset; vertically, NT0↔NT2 lay stacked at one
      // SOURCE_HEIGHT offset. The full virtual BG plane is therefore
      // 2 × SOURCE_WIDTH × 2 × SOURCE_HEIGHT (four logical nametables).
      const baseNTH = this.baseNametable & 1;
      const baseNTV = (this.baseNametable >> 1) & 1;
      const virtualWidth  = SOURCE_WIDTH * 2;
      const virtualHeight = SOURCE_HEIGHT * 2;
      const effSx = (sx + baseNTH * SOURCE_WIDTH)  % virtualWidth;
      const effSy = (sy + baseNTV * SOURCE_HEIGHT) % virtualHeight;
      const mirroring = this.nametableMirroring;
      const ntRam = this.nametableRam;

      // Per-pixel walk so scroll values that aren't tile-aligned still
      // fetch the correct source position. Inner loop caches the last
      // tile-column lookup so the cost stays tile-grained on average.
      for (let py = 0; py < ULTRA_HEIGHT; py++) {
        const virtualY = (py + effSy) % virtualHeight;
        const ntV = (virtualY / SOURCE_HEIGHT) | 0;       // 0 = NT0/NT1, 1 = NT2/NT3
        const srcY = virtualY - ntV * SOURCE_HEIGHT;
        const tileRow = (srcY / TILE_PX) | 0;
        const tileSubY = srcY - tileRow * TILE_PX;
        let dst = py * width;
        let lastNtH = -1;
        let lastTileCol = -1;
        let physBase = 0;
        let tileBase = 0;
        let subPalette = 0;
        for (let px = 0; px < ULTRA_WIDTH; px++) {
          const virtualX = (px + effSx) % virtualWidth;
          const ntH = (virtualX / SOURCE_WIDTH) | 0;     // 0 = NT0/NT2, 1 = NT1/NT3
          const srcX = virtualX - ntH * SOURCE_WIDTH;
          const tileCol = (srcX / TILE_PX) | 0;
          // When we cross a nametable boundary we have to refresh the
          // physical-page base before re-reading tile + attribute.
          if (ntH !== lastNtH) {
            lastNtH = ntH;
            lastTileCol = -1;
            const logicalNT = ntV * 2 + ntH;
            const physicalNT = resolvePhysicalNT(logicalNT, mirroring);
            physBase = physicalNT * NAMETABLE_SIZE;
          }
          if (tileCol !== lastTileCol) {
            lastTileCol = tileCol;
            const tileIdx = ntRam[physBase + tileRow * TILE_COLS + tileCol]!;
            tileBase = tileIdx * TILE_BYTES;
            const attrByte = ntRam[physBase + 960 + (tileRow >> 2) * 8 + (tileCol >> 2)]!;
            const attrShift = ((tileRow & 2) << 1) | (tileCol & 2);
            subPalette = (attrByte >> attrShift) & 0x3;
          }
          const tileSubX = srcX - tileCol * TILE_PX;
          const pv = chr[(tileBase + tileSubY * TILE_PX + tileSubX) % chrLen]! & 0x3;
          let color: number;
          if (pv === 0) {
            color = universalBg;
          } else {
            const idx = pal[subPalette * 4 + pv]! % masterLen;
            color = master[idx]!;
          }
          fb[dst++] = color;
        }
      }
    } else {
      // BG layer disabled — fill with universal BG colour.
      fb.fill(universalBg);
    }

    if (!this.showSprites) return;

    // Sprite layer. Walk OAM in front-to-back order (sprite 0 has
    // highest priority among sprites — drawn last so it covers others
    // is the typical NES rule, but for simplicity the stub draws in
    // index order over BG; sprite priority and BG-vs-sprite ordering
    // come with the next ROM).
    for (let s = 0; s < SPRITE_COUNT; s++) {
      const o = s * OAM_BYTES_PER_SPRITE;
      const y = this.oamRam[o + 0]! | (this.oamRam[o + 1]! << 8);
      const x = this.oamRam[o + 2]! | (this.oamRam[o + 3]! << 8);
      const tileIdx = this.oamRam[o + 4]! | (this.oamRam[o + 5]! << 8);
      const attr = this.oamRam[o + 6]!;

      // Off-screen (top-left corner past visible area) → skip.
      if (y >= ULTRA_HEIGHT || x >= ULTRA_WIDTH) continue;

      const subPalette = attr & 0x3;
      const flipH = (attr & 0x08) !== 0;
      const flipV = (attr & 0x10) !== 0;

      const tileBase = tileIdx * TILE_BYTES;

      for (let py = 0; py < SPRITE_PX; py++) {
        const sy = y + py;
        if (sy >= ULTRA_HEIGHT) break;
        const ty = flipV ? (SPRITE_PX - 1 - py) : py;
        const rowBase = tileBase + ty * TILE_PX;
        const dstRow = sy * width + x;
        for (let px = 0; px < SPRITE_PX; px++) {
          const sx = x + px;
          if (sx >= ULTRA_WIDTH) break;
          const tx = flipH ? (SPRITE_PX - 1 - px) : px;
          const pv = chr[(rowBase + tx) % chrLen]! & 0x3;
          if (pv === 0) continue; // sprite-pixel 0 = transparent
          const idx = pal[SPRITE_PALETTE_OFFSET + subPalette * 4 + pv]! % masterLen;
          fb[dstRow + px] = master[idx]!;
        }
      }
    }
  }

  private vramWrite(addr: number, value: number): void {
    if (addr >= PALETTE_RAM_BASE) {
      this.paletteRam[addr & 0x1f] = value;
      this.refreshBgColor();
      return;
    }
    if (addr >= 0x2000 && addr < 0x3000) {
      // Logical nametable from PPU address: bits 10-11 select NT 0..3.
      // The mirroring lookup folds it onto the two physical pages.
      const logicalNT = (addr >> 10) & 0x3;
      const physicalNT = resolvePhysicalNT(logicalNT, this.nametableMirroring);
      const offset = physicalNT * NAMETABLE_SIZE + (addr & 0x03ff);
      this.nametableRam[offset] = value;
      return;
    }
    // CHR-RAM (writes below $2000) is routed through the cartridge
    // mapper in Phase 4 of the v0.3.0 plan; for now stays a no-op.
  }

  /**
   * Recompute the universal-BG colour and eagerly fill the framebuffer.
   * Eager-fill makes the framebuffer reflect palette changes immediately
   * (cheap for our use, and tests inspect pixels without manually
   * driving a full frame). The next `renderFrame()` overwrites it tile-
   * by-tile if there's actual tile data to draw.
   */
  private refreshBgColor(): void {
    if (this.masterPalette.length === 0) {
      this.bgColor = 0xff000000;
    } else {
      const idx = this.paletteRam[0]! % this.masterPalette.length;
      this.bgColor = this.masterPalette[idx]!;
    }
    this.framebuffer.data.fill(this.bgColor);
  }
}

/**
 * Logical nametable (0–3 = NT0/1/2/3) → physical page (0–1) given the
 * cart's mirroring mode. Two physical pages cover all four logical
 * nametables in the standard horizontal / vertical / single-screen
 * cases. Four-screen needs 4 KB of cart-supplied VRAM; until that lands
 * we degrade to vertical (the most common iNES default for scrolling
 * games — Contra ships vertical).
 */
export function resolvePhysicalNT(logicalNT: number, mirroring: Mirroring): 0 | 1 {
  const lnt = logicalNT & 0x3;
  switch (mirroring) {
    case 'horizontal':  return ((lnt >> 1) & 1) as 0 | 1; // NT0,1 → 0; NT2,3 → 1
    case 'vertical':    return (lnt & 1) as 0 | 1;        // NT0,2 → 0; NT1,3 → 1
    case 'single-low':  return 0;
    case 'single-high': return 1;
    case 'four-screen': return (lnt & 1) as 0 | 1;        // TODO: full 4-screen via cart VRAM
  }
}
