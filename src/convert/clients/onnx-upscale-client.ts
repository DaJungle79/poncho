/**
 * ONNX-runtime-backed upscale client. Generic enough to drive any
 * image-to-image model whose input/output shapes can be described by
 * a small config — Real-ESRGAN x4 Anime is the first registered user
 * (Phase 5a of v0.4), but the same class works for any later model
 * we register (pixel-art-aware super-res, custom-trained tile
 * networks, etc.) by changing the config blob.
 *
 * Pipeline (steps 2-4, 6 of the per-tile pipeline in v0.4.0-plan.md):
 *
 *   1. (caller's `renderTile32`)             — NES tile → 32×32 RGBA primer
 *   2. preprocessTensor(primer, config)      — RGBA → Float32 tensor in
 *                                               model's expected layout
 *                                               (NCHW / NHWC) and range
 *                                               ([0..1] or [-1..1])
 *   3. session.run({input: tensor})          — ONNX forward pass
 *   4. postprocessTensor(output, config)     — output tensor → 32×32 RGBA
 *   5. (caller / Phase 5b guards)            — silhouette / colour /
 *                                               histogram constraints
 *   6. snapToExtendedPalette(rgba, ext)      — RGBA → pv 0..255 (Phase 4.6)
 *   7. (caller's tile cache)                 — store + write-back
 *
 * The ONNX runtime import is dynamic so the heavy WASM bundle only
 * loads when the model is actually selected. Tests inject a mock
 * runtime factory; production calls `import('onnxruntime-web')`
 * lazily on the first inference.
 *
 * Browser-only by default — `onnxruntime-web` ships WASM + WebGPU
 * backends that require a browser env. CLI tools should use the NN
 * fallback (`MockUpscaleClient`) until a Node-side runner lands.
 */

import { UpscaleClient, UpscaleError } from '../upscale-client';
import {
  EXTENDED_PALETTE_SIZE,
  buildExtendedSubPalette,
  snapToExtendedPalette,
} from '../../runtime/extended-palette';
import { NES_MASTER_PALETTE_RGBA } from '../../core/ppu-ultra/nes-master-palette';

/** What the model expects on its input pin. */
export interface OnnxModelInputSpec {
  /** Side length in pixels of the model's input image. Real-ESRGAN x4 = 8. */
  size: number;
  /** Tensor layout — NCHW most common; NHWC for some pixel-art models. */
  layout: 'nchw' | 'nhwc';
  /** Channel order. RGB for most modern models; BGR for OpenCV-heritage ones. */
  channelOrder: 'rgb' | 'bgr';
  /** Numeric range expected by the model — `[0..1]` is most common. */
  range: '[0..1]' | '[-1..1]';
  /** Pin name in the ONNX graph. Default: `input`. Overridden per model. */
  pinName?: string;
}

/** What the model emits on its output pin. */
export interface OnnxModelOutputSpec {
  /**
   * Side length of the output image, in pixels. May be larger than 32
   * — Real-ESRGAN x4plus, for instance, has a fixed `[1, 3, 512, 512]`
   * output. The client downscales any size > 32 to 32×32 via a box
   * filter before snap-back so the final native tile fits Poncho's
   * 32×32 expectation.
   */
  size: number;
  /** Same layout / channel-order conventions as input. */
  layout: 'nchw' | 'nhwc';
  channelOrder: 'rgb' | 'bgr';
  range: '[0..1]' | '[-1..1]';
  /** Pin name in the ONNX graph. Default: `output`. */
  pinName?: string;
}

export interface OnnxUpscaleClientConfig {
  /** Stable cache id (matches `AI_CACHE_MODEL_*` in `ai-cache.ts`). */
  modelId: number;
  /** Where to load the model from. Required — no default. */
  modelUrl: string;
  /** Execution provider preference order. Default: `['webgpu', 'wasm']`. */
  executionProviders?: string[];
  /** Model I/O shape + format. */
  input: OnnxModelInputSpec;
  output: OnnxModelOutputSpec;
}

