/**
 * Upscale model registry — the single source of truth for which
 * upscalers exist, their stable identifiers, and how to construct a
 * client instance from runtime configuration.
 *
 * The user picks one model for **CHR-ROM bake-now** and (typically)
 * the same model for **CHR-RAM runtime**, via Settings. Each selection
 * is keyed by `UpscaleModel.id` (a stable string) which the registry
 * resolves to a factory.
 *
 * Adding a new model:
 *   1. Implement `UpscaleClient` for it (network call, WebGPU
 *      inference, whatever).
 *   2. Allocate a stable `cacheModelId` in `ai-cache.ts` so cached
 *      tiles stay invalidated correctly across model switches.
 *   3. Register the `UpscaleModel` definition here. UI dropdowns and
 *      App lookup pick it up automatically.
 *
 * The registry is intentionally separate from `upscale-client.ts` to
 * keep the boundary tile-shaped: the client doesn't know about config
 * or workflow choice, the registry doesn't know about transport.
 */

import {
  AI_CACHE_MODEL_ESRGAN_X4_ANIME,
  AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
  AI_CACHE_MODEL_UNSPECIFIED,
} from '../core/cart-poncho/ai-cache';
import { MockUpscaleClient, type UpscaleClient } from './upscale-client';
import {
  OnnxUpscaleClient,
  type OnnxUpscaleClientConfig,
} from './clients/onnx-upscale-client';

/** Workflow the model is being instantiated for. Future-proof. */
export type UpscaleWorkflow = 'rom-bake' | 'ram-runtime';

/**
 * Optional platform-level context passed to model factories. Lets a
 * model wire to host capabilities (model asset cache for ONNX/WASM
 * weights, future logger / progress reporter) without each call site
 * stuffing those into the per-model config blob.
 *
 * Models that don't need any of these (e.g. nearest-neighbour) just
 * ignore the parameter.
 */
export interface UpscaleModelContext {
  /**
   * Load model bytes from a URL with progress reporting. The web
   * shell wires this to `Platform.modelAssetCache.load(url, opts)`
   * so weights persist across reloads. Models that don't override
   * this fall back to plain `fetch().arrayBuffer()` (no caching).
   */
  loadAsset?: (
    url: string,
    opts?: { signal?: AbortSignal; onProgress?: (p: { loaded: number; total: number | null; fromCache: boolean }) => void },
  ) => Promise<ArrayBuffer>;
}

/**
 * Per-model arbitrary configuration produced by Settings UI and
 * threaded through to factories. Cloud models would carry an API key,
 * local models would carry a WASM/ONNX URL or quantisation level, etc.
 *
 * The registry is intentionally untyped here — each model knows the
 * shape it expects and validates internally; callers pass through the
 * config blob from `config.ai.modelConfig[modelId]`.
 */
export type UpscaleModelConfig = Record<string, unknown>;

export interface UpscaleModel {
  /** Stable string id used in config + registry lookup. */
  readonly id: string;
  /** Human-readable label for UI dropdowns. */
  readonly label: string;
  /**
   * Short blurb shown beneath the dropdown — one or two sentences
   * describing the trade-off (latency, quality, dependencies).
   */
  readonly description: string;
  /**
   * Numeric id stored in the `.poncho` AI cache section so previously
   * cached tiles can be matched / invalidated when the user switches
   * models. Mirrors the `AI_CACHE_MODEL_*` constants in `ai-cache.ts`.
   */
  readonly cacheModelId: number;
  /**
   * Workflows this model supports. Some local models may be too heavy
   * for the runtime path (CHR-RAM render-time) but fine for the bake
   * pipeline; the UI greys out unsupported (workflow, model) pairs.
   */
  readonly supportedWorkflows: readonly UpscaleWorkflow[];
  /**
   * Construct a fresh client for the given workflow + config. Throws
   * if the config doesn't satisfy the model (e.g. missing key, model
   * file unavailable). Callers handle the throw and fall back to the
   * default `nearest-neighbour` model.
   *
   * `ctx` is optional platform-level context (e.g. asset loader).
   * Models that don't need it ignore the parameter.
   */
  create(
    workflow: UpscaleWorkflow,
    config: UpscaleModelConfig,
    ctx?: UpscaleModelContext,
  ): UpscaleClient;
}

// ----- Built-in models -----------------------------------------------------

/**
 * The deterministic 4×4 nearest-neighbour fallback. Always available;
 * always the safe default when no other model is configured. Identical
 * output to PpuUltra's existing render path, just precomputed into
 * tiles so cache layers can serve it.
 */
