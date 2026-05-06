# PonchoROM — file format spec

This document is the design proposal for the PonchoROM cartridge format. It is *not yet implemented*. Use it as the contract while the chip code (the 2C02-Ultra PPU and the PonchoMapper) is built. When the runtime ships, this doc becomes the reference.

For an overview of how PonchoROM relates to the rest of the codebase, see [`consoles.md`](consoles.md).

---

## Goals

- A 4×-resolution, 32-bit-colour cartridge format that runs on the same 2A03 CPU + 2A03 APU as the original NES.
- A trivially mechanical conversion path from any iNES ROM to a PonchoROM, preserving game logic.
- Room to enhance the converted ROM's art incrementally — replace a single tile, palette, or sprite without rebuilding anything else.
- Header and layout that's hex-readable; no ambiguity about where each section starts.

## Non-goals

- New CPU instructions or audio channels (those are future revisions, not v1).
- A scripting layer or behaviour overlay.
- Replacing or recompiling the original PRG-ROM during conversion.

---

## File layout

```
0x0000  +-------------------------+
        | Header (64 bytes)       |
0x0040  +-------------------------+
        | Master palette          |
        | (palette_count × 4 B)   |
        +-------------------------+
        | PRG-ROM                 |
        | (prg_size_kb × 1024 B)  |
        +-------------------------+
        | CHR-ROM                 |
        | (chr_size_kb × 1024 B)  |
        +-------------------------+
        | Trailer (optional)      |
        | (metadata, signature)   |
        +-------------------------+
```

All multi-byte integers are little-endian.

