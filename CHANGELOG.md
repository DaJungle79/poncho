# Changelog

All notable changes to Poncho are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project loosely tracks [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In progress — v0.4.0 (AI-driven CHR upscaling via nanobanana / Gemini 2.5 Flash Image). See [`docs/v0.4.0-plan.md`](docs/v0.4.0-plan.md). Game-by-game validation + regression harness moved to [`docs/v0.5.0-plan.md`](docs/v0.5.0-plan.md).

### Added — v0.4 Phase 1: foundation

- **PonchoROM AI cache section** (optional, gated by header flag bit 2: `flags.aiCachePresent`). 12-byte sub-header (`AICH` magic + format version + model id + entry count) followed by N × 1056-byte entries (16-byte palette-aware hash + 16-byte source NES tile + 1024-byte upscaled native tile). [`src/core/cart-poncho/ai-cache.ts`](src/core/cart-poncho/ai-cache.ts) implements parser + writer; [`PonchoCartridge`](src/core/cart-poncho/cartridge.ts) loads it on construction. Format spec in [`docs/poncho-rom.md`](docs/poncho-rom.md).
- **Tile cache** ([`src/convert/tile-cache.ts`](src/convert/tile-cache.ts)) — three-tier lookup (per-cart `FileTileCache` → cross-cart `GlobalTileCache` → `UpscaleClient`) with promotion on hit. SHA-256-truncated-128 palette-aware tile hashing via Web Crypto, with a pure-JS RFC 6234 fallback. Model-id mismatched entries are treated as cache misses (not destructively purged) so the on-disk cache is preserved when the user switches upscalers.
- **Upscale client interface** ([`src/convert/upscale-client.ts`](src/convert/upscale-client.ts)) — `UpscaleClient` boundary with two implementations: `MockUpscaleClient` (deterministic 4× nearest-neighbour, used by tests + as the no-key fallback) and `NanoBananaClient` (Phase 1: stub).

### Added — v0.4 Phase 2: CHR-ROM bake-now pipeline

- **`convertInesToPonchoAi`** ([`src/convert/ines-to-poncho-ai.ts`](src/convert/ines-to-poncho-ai.ts)) — high-level converter for CHR-ROM cartridges. Dedupes tiles by content hash, pumps unique tiles through the cache layers with bounded concurrency (default 4), reassembles CHR with each NES tile replaced by its 1024-byte upscaled native counterpart, and emits a native-mode `.poncho`. Per-tile API failures fall back to nearest-neighbour so a flaky network doesn't fail the whole conversion. Reports progress via `onProgress` callback; cancellable via `AbortSignal`. CHR-RAM cartridges are rejected at the boundary — they take the runtime upscale path instead.
- **`NanoBananaClient` real transport** — Gemini 2.5 Flash Image API client with PNG encode/decode via the Canvas API. Browser-only by design; CLI sticks with `MockUpscaleClient` until a Node-side codec lands.
- **CLI**: `npm run poncho:convert -- <input.nes> --ai` runs the AI pipeline with the mock client (deterministic NN expansion).
- **Web UI**: "Use AI upscale" checkbox under "Convert .nes" (Poncho-NES mode only). For CHR-ROM games it shows a modal with progress bar, tile counter, and Cancel button. For CHR-RAM games it converts instantly with a hint that AI will run during play. Uses `NanoBananaClient` if `window.PONCHO_GEMINI_API_KEY` is set; otherwise falls back to `MockUpscaleClient`.

## [0.3.0] — 2026-05-07

> Poncho-NES native runtime + iNES converter. The runtime gains everything needed
> to play a converted Contra: per-scanline rendering, sprite-0 hit, 8×16 sprites,
> all major mapper banking variants, CHR-RAM, palette mirroring, and `$2007` read
> buffering. The converter wraps any iNES ROM (NROM/MMC1/UxROM/CNROM/MMC3/AxROM)
> as an upscaled-mode `.poncho` cartridge that runs on PpuUltra without any
> compatibility shims at runtime. A "Convert .nes" UI button puts the workflow
> directly in the web shell. See [`docs/v0.3.0-plan.md`](docs/v0.3.0-plan.md) for
> the full release plan.
>
> Validation: Contra title screen + first level boot through the converter and
> render essentially identically to the classic NES emulator (99–100% pixel match
> outside of heavy-sprite scenes where Poncho-NES legitimately renders more
> sprites than NES would due to the latter's 8-per-scanline hardware limit).

### Added — Track A: runtime

- **PonchoROM format extension (Phase 1)**
  - `flags.upscaledMode` (bit 0): renamed from `nesCompat` and re-purposed. When set, the cartridge declares NES-shape CHR (8×8 2 bpp) and NES-shape OAM (4-byte sprites at 8-bit coords); PpuUltra renders each NES pixel as a 4×4 block. Both upscaled and native (clear) modes are first-class native capabilities of the chip — no compat layer.
  - `mapperSubmode` formalised: bits 0–7 = PonchoMapper banking variant (0 = NROM-style, 2 = UxROM-style, 4 = MMC3-style, etc., matching iNES mapper numbers); bits 8–9 = boot-time nametable mirroring; bits 10–15 reserved. Codec helpers `encodeMapperSubmode` / `decodeMapperSubmode` exported from [`src/core/cart-poncho/header.ts`](src/core/cart-poncho/header.ts).
  - **CHR-RAM allocation**: when `chrRamKb > 0`, [`PonchoCartridge`](src/core/cart-poncho/cartridge.ts) allocates a writable CHR-RAM buffer of the declared size and exposes `chrIsRam = true`.
- **PonchoMapper banking variants (Phases 2 + 8)** — full set of variants in [`src/core/mappers-poncho/variants/`](src/core/mappers-poncho/variants/), each implementing `Mapper` directly with its own state. Selected at construction from `mapper_submode` low byte:
  - **NROM-style** (variant 0) — flat mirror, no banking.
  - **UxROM-style** (variant 2) — 16 KB switchable @ $8000-$BFFF, fixed last bank @ $C000-$FFFF, bank-select on any write to $8000-$FFFF.
  - **MMC1-style** (variant 1) — 5-bit serial register protocol; PRG modes 0/1 (32 KB), 2 (fixed first / switch second), 3 (switch first / fixed last); CHR modes 0 (single 8 KB) / 1 (two 4 KB); runtime mirroring control. Bit-7 reset forces PRG mode 3.
  - **CNROM-style** (variant 3) — any write to $8000-$FFFF selects an 8 KB CHR bank.
  - **MMC3-style** (variant 4) — per-1 KB CHR banking with two layout modes; PRG/CHR mode swap; scanline IRQ counter clocked by filtered PPU A12 0→1 edges (10-dot low filter via `tickPpu`). Four-screen mirroring locked when boot mirroring is four-screen.
  - **AxROM-style** (variant 7) — 32 KB switchable PRG bank; bit 4 of bank-select toggles single-low vs single-high mirroring.
  - PonchoMapper restructured as a thin delegating wrapper.
- **Multi-nametable + mirroring (Phase 3)** — PpuUltra honors the four logical nametables ($2000/$2400/$2800/$2C00) under horizontal / vertical / single-low / single-high. Four-screen falls back to vertical until cart-supplied 4 KB VRAM lands. PPUCTRL `baseNametable` + $2005 scroll fold into a 2 × 2 virtual nametable grid; tile + attribute fetches re-base on nametable-boundary crossings. Exported helper `resolvePhysicalNT(logicalNT, mirroring)`.
- **Upscaled-CHR render path (Phase 4)** — PpuUltra walks 8×8 2 bpp NES tiles in 256×240 NES-pixel coordinate space, painting each NES pixel as a 4×4 block in the 1024×960 framebuffer. CHR fetched via `chrReader` callback (wired to `mapper.ppuRead`); `$2007` writes in `$0000-$1FFF` route through `chrWriter` so PRG-driven CHR-RAM uploads persist. `setUpscaledMode(bool)` toggles the path.
- **Upscaled-OAM render path (Phase 5)** — `$4014` OAM DMA copies 256 bytes when `upscaledMode` is set; PpuUltra walks 64 × 4-byte NES OAM (`[y, tile, attr, x]`); position scaled ×4 from NES → Poncho px; sub-palette from attr bits 0–1, flip-H bit 6, flip-V bit 7; off-screen `y >= 0xEF` skipped.
- **Sprite-0 hit + 8×16 sprite mode (Phase 6)** — sprite-0 hit pre-computed at the pre-render scanline, fired during the matching visible-scanline dot. PPUCTRL bit 5 selects 8×16 sprites: tile LSB picks pattern table, `tile & 0xFE` is the top tile, `+1` is the bottom; renders as a 32×64 Poncho block.
- **Per-scanline BG rendering (Phase 7)** — PpuUltra's BG render moved out of vblank-entry into a per-scanline event in `tick()`. `renderScanlineUpscaled(nesY)` paints the 4 Poncho rows for one NES scanline using the chip's CURRENT state; called at dot 340 of each visible scanline. Mid-frame palette / scroll / `showBg` writes take effect on the next-rendered scanline. Eager `renderFrameUpscaled()` becomes a thin loop over the new method (used by direct-render unit tests). `refreshBgColor` no longer fills the framebuffer (would wipe per-scanline output on mid-frame palette writes).

### Added — Track B: converter

- **iNES → upscaled-mode PonchoROM converter v2 (Phase 9)** — [`src/convert/ines-to-poncho.ts`](src/convert/ines-to-poncho.ts). Replaces the v0.2 NROM-only converter. Supports all 6 PonchoMapper banking variants. PRG copied verbatim. CHR-ROM embedded verbatim; CHR-RAM games get `chrRamKb=8`. iNES mirroring maps into the boot-mirroring sub-field of `mapper_submode`. `flags.upscaledMode = 1`. Source iNES CRC32 recorded in the header. Lives under `src/` so the web shell imports client-side; `scripts/lib/ines-to-poncho.ts` is a thin re-export.
- **"Convert .nes" button in the ROMs panel** (web shell) — visible only when Poncho-NES is the active console; sits next to "Upload .poncho". Opens a file picker accepting `.nes`. On selection: client-side conversion, result stored in the IndexedDB library under `basename.poncho`, list refreshed. Conversion errors surface in the status bar.
- **Phase 10 — Contra end-to-end validation** — found and fixed four PpuUltra correctness issues that surface only against real games:
  - **Palette mirroring** — `$3F10/$3F14/$3F18/$3F1C` writes now mirror to `$3F00/$3F04/$3F08/$3F0C` per NES hardware. Universal-BG was going stale when PRG wrote via the mirror. New free function `mirrorPaletteAddr(addr)`.
  - **`$2007` (PPUDATA) reads** — implemented with the standard 1-byte read buffer for `$0000-$3EFF` and direct read for `$3F00-$3FFF` (with buffer refilled from `addr-$1000`). Previously returned 0.
  - **Sprite y-coordinate hardware delay** — NES OAM y stores `actual_y - 1`; sprites display at `(yNes + 1)..(yNes + height)`. PpuUltra was rendering one scanline too high. Fixed in `renderSpritesUpscaled` and `computeSprite0HitScanline`.
  - **Sprite priority order** — NES draws lower-index sprites *in front of* higher-index. Iteration reversed (63 → 0).
- **Diagnostic harness** — [`scripts/diagnose-contra.ts`](scripts/diagnose-contra.ts): converts Contra, runs both consoles in parallel for N frames, dumps cross-console state diff (CPU PC, CPU RAM, OAM, palette, nametable, CHR), per-pixel match count, and a register-write timeline. Reusable for future game debugging.

### Synthetic test ROMs (committed under `tests/roms/poncho/`)

One per phase, generated via `npm run gen:poncho:<name>`:
`uxrom-bankswitch`, `multi-nametable`, `upscaled-chr`, `upscaled-sprite`, `sprite0-hit`, `sprite-8x16`, `scanline-split`, `mmc1-bankswitch`.

### Tests

84 net new tests across the v0.3.0 cycle. Final count: **366 passed, 1 skipped** (up from 276 at v0.2.0).

### Format spec

[`docs/poncho-rom.md`](docs/poncho-rom.md) updated with the new "Upscaled vs native modes" table, the formalised "Mapper submode" section, and the rewritten "Conversion from iNES" pipeline that matches the v0.3 architecture (verbatim PRG/CHR, no transpiler).

### Documentation

- New [`docs/v0.3.0-plan.md`](docs/v0.3.0-plan.md) — phased roadmap (this release).
- New [`docs/v0.4.0-plan.md`](docs/v0.4.0-plan.md) — wider game coverage + regression harness + AI upscaling.

### Pre-v0.3-plan changes (still part of the 0.3 release)

These shipped on `main` between v0.2.0 and the v0.3.0 plan kickoff:

- **Overscan crop** for Classic NES ([`src/renderer/filters/overscan.ts`](src/renderer/filters/overscan.ts)). `OverscanCropFilter` trims a configurable number of pixels from each edge, hiding the BG-LEFT clip region that games expose during horizontal scrolling. Defaults: Left 8, Top/Bottom/Right 0. Per-side values editable in Settings → Video (4 inputs appear when the checkbox is ticked). Hidden entirely for Poncho-NES (native 1024 × 960 output).
- **ROMs panel filters by active console's extension** — `.nes` for Classic NES, `.poncho` for Poncho-NES. Upload button label and panel title update on console switch.
- **NES-compat sub-mode removed** from Poncho-NES (initial pre-Phase-1 cleanup; replaced by the v0.3 upscaled-mode flag). `PpuUltra.setNesCompat()` / `setChrReader()` / `renderFrameNesCompat()` removed. `BusCartridge` structural interface dropped; the bus is typed directly to `PonchoCartridge`.

### Fixed (overscan UI bugs)

- Overscan inputs were visible on panel open even when overscan was disabled. Root cause: `display: grid` on `.overscan-inputs` overrode the `hidden` attribute. Fixed with `.overscan-inputs[hidden] { display: none; }`.
- Users with configs from earlier sessions received stale overscan values (8/8/8/8). Config version bumped 1 → 2; the v1 → v2 migration resets overscan to the correct defaults.
- White/black border appeared around the viewport when overscan was active. Removed the hardcoded `aspect-ratio: 16 / 15` from `#screen`; the canvas's intrinsic dimensions already encode the correct ratio.

### Known divergence vs Classic NES

- **8-sprites-per-scanline limit** — Poncho-NES renders all 64 sprites without per-scanline truncation. Classic NES drops sprites past 8 on a given scanline (causing the famous flicker). For Contra and similar sprite-heavy games, this means Poncho-NES shows ~5–20% more pixels per frame in heavy scenes. This is an intentional design enhancement, not a bug.

## [0.2.0] — 2026-05-06

### Added
- **Console abstraction layer** at `src/console/`. `src/core/` is now a pure chip library; both `nes.ts` and `poncho-nes.ts` compositions wire chips into a virtual console behind a shared `Console` interface.
- **Poncho-NES** — second virtual console (status: `beta`). 4× linear resolution (1024×960), 32-bit RGBA palette, 32×32 sprites, custom PonchoROM cartridge format. The Ultra PPU additionally exposes a NES-compat sub-mode that boots ordinary `.nes` files at 4× pixel-block scale via the existing iNES mappers. See `docs/consoles.md` and `docs/poncho-rom.md`.
- Console-selector UI: top sidebar icon (Lucide `cpu`, hotkey `0`) opens an L2 panel listing every console from `ALL_SPECS`. Selection persists in `general.selectedConsoleId`; the sidebar tooltip dynamically reflects the active console's name.
- `ConsoleSpec` data type + [`src/console/specs.ts`](src/console/specs.ts) — single source of truth for UI panels and the README. `status` enum is `'working' | 'beta'`.
- [`docs/consoles.md`](docs/consoles.md) — virtual-console catalogue and architecture rationale.
- [`docs/poncho-rom.md`](docs/poncho-rom.md) — full design spec for the PonchoROM format.
- PonchoROM header parser + writer at [`src/core/cart-poncho/`](src/core/cart-poncho/). 29 unit tests cover round-trip, every header field, accept/reject paths, CRC32, and alignment errors.
- 2C02-Ultra PPU at [`src/core/ppu-ultra/`](src/core/ppu-ultra/) — 1024×960 framebuffer, NES-compatible scanline timing, NES-shaped 32-byte palette RAM, register file for `$2000` (auto-increment), `$2006` (VRAM address latch), `$2007` (auto-incrementing data write). Master palette stored as ABGR Uint32.
- BG tile-render pipeline in the Ultra PPU: 32×32 8 bpp tiles fetched from cartridge CHR, 30×32 nametable cells, NES-style attribute-table decode → sub-palette selection (4 sub-palettes × 4 colours), eager full-frame render at vblank-start. Tile-pixel values currently masked `& 3` to fit NES-shape sub-palettes; expansion to 256-entry sub-palettes is additive.
- Sprite OAM + sprite render path: 64 sprites × 8 bytes (Poncho-NES layout: y(16), x(16), tile(16), attr, size). Power-on OAM = `0xFF` so uninitialised sprites are off-screen. Registers `$2003` OAMADDR / `$2004` OAMDATA implemented; `$4014` OAM DMA copies 512 bytes from a CPU page. Sprite renderer: 32×32 sprites only (v1), per-spec attr bits (sub-palette in 0-1, BG priority in 2 — not yet enforced — flip-H in 3, flip-V in 4), sprite-pixel-0 = transparent. Drawn after BG, no per-scanline limit yet.
- Full PPU register file: `$2000` PPUCTRL (all bits decoded — base nametable, VRAM increment, BG/sprite pattern bases, sprite size, NMI enable), `$2001` PPUMASK (BG/sprite enable + greyscale + emphasis tracked), `$2002` PPUSTATUS (vblank flag, sprite-0 hit, sprite overflow; reading clears vblank + the $2005/$2006 toggle), `$2005` PPUSCROLL (two-write X then Y, toggle shared with `$2006`).
- NMI delivery: `PpuUltra.setNmiCallback()` wired by `PonchoNes` to `cpu.triggerNmi()`. NMI fires at vblank-start when PPUCTRL bit 7 is set; flags clear at the pre-render scanline.
- BG scrolling: per-pixel BG render with `scrollX` / `scrollY` offsets. Source coords wrap at the single-screen nametable edge (4-screen / mirroring lands when needed).
- New synthetic test ROM `tests/roms/poncho/nmi-scroll.poncho` — PRG enables NMI, NMI handler increments a zero-page counter and writes the new scroll value via `$2005`. Integration test runs 9 frames and verifies the BG has shifted by 8 pixels.
- **NES-compat sub-mode** in the Ultra PPU. Poncho-NES now boots iNES `.nes` files alongside `.poncho` ROMs:
  - `PpuUltra.setNesCompat(true)` switches the renderer to walk 8×8 2 bpp NES tile data, painting each NES pixel as a 4×4 block in the 1024×960 framebuffer
  - CHR fetches go through `mapper.ppuRead()` so existing iNES mappers (NROM, MMC1, UxROM, CNROM, MMC3, AxROM) work unchanged
  - Built-in NES master palette at [`src/core/ppu-ultra/nes-master-palette.ts`](src/core/ppu-ultra/nes-master-palette.ts) — 64 RGBA entries derived from `src/core/ppu/palette.ts`
  - Sprite render in compat mode: 64 × 4-byte NES OAM entries, 8×8 sprites only (8×16 pending), per-NES attribute bits (sub-palette, flip-H bit 6, flip-V bit 7), drawn after BG
  - OAM DMA size selects 256 vs 512 bytes based on the compat flag
  - `PonchoNes.loadRom` magic-byte sniffs: `PNCH` → native PonchoROM path; `NES\x1A` → iNES NROM/MMC1/etc. via the existing `Cartridge` wrapper, with the Ultra PPU configured for compat
  - Bus accepts a structural `BusCartridge { mapper }` so iNES and PonchoROM cartridges share routing
- New synthetic iNES test ROM `tests/roms/poncho/compat-bg.nes` (NROM, 24 KB). Integration test loads it through `PonchoNes`, runs a frame, and verifies every pixel is `NES_PALETTE[1]` (master index 1, dark blue) — the BG → CHR → palette → master pipeline.
- Pending compat features (next batch): sprite-0 hit, 8×16 sprite mode, MMC3 IRQ counter accuracy, per-scanline timing, conversion CLI (`scripts/poncho-convert.ts`).
- **Console-selector UI**: a new sidebar icon at the top (Lucide `cpu`, hotkey `0`) opens an L2 panel listing every console from `ALL_SPECS` with name, description, status, PPU, and cart format. Clicking switches the active runtime — the App re-instantiates the chosen console class (`Nes` or `PonchoNes`), persists the selection in `general.selectedConsoleId`, and the sidebar tooltip dynamically reflects the active console name. Switching ejects any loaded ROM (different consoles accept different formats); the user re-picks from the library.
- PonchoMapper stub at [`src/core/mappers-poncho/`](src/core/mappers-poncho/) (flat PRG mirroring across $8000-$FFFF, no banking) and PonchoCartridge wrapper at [`src/core/cart-poncho/cartridge.ts`](src/core/cart-poncho/cartridge.ts).
- PonchoCpuBus at [`src/core/bus-poncho/`](src/core/bus-poncho/) — Poncho-NES CPU memory map.
- Poncho-NES composition at [`src/console/poncho-nes.ts`](src/console/poncho-nes.ts) — full chipset wired (CPU + APU + Ultra PPU + bus + PonchoMapper) with the same per-cycle CPU↔PPU↔APU sync model as the NES. `solid-bg.poncho` now boots through real 6502 PRG (a halt loop) instead of cycle-spinning the PPU directly.
- Console-detection registry at [`src/console/detect.ts`](src/console/detect.ts) — magic-byte sniff routes iNES bytes to `Nes`, PonchoROM bytes to `PonchoNes`. Adding a new console is one line.
- Three synthetic test ROMs (committed):
  - `tests/roms/poncho/solid-bg.poncho` — halt-loop PRG, single-colour master palette. Verifies header parse, palette upload, BG-colour render path.
  - `tests/roms/poncho/palette-write.poncho` — PRG writes a known index to `$3F00` via `$2006/$2007`, then halts. Verifies the full PRG → bus → PPU register-file → palette RAM → framebuffer pipeline.
  - `tests/roms/poncho/solid-tile.poncho` — PRG installs palette + writes 1024 nametable bytes (NES-shaped attribute table included), then halts; CHR tile 0 is filled with pixel value 1. Verifies the BG tile renderer end-to-end (CHR fetch → attribute decode → palette lookup → framebuffer).
  - `tests/roms/poncho/single-sprite.poncho` — PRG sets BG palette, sprite palette, and OAM[0..7] for one 32×32 sprite at (100, 80) using sprite sub-palette 0; halts. Verifies the OAM register file + sprite render path. Integration test counts exactly 1024 red pixels in the framebuffer.
  - Built by `npm run gen:poncho:{solid-bg,palette-write,solid-tile,single-sprite}`. Integration tests in `tests/integration/poncho-synthetic.test.ts` re-load each ROM via `detectConsole` and check pixel output.
- Shared `scripts/lib/png.ts` PNG encoder.
- Poncho logo (light + dark variants) at `src/shells/web/ui/`; brand area in the title bar now shows the theme-matched logo SVG instead of the text glyph. Logo also added to the README.
- [`ROADMAP.md`](ROADMAP.md) — themed list of near-term / mid-term / long-term work.
- Architecture overview at [`docs/architecture.md`](docs/architecture.md) with data-flow and module-layering diagrams.
- GitHub Pages deployment workflow (`.github/workflows/deploy.yml`).
- Browser-support matrix in the README.
- `scripts/render-screenshot.ts` — headless single-frame renderer used to refresh the README screenshot.
- Sidebar playback controls: Pause / Reset / Off — Eject buttons next to ROMs, with `1`–`5` keyboard shortcuts and instant retro tooltips.
- Sticky bottom status bar with a Settings → Appearance toggle to hide it.

### Changed
- `src/core/nes.ts` moved to `src/console/nes.ts` and now formally implements the new `Console` interface. Behaviour unchanged; 7 import paths updated across `src/shells/`, `tests/`, and `scripts/`.
- Each shell now owns its own App orchestrator and UI tree. `src/app.ts` and `src/ui/` moved into `src/shells/web/`. UI is no longer shared across shells.

## [0.1.0] — 2026-05-05

First public release.

### Emulation
- Cycle-accurate 6502 / 2A03 CPU: 151 official + 25 illegal opcodes, per-cycle bus accesses with phantom reads on indexed addressing and dummy writes on read-modify-write.
- Full 2C02 PPU: scanline-stepped background + sprite shifters, sprite-0 hit, sprite overflow, runtime mirroring, OAM DMA.
- All five APU channels (pulse × 2, triangle, noise, DMC) feeding the canonical NES non-linear mixer through 90 Hz / 440 Hz / 14 kHz analog filters.
- Cartridge mappers: NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 (4), AxROM (7).
- Passes `nestest` cleanly and the bulk of the blargg `apu_mixer`, `oam_*`, `apu_test`, and `sprite_*` suites; remaining failures share a single sub-cycle-timing root cause documented in [`DEFERRED.md`](DEFERRED.md).

### User interface
- Retro-NES aesthetic with `Press Start 2P` headers, `JetBrains Mono` data, NES-palette colours, optional scanline overlay.
- Light + dark themes, persisted across reloads.
- Three-level sliding panel layout (sidebar / detail / sub-detail), overlay-style on top of the canvas.
- Auto-extracted game title from filename (No-Intro / GoodNES naming) via the RomInfo client, cached by SHA-1.
- Rebindable keyboard controls; adjustable scale (1×, 2×, 4×) and audio volume.

### ROM management
- Browser storage: uploaded `.nes` files persist in IndexedDB across browser sessions.
- Server folder: files in `roms/` are served by a Vite middleware in development.
- Persistent metadata cache keyed by SHA-1.

### Architecture
- Shell-decoupled: emulator core, renderer, audio mixer, and UI panels are platform-agnostic; web shell lives behind a `Platform` interface in `src/platform/web/`.
- Pluggable rendering pipeline: separate filter and scaler stages.
- Pluggable RomInfo sources behind a unified cache.

[Unreleased]: https://github.com/DaJungle79/poncho/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/DaJungle79/poncho/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DaJungle79/poncho/releases/tag/v0.2.0
[0.1.0]: https://github.com/DaJungle79/poncho/releases/tag/v0.1.0
