/**
 * blargg's `ppu_vbl_nmi` — 10 sub-tests covering vblank flag timing and
 * NMI delivery.
 *
 * Current status with our Phase 3 PPU: passes sub-test 1 (vbl_basics),
 * fails sub-test 2 (vbl_set_time) and beyond. Tests 2+ measure the *exact*
 * dot at which vblank latches relative to CPU instruction cycles; matching
 * those requires per-cycle CPU↔PPU lockstep where bus accesses see PPU
 * state at the precise cycle they happen, not at instruction completion.
 * That's a substantial CPU rework planned for a later phase.
 *
 * The assertion below captures exactly today's verdict so any regression
 * is loud, and a future improvement (e.g. passing more sub-tests) flips
 * the test red until the snapshot is updated.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runBlarggRom } from './blargg';
import { testRomPath } from '../rom-paths';

const ROM_PATH = testRomPath('ppu_vbl_nmi.nes');

describe.skipIf(!existsSync(ROM_PATH))('blargg ppu_vbl_nmi', () => {
  it('reaches a verdict; current ceiling is sub-test 1 (vbl_basics)', () => {
    const result = runBlarggRom(ROM_PATH, { maxSteps: 10_000_000 });

    // Hard requirements: must converge and reach the protocol setup.
    expect(result.timedOut).toBe(false);
    expect(result.signatureValid).toBe(true);

    // Snapshot: we currently fail sub-test 2 (vbl_set_time). Update when
    // Phase 4/5 cycle-accurate timing flips this green.
    expect(result.code).toBe(0x01);
    expect(result.message).toContain('02-vbl_set_time');
    expect(result.message).toContain('Failed');
  });
});
