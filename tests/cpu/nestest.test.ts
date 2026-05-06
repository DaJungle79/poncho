/**
 * nestest.nes — the de facto CPU correctness test for NES emulators.
 *
 * Two run modes exist; we use the *auto* mode that requires no controller:
 *   1. Load the ROM (NROM, mapper 0).
 *   2. Force PC = $C000 (bypassing the standard reset vector, which would
 *      drop you in the menu-driven UI mode).
 *   3. Run until the test program parks itself in a tight infinite loop.
 *
 * Pass criteria:
 *   $0002 == 0  — official-opcode subtest result code (0 = all pass).
 *   $0003 == 0  — illegal-opcode  subtest result code (0 = all pass).
 *
 * Any non-zero value is a documented error code. The full table lives in
 * nestest.txt that ships with the ROM (see nesdev.org). We surface the raw
 * hex bytes on failure so the user can look the code up.
 *
 * Reference: https://www.nesdev.org/wiki/Emulator_tests#nestest
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Nes } from '../../src/console/nes';
import { testRomPath } from '../rom-paths';

const ROM_PATH = testRomPath('nestest.nes');
const HAS_ROM = existsSync(ROM_PATH);

describe.skipIf(!HAS_ROM)('nestest.nes', () => {
  it('passes the auto-mode CPU self-test (official + illegal opcodes)', () => {
    const data = new Uint8Array(readFileSync(ROM_PATH));
    const nes = new Nes();
    nes.loadRom(data);

    // Bypass the menu by jumping directly into the auto-test entry.
    nes.cpu.pc = 0xc000;

    // Sanity: the ROM should start its auto path with `JMP $C5F5` (4C F5 C5).
    expect(nes.cpuBus.read(0xc000)).toBe(0x4c);
    expect(nes.cpuBus.read(0xc001)).toBe(0xf5);
    expect(nes.cpuBus.read(0xc002)).toBe(0xc5);

    // Canonical run: ~8991 instructions / ~26554 cycles. Run plenty more so
    // we land inside the trailing infinite-loop and capture the final state.
    for (let i = 0; i < 50_000; i++) nes.cpu.step();

    const official = nes.cpuBus.read(0x0002);
    const illegal = nes.cpuBus.read(0x0003);

    if (official !== 0 || illegal !== 0) {
      // Surface enough state to diagnose without re-running.
      const last = `PC=$${nes.cpu.pc.toString(16).toUpperCase().padStart(4, '0')}` +
        ` A=$${nes.cpu.a.toString(16).toUpperCase().padStart(2, '0')}` +
        ` X=$${nes.cpu.x.toString(16).toUpperCase().padStart(2, '0')}` +
        ` Y=$${nes.cpu.y.toString(16).toUpperCase().padStart(2, '0')}` +
        ` P=$${nes.cpu.p.toString(16).toUpperCase().padStart(2, '0')}` +
        ` SP=$${nes.cpu.sp.toString(16).toUpperCase().padStart(2, '0')}`;
      throw new Error(
        `nestest reported errors: $0002=$${official.toString(16).toUpperCase().padStart(2, '0')} ` +
          `$0003=$${illegal.toString(16).toUpperCase().padStart(2, '0')} (${last})`,
      );
    }

    expect(official).toBe(0);
    expect(illegal).toBe(0);
  });
});
