# Virtual consoles

Poncho hosts more than one virtual console. Each is a *composition* of chips from `src/core/` (CPU, PPU, APU, buses, mappers, cartridge) wired together in a top-level file under `src/console/`. The user picks the active console from the sidebar (top icon, hotkey `0`); each console accepts its own set of cartridge formats.

This page lists the consoles, their specs side-by-side, and how the abstraction is shaped.

---

## At a glance

| | NES | Poncho-NES |
|---|---|---|
| **Status** | Working | Beta |
| **Released** | 1985 | — |
| **CPU** | Ricoh 2A03 @ 1.79 MHz | Ricoh 2A03 @ 1.79 MHz |
| **PPU** | 2C02 | 2C02-Ultra |
| **Resolution** | 256 × 240 | 1024 × 960 |
| **Master palette** | 64 fixed entries | Per-ROM 32-bit RGBA |
| **Colours on screen** | 32 | 2048 |
| **Palettes** | 4 BG + 4 sprite × 4 colours | 4 BG + 4 sprite × 256 colours |
| **Tile depth** | 2 bpp | 8 bpp |
| **Sprite size** | 8 × 8 (or 8 × 16) | 32 × 32 |
| **Sprites total** | 64 | 64 |
| **Sprites per scanline** | 8 | 32 |
| **APU** | 5 channels (pulse × 2, triangle, noise, DMC) | identical |
| **Cart format** | iNES (`NES\x1A`) | PonchoROM (`PNCH`) + iNES (compat mode) |

The complete spec for each is in [`src/console/specs.ts`](../src/console/specs.ts) — that file is the source of truth. The UI and this page consume it.

## NES (working)

The original Nintendo Entertainment System. Composition file: [`src/console/nes.ts`](../src/console/nes.ts). Detailed architecture and per-cycle synchronisation notes live in [`architecture.md`](architecture.md) and [`../CLAUDE.md`](../CLAUDE.md).

Six cartridge mappers (NROM, MMC1, UxROM, CNROM, MMC3, AxROM) cover roughly 85% of the commercial library. Accepts `.nes` only; refuses PonchoROM.

## Poncho-NES (beta)

A virtual successor: same 6502 + same APU as the NES, paired with a redesigned PPU (the *2C02-Ultra*) and a new cartridge format (*PonchoROM*). Boots and renders today; feature gaps remain (sprite-0 hit, 8×16 sprite mode, MMC3 IRQ counter accuracy, per-scanline timing) so it's `'beta'` until those land.

Composition file: [`src/console/poncho-nes.ts`](../src/console/poncho-nes.ts). Accepts both `.poncho` (native mode — full Ultra PPU pipeline) and `.nes` (NES-compat mode — 8×8 2 bpp tiles painted as 4×4 pixel blocks in the 1024×960 framebuffer, via the existing iNES mappers).

The design rationale: keep the parts that aged well (the 6502 core, the 2A03 APU, the cycle-accurate per-dot rendering pipeline), and unblock the parts the original 2C02 constrained too tightly — colour depth, tile size, and the master palette.

**What's the same as NES:**
- 6502 instruction set and clock rate
- APU and audio mixer
- Per-cycle CPU↔PPU synchronisation model
- Controller interface
- Sprites-in-OAM model and DMA semantics

**What's different:**
- 4× linear resolution (16× pixel area)
- 4× linear sprite size (32 × 32 instead of 8 × 8)
- 32-bit RGBA palette entries; per-ROM master palette of any size
- 256 colours per sub-palette instead of 4
- 8 bpp tile data (one byte per pixel)
- 32 sprites per scanline instead of 8
- New cartridge header (`PNCH`) with extended PRG/CHR sizes

The full file format and the mapper register map are specified in [`poncho-rom.md`](poncho-rom.md).

**NES backward compatibility.** The Ultra PPU has a *NES-compat* sub-mode (`PpuUltra.setNesCompat(true)`): it exposes the original `$2000–$2007` register set, fetches CHR via the iNES mapper, and renders 8×8 2 bpp tiles as 4×4 pixel blocks. PRG runs unchanged. A converter (`scripts/poncho-convert.ts`, planned) will additionally produce a PonchoROM with upscaled CHR — a starting point for hand-painted art replacement.

---

## How the abstraction is shaped

```
src/core/              ← chip library
  cpu/  apu/  input/   ← shared by every console
  bus/  cart/  mappers/  ppu/             ← NES-flavoured chips
  ppu-ultra/  cart-poncho/  mappers-poncho/  bus-poncho/  ← Poncho-NES chips

src/console/
  console.ts           ← Console interface + ConsoleSpec types
  specs.ts             ← NES_SPEC + PONCHO_NES_SPEC (data only)
  detect.ts            ← magic-byte registry mapping bytes → factory
  nes.ts               ← composition: 2C02 + iNES + NES mappers
  poncho-nes.ts        ← composition: 2C02-Ultra + PonchoROM + PonchoMapper
                         (also boots iNES via NES-compat sub-mode)
```

Every composition file implements the same `Console` interface:

```ts
interface Console {
  runFrame(): FrameBuffer;
  reset(): void;
  loadRom(data: Uint8Array): void;
  unload(): void;
  setController(player: 1 | 2, source: ControllerSource | null): void;
}
```

Composition is the only thing that changes per console. The shell, the renderer, the audio sink, the config store, and the controller stack are all console-agnostic — they speak `Console`, `FrameBuffer`, and `Float32Array`.

## Why split the chip library and the compositions

- **A chip is a chip.** The 6502 doesn't know it's "in an NES" — it just steps. Keeping the chip library in `src/core/` and the wiring in `src/console/` avoids accidentally encoding "NES-ness" into a generic chip.
- **New consoles are cheap.** Adding one means new chips (or reusing existing ones) plus one composition file — not a fork of the runtime.
- **The chip library is the SDK.** A future user-built virtual console only needs to import from `src/core/` and write a composition file.

## See also

- [`poncho-rom.md`](poncho-rom.md) — full PonchoROM file format spec
- [`architecture.md`](architecture.md) — per-frame data flow + module layering
- [`../CLAUDE.md`](../CLAUDE.md) — per-cycle sync model, deeper conventions
- [`../src/console/specs.ts`](../src/console/specs.ts) — the spec data this page mirrors
