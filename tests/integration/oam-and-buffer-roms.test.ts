/**
 * Newer blargg PPU/OAM tests that DO use the standard $6000 protocol.
 * Run via the existing blargg runner; assertions snapshot today's verdict.
 *
 *   oam_read.nes        — PASS
 *   oam_stress.nes      — PASS
 *   ppu_read_buffer.nes — FAIL $13 (test combining sprite-0 + DMA + mirroring)
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

const specs: Spec[] = [
  { rom: 'oam_read.nes',        expectedCode: 0x00 },
  { rom: 'oam_stress.nes',      expectedCode: 0x00 },
  { rom: 'ppu_read_buffer.nes', expectedCode: 0x13 },
];

for (const { rom, expectedCode } of specs) {
  const romPath = testRomPath(rom);
  describe.skipIf(!existsSync(romPath))(`blargg ${rom}`, () => {
    it(`reports code $${expectedCode.toString(16).padStart(2, '0')}`, () => {
      // 30M steps for oam_stress; the others finish in well under that.
      const result = runBlarggRom(romPath, { maxSteps: 30_000_000 });
      expect(result.timedOut).toBe(false);
      expect(result.signatureValid).toBe(true);
      expect(result.code).toBe(expectedCode);
    });
  });
}
