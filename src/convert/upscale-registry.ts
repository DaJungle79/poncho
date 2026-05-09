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
  AI_CACHE_MODEL_NEAREST_NEIGHBOUR,
  AI_CACHE_MODEL_UNSPECIFIED,
} from '../core/cart-poncho/ai-cache';
import { MockUpscaleClient, type UpscaleClient } from './upscale-client';

/** Workflow the model is being instantiated for. Future-proof. */
export type UpscaleWorkflow = 'rom-bake' | 'ram-runtime';

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
   */
  create(workflow: UpscaleWorkflow, config: UpscaleModelConfig): UpscaleClient;
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
  create(_workflow, _config) {
    return new MockUpscaleClient();
  },
};

const MODELS: Record<string, UpscaleModel> = {
  [NEAREST_NEIGHBOUR_MODEL.id]: NEAREST_NEIGHBOUR_MODEL,
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
 */
export function createUpscaleClient(
  id: string | undefined,
  workflow: UpscaleWorkflow,
  config: UpscaleModelConfig = {},
): { client: UpscaleClient; model: UpscaleModel; usedFallback: boolean } {
  const requested = id ? MODELS[id] : null;
  const supports = requested?.supportedWorkflows.includes(workflow) ?? false;
  if (requested && supports) {
    try {
      return { client: requested.create(workflow, config), model: requested, usedFallback: false };
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
    client: NEAREST_NEIGHBOUR_MODEL.create(workflow, {}),
    model: NEAREST_NEIGHBOUR_MODEL,
    usedFallback: userRequestedSomething && !userPickedFallback,
  };
}

// Sanity export so a hypothetical caller can ensure the registry is
// non-empty without poking at internals.
export const REGISTRY_DEFAULT_CACHE_MODEL_ID = AI_CACHE_MODEL_UNSPECIFIED;
