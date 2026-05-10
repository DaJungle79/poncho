/**
 * iNES → PonchoROM CLI.
 *
 * Usage:
 *   npm run poncho:convert -- <input.nes> [output.poncho] [--title "Game Name"] [--ai] [--model <id>] [--model-path <file>]
 *
 * If no output path is given, the converter writes
 * `<input-without-ext>.poncho` next to the input file.
 *
 * `--ai` switches on the AI bake-now pipeline (`convertInesToPonchoAi`).
 * Without `--model`, the bake uses the deterministic NN fallback
 * (`MockUpscaleClient`).
 *
 * `--model <id>` selects a registered upscale model. Available:
 *   - `nearest-neighbour` (default; same as `--ai` alone)
 *   - `Real-ESRGAN-x4plus` — 128→512 generic photo upscaler. Heavy
 *     (64 MB, ~60 ms/tile on CoreML), produces near-identity output
 *     on pixel-art primer.
 *   - `4x-spanx4-ch48` — tiny SPAN x4 super-res network. 8→32 fp32,
 *     ~1.4 ms/tile on CPU. External-data weights in `<file>.onnx.data`
 *     sidecar — keep both files in `public/models/`. Direct fit for
 *     Poncho's NES tile shape (8×8 → 32×32).
 *
 * Local CLI only — Node ORT (CoreML on macOS, CPU fallback). The
 * browser path goes through `onnxruntime-web`.
 *
 * `--model-path <file>` overrides the ONNX file location (defaults to
 * `public/models/<id>.onnx`).
 *
 * The conversion logic is in `scripts/lib/ines-to-poncho.ts` so it can
 * also be called programmatically from other scripts / tests.
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import {
  AI_CACHE_MODEL_ESRGAN_X4_PLUS,
  AI_CACHE_MODEL_SPAN_X4_CH48,
} from '../src/core/cart-poncho/ai-cache';
import {
  ConvertError,
  MockUpscaleClient,
  OnnxUpscaleClient,
  ESRGAN_X4_PLUS_MODEL_URL,
  bankingVariantName,
  convertInesToPoncho,
  convertInesToPonchoAi,
  type UpscaleClient,
} from './lib/ines-to-poncho';
import { createNodeOrtFactory } from './lib/node-ort-factory';

interface CliArgs {
  input: string;
  output: string;
  title: string | undefined;
  ai: boolean;
  modelId: string;
  modelPath: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let title: string | undefined;
  let ai = false;
  let modelId = 'nearest-neighbour';
  let modelPath: string | undefined;
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
    } else if (arg === '--model') {
      const next = argv[i + 1];
      if (next === undefined) usageAndExit('--model needs a value');
      modelId = next;
      ai = true;
      i++;
    } else if (arg.startsWith('--model=')) {
      modelId = arg.slice('--model='.length);
      ai = true;
    } else if (arg === '--model-path') {
      const next = argv[i + 1];
      if (next === undefined) usageAndExit('--model-path needs a value');
      modelPath = resolve(next);
      i++;
    } else if (arg.startsWith('--model-path=')) {
      modelPath = resolve(arg.slice('--model-path='.length));
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
  return { input, output, title, ai, modelId, modelPath };
}

function usageAndExit(reason: string | null): never {
  if (reason) console.error(`error: ${reason}\n`);
  console.error(
    'Usage: npm run poncho:convert -- <input.nes> [output.poncho] [--title "Name"] [--ai] [--model <id>] [--model-path <file>]',
  );
  process.exit(reason ? 2 : 0);
}

/**
 * Build the upscale client for the requested model id. Defaults to
 * `MockUpscaleClient`. `Real-ESRGAN-x4plus` constructs a Node-side
 * `OnnxUpscaleClient` that reads the ONNX file directly off disk
 * (no fetch).
 */
