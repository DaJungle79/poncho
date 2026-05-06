/**
 * Older blargg PPU test ROMs that don't use the $6000 protocol — they print
 * "PASSED" or "FAILED <subtest>" into the nametable for visual readout.
 *
 * Our runner steps the system until the CPU enters its post-test halt
 * (a tight `JMP self`), then reads the nametable as ASCII.
 *
 * Each row below locks in *today's* behavior; an improvement that flips a
 * test green will trip its assertion and force the snapshot to be updated.
 *
 * Currently passing:
 *   sprite_hit_11      edge_timing
 *   sprite_overflow_1  Basics
 *   sprite_overflow_5  Emulator
 *
 * Currently failing on early sub-tests — known limitations tracked in
 * DEFERRED.md (sprite-0 hit precise timing + overflow hardware-bug edges).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Nes } from '../../src/console/nes';
import { testRomPath } from '../rom-paths';

interface VisualResult {
  /** "PASSED" or "FAILED N" or "(no verdict)". */
  verdict: string;
  /** Whether the verdict text contains "PASSED". */
  passed: boolean;
}

function runVisualRom(romPath: string): VisualResult {
  const data = new Uint8Array(readFileSync(romPath));
  const nes = new Nes();
  nes.loadRom(data);

  // Step until the CPU sits at one PC for many consecutive instructions
  // (tight JMP-self halt).
  let prev = -1;
  let stuck = 0;
  for (let i = 0; i < 10_000_000; i++) {
    nes.step();
    if (nes.cpu.pc === prev) {
      stuck++;
      if (stuck > 10_000) break;
    } else {
      stuck = 0;
      prev = nes.cpu.pc;
    }
  }

  // Read nametable $2000-$23BF as ASCII tile codes; find row with verdict.
  for (let row = 0; row < 30; row++) {
    let line = '';
    for (let col = 0; col < 32; col++) {
      const tile = nes.ppuBus.read(0x2000 + row * 32 + col);
      if (tile === 0 || tile === 0x24) line += ' ';
      else if (tile >= 0x41 && tile <= 0x5a) line += String.fromCharCode(tile); // A-Z
      else if (tile >= 0x30 && tile <= 0x39) line += String.fromCharCode(tile); // 0-9
      else line += '.';
    }
    if (line.includes('PASSED') || line.includes('FAILED')) {
      const cleaned = line.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
      return { verdict: cleaned, passed: cleaned.includes('PASSED') };
    }
  }
  return { verdict: '(no verdict found)', passed: false };
}

interface Spec { rom: string; expected: string; }

// Sprite-0 hit: 11 sub-tests. Snapshot of today's verdicts.
const spriteHitSpecs: Spec[] = [
  { rom: 'sprite_hit_01.basics.nes',          expected: 'FAILED 2' },
  { rom: 'sprite_hit_02.alignment.nes',       expected: 'FAILED 2' },
  { rom: 'sprite_hit_03.corners.nes',         expected: 'FAILED 2' },
  { rom: 'sprite_hit_04.flip.nes',            expected: 'FAILED 2' },
  { rom: 'sprite_hit_05.left_clip.nes',       expected: 'FAILED 4' },
  { rom: 'sprite_hit_06.right_edge.nes',      expected: 'FAILED 3' },
  { rom: 'sprite_hit_07.screen_bottom.nes',   expected: 'FAILED 3' },
  { rom: 'sprite_hit_08.double_height.nes',   expected: 'FAILED 3' },
  { rom: 'sprite_hit_09.timing_basics.nes',   expected: 'FAILED 3' },
  { rom: 'sprite_hit_10.timing_order.nes',    expected: 'FAILED 3' },
  { rom: 'sprite_hit_11.edge_timing.nes',     expected: 'PASSED' },
];

// Sprite overflow: 5 sub-tests.
const spriteOverflowSpecs: Spec[] = [
  { rom: 'sprite_overflow_1.Basics.nes',   expected: 'PASSED' },
  { rom: 'sprite_overflow_2.Details.nes',  expected: 'FAILED 5' },
  { rom: 'sprite_overflow_3.Timing.nes',   expected: 'FAILED 5' },
  { rom: 'sprite_overflow_4.Obscure.nes',  expected: 'FAILED 2' },
  { rom: 'sprite_overflow_5.Emulator.nes', expected: 'PASSED' },
];

function suiteFor(label: string, specs: Spec[]): void {
  for (const { rom, expected } of specs) {
    const romPath = testRomPath(rom);
    describe.skipIf(!existsSync(romPath))(`${label} / ${rom}`, () => {
      it(`reports "${expected}"`, () => {
        const result = runVisualRom(romPath);
        expect(result.verdict).toBe(expected);
      });
    });
  }
}

suiteFor('sprite_hit_tests', spriteHitSpecs);
suiteFor('sprite_overflow_tests', spriteOverflowSpecs);
