/**
 * blargg APU test ROMs. Snapshot of today's verdicts.
 *
 * Categories:
 *   apu_test/*       → 8 sub-tests, $6000 protocol — pass/fail observable.
 *   apu_mixer/*      → 4 mixer ROMs, $6000 protocol — all PASS for us.
 *   apu_reset/*      → 6 ROMs that require a real "press RESET" event;
 *                      the runner sends one programmatic soft-reset on
 *                      code `$81` ("needs reset") and continues.
 *
 * Currently passing:
 *   apu_1-len_ctr, apu_2-len_table, apu_3-irq_flag,
 *   all 4 mixer tests
 *
 * Currently failing (mostly sub-cycle timing — same root cause as
 * `ppu_vbl_nmi` test 2; tracked in DEFERRED.md):
 *   apu_4-jitter, apu_5-len_timing, apu_6-irq_flag_timing,
 *   apu_7-dmc_basics, apu_8-dmc_rates
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runBlarggRom } from './blargg';
import { testRomPath } from '../rom-paths';

interface Spec {
  rom: string;
  /** Expected $6000 result code. 0 = PASS. */
  expectedCode: number;
}

const apuTestSpecs: Spec[] = [
  { rom: 'apu_1-len_ctr.nes',         expectedCode: 0x00 },
  { rom: 'apu_2-len_table.nes',       expectedCode: 0x00 },
  { rom: 'apu_3-irq_flag.nes',        expectedCode: 0x00 },
  { rom: 'apu_4-jitter.nes',          expectedCode: 0x02 },
  { rom: 'apu_5-len_timing.nes',      expectedCode: 0x02 },
  { rom: 'apu_6-irq_flag_timing.nes', expectedCode: 0x02 },
  { rom: 'apu_7-dmc_basics.nes',      expectedCode: 0x13 },
  { rom: 'apu_8-dmc_rates.nes',       expectedCode: 0x02 },
];

const apuMixerSpecs: Spec[] = [
  { rom: 'apu_mixer_dmc.nes',      expectedCode: 0x00 },
  { rom: 'apu_mixer_noise.nes',    expectedCode: 0x00 },
  { rom: 'apu_mixer_square.nes',   expectedCode: 0x00 },
  { rom: 'apu_mixer_triangle.nes', expectedCode: 0x00 },
];

function suiteFor(label: string, specs: Spec[]): void {
  for (const { rom, expectedCode } of specs) {
    const romPath = testRomPath(rom);
    describe.skipIf(!existsSync(romPath))(`${label} / ${rom}`, () => {
      it(`reports code $${expectedCode.toString(16).padStart(2, '0')}`, () => {
        const result = runBlarggRom(romPath, { maxSteps: 20_000_000 });
        expect(result.timedOut).toBe(false);
        expect(result.signatureValid).toBe(true);
        expect(result.code).toBe(expectedCode);
      });
    });
  }
}

suiteFor('apu_test', apuTestSpecs);
suiteFor('apu_mixer', apuMixerSpecs);
