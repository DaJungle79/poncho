/**
 * End-to-end bake test — produces a loadable `.poncho` for every
 * iNES file under `roms/` that has a fixture entry below. Picks the
 * right pipeline per cart type:
 *
 *   - **CHR-ROM** carts → `convertInesToPonchoAi` with the
 *     deterministic `MockUpscaleClient` (NN fallback). The output
 *     ships with a populated AI cache section.
 *   - **CHR-RAM** carts → plain `convertInesToPoncho` (no AI bake;
 *     the runtime worker fills the AI cache lazily during play).
 *
 * Output lands at `tmp/<basename>.poncho`. Drag-drop into "ROMs
 * panel → Upload" or copy into IndexedDB via the dev tools to load
 * directly. Practical use: when the browser UI is misbehaving with
 * the ESRGAN client, this test bypasses the UI entirely.
 *
 * Each fixture is tested independently — `skipIf(!existsSync(...))`
 * keeps CI green when a `.nes` isn't checked in (which is most of
 * them — `roms/` is gitignored).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PonchoCartridge } from '../../src/core/cart-poncho/cartridge';
import { parsePonchoRom } from '../../src/core/cart-poncho/header';
import { convertInesToPoncho } from '../../src/convert/ines-to-poncho';
import { convertInesToPonchoAi } from '../../src/convert/ines-to-poncho-ai';
import { MockUpscaleClient } from '../../src/convert/upscale-client';

const REPO_ROOT = process.cwd();
const ROMS_DIR = path.join(REPO_ROOT, 'roms');
const OUT_DIR = path.join(REPO_ROOT, 'tmp');

interface BakeFixture {
  /** Filename inside `roms/`. */
  source: string;
  /** Output filename inside `tmp/`. */
  output: string;
  /** Title written into the .poncho header. */
  title: string;
  /** Expected mapper id from the source iNES (sanity check). */
  expectedMapper: number;
}

const FIXTURES: readonly BakeFixture[] = [
  {
    source: 'Mighty Bomb Jack (E) [!].nes',
    output: 'mighty-bomb-jack.poncho',
    title: 'Mighty Bomb Jack',
    expectedMapper: 3, // CNROM
  },
  {
    source: 'Contra (USA).nes',
    output: 'contra.poncho',
    title: 'Contra',
    expectedMapper: 2, // UxROM
  },
  {
    source: 'Battletoads (USA)(1).nes',
    output: 'battletoads.poncho',
    title: 'Battletoads',
    expectedMapper: 7, // AxROM
  },
  {
    source: 'Double Dragon II - The Revenge (Europe).nes',
    output: 'double-dragon-2.poncho',
    title: 'Double Dragon II',
    expectedMapper: 4, // MMC3
  },
  // Drop a `Bomberman.nes` (or any other iNES file) into `roms/` and
  // append an entry here to bake it via this test. The fixture is
  // skipped whenever the source file isn't present.
  {
    source: 'Bomberman (USA).nes',
    output: 'bomberman.poncho',
    title: 'Bomberman',
    expectedMapper: 0, // NROM (Hudson Soft 1985)
  },
];

describe('Bake .nes → .poncho via NN fallback (loadable in the web UI)', () => {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const fix of FIXTURES) {
    const srcPath = path.join(ROMS_DIR, fix.source);

    it.skipIf(!existsSync(srcPath))(
      `${fix.source} → tmp/${fix.output}`,
      async () => {
        const inesBytes = new Uint8Array(readFileSync(srcPath));
        // iNES byte 5 = CHR-ROM bank count. 0 means CHR-RAM (no CHR
        // bytes in the file; PRG uploads tiles at runtime).
        const isChrRam = inesBytes[5] === 0;

        let outBytes: Uint8Array;
        let summary: string;
        if (isChrRam) {
          // CHR-RAM cartridges can't be baked at conversion time —
          // tiles aren't known until PRG runs. The plain converter
          // produces an upscaled-mode `.poncho` whose AI cache fills
          // during play.
          const result = convertInesToPoncho(inesBytes, { title: fix.title });
          outBytes = result.poncho;
          summary =
            `${result.notes.chrRamKb} KB CHR-RAM (lazy-baked at runtime), ` +
            `mapper ${result.notes.sourceMapper}`;

          const layout = parsePonchoRom(outBytes);
          expect(layout.header.flags.upscaledMode).toBe(true);
          // CHR-RAM carts ship without an AI cache section — runtime fills it.
          expect(layout.header.flags.aiCachePresent).toBe(false);
          expect(layout.header.title).toBe(fix.title);
          expect(result.notes.sourceMapper).toBe(fix.expectedMapper);
        } else {
          // CHR-ROM cartridges go through the bake-now AI pipeline
          // with the deterministic NN fallback client. No async
          // surprises, no network — predictable runtime.
          const result = await convertInesToPonchoAi(inesBytes, {
            title: fix.title,
            client: new MockUpscaleClient(),
          });
          outBytes = result.poncho;
          summary =
            `${result.notes.chrKb} KB CHR-ROM, ${result.notes.uniqueTiles} ` +
            `unique tiles AI-baked, mapper ${result.notes.sourceMapper}`;

          const layout = parsePonchoRom(outBytes);
          expect(layout.header.flags.upscaledMode).toBe(true);
          expect(layout.header.flags.aiCachePresent).toBe(true);
          expect(layout.header.title).toBe(fix.title);

          const cart = new PonchoCartridge(outBytes);
          expect(cart.aiCache).not.toBeNull();
          expect(cart.aiCache!.entries.length).toBe(result.notes.uniqueTiles);
          expect(result.notes.sourceMapper).toBe(fix.expectedMapper);
        }

        // Write to disk so the user can drag-drop into the browser
        // (ROMs panel → Upload .poncho).
        const outPath = path.join(OUT_DIR, fix.output);
        writeFileSync(outPath, outBytes);

        // eslint-disable-next-line no-console
        console.log(
          `\n  ✓ ${fix.source}\n` +
          `      → ${path.relative(REPO_ROOT, outPath)}  ` +
          `(${(outBytes.byteLength / 1024).toFixed(1)} KB; ${summary})\n`,
        );
      },
      120_000, // 2-min timeout — large MMC3 carts dedup ~1500 tiles.
    );
  }
});
