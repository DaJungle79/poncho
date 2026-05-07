# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev         # vite dev server (http://localhost:5173)
npm test            # vitest run, all suites
npm run test:watch  # vitest in watch mode
npm run typecheck   # tsc --noEmit
npm run build       # tsc -b && vite build (also runs full typecheck)
```

Run a single test file:
```bash
npm test -- tests/cpu/instructions.test.ts
```

Run a one-off probe directly via tsx (handy for blargg ROM debugging):
```bash
npx tsx -e "import { runBlarggRom } from './tests/integration/blargg'; ..."
```

## Architecture

This is an NES emulator (the **NES console**, not a game) written in TypeScript, running in the browser, built with Vite. The emulator core is decoupled from the renderer/UI so the same `Nes` class can be driven headless from tests or from the browser main loop.

### Per-cycle synchronization model — central design choice

The CPU is the master clock. **Every CPU bus access ticks the rest of the system before/with the access**, not after the instruction completes. The implications are pervasive:

- `Cpu` has a `tickCallback` (set by `Nes`) invoked once per CPU cycle. The callback advances APU 1× and PPU 3×.
- Instruction implementations **must not** call `bus.read/write` directly. They go through `cpu.read8/write8/dummyRead/dummyWrite/internalCycle` — every helper ticks once.
- Per-instruction cycle counts are *implicit* (count of helper calls), not declared. The `cycles` field in the opcode table is documentation only.
- "Phantom" bus accesses are explicit: indexed addressing on page-cross does `dummyRead(earlyAddr)`; read-modify-write writes the old value back via `dummyWrite(addr, oldValue)` before writing the new one.
- Branches: taken adds `dummyRead(oldPc)`; page-cross adds another `dummyRead(wrongAddr)`.

### Module layout

```
src/
  domain/             Platform-agnostic types. Pure interfaces only.
    rom.ts              LoadedRom · RomMeta · StoredRomEntry · RomInfoSource

  core/                 Chip library (no DOM / Node deps). Generic 2A03/2C02 parts.
    cpu/                6502: flags · addressing · instructions · opcodes · cpu · disasm
    ppu/                2C02: registers · timing · ppu · palette · render
    apu/                2A03 audio: 5 channels + frame-counter + mixer + filters
    bus/                cpu-bus + ppu-bus. Each routes to mapper for cart space.
    cart/               iNES parser, Cartridge wrapper, Mapper interface.
    mappers/            NROM(0), MMC1(1), UxROM(2), CNROM(3), MMC3(4), AxROM(7).
    input/              Controller + ControllerSource interface + KeyboardSource.
    cart-poncho/        PonchoROM header parser + writer + cartridge + CRC32.
    mappers-poncho/     PonchoMapper. Stub: flat PRG mirroring, no banking yet.
    bus-poncho/         Poncho-NES CPU bus. Accepts only PonchoCartridge.
    ppu-ultra/          2C02-Ultra. BG + sprites + scrolling + NMI; full
                        $2000-$2007 register file; native 32×32 8 bpp tile
                        render. Sprite-0 hit / 8×16 sprites / MMC3 IRQ
                        accuracy still pending.

  console/              Compositions: pick chips from core/, wire a virtual console.
    console.ts          Console + ConsoleFactory + ConsoleSpec interfaces.
    specs.ts            NES_SPEC + PONCHO_NES_SPEC (data only — UI + docs SoT).
    detect.ts           Magic-byte registry. Routes ROM bytes to a factory.
    nes.ts              NES composition. Sets cpu.tickCallback, ppu.nmiCallback, etc.
    poncho-nes.ts       Poncho-NES composition (Ultra PPU + APU + PonchoROM).

  renderer/             Pure rendering pipeline. Reusable by every shell.
    frame-buffer        Uint32 pixel store + size constants.
    stage               RenderStage interface (shared by Filter and Scaler).
    scalers/            Scaler interface + NearestNeighborScaler 1x/2x/4x + registry.
    filters/            Filter interface + empty registry (CRT / NTSC future).
    renderer            RenderPipeline composition (preFilters, scaler, postFilters).
    canvas-renderer     Canvas2D blit target. Reusable in any DOM context.

  audio/                AudioSink interface (pure — no implementation here).
  config/               Storage-backed Config with schema version + migration.
  rom/                  Loaders + iNES validator + RomInfoClient.
  debug/                Leveled per-subsystem logger + tracer.

  platform/             Shell-specific platform-API implementations.
    types.ts            Platform · RomLibrary · ServerRomLoader · FilePicker.
    web/                Web-shell pieces:
      audio-sink          WebAudioSink (AudioWorklet + Web Audio)
      rom-library         WebRomLibrary (IndexedDB)
      server-roms         WebServerRomLoader (fetches /roms/ via Vite middleware)
      file-picker         WebFilePicker (programmatic <input type=file>)
      url-loader          fetch helper used by server-roms
      ines-validator      shared iNES magic check
      index.ts            createWebPlatform() factory

  shells/               Per-shell entry points. Each shell owns its own
                        App orchestrator and UI tree — no shared DOM code
                        across shells. Duplication is fine; if a future
                        shell wants different panels, it forks freely.
    web/
      main.ts             Bootstraps web platform → App → run().
      app.ts              Web App orchestrator. Takes a Platform + DOM refs.
                          Owns the ConfigStore, Nes, renderer, panels, run loop.
      ui/                 DOM panels + sidebar + icons used by this shell.
