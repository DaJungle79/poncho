import { describe, expect, it } from 'vitest';

import { PpuUltra, ULTRA_HEIGHT, ULTRA_WIDTH } from '../../src/core/ppu-ultra/ppu-ultra';

describe('PpuUltra (minimal stub)', () => {
  it('framebuffer is 1024 × 960 RGBA Uint32', () => {
    const ppu = new PpuUltra();
    expect(ppu.framebuffer.width).toBe(ULTRA_WIDTH);
    expect(ppu.framebuffer.height).toBe(ULTRA_HEIGHT);
    expect(ppu.framebuffer.data).toBeInstanceOf(Uint32Array);
    expect(ppu.framebuffer.data.length).toBe(ULTRA_WIDTH * ULTRA_HEIGHT);
  });

  it('fills with the master-palette entry-0 colour packed as ABGR', () => {
    const ppu = new PpuUltra();
    // R=0xE6, G=0x3E, B=0x32, A=0xFF → 0xFF323EE6
    ppu.setMasterPalette(new Uint8Array([0xe6, 0x3e, 0x32, 0xff]));
    // setMasterPalette no longer eagerly fills the framebuffer (a mid-frame
    // palette change must not wipe per-scanline output); render explicitly
    // to inspect the universal-BG fill.
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xff323ee6);
    expect(ppu.framebuffer.data[ppu.framebuffer.data.length - 1]).toBe(0xff323ee6);
    // Spot-check a pixel in the middle.
    expect(ppu.framebuffer.data[Math.floor(ppu.framebuffer.data.length / 2)]).toBe(0xff323ee6);
  });

  it('reset re-fills the buffer with the current BG colour', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    ppu.framebuffer.data[0] = 0; // simulate corruption
    ppu.reset();
    expect(ppu.framebuffer.data[0]).toBe(0xffffffff);
  });

  it('returns true exactly once per frame, at the vblank-start dot', () => {
    const ppu = new PpuUltra();
    let trueCount = 0;
    let dotsToFirstTrue = 0;
    const DOTS_PER_FRAME = 341 * 262;
    for (let i = 0; i < DOTS_PER_FRAME; i++) {
      if (ppu.tick()) {
        trueCount++;
        if (trueCount === 1) dotsToFirstTrue = i;
      }
    }
    expect(trueCount).toBe(1);
    // VBlank dot = (scanline 241 × 341) + 1 = 82182.
    expect(dotsToFirstTrue).toBe(241 * 341 + 1);
  });

  it('keeps cycling — second frame also fires once at the same offset', () => {
    const ppu = new PpuUltra();
    const DOTS_PER_FRAME = 341 * 262;
    let firstFrameDot = -1;
    let secondFrameDot = -1;
    for (let i = 0; i < 2 * DOTS_PER_FRAME; i++) {
      if (ppu.tick()) {
        if (firstFrameDot < 0) firstFrameDot = i;
        else if (secondFrameDot < 0) secondFrameDot = i;
      }
    }
    expect(secondFrameDot - firstFrameDot).toBe(DOTS_PER_FRAME);
  });
});

describe('PpuUltra register file: $2000 / $2006 / $2007', () => {
  function makePalette8(): Uint8Array {
    // 8 distinguishable colours: black, red, green, blue, yellow, magenta, cyan, white.
    return new Uint8Array([
      0x00, 0x00, 0x00, 0xff,
      0xff, 0x00, 0x00, 0xff,
      0x00, 0xff, 0x00, 0xff,
      0x00, 0x00, 0xff, 0xff,
      0xff, 0xff, 0x00, 0xff,
      0xff, 0x00, 0xff, 0xff,
      0x00, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff,
    ]);
  }

  it('$2006 latches hi/lo bytes; $2007 writes to palette RAM at $3F00', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // Set VRAM addr = $3F00.
    ppu.cpuWrite(0x2006, 0x3f); // hi
    ppu.cpuWrite(0x2006, 0x00); // lo
    // Write index 5 (magenta) to palette[0].
    ppu.cpuWrite(0x2007, 0x05);

    expect(ppu.paletteRam[0]).toBe(0x05);
    // Per-scanline rendering owns every pixel; render the frame to
    // inspect the universal-BG colour in the framebuffer.
    ppu.renderFrame();
    // ABGR pack of (0xFF, 0x00, 0xFF) = 0xFFFF00FF.
    expect(ppu.framebuffer.data[0]).toBe(0xffff00ff);
  });

  it('$2007 auto-increments by 1 by default', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, 0x00);
    ppu.cpuWrite(0x2007, 0x01);
    ppu.cpuWrite(0x2007, 0x02);
    ppu.cpuWrite(0x2007, 0x03);

    expect(ppu.paletteRam[0]).toBe(0x01);
    expect(ppu.paletteRam[1]).toBe(0x02);
    expect(ppu.paletteRam[2]).toBe(0x03);
  });

  it('$2000 bit 2 switches auto-increment to 32', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    ppu.cpuWrite(0x2000, 0x04); // increment-by-32 mode
    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, 0x00);
    // $3F00 → write 7, addr += 32 → wraps within palette RAM (mask &0x1F = 0x00).
    ppu.cpuWrite(0x2007, 0x07);
    ppu.cpuWrite(0x2007, 0x06); // also lands at palette[0] due to & 0x1F mirroring

    expect(ppu.paletteRam[0]).toBe(0x06);
  });

  it('$2006 mirrors via the 8-byte register window', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // $2026 mirrors to $2006 because the bus masks low 3 bits.
    ppu.cpuWrite(0x2026, 0x3f);
    ppu.cpuWrite(0x200e, 0x00);
    ppu.cpuWrite(0x3fff, 0x04); // mirror of $2007

    expect(ppu.paletteRam[0]).toBe(0x04);
  });

  it('reset clears palette RAM and re-fills the framebuffer', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, 0x00);
    ppu.cpuWrite(0x2007, 0x05);
    ppu.renderFrame();
    expect(ppu.framebuffer.data[0]).toBe(0xffff00ff); // magenta

    ppu.reset();
    expect(ppu.paletteRam[0]).toBe(0x00);
    // reset() explicitly fills the framebuffer with the new bgColor
    // (master[0] = black) so it's coherent for the next frame's
    // per-scanline render.
    expect(ppu.framebuffer.data[0]).toBe(0xff000000);
  });
});
