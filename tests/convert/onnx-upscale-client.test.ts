import { describe, expect, it, vi } from 'vitest';

import {
  AI_CACHE_MODEL_ESRGAN_X4_PLUS,
} from '../../src/core/cart-poncho/ai-cache';
import {
  OnnxUpscaleClient,
  downscaleToNative,
  postprocessTensor,
  preprocessTensor,
  renderPrimer,
  type OnnxModelInputSpec,
  type OnnxModelOutputSpec,
  type OrtFacade,
  type OrtSession,
  type OrtTensor,
} from '../../src/convert/clients/onnx-upscale-client';
import { UpscaleError } from '../../src/convert/upscale-client';

// ---------------------------------------------------------------------------
// Helpers — the smallest tile + palette that exercises all four pv values.
// ---------------------------------------------------------------------------

const SAMPLE_TILE = (() => {
  // Plane 0 = 0xAA, plane 1 = 0x55 → alternating pv pattern across the row.
  // Lets the post-snap-back assertions check that pv 0..3 all flowed through.
  const t = new Uint8Array(16);
  for (let i = 0; i < 8; i++) t[i] = 0xaa;
  for (let i = 8; i < 16; i++) t[i] = 0x55;
  return t;
})();
const SAMPLE_PAL = new Uint8Array([0x0f, 0x16, 0x2a, 0x12]);

