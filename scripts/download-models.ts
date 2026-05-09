/**
 * Fetch every entry from `scripts/models-manifest.json` into
 * `public/models/<filename>`. Idempotent — skips downloads that
 * already match the manifest's `expectedSize` / `sha256`.
 *
 * Vite serves anything in `public/` at the root, so a model at
 * `public/models/realesrgan-x4-anime.onnx` is reachable at
 * `/models/realesrgan-x4-anime.onnx` in dev + prod. The registry's
 * ESRGAN factory hardcodes that path, so the user doesn't have to
 * paste URLs.
 *
 * Usage:
 *
 *   npm run setup:models             # fetch missing models
 *   npm run setup:models -- --force  # re-download even if cached
 *
 * The deploy workflow runs this before `npm run build` so the public
 * site ships with the model files inside `dist/models/`.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

interface ManifestEntry {
  id: string;
  filename: string;
  url: string;
  expectedSize: number | null;
  sha256: string | null;
  description?: string;
}

interface Manifest {
  version: number;
  models: ManifestEntry[];
}

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'models-manifest.json');
const TARGET_DIR = path.join(REPO_ROOT, 'public', 'models');

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

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Manifest;
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error('models-manifest.json is malformed (no `models` array)');
  }
  return parsed;
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function sha256OfFile(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * True when the target file matches the manifest's expectations
 * (size + optional sha256). Used to skip re-downloads.
 */
async function isFileSatisfied(targetPath: string, entry: ManifestEntry): Promise<boolean> {
  if (!existsSync(targetPath)) return false;
  const st = statSync(targetPath);
  if (entry.expectedSize !== null && st.size !== entry.expectedSize) return false;
  if (entry.sha256) {
    const got = await sha256OfFile(targetPath);
    if (got.toLowerCase() !== entry.sha256.toLowerCase()) return false;
  }
  return true;
}

async function downloadEntry(entry: ManifestEntry, force: boolean): Promise<void> {
  const targetPath = path.join(TARGET_DIR, entry.filename);
  const tmpPath = targetPath + '.partial';

  // Manual-install short-circuit: if the file is already present (e.g.
  // the user dropped it in by hand) and matches expectations, we're
  // done — no fetch needed.
  if (!force && await isFileSatisfied(targetPath, entry)) {
    logLine(`✓ ${entry.filename} — already present (${bytesHuman(statSync(targetPath).size)}); skipping.`);
    return;
  }

  // No URL configured (or marked placeholder) → tell the user how to
  // install manually instead of trying to fetch nothing.
  if (!entry.url || entry.url.length === 0 || entry.url === 'PLACEHOLDER') {
    throw new Error(
      `no URL configured for ${entry.filename}. ` +
      `Either edit scripts/models-manifest.json with a working URL, ` +
      `or drop the file at public/models/${entry.filename} manually.`,
    );
  }

  logLine(`↓ ${entry.filename}`);
  logLine(`    from: ${entry.url}`);

  let resp: Response;
  try {
    resp = await fetch(entry.url);
  } catch (err) {
    throw new Error(
      `network error fetching ${entry.url} — ${(err as Error).message}. ` +
      `If the URL is gated/auth-required or stale, edit scripts/models-manifest.json ` +
      `or drop the file at public/models/${entry.filename} manually.`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `HTTP ${resp.status} fetching ${entry.url}. ` +
      `If the URL is gated/auth-required or stale, edit scripts/models-manifest.json ` +
      `or drop the file at public/models/${entry.filename} manually.`,
    );
  }
  const total = parseInt(resp.headers.get('content-length') ?? '0', 10) || null;
  if (!resp.body) {
    throw new Error(`no response body for ${entry.url}`);
  }

  // Stream to a `.partial` file with progress reporting; rename on success.
  let received = 0;
  let lastReported = 0;
  const out = createWriteStream(tmpPath);
  const reader = resp.body.getReader();
  const reportProgress = (final = false): void => {
    if (!total) {
      if (final || received - lastReported > 1024 * 1024) {
        process.stdout.write(`\r    ${bytesHuman(received)}…`);
        lastReported = received;
      }
      return;
    }
    const pct = Math.floor((received / total) * 100);
    if (final || pct !== Math.floor((lastReported / total) * 100)) {
      process.stdout.write(`\r    ${pct}% — ${bytesHuman(received)} / ${bytesHuman(total)}   `);
      lastReported = received;
    }
  };

  try {
    // Drain the WHATWG ReadableStream into the Node write stream.
    await pipeline(
      Readable.from((async function* () {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          reportProgress();
          yield Buffer.from(value);
        }
      })()),
      out,
    );
    reportProgress(true);
    process.stdout.write('\n');
  } catch (err) {
    // Clean up partial file before rethrowing.
    try { await unlink(tmpPath); } catch { /* swallow */ }
    throw err;
  }

  // Verify before promoting the partial file.
  if (entry.expectedSize !== null) {
    const st = statSync(tmpPath);
    if (st.size !== entry.expectedSize) {
      await unlink(tmpPath);
      throw new Error(
        `size mismatch for ${entry.filename}: got ${st.size}, expected ${entry.expectedSize}`,
      );
    }
  }
  if (entry.sha256) {
    const got = await sha256OfFile(tmpPath);
    if (got.toLowerCase() !== entry.sha256.toLowerCase()) {
      await unlink(tmpPath);
      throw new Error(
        `sha256 mismatch for ${entry.filename}: got ${got}, expected ${entry.sha256}`,
      );
    }
  }

  await rename(tmpPath, targetPath);
  logLine(`✓ wrote ${path.relative(REPO_ROOT, targetPath)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('-f');

  const manifest = await loadManifest();
  await mkdir(TARGET_DIR, { recursive: true });

  logHeader(`Poncho model downloader — ${manifest.models.length} entry/entries`);

  let okCount = 0;
  let failCount = 0;
  for (const entry of manifest.models) {
    try {
      await downloadEntry(entry, force);
      okCount++;
    } catch (err) {
      logErr(`${entry.filename}: ${(err as Error).message}`);
      failCount++;
    }
  }

  logLine('');
  logLine(`Done. ${okCount} ok, ${failCount} failed. Files in ${path.relative(REPO_ROOT, TARGET_DIR)}/`);
  if (failCount > 0) process.exit(1);
}

void main().catch((err) => {
  logErr((err as Error).message);
  process.exit(2);
});