async function buildClient(modelId: string, modelPath: string | undefined): Promise<UpscaleClient> {
  if (modelId === 'nearest-neighbour') {
    return new MockUpscaleClient();
  }
  if (modelId === 'Real-ESRGAN-x4plus') {
    return buildOnnxClient(
      modelPath ?? resolve(process.cwd(), 'public/models/Real-ESRGAN-x4plus.onnx'),
      AI_CACHE_MODEL_ESRGAN_X4_PLUS,
      {
        // 128×128 fp32 RGB → 512×512 fp32 RGB. The 512 output is
        // box-filtered down to 32×32 inside the client.
        input: { size: 128, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'image' },
        output: { size: 512, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
    );
  }
  if (modelId === '4x-spanx4-ch48') {
    return buildOnnxClient(
      modelPath ?? resolve(process.cwd(), 'public/models/4x-spanx4-ch48.onnx'),
      AI_CACHE_MODEL_SPAN_X4_CH48,
      {
        // 8×8 fp32 RGB → 32×32 fp32 RGB. Native fit — no downscale.
        // SPAN is a tiny pixel-art-friendly super-res network; the
        // 8×8 → 32×32 path matches Poncho's NES tile shape exactly.
        // Model has external-data sidecar (`.onnx.data`); see
        // `loadByPath` flag below.
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'input' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'output' },
      },
      // Path-based load required: ORT-Node resolves the `.onnx.data`
      // sidecar relative to the model file's directory. Loading from
      // bytes drops the path → ORT errors with `model_path must not
      // be empty` during graph optimization.
      { loadByPath: true, executionProviders: ['cpu'] },
    );
  }
  throw new Error(
    `Unknown --model "${modelId}". Try: nearest-neighbour, Real-ESRGAN-x4plus, 4x-spanx4-ch48`,
  );
}

interface BuildClientOptions {
  /** Pass the file path to ORT (vs. pre-loading bytes). Required for models with external-data sidecars. */
  loadByPath?: boolean;
  /** Override the default `['coreml', 'cpu']` provider order. */
  executionProviders?: string[];
}

function buildOnnxClient(
  onnxPath: string,
  cacheModelId: number,
  spec: { input: import('../src/convert/clients/onnx-upscale-client').OnnxModelInputSpec; output: import('../src/convert/clients/onnx-upscale-client').OnnxModelOutputSpec },
  buildOpts: BuildClientOptions = {},
): UpscaleClient {
  if (!existsSync(onnxPath)) {
    throw new Error(
      `Model file not found at ${onnxPath}. Drop the .onnx into public/models/ ` +
      'or pass --model-path <file>.',
    );
  }
  const providers = buildOpts.executionProviders ?? ['coreml', 'cpu'];
  const cfg = {
    modelId: cacheModelId,
    modelUrl: onnxPath,
    executionProviders: providers,
    input: spec.input,
    output: spec.output,
  };
  if (buildOpts.loadByPath) {
    // No modelLoader → OnnxUpscaleClient calls
    // `InferenceSession.create(modelUrl, ...)` and ORT resolves any
    // external-data sidecar relative to the path.
    return new OnnxUpscaleClient(cfg, { ortFactory: createNodeOrtFactory });
  }
  // Pre-load bytes (smaller models without external data).
  const bytes = new Uint8Array(readFileSync(onnxPath));
  return new OnnxUpscaleClient(cfg, {
    ortFactory: createNodeOrtFactory,
    modelLoader: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
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
  const { input, output, title, ai, modelId, modelPath } = parseArgs(process.argv.slice(2));

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
      const client = await buildClient(modelId, modelPath);
      console.log(`  upscale model:   ${modelId}${modelId !== 'nearest-neighbour' ? ' (Node ORT)' : ''}`);
      const startMs = Date.now();
      let lastDone = -1;
      const aiResult = await convertInesToPonchoAi(inesBytes, {
        title: finalTitle,
        client,
        onProgress: (p) => {
          if (p.total === 0 || p.done === lastDone) return;
          lastDone = p.done;
          const pct = Math.floor((p.done / p.total) * 100);
          const elapsedSec = (Date.now() - startMs) / 1000;
          const perTile = p.done > 0 ? elapsedSec / p.done : 0;
          const etaSec = perTile * (p.total - p.done);
          const etaMin = Math.floor(etaSec / 60);
          const etaS = Math.floor(etaSec % 60);
          process.stderr.write(
            `  upscale: ${pct}% (${p.done}/${p.total}) · ` +
            `${perTile.toFixed(2)}s/tile · ` +
            `eta ${etaMin}m${String(etaS).padStart(2, '0')}s\r`,
          );
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
