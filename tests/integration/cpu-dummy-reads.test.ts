/**
 * blargg's `cpu_dummy_reads` test.
 *
 * Verifies that read-modify-write instructions and indexed reads perform
 * the documented *dummy* bus accesses — e.g. INC abs reads, writes the
 * old value back, then writes the new value; LDA abs,X with page cross
 * first reads from the WRONG page before reading the correct one. These
 * dummy accesses matter when the address is a memory-mapped register with
 * read side-effects (PPU/APU).
 *
 * Phase 3 status: we do NOT yet model dummy reads or read-modify-write
 * dummy writes. The ROM detects this, jumps to its permanent halt routine
 * (SEI; LDA #$00; STA $2000; JMP $E60F at $E60F-$E617) *without* writing
 * the protocol bytes — so the runner times out. This test exists to track
 * the situation; it is marked `it.skip` until per-cycle bus accesses land
 * (a substantial CPU rework, planned for a future phase).
 */
import { existsSync } from 'node:fs';
import { describe, it } from 'vitest';
import { runBlarggRom } from './blargg';
import { testRomPath } from '../rom-paths';

const ROM_PATH = testRomPath('cpu_dummy_reads.nes');

describe.skipIf(!existsSync(ROM_PATH))('blargg cpu_dummy_reads', () => {
  it.skip('expected to fail until phantom bus reads are modelled', () => {
    runBlarggRom(ROM_PATH);
  });
});