## Header (64 bytes)

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0x00 | 4 | `magic` | ASCII `PNCH` (0x50 0x4E 0x43 0x48) |
| 0x04 | 1 | `version` | Format version. v1 = `0x01`. |
| 0x05 | 1 | `flags` | Bit 0: NES-compat sub-mode. Bit 1: trailer present. Bits 2–7 reserved (0). |
| 0x06 | 2 | `prg_size_kb` | PRG-ROM size in KB. Up to 65 535 KB (~64 MB). |
| 0x08 | 4 | `chr_size_kb` | CHR-ROM size in KB. Up to ~4 GB (we won't hit this). |
| 0x0C | 2 | `palette_count` | Number of master-palette entries (each entry = 4 B RGBA). 0 ≤ N ≤ 65 535. |
| 0x0E | 2 | `mapper_id` | PonchoMapper ID. v1 reserves `0x0001`. |
| 0x10 | 2 | `mapper_submode` | Mapper-specific. For PonchoMapper: bit 0 = NES-compat. |
| 0x12 | 2 | `prg_ram_kb` | Battery-backed save RAM size, KB. 0 if none. |
| 0x14 | 2 | `chr_ram_kb` | Writable CHR-RAM size, KB (in addition to `chr_size_kb` ROM). |
| 0x16 | 1 | `tv_system` | 0 = NTSC, 1 = PAL, 2 = both. |
| 0x17 | 1 | `region` | 0 = world, others reserved. |
| 0x18 | 4 | `crc32` | CRC32 of bytes from 0x40 onwards. |
| 0x1C | 4 | `source_ines_crc32` | iNES CRC32 if produced by the converter, else 0. |
| 0x20 | 32 | `title` | Null-padded UTF-8 game title. |

**Header validation rules.** Reject the ROM if:
- `magic` ≠ `"PNCH"`
- `version` is unknown to the runtime
- file size < `0x40 + palette_count × 4 + prg_size_kb × 1024 + chr_size_kb × 1024`

## Master palette

A flat array of 32-bit RGBA entries, each 4 bytes: `R, G, B, A` (big-endian inside the 4 bytes). The palette is referenced by 16-bit indices from CHR data and from runtime palette RAM, so a single ROM can carry up to 65 535 distinct colours.

**Layout convention** (not enforced):
- Entries 0…3: NES-compat fallback (used when `flags.0` is set), populated with the converter's choice of NES master-palette colours.
- Entries 4 onwards: free for the artist.

## PRG-ROM

Raw 6502 machine code, identical in shape to iNES PRG-ROM. The 2A03 instruction set is unchanged, so a converter can copy an iNES PRG-ROM byte-for-byte.

Bank size and banking is controlled by the PonchoMapper (see below).

## CHR-ROM

Tile bitmap data. **Format:**

- Tile size: **32 × 32 pixels** = 1 024 bytes per tile.
- Bit depth: **8 bpp** — one byte per pixel.
- Each pixel byte indexes either:
  - The current sub-palette (256 entries × 4 bytes = 1 KB of palette RAM), if `< 256`.
  - Reserved range for direct-master-palette references in future revisions.
- Tile pixels are stored **row-major**: row 0 left-to-right, then row 1, etc. No bitplane interleaving (that was an NES-era ROM-cost optimisation, no longer relevant).

**Tile addressing.** A 16-bit tile index in the nametable / OAM points to byte offset `tile_index × 1024` from the start of CHR. So 65 536 tiles addressable, max CHR size = 64 MB. Mappers can extend this via banking.

## Nametable + attributes (in PPU VRAM, not the cartridge)

For reference — the cartridge writes none of this — but it shapes the format the PRG-ROM produces.

- Screen at 1024 × 960 ÷ 32 × 32 = **32 × 30 tiles**, same dimensions as NES.
- Each nametable byte is now a **16-bit tile index** (2 bytes), so a nametable is 32 × 30 × 2 = 1 920 bytes.
- Attribute table: same 2 bits per 2×2-tile group = same NES layout, scaled.
- Total VRAM per nametable: 1 920 + 64 = 1 984 bytes. Four nametables = 7 936 bytes.

## OAM (sprite RAM)

64 sprites × 8 bytes each = 512 bytes.

| Byte | Field | Notes |
|---|---|---|
| 0–1 | `y` | 16-bit, pixel-precise on the 1024 × 960 screen |
| 2–3 | `x` | 16-bit |
| 4–5 | `tile_index` | 16-bit, indexes CHR by tile |
| 6 | `attr` | bits 0–1 sub-palette, bit 2 priority, bit 3 flip-h, bit 4 flip-v, bits 5–7 reserved |
| 7 | `size` | 0 = 32×32, 1 = 64×32, 2 = 32×64, 3 = 64×64 (extended sizes; v1 may only support 0). |

OAM DMA mechanism is unchanged from NES — written via `$4014` — but now copies 512 bytes (= 2 × 256 cycles).

## PonchoMapper register map

PonchoMapper exposes registers in the `$8000–$FFFF` write-protected range like most NES mappers. The exact layout will be finalised when the chip is implemented; the slots reserved in this spec are:

| Range | Purpose |
|---|---|
| `$8000–$9FFF` | PRG bank select (16 KB banks) |
| `$A000–$BFFF` | CHR bank select (4 KB banks of tile data) |
| `$C000–$DFFF` | Palette RAM swap-in (load N palette entries from CHR) |
| `$E000–$FFFF` | Mapper config + IRQ counter |

**NES-compat sub-mode** (when `flags.0` and `mapper_submode.0` are both set): the mapper additionally exposes the original NES PPU register set at `$2000–$2007`, routed to the Ultra PPU. Original game code runs unchanged; the PPU renders at 1024 × 960 using the upscaled CHR data and the converter-populated 4-entry sub-palettes.

## Conversion from iNES

The converter (`scripts/poncho-convert.ts`, planned) is purely mechanical:

1. Read the iNES file. Extract PRG-ROM, CHR-ROM, mapper ID.
2. **PRG-ROM**: copy verbatim.
3. **CHR-ROM**: for each 8 × 8 2bpp NES tile, expand to 32 × 32 8bpp via 4×4 nearest-neighbour pixel replication. Pixel value 0–3 maps directly to sub-palette indices 0–3.
4. **Master palette**: write 64 RGBA entries matching the NES master palette (one of the standard reference palettes — likely Smooth (FBX) or 2C02 capture).
5. **Header**: set `flags.0 = 1` (NES-compat), `mapper_id = 1`, `mapper_submode.0 = 1`. Copy the iNES mapper number into a custom field for later reference.
6. **Title**: extract from filename or leave blank.
7. **Output**: write PonchoROM to `<input>.poncho`.

The output is *visually identical* to running the iNES file through Poncho's existing 4× nearest-neighbour scaler — same pixels. The point is to give artists a hand-paintable starting file. Replacing the 4×4-replicated tiles with hand-drawn 32×32 8bpp tiles upgrades the visuals without touching game code.

## Trailer (optional)

When `flags.1` is set, the trailer follows the CHR-ROM. Reserved for: extended metadata (author, signature), update notes, embedded screenshots, debug symbols. v1 does not specify the layout.

## Versioning policy

- Bump `version` only for backward-incompatible changes.
- New features in the same `version` go through `flags`, mapper sub-modes, or trailer.
- The runtime must reject ROMs with a `version` it doesn't know — never partially load.

## See also

- [`consoles.md`](consoles.md) — comparison of NES and Poncho-NES
- [`architecture.md`](architecture.md) — Poncho's chip library + composition layout
