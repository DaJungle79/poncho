import { describe, expect, it } from 'vitest';

import { AI_CACHE_MODEL_NEAREST_NEIGHBOUR } from '../../src/core/cart-poncho/ai-cache';
import {
  DEFAULT_UPSCALE_MODEL_ID,
  NEAREST_NEIGHBOUR_MODEL,
  createUpscaleClient,
  getUpscaleModel,
  listUpscaleModels,
  resolveUpscaleModel,
} from '../../src/convert/upscale-registry';

describe('UpscaleModel registry', () => {
  it('exposes nearest-neighbour as the deterministic floor + cacheModelId is canonical', () => {
    // Since v0.5 the default flipped to xbrz-4x-snap (deterministic
    // pixel-art-aware scaler with extended-palette snap-back). NN
    // remains as the explicit "no smoothing" floor.
    expect(NEAREST_NEIGHBOUR_MODEL.id).toBe('nearest-neighbour');
    expect(NEAREST_NEIGHBOUR_MODEL.cacheModelId).toBe(AI_CACHE_MODEL_NEAREST_NEIGHBOUR);
  });

  it('default model is xbrz-4x-snap (v0.5)', () => {
    expect(DEFAULT_UPSCALE_MODEL_ID).toBe('xbrz-4x-snap');
  });

  it('lists at least the nearest-neighbour model', () => {
    const models = listUpscaleModels();
    expect(models.length).toBeGreaterThanOrEqual(1);
    expect(models.some((m) => m.id === 'nearest-neighbour')).toBe(true);
  });

  it('looks up by id; null on miss', () => {
    expect(getUpscaleModel('nearest-neighbour')?.id).toBe('nearest-neighbour');
    expect(getUpscaleModel('definitely-not-registered')).toBeNull();
  });

  it('resolveUpscaleModel falls back to nearest-neighbour on unknown id', () => {
    const m = resolveUpscaleModel('does-not-exist', 'rom-bake');
    expect(m.id).toBe('nearest-neighbour');
  });

  it('createUpscaleClient signals fallback when the requested model is unknown', () => {
    const { client, model, usedFallback } = createUpscaleClient('does-not-exist', 'rom-bake');
    expect(model.id).toBe('nearest-neighbour');
    expect(usedFallback).toBe(true);
    expect(client.modelId).toBe(AI_CACHE_MODEL_NEAREST_NEIGHBOUR);
  });

  it('createUpscaleClient does NOT flag fallback when the user explicitly picks the default', () => {
    const { model, usedFallback } = createUpscaleClient('nearest-neighbour', 'rom-bake');
    expect(model.id).toBe('nearest-neighbour');
    expect(usedFallback).toBe(false);
  });

  it('createUpscaleClient handles undefined id (config not yet set) without throwing', () => {
    const { model, usedFallback } = createUpscaleClient(undefined, 'ram-runtime');
    expect(model.id).toBe('nearest-neighbour');
    expect(usedFallback).toBe(false);
  });

  it('every registered model declares which workflows it supports', () => {
    for (const m of listUpscaleModels()) {
      expect(Array.isArray(m.supportedWorkflows)).toBe(true);
      expect(m.supportedWorkflows.length).toBeGreaterThan(0);
    }
  });
});
