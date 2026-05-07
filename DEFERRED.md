# Deferred improvements

Things known to be imperfect or incomplete. Each entry should explain *what*
is wrong, *why* it isn't fixed yet, and *how* we'd verify a fix.

## Sub-cycle bus alignment — single root cause for ~24 test-ROM failures

A handful of separate-looking failures all share one architectural gap:
our CPU's bus access happens at the *end* of each CPU cycle, with the
PPU's three dots ticking as a batch *before* the access. Real silicon
interleaves them — bus access slots between PPU dots 1 and 2 of the
cycle, with APU's frame counter clocked alongside dot 2.

The result: every test ROM that measures "exactly when does the chip
make X visible to a CPU read" reports an off-by-1-cycle error, in the
same direction, across four different test suites.

This section bundles all the affected suites — they would *all* flip
to PASSED from the same rework.

### Suites affected

#### `ppu_vbl_nmi` — 9 of 10 sub-tests failing

**Symptom.** Code `$01`, message starts `02-vbl_set_time`. The ROM
prints a "T+ 1 2" alternation pattern that's off by ~5 rows from
canonical. Sub-tests 6 (`suppression`), 9 (`even_odd_frames`), and 10
(`even_odd_timing`) additionally need behavior we haven't built (NMI
suppression race at dot 1/241, odd-frame dot-skip on visible-scanline
0).

**Snapshot.** `tests/integration/ppu-vbl-nmi.test.ts` asserts the
current code/message; a fix flips both.

#### `sprite_hit_tests` — 10 of 11 sub-tests failing

**Symptom.** Only `11.edge_timing` passes. The other 10 fail at
sub-tests 2-4 with the displayed message `FAILED N`. Our sprite-0 hit
fires under the right *general* conditions (opaque sprite-0 pixel ∧
opaque bg pixel ∧ leftmost-8 mask ∧ x≠255) but its exact firing cycle
is off by one. Some ROMs additionally depend on "first frame after
reset" suppression and mid-frame mask-change quirks.

**Snapshot.** `tests/integration/sprite-roms.test.ts` asserts each
ROM's exact `PASSED` / `FAILED N` verdict.

#### `apu_test` frame counter timing — 5 of 8 sub-tests failing

**Symptom.** `4-jitter`, `5-len_timing`, `6-irq_flag_timing`,
`7-dmc_basics` (sub-test 13) and `8-dmc_rates` fail with "too soon" /
"too short" messages. The frame counter fires at the documented cycle
but the test ROM measures the offset relative to a CPU instruction
boundary that needs sub-cycle alignment. The 4 mixer tests, 3 of the
8 basic apu_test sub-tests, and our APU unit tests all pass — channel
logic is correct.

**Snapshot.** `tests/integration/apu-roms.test.ts`.

#### `ppu_read_buffer.nes` sub-test `$13`

**Symptom.** Code `$13`, message starts "Performing tests that combine
sprite 0 hit flag, $4014 DMA and the RAM mirroring…". The basic
$2007-buffer behavior we *do* pass — only this specific
sprite-0 + DMA + mirroring interaction fails, and it depends on the
sub-cycle timing of all three.

**Snapshot.** `tests/integration/oam-and-buffer-roms.test.ts`.

### The unified fix

Today, `cpu.read8` (and the four other bus helpers) do:
```
this.cycleCount++;
const v = this.bus.read(addr) & 0xff;
this.tickCb();   // 3 PPU + 1 APU ticks at end of cycle
return v;
```

Real silicon: the bus access slots between PPU dots 1 and 2 of the
cycle. The correct shape is three callbacks per CPU cycle (or one
with a phase argument), with the bus access happening between phases:

```
this.tickCb1();   // PPU dot 1
const v = this.bus.read(addr) & 0xff;
this.tickCb2();   // PPU dot 2 + APU
this.tickCb3();   // PPU dot 3
this.cycleCount++;
return v;
```

The same change applies to `write8`, `dummyRead`, `dummyWrite`, and
`internalCycle`. `Nes` then wires PPU `tick` to phases 1/3 and APU
`tick` to phase 2.

### Why deferred

The code change itself is small (~50 lines in `cpu.ts` + a callback
restructure in `nes.ts`). The hard part is **verification** — change
the dot-vs-bus alignment by 1 step in either direction and you'll
fix some tests while breaking others.

The standard approach is measurement-driven: build a per-cycle bus
trace runner, diff against a known-good Mesen trace of nestest, find
the first divergent line, tweak the phase ordering, repeat until the
traces match exactly. Realistic budget: **3–5 days of focused debug
iterations**.

For the games anyone actually wants to play (Mario, Zelda, Castlevania,
Mega Man, Metroid, Final Fantasy, etc.) current accuracy is enough.
The 1-cycle granularity matters only for: (a) demoscene/timing-pushed
homebrew, (b) split-screen effects on the very edge of safe-zones,
(c) bragging rights on a "100% pass on blargg suite" emulator.

### How to verify a fix

Each suite has a snapshot test — a pass would force the snapshot to
update:

| Suite | File | Today |
|---|---|---|
| `ppu_vbl_nmi` | `tests/integration/ppu-vbl-nmi.test.ts` | code `$01`, msg `02-vbl_set_time` |
| `sprite_hit_*` | `tests/integration/sprite-roms.test.ts` | "FAILED 2"–"FAILED 4" verdicts |
| `apu_*` (timing) | `tests/integration/apu-roms.test.ts` | codes `$02` / `$13` |
| `ppu_read_buffer` | `tests/integration/oam-and-buffer-roms.test.ts` | code `$13` |

A canonical "all passed" outcome would change every assertion in those
files to expect a passing result.

