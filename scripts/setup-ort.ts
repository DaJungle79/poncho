/**
 * Copy `onnxruntime-web`'s WASM runtime files into `public/ort/` so
 * Vite serves them at `/ort/*` in both dev and production. The
 * `OnnxUpscaleClient` configures `ort.env.wasm.wasmPaths = '/ort/'`
 * before creating a session, which routes the runtime's loader to
 * these copies.
 *
 * Why this is needed:
 *   - In dev, Vite pre-bundles `onnxruntime-web`. The pre-bundled
 *     code uses `import.meta.url` to resolve sibling WASM files,
 *     but the path lands inside Vite's dep cache where the `.wasm`
 *     files don't exist → fetch returns the dev server's HTML 404
 *     fallback → "Incorrect response MIME type. Expected
 *     'application/wasm'" + "expected magic word 00 61 73 6d, found
 *     3c 21 64 6f" (= `<!do…`, an HTML doc).
 *   - In production, Vite bundles the WASM as a separate asset, but
 *     the resolved URL is build-hashed and not what ORT's runtime
 *     loader expects.
 *
 * Putting the files at a stable `/ort/` URL sidesteps both. They're
 * served from `public/ort/` (gitignored), idempotently copied here
 * by `npm run setup:ort` (or `npm run setup` to also fetch models).
 *
 * Run: npm run setup:ort
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const SRC_DIR = path.join(REPO_ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const OUT_DIR = path.join(REPO_ROOT, 'public', 'ort');

/**
 * Only the `.wasm` binaries — NOT the `.mjs` loaders. We import
 * `onnxruntime-web` via the package's default export, which resolves
 * to `ort.bundle.min.mjs` (per the package.json `exports` field) —
 * a fully-bundled variant where the JSEP `.mjs` is inlined. Only the
 * `.wasm` files are external; ORT fetches them from `wasmPaths` at
 * runtime.
 *
 * If we copied the `.mjs` files into `public/ort/` too, Vite would
 * intercept their import (Vite refuses to module-import files placed
 * in `public/` because those are static-serve-only by convention).
 * Keeping `.mjs` out of `public/` lets ORT resolve them through its
 * own bundle while still getting the `.wasm` over HTTP from /ort/.
 */
const RUNTIME_ASSET_PATTERNS: ReadonlyArray<RegExp> = [
  /^ort-wasm-simd-threaded\.(jsep|jspi|asyncify)?\.?wasm$/,
];

function logHeader(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n  ${msg}\n`);
}
function logLine(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ${msg}`);
}
function logErr(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`  ! ${msg}`);
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  if (!existsSync(SRC_DIR)) {
    logErr(`onnxruntime-web not installed (${path.relative(REPO_ROOT, SRC_DIR)} missing). Run \`npm install\` first.`);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const all = readdirSync(SRC_DIR);
  const targets = all.filter((name) =>
    RUNTIME_ASSET_PATTERNS.some((re) => re.test(name)),
  );

  if (targets.length === 0) {
    logErr('no ORT runtime assets matched — has the package layout changed?');
    process.exit(2);
  }

  logHeader(`Copying ${targets.length} ORT runtime asset(s) → ${path.relative(REPO_ROOT, OUT_DIR)}/`);

  let totalBytes = 0;
  for (const name of targets) {
    const src = path.join(SRC_DIR, name);
    const dst = path.join(OUT_DIR, name);
    const size = statSync(src).size;
    await copyFile(src, dst);
    totalBytes += size;
    logLine(`✓ ${name}  (${bytesHuman(size)})`);
  }

  logLine('');
  logLine(`Done. ${targets.length} files, ${bytesHuman(totalBytes)} total.`);
}

void main().catch((err) => {
  logErr((err as Error).message);
  process.exit(2);
});
