import { describe, expect, it } from 'vitest';

import { parsePonchoRom, isPonchoRom } from '../../src/core/cart-poncho/header';
import { detectConsole } from '../../src/console/detect';
import { PonchoNes } from '../../src/console/poncho-nes';
import { NES_MASTER_PALETTE_RGBA } from '../../src/core/ppu-ultra/nes-master-palette';
import {
  ConvertError,
  convertInesToPoncho,
  expandNesChrToPoncho,
} from '../../scripts/lib/ines-to-poncho';

/**
 * Build a synthetic minimal NROM iNES file:
 *   - 16 KB PRG (single bank, mirrored at $C000)
 *   - 8 KB CHR (one drawn tile + zeros)
 *   - mapper 0, horizontal mirroring
 *
 * The reset vector points to a halt loop ($8000: JMP $8000).
 */
function buildSyntheticNrom(chrTile0: Uint8Array): Uint8Array {
  const header = new Uint8Array(16);
  header[0] = 0x4e; header[1] = 0x45; header[2] = 0x53; header[3] = 0x1a; // "NES\x1A"
  header[4] = 1; // 1 × 16 KB PRG
  header[5] = 1; // 1 × 8 KB CHR
  header[6] = 0; // flags6 — mapper low nibble = 0, horizontal mirror, no battery, no trainer
  header[7] = 0; // flags7 — mapper high nibble = 0

  const prg = new Uint8Array(16 * 1024);
  // Halt loop at $8000: JMP $8000.
  prg[0x0000] = 0x4c;
  prg[0x0001] = 0x00;
  prg[0x0002] = 0x80;
  // Reset vector at $FFFC = $8000. NMI/IRQ vectors stay $0000.
  prg[0x3ffc] = 0x00;
  prg[0x3ffd] = 0x80;

  const chr = new Uint8Array(8 * 1024);
  if (chrTile0.length !== 16) throw new Error('test tile must be 16 bytes');
  chr.set(chrTile0, 0);

  const out = new Uint8Array(header.length + prg.length + chr.length);
  out.set(header, 0);
  out.set(prg, header.length);
  out.set(chr, header.length + prg.length);
  return out;
}

describe('expandNesChrToPoncho', () => {
  it('upscales a single tile to 32×32 8 bpp with 4×4 nearest-neighbour blocks', () => {
    // NES tile encoding the value `1` in row 0, col 0; everything else 0.
    // Plane 0 row 0 = 0b1000_0000 (bit 7 = pixel 0). Plane 1 = 0.
    const tile = new Uint8Array(16);
    tile[0] = 0b1000_0000;

    const out = expandNesChrToPoncho(tile);

    expect(out.length).toBe(1024);

    // Top-left 4×4 block should all be `1`.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(out[y * 32 + x]).toBe(1);
      }
    }
    // Pixel just to the right of the 4-block (col 4, row 0) should be 0.
    expect(out[0 * 32 + 4]).toBe(0);
    // Pixel just below the 4-block (col 0, row 4) should be 0.
    expect(out[4 * 32 + 0]).toBe(0);
    // Bottom-right corner = 0.
    expect(out[31 * 32 + 31]).toBe(0);
  });

  it('preserves the 2-bpp pixel value range 0–3', () => {
    // Full-row tile: row 0 has all four pixel values. We use bits 7..4
    // for pixels 0..3 to make hand-checking easier.
    // Pixel 0 = 0 (plane0=0, plane1=0)
    // Pixel 1 = 1 (plane0=1, plane1=0)
    // Pixel 2 = 2 (plane0=0, plane1=1)
    // Pixel 3 = 3 (plane0=1, plane1=1)
    const tile = new Uint8Array(16);
    tile[0]     = 0b0101_0000; // plane 0 row 0 — bits at pixels 1, 3
    tile[0 + 8] = 0b0011_0000; // plane 1 row 0 — bits at pixels 2, 3

    const out = expandNesChrToPoncho(tile);

    // Block 0 (cols 0..3, rows 0..3) → 0
    expect(out[0]).toBe(0);
    // Block 1 (cols 4..7) → 1
    expect(out[4]).toBe(1);
    // Block 2 (cols 8..11) → 2
    expect(out[8]).toBe(2);
    // Block 3 (cols 12..15) → 3
    expect(out[12]).toBe(3);
  });

  it('expands many tiles in sequence', () => {
    // 4 tiles: 64 bytes in, 4096 bytes out (4 × 1024).
    const tiles = new Uint8Array(4 * 16);
    const out = expandNesChrToPoncho(tiles);
    expect(out.length).toBe(4 * 1024);
  });

  it('rejects a buffer that is not a multiple of 16 bytes', () => {
    expect(() => expandNesChrToPoncho(new Uint8Array(15))).toThrow(ConvertError);
  });
});

