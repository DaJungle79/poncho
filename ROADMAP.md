# Roadmap

The features and improvements Poncho is heading toward, grouped by theme rather than by version. *What's already broken* lives in [`DEFERRED.md`](DEFERRED.md); *what's shipped* lives in [`CHANGELOG.md`](CHANGELOG.md).

This doc is intentionally informal and freely edited. Order inside each section is rough priority, top-to-bottom. A bullet here is intent, not a commitment.

---

## Near-term — likely next

- **Sub-cycle bus alignment** — interleave CPU bus accesses with PPU dots and APU frame-counter clocking. Single rework that flips ~24 blargg sub-tests in `ppu_vbl_nmi`, `sprite_hit_tests`, `sprite_overflow`, `apu_test`. See [`DEFERRED.md`](DEFERRED.md).
- **Save states** — serialize Nes state to a `Uint8Array`; restore from same. Per-slot persistence in browser storage.
- **Battery-backed SRAM** — persist `prg-ram` for cartridges with non-volatile save (Zelda, Final Fantasy). Keyed by ROM SHA-1, stored alongside the library.
- **Pause-on-blur** — auto-pause when the tab loses focus; resume on focus. Optional via Settings.

## Mid-term — themes worth a focused pass

### Emulation accuracy
- **OAM DMA bus interleaving** — currently bulk-then-stall (correct cycle count, wrong bus order). Real DMA alternates read/write per cycle.
- **Unstable illegal opcodes** — currently NOPs. Implement `ANE`, `LXA`, `SHA`, `SHX`, `SHY`, `TAS` to match common reference behavior.
- **MMC3 IRQ A12 filter** — verify against `mmc3_test_*` blargg ROMs.

### Mappers (push commercial coverage past ~85%)
- **MMC2** (9) — Punch-Out!!
- **MMC5** (5) — Castlevania III, Metal Slader Glory (large undertaking; lots of features)
- **VRC6** (24, 26) — Akumajou Densetsu (extra audio channels)
- **Color Dreams / FFE / Sunsoft** (11, 17, 67-69) — long tail

### UI / UX
- **CRT post-processing filter** — scanlines, NTSC composite blur, barrel distortion. The filter pipeline already supports it.
- **Debug overlay** — PPU pattern-table viewer, OAM viewer, nametable viewer, CPU trace.
- **Gamepad support** — `Gamepad` API as a second `ControllerSource` alongside `KeyboardSource`. Default mapping for SNES-style USB pads.
- **Two-player input** — wire `controller2`, expose Player 2 keybinds + gamepad slot in Settings.
- **Volume per channel** — pulse 1, pulse 2, triangle, noise, DMC sliders in audio settings.
- **Fast-forward / slow-mo / single-step** — hold a key for 2x, 0.5x, frame advance. Useful for both play and debugging.
- **Mobile mode** - detect mobile device and create a virtual gamepad. 

### Tooling / dev experience
- **`ultrareview` cycle-by-cycle trace UI** — load a trace file, scrub through CPU + PPU + APU state.
- **Headless CI screenshot baselines** — extend `scripts/render-screenshot.ts` into a regression suite (one PNG per game per N frames, fail on diff).

## Long-term — bigger bets

- **Electron / Tauri shell** — file-system ROM library, native menus, file associations for `.nes`. Each shell owns its own UI per the new layout (`src/shells/<name>/`).
- **NES 2.0 ROM format** — parse the extended header (submapper, exact prg/chr-ram sizes). Most test ROMs already use it.
- **Netplay** — rollback-based two-player over WebRTC. Hard but well-understood; existing libraries (GGPO-style) make the input-prediction loop tractable.
- **iOS / Android shell** — same web shell wrapped in Capacitor or a lightweight native chrome. Touch controls overlay.

---

## How this list works

- Items move into [`CHANGELOG.md`](CHANGELOG.md) under `[Unreleased]` when they ship, then into a versioned section at release time.
- Items that turn out to be *bugs in shipped code* (not future features) move to [`DEFERRED.md`](DEFERRED.md), which has the *what / why deferred / how to verify* template.
- No formal status tracking here. If something becomes interesting enough to plan in detail, write it up under [`docs/`](docs/) and link from the bullet.