/**
 * Minimum-viable ORT facade — subset of `onnxruntime-web`'s API the
 * client actually uses. Tests substitute a mock that satisfies this
 * shape; production wires it to the real runtime via dynamic import.
 */
export interface OrtFacade {
  Tensor: new (
    type: 'float32',
    data: Float32Array,
    dims: readonly number[],
  ) => OrtTensor;
  InferenceSession: {
    /**
     * Mirrors `ort.InferenceSession.create` from `onnxruntime-web`:
     * accepts either a URL string (ORT fetches itself, no caching)
     * or pre-loaded bytes (we use this when a `modelLoader` hook is
     * wired so the platform's cache can intercept the fetch).
     */
    create(
      modelOrBytes: string | Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<OrtSession>;
  };
  /**
   * `ort.env` — runtime config object. We poke `wasm.wasmPaths` to
   * point at `/ort/` so the WASM loader fetches from the dev server's
   * static dir rather than from Vite's pre-bundled deps cache (which
   * doesn't ship the .wasm sidecars). Files land there via
   * `npm run setup:ort` (or `npm run setup`).
   */
  env?: { wasm?: { wasmPaths?: string } };
}

export interface OrtTensor {
  readonly type: string;
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

/** Progress event the loader hook fires while fetching model bytes. */
export interface ModelLoadProgress {
  loaded: number;
  total: number | null;
  fromCache: boolean;
}

/** Hooks exposed for tests + platform plumbing. */
export interface OnnxUpscaleClientHooks {
  /** Inject a custom ORT factory (default: dynamic-import `onnxruntime-web`). */
  ortFactory?: () => Promise<OrtFacade>;
  /**
   * Load model bytes from a URL. Production wires this to the
   * platform's persistent model-asset cache so weights survive page
   * reloads; tests inject a fixed-bytes stub. When unset, the client
   * falls back to a plain `fetch().arrayBuffer()` (no caching).
   */
  modelLoader?: (
    url: string,
    opts?: { signal?: AbortSignal; onProgress?: (p: ModelLoadProgress) => void },
  ) => Promise<ArrayBuffer>;
  /** Optional progress sink — fired during `ensureSession` first load. */
  onModelLoadProgress?: (p: ModelLoadProgress) => void;
}

export class OnnxUpscaleClient implements UpscaleClient {
  readonly modelId: number;
  private readonly cfg: OnnxUpscaleClientConfig;
  private readonly hooks: OnnxUpscaleClientHooks;
  private session: OrtSession | null = null;
  private ort: OrtFacade | null = null;
  private sessionLoad: Promise<OrtSession> | null = null;

  constructor(cfg: OnnxUpscaleClientConfig, hooks: OnnxUpscaleClientHooks = {}) {
    if (!cfg.modelUrl || cfg.modelUrl.trim().length === 0) {
      throw new UpscaleError(
        'OnnxUpscaleClient: modelUrl is required (configure under Settings → AI upscale)',
      );
    }
    if (cfg.output.size < 32 || cfg.output.size % 32 !== 0) {
      throw new UpscaleError(
        `OnnxUpscaleClient: output size must be ≥ 32 and a multiple of 32 ` +
        `(Poncho native tile is 32×32; sizes > 32 are box-filtered down); got ${cfg.output.size}`,
      );
    }
    this.modelId = cfg.modelId;
    this.cfg = cfg;
    this.hooks = hooks;
  }

