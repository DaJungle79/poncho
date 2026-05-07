/**
 * iNES → PonchoROM CLI.
 *
 * Usage:
 *   npm run poncho:convert -- <input.nes> [output.poncho] [--title "Game Name"]
 *
 * If no output path is given, the converter writes
 * `<input-without-ext>.poncho` next to the input file.
 *
 * The conversion logic is in `scripts/lib/ines-to-poncho.ts` so it can
 * also be called programmatically from other scripts / tests.
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import { ConvertError, convertInesToPoncho } from './lib/ines-to-poncho';

interface CliArgs {
  input: string;
  output: string;
  title: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let title: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--title') {
      const next = argv[i + 1];
      if (next === undefined) usageAndExit('--title needs a value');
      title = next;
      i++;
    } else if (arg.startsWith('--title=')) {
      title = arg.slice('--title='.length);
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
  return { input, output, title };
}

function usageAndExit(reason: string | null): never {
  if (reason) console.error(`error: ${reason}\n`);
  console.error(
    'Usage: npm run poncho:convert -- <input.nes> [output.poncho] [--title "Name"]',
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

function main(): void {
  const { input, output, title } = parseArgs(process.argv.slice(2));

  let inesBytes: Uint8Array;
  try {
    inesBytes = new Uint8Array(readFileSync(input));
  } catch (err) {
    console.error(`Failed to read input: ${(err as Error).message}`);
    process.exit(1);
  }

  const finalTitle = title ?? defaultTitleFromFilename(input);

  let result;
  try {
    result = convertInesToPoncho(inesBytes, { title: finalTitle });
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
  console.log(`✓ ${input}`);
  console.log(`  → ${output}  (${formatBytes(outSize)})`);
  console.log(`  title:           ${finalTitle || '(empty)'}`);
  console.log(`  source mapper:   ${notes.sourceMapper} (NROM)`);
  console.log(`  source mirror:   ${notes.sourceMirroring}`);
  console.log(`  battery save:    ${notes.hasBattery ? 'yes (not preserved)' : 'no'}`);
  console.log(`  PRG:             ${notes.prgKb} KB (verbatim)`);
  console.log(
    `  CHR:             ${notes.chrKbSource} KB → ${notes.chrKbExpanded} KB ` +
    `(${(notes.chrKbExpanded / notes.chrKbSource).toFixed(0)}× expansion)`,
  );
  console.log(`  master palette:  ${notes.paletteEntries} entries (NES canonical)`);
  for (const w of notes.warnings) console.log(`  ! ${w}`);
}

main();
