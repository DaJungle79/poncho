/**
 * Smoke test for the background rendering pipeline (Phase 4a).
 *
 * Loads nestest.nes (always present in CI for the CPU test), runs enough
 * frames for it to display its result screen, and asserts the framebuffer
 * has non-trivial content: multiple distinct colors and a meaningful
 * fraction of non-background pixels. This catches regressions where the
 * rendering goes black / monochrome / stuck on a constant pattern.
 *
 * Sprites and sprite-0 hit are still pending, so we don't assert on
 * specific pixel values — just that the pipeline produced *something*.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Nes } from '../../src/core/nes';
import { testRomPath } from '../rom-paths';

const ROM_PATH = testRomPath('nestest.nes');

describe.skipIf(!existsSync(ROM_PATH))('background rendering smoke test', () => {
  it('produces a varied framebuffer after running nestest for 60 frames', () => {
    const nes = new Nes();
    nes.loadRom(new Uint8Array(readFileSync(ROM_PATH)));
    for (let i = 0; i < 60; i++) nes.runFrame();

    const fb = nes.ppu.framebuffer.data;
    const colors = new Set<number>();
    let nonBg = 0;
    const bg = fb[0];
    for (let i = 0; i < fb.length; i++) {
      colors.add(fb[i]);
      if (fb[i] !== bg) nonBg++;
    }

    // We rendered text on a background. There must be at least 2 colors,
    // and meaningful fraction of pixels need to differ from the background.
    expect(colors.size).toBeGreaterThanOrEqual(2);
    expect(nonBg).toBeGreaterThan(500);
    expect(nonBg).toBeLessThan(fb.length); // not the entire screen
  });
});
