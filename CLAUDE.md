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
src/core/
  cpu/        6502 core. flags · addressing · instructions · opcodes · cpu · disasm
  ppu/        2C02. registers · timing · ppu · palette · render(stub)
  apu/        2A03 audio. Stubs — Phase 7.
  bus/        cpu-bus + ppu-bus. Each routes to mapper for cart space.
  cart/       iNES parser, Cartridge wrapper, Mapper interface.
  mappers/    NROM(0), MMC1(1), CNROM(3). Registered via mappers/index.ts.
  input/      Controller (NES protocol) + ControllerSource interface + KeyboardSource.
  nes.ts      Top-level wiring. Sets cpu.tickCallback, ppu.nmiCallback, oamDmaCallback.

src/renderer/
  frame-buffer        Uint32 pixel store + size constants.
  stage               RenderStage interface (shared by Filter and Scaler).
  scalers/            Scaler interface + NearestNeighborScaler 1x/2x/4x + registry.
  filters/            Filter interface + empty registry (Phase 11+).
  renderer            RenderPipeline composition (preFilters, scaler, postFilters).
  canvas-renderer     Canvas2D blit target.

src/audio/            AudioSink interface + WebAudioSink stub.
src/config/           localStorage-backed Config with schema version + migration.
src/rom/              URL / file / local /roms loaders + iNES validator.
src/debug/            leveled per-subsystem logger + tracer (capture wired but unused).
src/main.ts           Browser bootstrap.
```

### Why some addressing modes have "Write" twins (`AbsoluteX` / `AbsoluteXWrite`)

Indexed read instructions only do the un-corrected dummy read on a real page cross. Indexed write/RMW instructions *always* do it (the chip can't know the cross outcome until it has read the high byte, so it always pays the cost). The opcode table picks the right variant per instruction. Same pattern for `AbsoluteY` / `AbsoluteYWrite` and `IndirectY` / `IndirectYWrite`. Don't unify these — the cycle counts and bus side-effects differ.

### How `runFrame()` returns at the right moment

The PPU's `tick()` returns `true` on the dot that starts vblank. `Nes` latches that into `frameComplete` from inside the tickCallback (since the tick callback is what calls `ppu.tick()` 3×). `runFrame()` loops on `cpu.step()` until `frameComplete`, then resets the flag.

### ROM loading

Three sources, all returning `LoadedRom { name, source, data }`:
- `UrlRomLoader` — `fetch()` + iNES validation.
- `FileRomLoader` — `<input type=file>`.
- `LocalRomLoader` — reads `/roms/*` served by a Vite dev-server middleware in `vite.config.ts` that exposes a top-level `roms/` directory at `/roms/` (and a JSON listing at `/roms/`).

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