  async upscaleTile(nesTile: Uint8Array, subPalette: Uint8Array): Promise<Uint8Array> {
    if (nesTile.length !== 16) {
      throw new UpscaleError(`expected 16-byte NES tile, got ${nesTile.length}`);
    }
    if (subPalette.length < 4) {
      throw new UpscaleError(`expected sub-palette of ≥4 bytes, got ${subPalette.length}`);
    }

    const session = await this.ensureSession();

    const primer = renderPrimer(nesTile, subPalette, this.cfg.input.size);
    const inputTensor = preprocessTensor(primer, this.cfg.input, this.ort!);

    const inputName = this.cfg.input.pinName ?? 'input';
    const outputName = this.cfg.output.pinName ?? 'output';

    let results: Record<string, OrtTensor>;
    try {
      results = await session.run({ [inputName]: inputTensor });
    } catch (err) {
      throw new UpscaleError(
        `OnnxUpscaleClient: inference failed — ${(err as Error).message ?? String(err)}`,
      );
    }
    const outputTensor = results[outputName] ?? Object.values(results)[0];
    if (!outputTensor) {
      throw new UpscaleError(
        `OnnxUpscaleClient: model produced no output (expected pin '${outputName}', got ${Object.keys(results).join(', ')})`,
      );
    }

    const rgba = postprocessTensor(outputTensor, this.cfg.output);

    // Models like Real-ESRGAN x4plus emit 512×512 (or any multiple of
    // 32). Box-filter down to 32×32 before snap-back so the rest of
    // the pipeline always sees a 32×32 RGBA buffer.
    const rgba32 = this.cfg.output.size === 32
      ? rgba
      : downscaleToNative(rgba, this.cfg.output.size, 32);

    // Build the extended palette for this sub-palette and snap each
    // output pixel to its closest pv. This step preserves Phase 4.6's
    // back-compat encoding (legacy pv 0..3 + 84-shade ramps for bases
    // 1, 2, 3) so cached tiles render through the new code path.
    const subPalette4 = subPalette.slice(0, 4);
    const ext = buildExtendedSubPalette(
      subPalette4,
      packMasterPaletteForSnap(),
    );
    const out = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) {
      const r = rgba32[i * 4]!;
      const g = rgba32[i * 4 + 1]!;
      const b = rgba32[i * 4 + 2]!;
      out[i] = snapToExtendedPalette(r, g, b, ext);
    }
    return out;
  }

  /**
   * Idempotently load + cache the ONNX session. First call kicks off
   * the dynamic ORT import + remote-model fetch; concurrent callers
   * share the same in-flight Promise. Failures rethrow on every call
   * so the user can retry by re-selecting the model.
   *
   * When `hooks.modelLoader` is configured, the bytes are pre-fetched
   * (via the platform's persistent cache) and passed to ORT as a
   * Uint8Array — keeps weights cached across reloads. Without a
   * loader, ORT fetches the URL itself with no caching.
   */
  private async ensureSession(): Promise<OrtSession> {
    if (this.session) return this.session;
    if (!this.sessionLoad) {
      this.sessionLoad = (async (): Promise<OrtSession> => {
        const factory = this.hooks.ortFactory ?? defaultOrtFactory;
        const ort = await factory();
        this.ort = ort;

        // ORT resolves its `.wasm` + JSEP `.mjs` sidecars via
        // `import.meta.url` relative to its own bundle. Vite's
        // `optimizeDeps.exclude: ['onnxruntime-web']` (set in
        // `vite.config.ts`) keeps ORT loaded as-is from node_modules
        // in dev so this resolution works; in production Vite's asset
        // bundler hashes the WASM into `dist/assets/`. No explicit
        // `wasmPaths` override needed in either mode.

        const providers = this.cfg.executionProviders ?? ['webgpu', 'wasm'];

        let session: OrtSession;
        if (this.hooks.modelLoader) {
          const bytes = await this.hooks.modelLoader(this.cfg.modelUrl, {
            ...(this.hooks.onModelLoadProgress ? { onProgress: this.hooks.onModelLoadProgress } : {}),
          });
          session = await ort.InferenceSession.create(
            new Uint8Array(bytes),
            { executionProviders: providers },
          );
        } else {
          session = await ort.InferenceSession.create(
            this.cfg.modelUrl,
            { executionProviders: providers },
          );
        }
        this.session = session;
        return session;
      })().catch((err) => {
        // Don't pin the failure — let the next call retry.
        this.sessionLoad = null;
        throw new UpscaleError(
          `OnnxUpscaleClient: failed to load model from '${this.cfg.modelUrl}' — ${(err as Error).message ?? String(err)}`,
        );
      });
    }
    return this.sessionLoad;
  }
}

/**
 * Default ORT factory — dynamically imports `onnxruntime-web` at the
 * first call site so the heavy WASM bundle stays out of the main
 * bundle until the user actually selects an ONNX-backed model.
 */
async function defaultOrtFactory(): Promise<OrtFacade> {
  const ort = (await import('onnxruntime-web')) as unknown as OrtFacade;
  return ort;
}

// --------------------------------------------------------------------------
// Pipeline helpers (exported for unit tests + future model implementations)
// --------------------------------------------------------------------------

/**
 * Render an 8×8 NES tile into an `inputSize`×`inputSize` RGBA primer
 * using the supplied sub-palette's actual master colours. When
 * `inputSize > 8`, each NES pixel is nearest-neighbour-expanded so the
 * model "sees" a clean rectangular block per source pixel — same shape
 * as the runtime's existing 4× expansion, just at the model's input
 * resolution.
 */
export function renderPrimer(
  nesTile: Uint8Array,
  subPalette: Uint8Array,
  inputSize: number,
): Uint8Array {
  if (inputSize < 8 || inputSize % 8 !== 0) {
    throw new UpscaleError(
      `renderPrimer: inputSize must be a multiple of 8 (≥ 8), got ${inputSize}`,
    );
  }
  const scale = inputSize / 8;
  const out = new Uint8Array(inputSize * inputSize * 4);
  for (let y = 0; y < 8; y++) {
    const p0 = nesTile[y]!;
    const p1 = nesTile[y + 8]!;
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      const pv = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1);
      const masterIdx = (subPalette[pv]! & 0x3f) * 4;
      const r = NES_MASTER_PALETTE_RGBA[masterIdx]!;
      const g = NES_MASTER_PALETTE_RGBA[masterIdx + 1]!;
      const b = NES_MASTER_PALETTE_RGBA[masterIdx + 2]!;
      const a = NES_MASTER_PALETTE_RGBA[masterIdx + 3]!;
      const dy0 = y * scale;
      const dx0 = x * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((dy0 + dy) * inputSize + (dx0 + dx)) * 4;
          out[idx] = r;
          out[idx + 1] = g;
          out[idx + 2] = b;
          out[idx + 3] = a;
        }
      }
    }
  }
  return out;
}

