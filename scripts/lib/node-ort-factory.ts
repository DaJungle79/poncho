/**
 * Node-side `OrtFacade` factory — wraps `onnxruntime-node` so
 * `OnnxUpscaleClient` (which targets the abstract facade interface)
 * runs the same model end-to-end from Node CLIs / tests, no browser
 * required. Lets you bake a CHR-ROM `.poncho` with real Real-ESRGAN
 * inference offline, then drop the file into the browser to view —
 * useful when the in-browser session-create takes 30 s of WebGPU
 * shader compile or freezes on Safari.
 *
 * `onnxruntime-node` is an *optional* dev dep (heavy native binary).
 * The dynamic import + try/catch surfaces a friendly error if the
 * package isn't installed.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OrtFacade } from '../../src/convert/clients/onnx-upscale-client';

const require_ = createRequire(import.meta.url);

/**
 * Force ORT's internal `float16 → typed-array` map to use `Uint16Array`
 * even when `Float16Array` is present in the runtime (Node 24+).
 * Reason: `onnxruntime-node`'s native N-API binding only accepts
 * `Uint16Array` carriers for fp16 tensors — it rejects `Float16Array`
 * with `Tensor.data must be a typed array (4 or Float16Array) for
 * float16 tensors, but got typed array (0)`. ORT-Common's tensor ctor
 * silently converts `Uint16Array` → `Float16Array` when the latter is
 * available, so we have to override the lookup directly.
 *
 * `checkTypedArray()` is a one-shot lazy initialiser; we trigger it
 * manually then overwrite the `'float16'` entry. Idempotent.
 *
 * Resolution note: `onnxruntime-common/package.json` `exports` does
 * not expose `dist/cjs/tensor-impl-type-mapping.js`, so we can't go
 * through the package resolver. We locate the file by walking up
 * the workspace and reading it via an absolute filesystem path —
 * brittle, but the only way to reach an internal module that the
 * vendor doesn't re-export.
 */
function forceFloat16AsUint16(): void {
  const candidates: string[] = [];
  // Try common npm install layouts, including hoisted + nested.
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, 'node_modules/onnxruntime-common/dist/cjs/tensor-impl-type-mapping.js'));
    candidates.push(join(dir, 'node_modules/onnxruntime-node/node_modules/onnxruntime-common/dist/cjs/tensor-impl-type-mapping.js'));
    dir = join(dir, '..');
  }
  const path = candidates.find(existsSync);
  if (!path) {
    throw new Error(
      'Could not locate onnxruntime-common tensor-impl-type-mapping.js — ' +
      'fp16 inference may fail. Run `npm install` and try again.',
    );
  }
  const tm = require_(path) as {
    checkTypedArray: () => void;
    NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP: Map<string, unknown>;
  };
  tm.checkTypedArray();
  tm.NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.set('float16', Uint16Array);
}

export async function createNodeOrtFactory(): Promise<OrtFacade> {
  let mod: typeof import('onnxruntime-node');
  try {
    mod = await import('onnxruntime-node');
  } catch (err) {
    throw new Error(
      'onnxruntime-node is not installed. Run `npm install --save-dev onnxruntime-node` ' +
      `to enable Node-side baking. (${(err as Error).message})`,
    );
  }
  forceFloat16AsUint16();
  return {
    Tensor: mod.Tensor as unknown as OrtFacade['Tensor'],
    InferenceSession: {
      create: (
        modelOrBytes: string | Uint8Array,
        options?: { executionProviders?: string[] },
      ) => mod.InferenceSession.create(
        modelOrBytes,
        options ?? {},
      ) as unknown as ReturnType<OrtFacade['InferenceSession']['create']>,
    },
    // Node ORT doesn't expose `env.wasm.wasmPaths` (no WASM); leaving
    // `env` undefined makes the `OnnxUpscaleClient` branch that pokes
    // `wasmPaths` a no-op.
  };
}
