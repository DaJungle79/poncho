# Changelog

All notable changes to Poncho are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project loosely tracks [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Architecture overview at [`docs/architecture.md`](docs/architecture.md) with data-flow and module-layering diagrams.
- GitHub Pages deployment workflow (`.github/workflows/deploy.yml`).
- Browser-support matrix in the README.
- `scripts/render-screenshot.ts` — headless single-frame renderer used to refresh the README screenshot.

## [0.1.0] — 2026-05-04

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

[Unreleased]: https://github.com/DaJungle79/poncho/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DaJungle79/poncho/releases/tag/v0.1.0