describe('convertInesToPoncho — NROM round trip', () => {
  it('produces a PonchoROM that parses cleanly with expected sizes', () => {
    const tile = new Uint8Array(16);
    tile[0] = 0xff; // top row solid pixel value 1
    const ines = buildSyntheticNrom(tile);

    const result = convertInesToPoncho(ines, { title: 'Synth' });

    expect(isPonchoRom(result.poncho)).toBe(true);
    const layout = parsePonchoRom(result.poncho);

    expect(layout.header.title).toBe('Synth');
    expect(layout.header.mapperId).toBe(1);
    expect(layout.header.flags.upscaledMode).toBe(false);
    expect(layout.header.prgSizeKb).toBe(16);
    // 8 KB CHR × 64 (4×4 area expansion of 1 byte/pixel) ÷ 1024 = 512 KB
    expect(layout.header.chrSizeKb).toBe(512);
    // The canonical NES master palette has 64 entries.
    expect(layout.header.paletteCount).toBe(64);
  });

  it('embeds the canonical NES master palette', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    const { poncho } = convertInesToPoncho(ines);

    const layout = parsePonchoRom(poncho);
    const slice = poncho.subarray(
      layout.paletteOffset,
      layout.paletteOffset + layout.paletteByteLength,
    );
    expect(slice).toEqual(NES_MASTER_PALETTE_RGBA);
  });

  it('records the source iNES CRC32', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    const { poncho } = convertInesToPoncho(ines);
    const layout = parsePonchoRom(poncho);
    // Non-zero — converter computed it from the input bytes.
    expect(layout.header.sourceInesCrc32).not.toBe(0);
  });

  it('reports the source mapper, mirroring, and CHR expansion ratio', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    const { notes } = convertInesToPoncho(ines);
    expect(notes.sourceMapper).toBe(0);
    expect(notes.sourceMirroring).toBe('horizontal');
    expect(notes.prgKb).toBe(16);
    expect(notes.chrKbSource).toBe(8);
    expect(notes.chrKbExpanded).toBe(512);
  });

  it('truncates titles longer than 32 bytes', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    const longTitle = 'A'.repeat(50);
    const { poncho } = convertInesToPoncho(ines, { title: longTitle });
    const layout = parsePonchoRom(poncho);
    expect(layout.header.title.length).toBe(32);
  });
});

describe('convertInesToPoncho — error paths', () => {
  it('rejects mapper != 0', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    // Force mapper = 1 (MMC1) by setting flags6 high nibble.
    ines[6] = 0x10;
    expect(() => convertInesToPoncho(ines)).toThrow(/Mapper 1/);
  });

  it('rejects CHR-RAM games (chrRomBanks = 0)', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    ines[5] = 0; // 0 CHR banks
    expect(() => convertInesToPoncho(ines)).toThrow(/CHR-RAM/);
  });

  it('rejects ROMs with a trainer block', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    ines[6] = 0x04; // flags6 trainer bit
    expect(() => convertInesToPoncho(ines)).toThrow(/trainer/i);
  });
});

describe('convertInesToPoncho — loads in PonchoNes without error', () => {
  it('detect → load → runFrame produces a 1024×960 frame', () => {
    const ines = buildSyntheticNrom(new Uint8Array(16));
    const { poncho } = convertInesToPoncho(ines);

    const factory = detectConsole(poncho);
    expect(factory).not.toBeNull();
    expect(factory!.spec.id).toBe('poncho-nes');

    const console = factory!.create();
    expect(console).toBeInstanceOf(PonchoNes);

    console.loadRom(poncho);
    const fb = console.runFrame();

    expect(fb.width).toBe(1024);
    expect(fb.height).toBe(960);
  });
});
