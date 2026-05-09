/**
 * iNES → PonchoROM CLI.
 *
 * Usage:
 *   npm run poncho:convert -- <input.nes> [output.poncho] [--title "Game Name"] [--ai]
 *
 * If no output path is given, the converter writes
 * `<input-without-ext>.poncho` next to the input file.
 *
 * `--ai` switches on the AI bake-now pipeline (`convertInesToPonchoAi`).
 * The CLI currently always runs through `MockUpscaleClient` (the
 * deterministic 4× nearest-neighbour fallback) — useful as a regression
 * target and so the CLI stays dependency-free. Real models (e.g. local
 * ESRGAN/ONNX on WebGPU) live in the web shell behind the model
 * registry; once a Node-side runner is added, this CLI will read the
 * model id from `--model <id>`.
 *
 * The conversion logic is in `scripts/lib/ines-to-poncho.ts` so it can
 * also be called programmatically from other scripts / tests.
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import {
  ConvertError,
  MockUpscaleClient,
  bankingVariantName,
  convertInesToPoncho,
  convertInesToPonchoAi,
} from './lib/ines-to-poncho';

interface CliArgs {
  input: string;
  output: string;
  title: string | undefined;
  ai: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let title: string | undefined;
  let ai = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--title') {
      const next = argv[i + 1];
      if (next === undefined) usageAndExit('--title needs a value');
      title = next;
      i++;
    } else if (arg.startsWith('--title=')) {
      title = arg.slice('--title='.length);
    } else if (arg === '--ai') {
      ai = true;
    } else if (arg === '--help' || arg === '-h') {
      usageAndExit(null);
    } else if (arg.startsWith('--')) {
      usageAndExit(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length === 0) usageAndExit('Missing <input.nes>');
  if (positional.length > 2)   usageAndExit('Too many positional arguments');

  const input = resolve(positional[0]!);
  const defaultOut = input.replace(/\.nes$/i, '') + '.poncho';
  const output = positional[1] ? resolve(positional[1]) : defaultOut;
  return { input, output, title, ai };
}

function usageAndExit(reason: string | null): never {
  if (reason) console.error(`error: ${reason}\n`);
  console.error(
    'Usage: npm run poncho:convert -- <input.nes> [output.poncho] [--title "Name"] [--ai]',
  );
  process.exit(reason ? 2 : 0);
}

function defaultTitleFromFilename(input: string): string {
  const base = basename(input, extname(input));
  // Strip GoodNES / No-Intro region tags like " (USA)" / " (Japan)".
  const cleaned = base.replace(/\s*\([^)]*\)/g, '').trim();
  return cleaned.slice(0, 32);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  const { input, output, title, ai } = parseArgs(process.argv.slice(2));

  let inesBytes: Uint8Array;
  try {
    inesBytes = new Uint8Array(readFileSync(input));
  } catch (err) {
    console.error(`Failed to read input: ${(err as Error).message}`);
    process.exit(1);
  }

  const finalTitle = title ?? defaultTitleFromFilename(input);

  let result;
  let aiNotes: { uniqueTiles: number; cacheHits: number; apiCalls: number; failedTiles: number } | null = null;
  try {
    if (ai) {
      // CLI defaults to the deterministic 4× fallback. Once a Node-
      // side model runner lands, swap to `createUpscaleClient(modelId,
      // 'rom-bake', config)` from the registry.
      const client = new MockUpscaleClient();
      let lastPct = -1;
      const aiResult = await convertInesToPonchoAi(inesBytes, {
        title: finalTitle,
        client,
        onProgress: (p) => {
          if (p.total === 0) return;
          const pct = Math.floor((p.done / p.total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stderr.write(`  upscale: ${pct}% (${p.done}/${p.total})\r`);
          }
        },
      });
      process.stderr.write('\n');
      result = aiResult;
      aiNotes = {
        uniqueTiles: aiResult.notes.uniqueTiles,
        cacheHits: aiResult.notes.cacheHits,
        apiCalls: aiResult.notes.apiCalls,
        failedTiles: aiResult.notes.failedTiles,
      };
    } else {
      result = convertInesToPoncho(inesBytes, { title: finalTitle });
    }
  } catch (err) {
    if (err instanceof ConvertError) {
      console.error(`Conversion failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  writeFileSync(output, result.poncho);
  const outSize = statSync(output).size;

  const { notes } = result;
  const variantLabel = bankingVariantName(notes.bankingVariant);
  console.log(`✓ ${input}`);
  console.log(`  → ${output}  (${formatBytes(outSize)})`);
  console.log(`  title:           ${finalTitle || '(empty)'}`);
  console.log(`  source mapper:   ${notes.sourceMapper} (${variantLabel})`);
  console.log(`  source mirror:   ${notes.sourceMirroring}`);
  console.log(`  battery save:    ${notes.hasBattery ? 'yes (not preserved)' : 'no'}`);
  console.log(`  PRG:             ${notes.prgKb} KB (verbatim)`);
  if (notes.chrRamKb > 0) {
    console.log(`  CHR:             RAM (${notes.chrRamKb} KB allocated; PRG uploads at runtime)`);
  } else {
    console.log(`  CHR:             ${notes.chrKb} KB${ai ? ' (AI-baked, native mode)' : ' (verbatim)'}`);
  }
  if (aiNotes) {
    console.log(`  AI tiles:        ${aiNotes.uniqueTiles} unique`);
    console.log(`  AI api-calls:    ${aiNotes.apiCalls}`);
    console.log(`  AI cache-hits:   ${aiNotes.cacheHits}`);
    if (aiNotes.failedTiles > 0) {
      console.log(`  AI fallbacks:    ${aiNotes.failedTiles} (NN substituted)`);
    }
  }
  console.log(`  master palette:  ${notes.paletteEntries} entries (NES canonical)`);
  for (const w of notes.warnings) console.log(`  ! ${w}`);
}

void main();