export const NEAREST_NEIGHBOUR_MODEL: UpscaleModel = {
  id: 'nearest-neighbour',
  label: 'Nearest-neighbour (fallback)',
  description:
    'Deterministic 4× pixel doubling. No external dependencies; instant. ' +
    'Identical to the renderer\'s built-in upscale — useful as a baseline ' +
    'or when no AI model is configured.',
  cacheModelId: AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
  supportedWorkflows: ['rom-bake', 'ram-runtime'],
  create(_workflow, _config, _ctx) {
    return new MockUpscaleClient();
  },
};

/**
 * Stable URL for the Real-ESRGAN x4 Anime ONNX file. Served by Vite
 * from the project's `public/models/` directory — populated by
 * `npm run setup:models` reading `scripts/models-manifest.json`. We
 * use a relative path so the same code works in dev (Vite serves
 * `/models/<file>`) and in production (the deploy pipeline runs
 * `setup:models` before `npm run build`, so `dist/models/<file>`
 * ends up on the static site).
 *
 * If the file isn't installed (the user skipped `setup:models`),
 * `OnnxUpscaleClient.ensureSession` will fail with a 404 and the
 * pipeline NN-falls-back per tile — Settings UX surfaces an
 * "install models" hint.
 */
export const ESRGAN_X4_ANIME_MODEL_URL = '/models/realesrgan-x4-anime.onnx';

/**
 * Hard-coded I/O shape for the Qualcomm Real-ESRGAN x4plus ONNX
 * export. The model has fixed input shape `[1, 3, 128, 128]` and
 * output shape `[1, 3, 512, 512]` baked into the graph at conversion
 * time, with input pin name `image` (PyTorch trace artifact).
 *
 * Pipeline shape:
 *   - Render an 8×8 NES tile NN-expanded to 128×128 RGB primer.
 *   - Run inference → 512×512 RGB.
 *   - Box-filter 512 → 32 (16×16 area average) inside `OnnxUpscaleClient`.
 *   - Snap each pixel to the extended palette → pv 0..255.
 *
 * If the user swaps in a different ONNX export with different shape
 * / pin names, override via per-model config (`modelConfig['esrgan-x4-anime']`).
 */
const ESRGAN_X4_INPUT_SIZE = 128;
const ESRGAN_X4_OUTPUT_SIZE = 512;
const ESRGAN_X4_INPUT_PIN = 'image';

/**
 * Real-ESRGAN x4 Anime — first registered local model (Phase 5a).
 *
 * The ONNX session is dynamically imported on first use so the heavy
 * `onnxruntime-web` runtime stays out of the main bundle until the
 * user actually selects this model.
 *
 * The model file is bundled with the application — fetched by
 * `npm run setup:models` into `public/models/` and served by Vite.
 * No paste-your-own-URL UX; the user just picks the model and either
 * the file is installed or it isn't. Custom ONNX exports with
 * different pin names can still override `inputPinName` /
 * `outputPinName` via the per-model config.
 *
 * The hard-coded I/O shape below matches the standard Real-ESRGAN x4
 * export (8×8 → 32×32, NCHW, RGB, [0..1]).
 */