```

### Decoupling — adding a new shell

The emulator core, renderer, audio interface, ROM info client, and config store all live above `src/platform/` and `src/shells/` — they have no shell-specific dependencies. To add an Electron / Tauri / native shell:

1. Implement `Platform` from `src/platform/types.ts` (provide audio sink, config Storage, RomLibrary, FilePicker, optional ServerRomLoader). Put it under `src/platform/<name>/` with a `create<Name>Platform()` factory.
2. Build a shell directory under `src/shells/<name>/` with its own `main.ts`, `app.ts` (orchestrator), and `ui/` tree. Reuse everything under `src/core/`, `src/renderer/`, `src/audio/`, `src/config/`, `src/rom/`, `src/domain/`.

UI is **not** shared between shells — each shell owns its own `App` and panels. If two shells later converge on the same UI, you can extract a shared module then; until then, duplication beats a premature abstraction that constrains both shells.

### Why some addressing modes have "Write" twins (`AbsoluteX` / `AbsoluteXWrite`)

Indexed read instructions only do the un-corrected dummy read on a real page cross. Indexed write/RMW instructions *always* do it (the chip can't know the cross outcome until it has read the high byte, so it always pays the cost). The opcode table picks the right variant per instruction. Same pattern for `AbsoluteY` / `AbsoluteYWrite` and `IndirectY` / `IndirectYWrite`. Don't unify these — the cycle counts and bus side-effects differ.

### How `runFrame()` returns at the right moment

The PPU's `tick()` returns `true` on the dot that starts vblank. `Nes` latches that into `frameComplete` from inside the tickCallback (since the tick callback is what calls `ppu.tick()` 3×). `runFrame()` loops on `cpu.step()` until `frameComplete`, then resets the flag.

### ROM loading

ROM loading is reached through the `Platform` interface (`src/platform/types.ts`). Each implementation lives under `src/platform/<shell>/`. The web shell wires up:

- `WebFilePicker` — programmatic `<input type="file">`. Used for "upload" actions.
- `WebRomLibrary` — IndexedDB-backed library that stores uploaded ROMs across browser sessions; the SHA-1 of the bytes is the key.
- `WebServerRomLoader` — fetches `/roms/<file>` from the Vite dev-server middleware in `vite.config.ts`, which exposes the top-level `roms/` directory (and a JSON listing at `/roms/`). The UI hides the section when `Platform.serverRoms` is `null` (e.g. desktop shells).
- `UrlRomLoader` — internal `fetch()` helper used by `WebServerRomLoader`. iNES magic check lives in `ines-validator.ts`.

All these return `LoadedRom { name, source, data }`. Adding a desktop shell means writing `src/platform/electron/` (or similar) with file-system-backed equivalents and a `createElectronPlatform()` factory.

**Two ROM directories** (different purposes, both gitignored except `.gitkeep`):
- `/roms/` — **games**, served by Vite at `/roms/*` for the browser UI.
- `/tests/roms/` — **test ROMs** (nestest, blargg, etc.), used by integration tests via `tests/rom-paths.ts` (`testRomPath('foo.nes')`). Never served to the browser; test files `skipIf(!existsSync(...))` so CI without these still works.

### Test ROM harness

`tests/integration/blargg.ts` runs any ROM that uses blargg's protocol ($6000 result code, $6001-$6003 `DE B0 61` signature, $6004+ ASCII message) until it converges or times out. Returns a structured `BlarggResult`. Used by `nestest.test.ts`, `cpu-dummy-reads.test.ts`, `ppu-vbl-nmi.test.ts`, `apu-roms.test.ts`, etc. All resolve filenames via `testRomPath()` so the layout can be moved in one place if needed.

### Renderer pipeline shape (worth understanding before adding effects)

`RenderPipeline = { preFilters[], scaler, postFilters[] }`. Filters and Scalers share a `RenderStage` interface (`outputSize` + `apply`). The pipeline is composed in `Canvas2DRenderer.render()` by walking input → preFilters → scaler → postFilters → canvas, hopping between two scratch buffers. Adding a filter means: implement `Filter`, register in `filters/index.ts`, list in `config.video.preFilters` or `postFilters`. Scalers are kept separate from filters by design.

## Conventions worth knowing

- TypeScript strict mode + `noUnusedLocals` + `exactOptionalPropertyTypes`. Underscore-prefix unused params (`_cpu`).
- Tests live alongside the topic they cover: `tests/cpu/`, `tests/ppu/`, `tests/integration/`. Vitest in node env (`vite.config.ts` `test` block).
- Heavy JSDoc on the CPU and PPU layers — non-obvious quirks (BIT's V/N, JMP indirect bug, ADC overflow formula, $2002 latch clearing, dummy-write side effects) are documented at the source. Match this style for new chip code; minimal comments elsewhere.
- Both `roms/` (games) and `tests/roms/` (test ROMs) are gitignored. Keep both out of commits.

## Known limitations and deferred work

See **DEFERRED.md** at the project root. It tracks:
- Sub-cycle PPU timing failures (`ppu_vbl_nmi` sub-tests 2-10)
- `cpu_dummy_reads` verdict needs rendering to verify
- OAM DMA does bulk-then-stall (correct cycle count, wrong bus order)
- Mapper coverage stops at NROM/MMC1/CNROM
- Save states / battery SRAM not wired
- Unstable illegal opcodes treated as NOP

Each entry has *what*, *why deferred*, and *how to verify a fix*. **When closing one of these, update DEFERRED.md** — don't just delete the entry without context.

## Phase numbering

Development is sequenced 0-11 in the original plan; Phases 0-3 are done (scaffold + CPU + skeletal PPU). Currently entering Phase 4 (PPU rendering pipeline). Phases 5-11 are APU, more mappers, config UI, debug panel, polish. The phase numbers are referenced in JSDoc comments scattered through stub code (e.g. "Phase 4 fills this in").


## Keep the docs in sync

Whenever you change project structure, add/remove features, or alter visible behavior, update these three files in the same change set so future sessions stay current:

- **`README.md`** — feature lists, mapper table, controls, browser support, screenshot, "Adding a new shell" example. The user-facing front door.
- **`CHANGELOG.md`** — add or update an entry under `## [Unreleased]`. Promote it to a versioned heading when cutting a release.
- **`docs/architecture.md`** — module layering, data-flow diagram, ROM-loading paths. If you move modules around or add a new top-level layer, the diagrams need to follow.
- **`docs/consoles.md`** + **`src/console/specs.ts`** — when a console's hardware capabilities change, update the spec data first; the doc tables mirror it. When a console reaches feature parity, flip its `status` field from `'beta'` to `'working'` and update the comparison tables in `consoles.md` and the README.
- **`docs/poncho-rom.md`** — PonchoROM file format spec. Until the format is locked, all design changes (header layout, mapper register map, conversion rules) land here first, before code.

If the change is structural (renaming/moving modules, changing the `Platform` interface, altering the per-cycle sync model), also update the relevant section of this file (`CLAUDE.md`) so the architecture overview here doesn't drift.

For deferred work / known gaps, the home is `DEFERRED.md`. When closing one of those, update it instead of silently deleting the entry — the *why deferred* and *how to verify* notes are part of the project's institutional memory.

For *future* features (things not yet shipped, not yet broken), the home is `ROADMAP.md`. When you ship a roadmap item, move it from `ROADMAP.md` to `CHANGELOG.md` under `## [Unreleased]` in the same change set.

## GitHub rules

Never commit automatically! Always ask the user.
