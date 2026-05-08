import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NanoBananaClient,
  QuotaExceededError,
  RateLimitError,
  UpscaleError,
} from '../../src/convert/upscale-client';

/**
 * Retry/backoff tests for the Gemini transport. We mock the canvas APIs
 * so the client doesn't actually try to encode/decode PNGs — the retry
 * loop fires before either side touches OffscreenCanvas, so the mocks
 * just need to exist as stubs to get past the env-check.
 */

const FAKE_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // not real, never decoded

class FakeOffscreenCanvas {
  constructor(public width: number, public height: number) {}
  getContext(): unknown {
    return {
      putImageData() {},
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(32 * 32 * 4) }),
    };
  }
  async convertToBlob(): Promise<Blob> {
    return new Blob([FAKE_PNG_BYTES as BlobPart], { type: 'image/png' });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  // @ts-expect-error stub global for the client
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  // @ts-expect-error stub for createImageBitmap path (only hit on success)
  globalThis.createImageBitmap = async () => ({ close() {} });
  // @ts-expect-error
  globalThis.ImageData = class { constructor(public data: unknown, public w: number, public h: number) {} };
});
afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error
  delete globalThis.OffscreenCanvas;
  // @ts-expect-error
  delete globalThis.createImageBitmap;
  // @ts-expect-error
  delete globalThis.ImageData;
});

const TILE = new Uint8Array(16);
const PAL = new Uint8Array([0x0f, 0x16, 0x30, 0x10]);

function geminiResponseBody(): string {
  // Minimal valid response: one candidate with one inline image part.
  return JSON.stringify({
    candidates: [{
      content: {
        parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
      },
    }],
  });
}

function makeFetchSequence(responses: Array<{ status: number; retryAfter?: string; body?: string }>): typeof fetch {
  let i = 0;
  const fakeFetch = (async (..._args: unknown[]) => {
    const r = responses[i++] ?? responses[responses.length - 1]!;
    const headers = new Headers();
    if (r.retryAfter !== undefined) headers.set('Retry-After', r.retryAfter);
    return new Response(r.body ?? geminiResponseBody(), { status: r.status, headers });
  }) as typeof fetch;
  return fakeFetch;
}

describe('NanoBananaClient — retry on 429', () => {
  it('retries on 429 then succeeds', async () => {
    const fetchImpl = makeFetchSequence([
      { status: 429, retryAfter: '1' },
      { status: 200 },
    ]);
    const client = new NanoBananaClient({ apiKey: 'test', fetch: fetchImpl, maxRetries: 3 });
    const promise = client.upscaleTile(TILE, PAL);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.length).toBe(1024);
  });

  it('throws RateLimitError when all retries exhausted', async () => {
    const fetchImpl = makeFetchSequence([
      { status: 429 },
      { status: 429 },
      { status: 429 },
    ]);
    const client = new NanoBananaClient({ apiKey: 'test', fetch: fetchImpl, maxRetries: 2 });
    const promise = client.upscaleTile(TILE, PAL).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('does NOT retry on 4xx other than 429', async () => {
    const fetchImpl = makeFetchSequence([{ status: 400, body: 'bad request' }]);
    const client = new NanoBananaClient({ apiKey: 'test', fetch: fetchImpl, maxRetries: 5 });
    const promise = client.upscaleTile(TILE, PAL).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(UpscaleError);
    expect(err).not.toBeInstanceOf(RateLimitError);
  });

  it('throws QuotaExceededError on free-tier `limit: 0` 429 (no retries)', async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message:
          'You exceeded your current quota, please check your plan and billing details. ' +
          'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, ' +
          'model: gemini-2.5-flash-preview-image',
      },
    });
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(body, { status: 429 });
    }) as typeof fetch;
    const client = new NanoBananaClient({ apiKey: 'test', fetch: fakeFetch, maxRetries: 5 });
    const promise = client.upscaleTile(TILE, PAL).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(QuotaExceededError);
    // Permanent quota — should fail fast, not exhaust retries.
    expect(calls).toBe(1);
  });

  it('retries on 5xx and succeeds', async () => {
    const fetchImpl = makeFetchSequence([
      { status: 503 },
      { status: 200 },
    ]);
    const client = new NanoBananaClient({ apiKey: 'test', fetch: fetchImpl, maxRetries: 3 });
    const promise = client.upscaleTile(TILE, PAL);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.length).toBe(1024);
  });
});