## Sprite overflow hardware-bug edge cases — fails 3 of 5 `sprite_overflow_tests`

**What.** We pass `1.Basics` and `5.Emulator` but fail `2.Details`,
`3.Timing`, and `4.Obscure`. Our overflow detection is the simplified
"set the flag the moment a 9th sprite is found"; real silicon has a
documented bug where the eval pointer increment can skip bytes,
causing overflow to be reported for sprites that aren't actually on
the line. Different root cause from the sub-cycle timing above —
needs the chip's eval state machine replicated rather than just
re-aligning ticks.

**Symptom.** Snapshots in `tests/integration/sprite-roms.test.ts`.

**Why deferred.** The bug is exercised by very few games. Implementing
it accurately is well-understood but tedious; not blocking any
visible feature.

**How to verify a fix.** Update the snapshot expectations when each
test flips to "PASSED".

## `cpu_dummy_reads.nes` — verdict not headlessly observable

**What.** This older blargg test ROM runs to completion in our emulator
(it reaches the post-test halt at $E60F) but doesn't use the standard
$6000/$6004 protocol — it draws results to the PPU framebuffer instead.

**Why deferred.** PPU rendering is now working (shipped in 0.2.0), so
the original blocker is gone. What remains is wiring up framebuffer
text inspection in the test harness: run the ROM until halt, blit the
256×240 framebuffer, map rendered pixel colours back to NES palette
indices, and read the on-screen text.

**How to verify a fix.** Extend `tests/integration/blargg.ts` (or add a
sibling helper) with a `runUntilHalt` + framebuffer-OCR path. Capture
the canvas after the CPU halts and assert the first line reads "Passed".
The test file already has `.skipIf(!existsSync(path))` so adding the ROM
to `tests/roms/` will automatically un-skip it.

## APU — DMC DMA does not stall the CPU

**What.** Real DMC sample fetches stall the CPU for ~4 cycles per byte
read from $8000-$FFFF. We do an immediate `cpuBus.read` from inside the
APU tick, so timing-sensitive games that count cycles around a sample
playback may behave subtly differently. Most don't notice.

**How to verify a fix.** Have the APU expose a "DMC needs to fetch"
signal, route through CPU `stall(n)` like OAM DMA does. Snapshot a
game that's known to depend on accurate DMC stall (e.g. *The Battle of
Olympus*) and confirm timing matches a reference.

## APU — soft-reset behavior not testable

**What.** All 6 `apu_reset/*` ROMs need a `Press RESET` event after
running their setup. We don't currently send one programmatically, so
all 6 timeout-and-fail. Implementing this means the blargg runner
needs to detect code `$81` ("needs reset"), call `nes.reset()`, and
continue.

**How to verify a fix.** Extend `tests/integration/blargg.ts` with a
reset hook; expect-code becomes `$00` for those ROMs.

## OAM DMA still uses bulk-then-stall

**What.** $4014 writes copy 256 bytes immediately, then we stall the
CPU for 513-514 cycles. Real silicon spreads the 256 reads + 256 writes
across the same window, so each individual byte is visible on the bus
at its own cycle.

**Why deferred.** Not currently observable to test ROMs we run, and the
gross cycle cost is correct (PPU/APU advance the right total during the
stall). Per-byte ticking is a small file change but adds risk; punted
until something needs it.

**How to verify a fix.** Test that DMA-source page reads of mapped
registers (e.g. $2007) show their auto-increment side effects each
cycle, not all at once. Likely needs a custom probe ROM.

## Mapper coverage — long tail beyond mapper 7

**What.** We support mappers 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM),
4 (MMC3), and 7 (AxROM). Together those cover ~85% of the commercial
library. The remaining ~15% is spread across many mappers, none of
which individually covers many games (mapper 9 = 1 game, 11 ≈ 16
games, etc.).

**Why deferred.** Diminishing returns on each addition. Add as needed
when you discover a specific game you want to play.

**How to verify a fix.** Each mapper has a documented bank-switching
spec on the nesdev wiki; pick a representative game and boot it.

## MMC3 IRQ — pre-revision-A behavior not modeled

**What.** Pre-rev-A MMC3s have slightly different IRQ behavior — the
"clock counter when reaching zero" logic differs in a way that affects
a small number of games (notably Klax). We implement the post-rev-A
behavior which is what the vast majority of games expect.

**Why deferred.** Affects almost no titles in practice.

**How to verify a fix.** Add an `mmc3RevA: boolean` flag at construction
and branch the `clockIrqCounter` logic. Klax should boot correctly.

## Save states / battery SRAM persistence

**What.** Mappers expose `getSram()` / `loadSram()`, but nothing wires
those to localStorage. No emulator-level save states either.

**Why deferred.** Architected-for, deliberately not implemented yet
(per the original plan). Will land alongside the config UI rebinding
work in Phase 9.

## Unstable illegal opcodes (XAA, AHX, SHX, SHY, TAS, LAS, ATX) treated as NOP

**What.** Listed as NOP in the dispatch table — they're so unpredictable
on real hardware that no game uses them, but a comprehensive test ROM
(e.g. blargg's full `instr_misc`) might exercise them.

**Why deferred.** Not currently observable in any test we run.

**How to verify a fix.** Pass a ROM that specifically exercises these.

## Tracer / debug panel

**What.** `Tracer.capture()` is wired but isn't called from `Nes.step()`.
The dev panel (Phase 11) is unbuilt.

**Why deferred.** Phase 11 of the plan.

**How to verify a fix.** Toggle tracer, run nestest, compare output to
`nestest.log` line-for-line (will require adding `PPU:` and `CYC:` columns
to the disassembly, which depend on cycle-accurate PPU dot tracking).