/** Lightweight ORT mock — just enough to drive the client end-to-end. */
function makeMockOrt(behaviour: {
  /** Return value of `session.run` — the output tensor data. */
  outputData: Float32Array;
  /** Input pin name the session will accept (matches client's default). */
  inputPin?: string;
  /** Output pin name the session emits. */
  outputPin?: string;
  /** Throws this on `session.run()` if set. */
  runError?: Error;
  /** Throws this on `InferenceSession.create()` if set. */
  createError?: Error;
  /** Bag for spying on what was passed to run / create. */
  spy?: {
    runFeeds?: Record<string, OrtTensor>[];
    createCalls?: Array<{ uri: string | Uint8Array; options: { executionProviders?: string[] } | undefined }>;
  };
}): OrtFacade {
  const session: OrtSession = {
    async run(feeds) {
      behaviour.spy?.runFeeds?.push(feeds);
      if (behaviour.runError) throw behaviour.runError;
      const out: OrtTensor = {
        type: 'float32',
        data: behaviour.outputData,
        dims: [1, 3, 32, 32],
      };
      return { [behaviour.outputPin ?? 'output']: out };
    },
  };
  return {
    Tensor: class {
      readonly type: string;
      readonly data: Float32Array;
      readonly dims: readonly number[];
      constructor(type: 'float32', data: Float32Array, dims: readonly number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    } as unknown as OrtFacade['Tensor'],
    InferenceSession: {
      async create(uri, options) {
        behaviour.spy?.createCalls?.push({ uri, options });
        if (behaviour.createError) throw behaviour.createError;
        return session;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// renderPrimer
// ---------------------------------------------------------------------------

describe('renderPrimer', () => {
  it('produces an inputSize × inputSize × 4 RGBA buffer', () => {
    const out = renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 8);
    expect(out.length).toBe(8 * 8 * 4);
    const out32 = renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 32);
    expect(out32.length).toBe(32 * 32 * 4);
  });

  it('alpha is opaque on every output pixel', () => {
    const out = renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 8);
    for (let i = 0; i < 8 * 8; i++) {
      expect(out[i * 4 + 3]).toBe(0xff);
    }
  });

  it('rejects non-multiple-of-8 input sizes', () => {
    expect(() => renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 7)).toThrow(UpscaleError);
    expect(() => renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 12)).toThrow(UpscaleError);
  });

  it('expands each NES pixel to a (size/8)×(size/8) block', () => {
    // 32×32 primer: each NES pixel becomes a 4×4 block. The top-left
    // 4×4 region must all be the same colour.
    const out = renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 32);
    const r0 = out[0]!, g0 = out[1]!, b0 = out[2]!;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 32 + x) * 4;
        expect(out[i]).toBe(r0);
        expect(out[i + 1]).toBe(g0);
        expect(out[i + 2]).toBe(b0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// preprocessTensor
// ---------------------------------------------------------------------------

describe('preprocessTensor', () => {
  const ortStub = makeMockOrt({ outputData: new Float32Array(3 * 32 * 32) });

  it('NCHW + [0..1] produces a (1, 3, N, N) Float32 tensor', () => {
    const primer = renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 8);
    const spec: OnnxModelInputSpec = { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' };
    const t = preprocessTensor(primer, spec, ortStub);
    expect(t.type).toBe('float32');
    expect(t.dims).toEqual([1, 3, 8, 8]);
    expect(t.data.length).toBe(3 * 8 * 8);
    // Every value should fall within [0, 1].
    for (let i = 0; i < t.data.length; i++) {
      expect(t.data[i]).toBeGreaterThanOrEqual(0);
      expect(t.data[i]).toBeLessThanOrEqual(1);
    }
  });

  it('NHWC produces a (1, N, N, 3) tensor', () => {
    const primer = renderPrimer(SAMPLE_TILE, SAMPLE_PAL, 8);
    const spec: OnnxModelInputSpec = { size: 8, layout: 'nhwc', channelOrder: 'rgb', range: '[0..1]' };
    const t = preprocessTensor(primer, spec, ortStub);
    expect(t.dims).toEqual([1, 8, 8, 3]);
  });

  it('[-1..1] range maps 0 → -1 and 255 → +1', () => {
    // Build a tiny "all-zero" primer — every channel will be 0.
    const black = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < black.length; i += 4) black[i + 3] = 0xff;
    const spec: OnnxModelInputSpec = { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[-1..1]' };
    const t = preprocessTensor(black, spec, ortStub);
    expect(t.data[0]).toBeCloseTo(-1, 5);

    const white = new Uint8Array(8 * 8 * 4).fill(0xff);
    const t2 = preprocessTensor(white, spec, ortStub);
    expect(t2.data[0]).toBeCloseTo(1, 5);
  });

  it('BGR channel order swaps R↔B', () => {
    const primer = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 8 * 8; i++) {
      primer[i * 4] = 0xff;     // R
      primer[i * 4 + 1] = 0x80; // G
      primer[i * 4 + 2] = 0x00; // B
      primer[i * 4 + 3] = 0xff;
    }
    const spec: OnnxModelInputSpec = { size: 8, layout: 'nchw', channelOrder: 'bgr', range: '[0..1]' };
    const t = preprocessTensor(primer, spec, ortStub);
    // First channel plane should contain B (0) values, not R (255).
    expect(t.data[0]).toBeCloseTo(0, 3);
    // Third channel plane should contain R (255) values.
    expect(t.data[2 * 64]).toBeCloseTo(1, 3);
  });
});

// ---------------------------------------------------------------------------
// postprocessTensor
// ---------------------------------------------------------------------------

describe('postprocessTensor', () => {
  function makeTensor(data: Float32Array, dims: number[]): OrtTensor {
    return { type: 'float32', data, dims };
  }

  it('NCHW [0..1] → 32×32 RGBA, opaque alpha', () => {
    const data = new Float32Array(3 * 32 * 32);
    for (let i = 0; i < data.length; i++) data[i] = 0.5;
    const spec: OnnxModelOutputSpec = { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' };
    const rgba = postprocessTensor(makeTensor(data, [1, 3, 32, 32]), spec);
    expect(rgba.length).toBe(32 * 32 * 4);
    // 0.5 * 255 ≈ 128
    expect(rgba[0]).toBe(128);
    expect(rgba[1]).toBe(128);
    expect(rgba[2]).toBe(128);
    expect(rgba[3]).toBe(255);
  });

  it('NCHW [-1..1] denormalises correctly', () => {
    // 1.0 → 255, -1.0 → 0
    const data = new Float32Array(3 * 32 * 32);
    for (let i = 0; i < 32 * 32; i++) data[i] = 1.0;       // R plane = +1 → 255
    for (let i = 32 * 32; i < 2 * 32 * 32; i++) data[i] = -1.0; // G plane = -1 → 0
    const spec: OnnxModelOutputSpec = { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[-1..1]' };
    const rgba = postprocessTensor(makeTensor(data, [1, 3, 32, 32]), spec);
    expect(rgba[0]).toBe(255);
    expect(rgba[1]).toBe(0);
  });

  it('clamps out-of-range values', () => {
    const data = new Float32Array(3 * 32 * 32);
    data[0] = 3.0;  // way over 1 in [0..1] → clamp to 255
    const spec: OnnxModelOutputSpec = { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' };
    const rgba = postprocessTensor(makeTensor(data, [1, 3, 32, 32]), spec);
    expect(rgba[0]).toBe(255);
  });

  it('rejects wrong-size tensors', () => {
    const data = new Float32Array(3 * 32 * 32 - 1);
    const spec: OnnxModelOutputSpec = { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' };
    expect(() => postprocessTensor(makeTensor(data, [1, 3, 32, 32]), spec)).toThrow(UpscaleError);
  });

  it('rejects non-float32 tensors', () => {
    const wrong = { type: 'int8', data: new Float32Array(3 * 32 * 32), dims: [1, 3, 32, 32] };
    const spec: OnnxModelOutputSpec = { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' };
    expect(() => postprocessTensor(wrong as unknown as OrtTensor, spec)).toThrow(UpscaleError);
  });
});

// ---------------------------------------------------------------------------
// OnnxUpscaleClient — end-to-end with mocked ORT
// ---------------------------------------------------------------------------

describe('downscaleToNative — box filter', () => {
  it('preserves a uniform-colour buffer exactly', () => {
    const src = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      src[i * 4] = 0x80;
      src[i * 4 + 1] = 0x40;
      src[i * 4 + 2] = 0xc0;
      src[i * 4 + 3] = 0xff;
    }
    const dst = downscaleToNative(src, 64, 32);
    expect(dst.length).toBe(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      expect(dst[i * 4]).toBe(0x80);
      expect(dst[i * 4 + 1]).toBe(0x40);
      expect(dst[i * 4 + 2]).toBe(0xc0);
      expect(dst[i * 4 + 3]).toBe(0xff);
    }
  });

  it('averages a 16×16 block (Real-ESRGAN x4plus 512→32 ratio)', () => {
    // 512 / 32 = 16, so each 32×32 output pixel averages a 16×16
    // input block. Set each block to a different gradient and check
    // the average lands at the block's median.
    const src = new Uint8Array(512 * 512 * 4);
    // Block (0, 0) is all 0; block (1, 0) is all 0xFF; the average
    // of (block 0 + block 1) at the boundary should be ~0x80.
    // Set each 16×16 block to a constant value derived from its
    // (block_x, block_y) index.
    for (let by = 0; by < 32; by++) {
      for (let bx = 0; bx < 32; bx++) {
        const v = ((bx + by) & 1) ? 0xc0 : 0x40; // alternating "checkerboard" of values
        for (let py = 0; py < 16; py++) {
          for (let px = 0; px < 16; px++) {
            const i = ((by * 16 + py) * 512 + (bx * 16 + px)) * 4;
            src[i] = v;
            src[i + 1] = v;
            src[i + 2] = v;
            src[i + 3] = 0xff;
          }
        }
      }
    }
    const dst = downscaleToNative(src, 512, 32);
    // Output (bx, by) should equal the corresponding block constant.
    for (let by = 0; by < 32; by++) {
      for (let bx = 0; bx < 32; bx++) {
        const expected = ((bx + by) & 1) ? 0xc0 : 0x40;
        const i = (by * 32 + bx) * 4;
        expect(dst[i]).toBe(expected);
        expect(dst[i + 1]).toBe(expected);
        expect(dst[i + 2]).toBe(expected);
      }
    }
  });

  it('rejects non-integer ratios', () => {
    const src = new Uint8Array(48 * 48 * 4);
    expect(() => downscaleToNative(src, 48, 32)).toThrow(/not a multiple/);
  });
});

describe('OnnxUpscaleClient — construction', () => {
  it('rejects empty modelUrl at construction time', () => {
    expect(() =>
      new OnnxUpscaleClient({
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: '',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      }),
    ).toThrow(/modelUrl is required/);
  });

  it('rejects output.size < 32 (smaller than Poncho native tile)', () => {
    expect(() =>
      new OnnxUpscaleClient({
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'https://example.com/m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 16, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      }),
    ).toThrow(/multiple of 32/);
  });

  it('rejects output.size that is not a multiple of 32 (box filter requires integer ratio)', () => {
    expect(() =>
      new OnnxUpscaleClient({
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'https://example.com/m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 33, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      }),
    ).toThrow(/multiple of 32/);
  });

  it('accepts output.size > 32 multiples (e.g. Real-ESRGAN x4plus 512×512)', () => {
    expect(() =>
      new OnnxUpscaleClient({
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'https://example.com/m.onnx',
        input: { size: 128, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 512, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      }),
    ).not.toThrow();
  });
});

describe('OnnxUpscaleClient.upscaleTile — end-to-end with mocked ORT', () => {
  it('runs preprocess → infer → postprocess → snap-back; returns 1024-byte tile', async () => {
    // Mid-grey output — every output pixel ≈ (128, 128, 128).
    const output = new Float32Array(3 * 32 * 32).fill(0.5);
    const ort = makeMockOrt({ outputData: output });

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
      { ortFactory: async () => ort },
    );

    const tile = await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);
    expect(tile.length).toBe(1024);
    // Every pv must be 0..255.
    for (let i = 0; i < 1024; i++) {
      expect(tile[i]).toBeGreaterThanOrEqual(0);
      expect(tile[i]).toBeLessThanOrEqual(255);
    }
  });

  it('caches the session — only one create + one run per call after the first', async () => {
    const spy = { runFeeds: [] as Record<string, OrtTensor>[], createCalls: [] as Array<{ uri: string | Uint8Array; options: { executionProviders?: string[] } | undefined }> };
    const output = new Float32Array(3 * 32 * 32).fill(0.5);
    const ort = makeMockOrt({ outputData: output, spy });

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
      { ortFactory: async () => ort },
    );

    await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);
    await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);
    await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);

    expect(spy.createCalls.length).toBe(1);
    expect(spy.runFeeds.length).toBe(3);
  });

  it('forwards configured executionProviders to InferenceSession.create', async () => {
    const spy = { createCalls: [] as Array<{ uri: string | Uint8Array; options: { executionProviders?: string[] } | undefined }> };
    const ort = makeMockOrt({
      outputData: new Float32Array(3 * 32 * 32).fill(0.5),
      spy,
    });

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        executionProviders: ['wasm'],
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
      { ortFactory: async () => ort },
    );

    await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);

    expect(spy.createCalls[0]?.options?.executionProviders).toEqual(['wasm']);
    expect(spy.createCalls[0]?.uri).toBe('mock://m.onnx');
  });

  it('uses the configured input pin name when feeding session.run', async () => {
    const spy = { runFeeds: [] as Record<string, OrtTensor>[] };
    const ort = makeMockOrt({
      outputData: new Float32Array(3 * 32 * 32).fill(0.5),
      outputPin: 'image_out',
      spy,
    });

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'image_in' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'image_out' },
      },
      { ortFactory: async () => ort },
    );

    await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);

    expect(spy.runFeeds.length).toBe(1);
    expect(Object.keys(spy.runFeeds[0]!)).toEqual(['image_in']);
  });

  it('wraps create() failures in UpscaleError; subsequent calls retry', async () => {
    let attempt = 0;
    const factory = vi.fn(async () => {
      const isFirstAttempt = ++attempt === 1;
      const opts: { outputData: Float32Array; createError?: Error } = {
        outputData: new Float32Array(3 * 32 * 32).fill(0.5),
      };
      if (isFirstAttempt) opts.createError = new Error('boom');
      return makeMockOrt(opts);
    });

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
      { ortFactory: factory },
    );

    await expect(client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL)).rejects.toBeInstanceOf(UpscaleError);
    // Retry: the second call should succeed (factory now returns a working ORT).
    const tile = await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);
    expect(tile.length).toBe(1024);
    expect(factory.mock.calls.length).toBe(2);
  });

  it('wraps run() failures in UpscaleError', async () => {
    const ort = makeMockOrt({
      outputData: new Float32Array(3 * 32 * 32).fill(0.5),
      runError: new Error('inference exploded'),
    });

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
      { ortFactory: async () => ort },
    );

    await expect(client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL)).rejects.toThrow(/inference exploded/);
  });

  it('handles 128×128 → 512×512 models — box-filters output to 32×32 before snap-back', async () => {
    // Real-ESRGAN x4plus shape: input [1, 3, 128, 128], output [1, 3, 512, 512].
    const output = new Float32Array(3 * 512 * 512).fill(0.5);
    const spy = { runFeeds: [] as Record<string, OrtTensor>[] };
    const ort: OrtFacade = {
      Tensor: class {
        readonly type: string;
        readonly data: Float32Array;
        readonly dims: readonly number[];
        constructor(t: 'float32', d: Float32Array, dims: readonly number[]) {
          this.type = t; this.data = d; this.dims = dims;
        }
      } as unknown as OrtFacade['Tensor'],
      InferenceSession: {
        async create() {
          return {
            async run(feeds) {
              spy.runFeeds.push(feeds);
              return {
                model_output: { type: 'float32', data: output, dims: [1, 3, 512, 512] } as OrtTensor,
              };
            },
          };
        },
      },
    };

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 128, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'image' },
        output: { size: 512, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' /* no pinName — fallback */ },
      },
      { ortFactory: async () => ort },
    );

    const tile = await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);
    expect(tile.length).toBe(1024);
    // Should have been fed via the configured `image` pin.
    expect(Object.keys(spy.runFeeds[0]!)).toEqual(['image']);
    // Input tensor was [1, 3, 128, 128] (not 8×8 — primer NN-expanded).
    expect(spy.runFeeds[0]!['image']!.dims).toEqual([1, 3, 128, 128]);
  });

  it('throws on missing output pin (model output is empty)', async () => {
    const ort: OrtFacade = {
      Tensor: class {
        readonly type = 'float32';
        readonly data: Float32Array;
        readonly dims: readonly number[];
        constructor(_t: 'float32', d: Float32Array, dims: readonly number[]) {
          this.data = d; this.dims = dims;
        }
      } as unknown as OrtFacade['Tensor'],
      InferenceSession: { async create() { return { async run() { return {}; } }; } },
    };

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
      { ortFactory: async () => ort },
    );

    await expect(client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL)).rejects.toThrow(/no output/);
  });

  it('returns valid pv values that respect the extended-palette structure', async () => {
    // Output: every output pixel exactly matches sub-palette entry 1's
    // master colour (red-ish in the canonical NES master palette,
    // master index 0x16 = (0xd2, 0x12, 0x69)). The snap-back should
    // pick a pv that maps to that colour — either pv 1 (legacy slot)
    // or somewhere in the base-1 ramp (pv 4..87) depending on which
    // entry is closest. Asserting "pv ≤ 87 i.e. base 0 or base 1
    // territory" rules out drift to bases 2/3.
    const r = 0xd2 / 255, g = 0x12 / 255, b = 0x69 / 255;
    const data = new Float32Array(3 * 32 * 32);
    for (let i = 0; i < 32 * 32; i++) {
      data[0 * 32 * 32 + i] = r;
      data[1 * 32 * 32 + i] = g;
      data[2 * 32 * 32 + i] = b;
    }
    const ort = makeMockOrt({ outputData: data });

    const client = new OnnxUpscaleClient(
      {
        modelId: AI_CACHE_MODEL_ESRGAN_X4_PLUS,
        modelUrl: 'mock://m.onnx',
        input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
        output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]' },
      },
      { ortFactory: async () => ort },
    );

    const tile = await client.upscaleTile(SAMPLE_TILE, SAMPLE_PAL);
    for (let i = 0; i < 1024; i++) {
      // Either pv 1 (legacy base 1 slot) or pv 4..87 (base 1 ramp).
      const pv = tile[i]!;
      expect(pv === 1 || (pv >= 4 && pv <= 87)).toBe(true);
    }
  });
});