/** RGBA primer (size×size×4) → Float32 tensor with the model's expected shape. */
export function preprocessTensor(
  primer: Uint8Array,
  spec: OnnxModelInputSpec,
  ort: OrtFacade,
): OrtTensor {
  const n = spec.size;
  const data = new Float32Array(3 * n * n);
  const norm = spec.range === '[0..1]'
    ? (v: number) => v / 255
    : (v: number) => (v / 127.5) - 1;
  // Channel index after BGR swap (if any).
  const swapBgr = spec.channelOrder === 'bgr';

  // For NCHW: data[c, y, x] = data[c*N*N + y*N + x]
  // For NHWC: data[y, x, c] = data[y*N*C + x*C + c]
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const src = (y * n + x) * 4;
      let r = primer[src]!;
      let g = primer[src + 1]!;
      let b = primer[src + 2]!;
      if (swapBgr) { const t = r; r = b; b = t; }
      const fr = norm(r), fg = norm(g), fb = norm(b);
      if (spec.layout === 'nchw') {
        data[0 * n * n + y * n + x] = fr;
        data[1 * n * n + y * n + x] = fg;
        data[2 * n * n + y * n + x] = fb;
      } else {
        data[(y * n + x) * 3 + 0] = fr;
        data[(y * n + x) * 3 + 1] = fg;
        data[(y * n + x) * 3 + 2] = fb;
      }
    }
  }

  const dims: readonly number[] = spec.layout === 'nchw'
    ? [1, 3, n, n]
    : [1, n, n, 3];
  return new ort.Tensor('float32', data, dims);
}