export const ESRGAN_X4_ANIME_MODEL: UpscaleModel = {
  id: 'esrgan-x4-anime',
  label: 'Real-ESRGAN x4 Anime (local, ONNX/WebGPU)',
  description:
    'A community ESRGAN variant trained on anime-styled imagery. Runs entirely in your ' +
    'browser via ONNX Runtime Web (WebGPU preferred, WASM fallback). Produces visibly ' +
    'smoother edges than the nearest-neighbour fallback; will fail "no content invention" ' +
    'on some BG decoration tiles until Phase 5b\'s constraint guards land. Model file ' +
    'is bundled — install via `npm run setup:models`.',
  cacheModelId: AI_CACHE_MODEL_ESRGAN_X4_ANIME,
  supportedWorkflows: ['rom-bake', 'ram-runtime'],
  create(_workflow, config, ctx) {
    // The URL is fixed; only optional knobs come from per-model config.
    const url = typeof config['modelUrl'] === 'string' && (config['modelUrl'] as string).trim().length > 0
      ? (config['modelUrl'] as string).trim()
      : ESRGAN_X4_ANIME_MODEL_URL;
    const providers = Array.isArray(config['executionProviders'])
      ? (config['executionProviders'] as string[])
      : ['webgpu', 'wasm'];
    const inputPinName = typeof config['inputPinName'] === 'string'
      ? (config['inputPinName'] as string)
      : ESRGAN_X4_INPUT_PIN;
    // Output pin: leave undefined by default — the client falls back
    // to the first key in the result map if the configured name
    // doesn't match. Robust against the Qualcomm export's
    // anonymously-named output. Override here if a future model
    // export uses a fixed name.
    const outputPinName = typeof config['outputPinName'] === 'string'
      ? (config['outputPinName'] as string)
      : undefined;
    const inputSize = typeof config['inputSize'] === 'number'
      ? (config['inputSize'] as number)
      : ESRGAN_X4_INPUT_SIZE;
    const outputSize = typeof config['outputSize'] === 'number'
      ? (config['outputSize'] as number)
      : ESRGAN_X4_OUTPUT_SIZE;

    const cfg: OnnxUpscaleClientConfig = {
      modelId: AI_CACHE_MODEL_ESRGAN_X4_ANIME,
      modelUrl: url,
      executionProviders: providers,
      input: {
        size: inputSize,
        layout: 'nchw',
        channelOrder: 'rgb',
        range: '[0..1]',
        pinName: inputPinName,
      },
      output: {
        size: outputSize,
        layout: 'nchw',
        channelOrder: 'rgb',
        range: '[0..1]',
        ...(outputPinName ? { pinName: outputPinName } : {}),
      },
    };
    // The platform's model-asset cache (browser Cache Storage on web)
    // wraps this loader so weights persist across reloads. Without a
    // ctx loader, the client falls back to plain fetch.
    if (ctx?.loadAsset) {
      return new OnnxUpscaleClient(cfg, { modelLoader: ctx.loadAsset });
    }
    return new OnnxUpscaleClient(cfg);
  },
};

const MODELS: Record<string, UpscaleModel> = {
  [NEAREST_NEIGHBOUR_MODEL.id]: NEAREST_NEIGHBOUR_MODEL,
  [ESRGAN_X4_ANIME_MODEL.id]: ESRGAN_X4_ANIME_MODEL,
};

/** Default model id — what a fresh config gets. */
export const DEFAULT_UPSCALE_MODEL_ID = NEAREST_NEIGHBOUR_MODEL.id;

/** All registered models, in stable insertion order. */
export function listUpscaleModels(): UpscaleModel[] {
  return Object.values(MODELS);
}

/** Lookup by id. Returns `null` if not registered. */
export function getUpscaleModel(id: string): UpscaleModel | null {
  return MODELS[id] ?? null;
}

/**
 * Resolve an id to a model, falling back to nearest-neighbour if the
 * id is unknown or unsupported for the given workflow. The fallback
 * is logged at the call site, not here, so callers can surface UX
 * status messages.
 */
export function resolveUpscaleModel(
  id: string | undefined,
  workflow: UpscaleWorkflow,
): UpscaleModel {
  const m = id ? MODELS[id] : null;
  if (m && m.supportedWorkflows.includes(workflow)) return m;
  return NEAREST_NEIGHBOUR_MODEL;
}

/**
 * Helper for callers that want a ready-to-use client with built-in
 * fallback. Returns the resolved client + the model that produced it
 * (so the caller can surface "running fallback" UI status).
 *
 * Pass `ctx` to give the model factory access to platform capabilities
 * — most importantly the model-asset cache loader so ONNX weights
 * persist across page reloads.
 */
export function createUpscaleClient(
  id: string | undefined,
  workflow: UpscaleWorkflow,
  config: UpscaleModelConfig = {},
  ctx?: UpscaleModelContext,
): { client: UpscaleClient; model: UpscaleModel; usedFallback: boolean } {
  const requested = id ? MODELS[id] : null;
  const supports = requested?.supportedWorkflows.includes(workflow) ?? false;
  if (requested && supports) {
    try {
      return { client: requested.create(workflow, config, ctx), model: requested, usedFallback: false };
    } catch {
      // Fall through to NN fallback.
    }
  }
  // Fallback flag fires when the user *asked for something else* — an
  // explicit pick of nearest-neighbour shouldn't read as "fallback".
  // An unknown id (id given but not registered) does signal fallback.
  const userRequestedSomething = id !== undefined && id !== '';
  const userPickedFallback = id === NEAREST_NEIGHBOUR_MODEL.id;
  return {
    client: NEAREST_NEIGHBOUR_MODEL.create(workflow, {}, ctx),
    model: NEAREST_NEIGHBOUR_MODEL,
    usedFallback: userRequestedSomething && !userPickedFallback,
  };
}

// Sanity export so a hypothetical caller can ensure the registry is
// non-empty without poking at internals.
export const REGISTRY_DEFAULT_CACHE_MODEL_ID = AI_CACHE_MODEL_UNSPECIFIED;
