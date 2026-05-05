/**
 * Synthetic sprite-pipeline tests. Drive the PPU directly with a tiny
 * CHR-RAM mapper, place sprites by writing OAM, and verify pixel output.
 *
 * Avoids dependency on a specific game ROM so these run in any CI.
 */
import { describe, expect, it } from 'vitest';
import { PpuBus } from '../../src/core/bus/ppu-bus';
import type { Mirroring } from '../../src/core/cart/ines';
import type { Mapper } from '../../src/core/cart/mapper';
import { Ppu } from '../../src/core/ppu/ppu';
import { PpuStatus } from '../../src/core/ppu/registers';

class TestMapper implements Mapper {
  readonly id = 0;
  readonly name = 'Test';
  readonly chr = new Uint8Array(0x2000);
  cpuRead(_a: number): number { return 0; }
  cpuWrite(_a: number, _v: number): void {}
  ppuRead(a: number): number { return this.chr[a & 0x1fff]; }
  ppuWrite(a: number, v: number): void { this.chr[a & 0x1fff] = v & 0xff; }
  mirroring(): Mirroring { return 'horizontal'; }
  notifyPpuA12(_l: 0 | 1): void {}
  irqPending(): boolean { return false; }
  irqClear(): void {}
  getSram(): Uint8Array | null { return null; }
  loadSram(_d: Uint8Array): void {}
}

interface Setup {
  ppu: Ppu;
  bus: PpuBus;
  mapper: TestMapper;
  /** Tick through all visible + post-render scanlines (240 lines × 341 dots).
   *  Stops *before* the pre-render line clears the status flags, so
   *  sprite-0-hit / overflow set during rendering are still observable. */
  runRenderedFrame(): void;
}

function setup(): Setup {
  const mapper = new TestMapper();
  const bus = new PpuBus();
  bus.setCartridge({ mapper, rom: null as unknown as never });
  const ppu = new Ppu(bus);
  ppu.reset();
  return {
    ppu, bus, mapper,
    runRenderedFrame() {
      // 241 scanlines × 341 dots: visible (0-239) + post-render (240). The
      // next dot would be scanline 241, dot 0 — vblank starts at dot 1, so
      // we stop here and inspect status before pre-render line 261 clears it.
      for (let i = 0; i < 241 * 341; i++) ppu.tick();
    },
  };
}

/** Fill tile `index` in CHR with a solid 3-pixel-bright pattern (8x8). */
function paintSolidTile(mapper: TestMapper, index: number): void {
  for (let row = 0; row < 8; row++) {
    mapper.chr[index * 16 + row] = 0xff;
    mapper.chr[index * 16 + 8 + row] = 0xff;
  }
}

describe('sprite rendering', () => {
  it('renders a solid sprite pixel that differs from the background', () => {
    const s = setup();
    paintSolidTile(s.mapper, 1);

    // Distinct colour 3 in sprite palette 0.
    s.bus.write(0x3f13, 0x30);

    // Enable sprites + leftmost-8.
    s.ppu.cpuWrite(0x2001, 0x14);

    // Sprite 0 at (20, 10), tile 1, palette 0, in front.
    s.ppu.oam[0] = 9;
    s.ppu.oam[1] = 1;
    s.ppu.oam[2] = 0;
    s.ppu.oam[3] = 20;

    s.runRenderedFrame();

    const fb = s.ppu.framebuffer.data;
    const inSprite = fb[13 * 256 + 24];
    const farBg = fb[13 * 256 + 0];
    expect(inSprite).not.toBe(farBg);
  });

  it('horizontal-flip mirrors the sprite', () => {
    const s = setup();
    // Tile 2: bit pattern 0b10000000 in every row → leftmost pixel opaque,
    // rest transparent (low bits 0).
    for (let row = 0; row < 8; row++) {
      s.mapper.chr[2 * 16 + row] = 0x80;
      s.mapper.chr[2 * 16 + 8 + row] = 0x80;
    }
    s.bus.write(0x3f13, 0x30);
    s.ppu.cpuWrite(0x2001, 0x14);
    s.ppu.oam[0] = 9; s.ppu.oam[1] = 2; s.ppu.oam[2] = 0x40; s.ppu.oam[3] = 20; // H-flip

    s.runRenderedFrame();

    const fb = s.ppu.framebuffer.data;
    // With H-flip, the opaque pixel moves from x=20 to x=27.
    expect(fb[13 * 256 + 27]).not.toBe(fb[13 * 256 + 20]);
  });

  it('marks sprite-0 hit when sprite-0 overlaps an opaque background pixel', () => {
    const s = setup();
    paintSolidTile(s.mapper, 1);

    // Fill the whole first nametable with tile 1 so the bg is opaque
    // wherever the sprite lands.
    for (let i = 0; i < 32 * 30; i++) s.bus.write(0x2000 + i, 1);
    s.bus.write(0x3f03, 0x05); // bg palette 0 colour 3
    s.bus.write(0x3f13, 0x30); // sprite palette 0 colour 3

    // Enable both BG and sprites, plus leftmost-8 for both.
    s.ppu.cpuWrite(0x2001, 0x1e);

    // Sprite 0 at (10, 10), tile 1 — overlaps the opaque bg.
    s.ppu.oam[0] = 9;
    s.ppu.oam[1] = 1;
    s.ppu.oam[2] = 0;
    s.ppu.oam[3] = 10;

    s.runRenderedFrame();
    expect(s.ppu.regs.status & PpuStatus.SpriteZeroHit).toBe(PpuStatus.SpriteZeroHit);
  });

  it('sets sprite-overflow when more than 8 sprites occupy a scanline', () => {
    const s = setup();
    paintSolidTile(s.mapper, 1);
    s.ppu.cpuWrite(0x2001, 0x14);
    // 9 sprites all on the same scanline:
    for (let i = 0; i < 9; i++) {
      s.ppu.oam[i * 4 + 0] = 9;
      s.ppu.oam[i * 4 + 1] = 1;
      s.ppu.oam[i * 4 + 2] = 0;
      s.ppu.oam[i * 4 + 3] = i * 10;
    }
    s.runRenderedFrame();
    expect(s.ppu.regs.status & PpuStatus.SpriteOverflow).toBe(PpuStatus.SpriteOverflow);
  });
});