/** Output Float32 tensor → 32×32 RGBA buffer ready for snap-back. */
export function postprocessTensor(
  output: OrtTensor,
  spec: OnnxModelOutputSpec,
): Uint8Array {
  if (output.type !== 'float32') {
    throw new UpscaleError(
      `postprocessTensor: expected float32 output tensor, got '${output.type}'`,
    );
  }
  const n = spec.size;
  const expectedLen = 3 * n * n;
  if (output.data.length !== expectedLen) {
    throw new UpscaleError(
      `postprocessTensor: tensor length ${output.data.length} ≠ expected ${expectedLen} for ${spec.layout} ${n}×${n}×3`,
    );
  }

  const denorm = spec.range === '[0..1]'
    ? (v: number) => v * 255
    : (v: number) => (v + 1) * 127.5;
  const swapBgr = spec.channelOrder === 'bgr';

  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r: number, g: number, b: number;
      if (spec.layout === 'nchw') {
        r = denorm(output.data[0 * n * n + y * n + x]!);
        g = denorm(output.data[1 * n * n + y * n + x]!);
        b = denorm(output.data[2 * n * n + y * n + x]!);
      } else {
        r = denorm(output.data[(y * n + x) * 3 + 0]!);
        g = denorm(output.data[(y * n + x) * 3 + 1]!);
        b = denorm(output.data[(y * n + x) * 3 + 2]!);
      }
      if (swapBgr) { const t = r; r = b; b = t; }
      const dst = (y * n + x) * 4;
      rgba[dst]     = clamp255(r);
      rgba[dst + 1] = clamp255(g);
      rgba[dst + 2] = clamp255(b);
      rgba[dst + 3] = 255;
    }
  }
  return rgba;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Box-filter (area-average) `srcSize×srcSize` RGBA buffer down to
 * `dstSize×dstSize`. `srcSize` must be a multiple of `dstSize`. Used
 * to fit Real-ESRGAN-style 4×-of-128 (= 512) output into Poncho's
 * 32×32 native tile shape; cheaper + free of ringing artefacts vs
 * Lanczos / bicubic, and fine for snap-back which discretises to
 * 256 colours anyway.
 *
 * Exported for tests.
 */
export function downscaleToNative(
  src: Uint8Array,
  srcSize: number,
  dstSize: number,
): Uint8Array {
  if (srcSize % dstSize !== 0) {
    throw new UpscaleError(
      `downscaleToNative: srcSize ${srcSize} is not a multiple of dstSize ${dstSize}`,
    );
  }
  const block = srcSize / dstSize;
  const blockArea = block * block;
  const out = new Uint8Array(dstSize * dstSize * 4);
  for (let oy = 0; oy < dstSize; oy++) {
    for (let ox = 0; ox < dstSize; ox++) {
      let sumR = 0, sumG = 0, sumB = 0;
      for (let dy = 0; dy < block; dy++) {
        const sy = oy * block + dy;
        for (let dx = 0; dx < block; dx++) {
          const sx = ox * block + dx;
          const idx = (sy * srcSize + sx) * 4;
          sumR += src[idx]!;
          sumG += src[idx + 1]!;
          sumB += src[idx + 2]!;
        }
      }
      const dst = (oy * dstSize + ox) * 4;
      out[dst]     = (sumR / blockArea) | 0;
      out[dst + 1] = (sumG / blockArea) | 0;
      out[dst + 2] = (sumB / blockArea) | 0;
      out[dst + 3] = 0xff;
    }
  }
  return out;
}

/**
 * `buildExtendedSubPalette` expects a `Uint32Array` of ABGR-packed
 * master entries (PpuUltra's internal layout). The cartridge palette
 * is byte-major RGBA. Pack once + cache.
 */
let cachedMasterPacked: Uint32Array | null = null;
function packMasterPaletteForSnap(): Uint32Array {
  if (cachedMasterPacked) return cachedMasterPacked;
  const count = (NES_MASTER_PALETTE_RGBA.length / 4) | 0;
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const r = NES_MASTER_PALETTE_RGBA[i * 4 + 0]!;
    const g = NES_MASTER_PALETTE_RGBA[i * 4 + 1]!;
    const b = NES_MASTER_PALETTE_RGBA[i * 4 + 2]!;
    const a = NES_MASTER_PALETTE_RGBA[i * 4 + 3]!;
    out[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  cachedMasterPacked = out;
  return out;
}

/** Re-exported for tests. */
export { EXTENDED_PALETTE_SIZE };
