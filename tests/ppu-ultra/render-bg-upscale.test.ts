import { describe, expect, it, vi } from 'vitest';

import { PpuUltra } from '../../src/core/ppu-ultra/ppu-ultra';

/**
 * BG render path with the AI tile resolver — Phase 3 of v0.4. The
 * resolver returns either a 1024-byte native tile (rendered 1 native px
 * ↔ 1 Poncho px) or null (existing 4× nearest-neighbour fallback). Per
 * tile granularity: a frame can mix native and NN tiles freely.
 */
describe('PpuUltra — upscaled BG resolver path', () => {
  function makePalette8(): Uint8Array {
    return new Uint8Array([
      0x00, 0x00, 0x00, 0xff, // 0 black
      0xff, 0x00, 0x00, 0xff, // 1 red
      0x00, 0xff, 0x00, 0xff, // 2 green
      0x00, 0x00, 0xff, 0xff, // 3 blue
      0xff, 0xff, 0x00, 0xff, // 4 yellow
      0xff, 0x00, 0xff, 0xff, // 5 magenta
      0x00, 0xff, 0xff, 0xff, // 6 cyan
      0xff, 0xff, 0xff, 0xff, // 7 white
    ]);
  }
  function setPalette(ppu: PpuUltra, index: number, value: number): void {
    ppu.cpuWrite(0x2006, 0x3f);
    ppu.cpuWrite(0x2006, index & 0x1f);
    ppu.cpuWrite(0x2007, value);
  }
  function setupUpscaledTile0AllPv1(ppu: PpuUltra): Uint8Array {
    // 8 KB CHR with tile 0 = plane 0 all 0xFF, plane 1 all 0x00 (pv = 1)
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;
    ppu.setUpscaledMode(true);
    ppu.setChrReader((a) => chr[a & 0x1fff]!);
    return chr;
  }

  it('null resolver — BG renders identically to no-resolver (NN fallback)', () => {
    const a = new PpuUltra();
    a.setMasterPalette(makePalette8());
    setupUpscaledTile0AllPv1(a);
    setPalette(a, 0, 0); // bg = black
    setPalette(a, 1, 2); // sub-palette 0, pv 1 = green
    a.renderFrame();
    const baseline = a.framebuffer.data.slice();

    const b = new PpuUltra();
    b.setMasterPalette(makePalette8());
    setupUpscaledTile0AllPv1(b);
    setPalette(b, 0, 0);
    setPalette(b, 1, 2);
    b.setUpscaledTileResolver(() => null); // always miss
    b.renderFrame();

    expect(b.framebuffer.data).toEqual(baseline);
  });

  it('non-null resolver — render uses per-pixel native tile data', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());
    setupUpscaledTile0AllPv1(ppu);
    setPalette(ppu, 0, 0); // bg = black
    setPalette(ppu, 1, 2); // pv 1 = green
    setPalette(ppu, 2, 3); // pv 2 = blue

    // Native tile: top half pv=1 (green), bottom half pv=2 (blue).
    const native = new Uint8Array(1024);
    for (let r = 0; r < 16; r++) for (let c = 0; c < 32; c++) native[r * 32 + c] = 1;
    for (let r = 16; r < 32; r++) for (let c = 0; c < 32; c++) native[r * 32 + c] = 2;

    ppu.setUpscaledTileResolver(() => native);
    ppu.renderFrame();

    // The 32×32 tile at top-left should show green for the top 16 Poncho
    // rows, blue for the bottom 16. (Tile 0 covers Poncho px 0..31 wide
    // and 0..31 tall in the 1024×960 framebuffer.)
    const W = 1024;
    expect(ppu.framebuffer.data[0]).toBe(0xff00ff00);     // top-left = green
    expect(ppu.framebuffer.data[15 * W + 0]).toBe(0xff00ff00); // row 15 still green
    expect(ppu.framebuffer.data[16 * W + 0]).toBe(0xffff0000); // row 16 → blue
    expect(ppu.framebuffer.data[31 * W + 31]).toBe(0xffff0000); // bottom-right of tile = blue
  });

  it('resolver receives the actual NES tile bytes + palette snapshot', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());

    // Build a CHR with a distinctive tile 0 pattern.
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 16; i++) chr[i] = (i * 7) & 0xff;
    ppu.setUpscaledMode(true);
    ppu.setChrReader((a) => chr[a & 0x1fff]!);

    setPalette(ppu, 0, 0);
    setPalette(ppu, 1, 2);
    setPalette(ppu, 2, 3);
    setPalette(ppu, 3, 4);

    const seen = vi.fn<(t: Uint8Array, p: Uint8Array) => Uint8Array | null>(() => null);
    ppu.setUpscaledTileResolver(seen);
    ppu.renderFrame();

    expect(seen).toHaveBeenCalled();
    const firstCall = seen.mock.calls[0]!;
    const tileBytes = firstCall[0];
    const palBytes = firstCall[1];
    expect(tileBytes.length).toBe(16);
    for (let i = 0; i < 16; i++) expect(tileBytes[i]).toBe((i * 7) & 0xff);
    // palette: [universal-bg, pv1, pv2, pv3] — sub-palette 0 here.
    expect(palBytes.length).toBe(4);
    expect(palBytes[0]).toBe(0); // universal bg
    expect(palBytes[1]).toBe(2);
    expect(palBytes[2]).toBe(3);
    expect(palBytes[3]).toBe(4);
  });

  it('per-tile mixing — tile 0 native, tile 1 NN, both render correctly', () => {
    const ppu = new PpuUltra();
    ppu.setMasterPalette(makePalette8());
    // Tile 0 = pv 1 (green), tile 1 = pv 2 (blue).
    const chr = new Uint8Array(8192);
    for (let i = 0; i < 8; i++) chr[i] = 0xff;             // tile 0 plane 0
    for (let i = 16; i < 24; i++) chr[i] = 0x00;           // tile 1 plane 0
    for (let i = 24; i < 32; i++) chr[i] = 0xff;           // tile 1 plane 1 → pv = 2
    ppu.setUpscaledMode(true);
    ppu.setChrReader((a) => chr[a & 0x1fff]!);

    // Cell (0,0) → tile 0; cell (0,1) → tile 1.
    ppu.nametableRam[0] = 0;
    ppu.nametableRam[1] = 1;

    setPalette(ppu, 0, 0);
    setPalette(ppu, 1, 2); // pv 1 → green
    setPalette(ppu, 2, 3); // pv 2 → blue
    setPalette(ppu, 3, 5); // pv 3 → magenta

    // Native version of tile 0 — top half pv 1, bottom half pv 3.
    const native0 = new Uint8Array(1024);
    for (let r = 0; r < 16; r++) for (let c = 0; c < 32; c++) native0[r * 32 + c] = 1;
    for (let r = 16; r < 32; r++) for (let c = 0; c < 32; c++) native0[r * 32 + c] = 3;

    // Resolver returns native ONLY for tile 0; null for tile 1.
    ppu.setUpscaledTileResolver((nesTile) => {
      // Tile 0 has plane0[0] = 0xFF; tile 1 has plane0[0] = 0x00.
      return nesTile[0] === 0xff ? native0 : null;
    });
    ppu.renderFrame();

    const W = 1024;
    // Tile 0 top half → green; bottom half → magenta.
    expect(ppu.framebuffer.data[0 * W + 0]).toBe(0xff00ff00);
    expect(ppu.framebuffer.data[20 * W + 0]).toBe(0xffff00ff);
    // Tile 1 (cell col 1) lives at Poncho x = 32..63. NN expansion → blue.
    expect(ppu.framebuffer.data[0 * W + 32]).toBe(0xffff0000);
    expect(ppu.framebuffer.data[15 * W + 50]).toBe(0xffff0000);
  });
});
