# AI upscale models — setup

Poncho's AI upscale path runs a local ONNX model (no cloud API). The
shipped UI registers only the deterministic 4× nearest-neighbour
fallback — ESRGAN, AnimeSharp, and SPAN-x4 were prototyped but didn't
pass the quality bar on pixel-art primer (see Phase 5a notes in
[`docs/v0.4.0-plan.md`](v0.4.0-plan.md)). To run a model anyway you
either:

1. **Attach a custom `.onnx` from the Convert .nes panel** (browser).
2. **Run the Node-side bake CLI** with one of the prototype models
   (offline, then drag the resulting `.poncho` into the browser).

Neither path requires `npm run setup` — that script is only useful if
you're shipping a bundled model with the build (no longer the default).

## Path A — Attach a custom `.onnx` in the browser

1. Open the L3 **Convert .nes** panel (cassette icon → "Convert .nes"
   button on a Poncho-NES cart).
2. **Upscale** is on by default. Click **Attach custom model
   (.onnx)** and pick your file.
3. Click **Convert**.

The wiring assumes the standard pixel-art SR contract:

|               | Input          | Output         |
|---------------|---------------:|---------------:|
| Image size    | 8 × 8          | 32 × 32        |
| Tensor shape  | `[1, 3, 8, 8]` | `[1, 3, 32, 32]` |
| Layout        | NCHW           | NCHW           |
| Channel order | RGB            | RGB            |
| Numeric range | `[0..1]` Float32 | `[0..1]` Float32 |
| Pin names     | `input`        | `output`       |

A model that mismatches this contract throws a clear preflight error
to the panel's status line — it won't silently NN-fallback every tile.

`onnxruntime-web`'s WASM sidecars are needed at runtime; if you've run
`npm run setup` (or `npm run setup:ort`) the dev server serves them
from `public/ort/`. Otherwise Vite's middleware in `vite.config.ts`
streams them directly out of `node_modules/onnxruntime-web/dist/`.

## Path B — Node CLI bake

The CLI bakes a `.nes` to a `.poncho` offline, then you drop the
result into the browser to play. Bypasses every browser-side ORT
constraint.

```bash
# Default (deterministic NN, no model file needed)
npx tsx scripts/poncho-convert.ts <input.nes> --ai

# With a real model (CoreML on macOS, CPU fallback)
npx tsx scripts/poncho-convert.ts <input.nes> --model Real-ESRGAN-x4plus
npx tsx scripts/poncho-convert.ts <input.nes> --model 4x-spanx4-ch48
```

`--model-path <file>` overrides the default file location. Drop the
`.onnx` (and any `.onnx.data` sidecar for external-data exports) into
`public/models/`. See `npx tsx scripts/poncho-convert.ts --help` for
the full flag list.

The CLI dependency `onnxruntime-node` is a heavy native binary — kept
as a `devDependency` so the production browser build doesn't pull it
in. `npm install` includes it in dev installs.

## Adding a new model in code

1. Allocate a numeric `cacheModelId` in
   [`src/core/cart-poncho/ai-cache.ts`](../src/core/cart-poncho/ai-cache.ts) —
   matters when mixing AI caches across models.
2. Implement `UpscaleClient` (or reuse `OnnxUpscaleClient` with a new
   I/O config blob).
3. Register the `UpscaleModel` definition in
   [`src/convert/upscale-registry.ts`](../src/convert/upscale-registry.ts).
   Anything in the `MODELS` map appears in the panel automatically.

`scripts/models-manifest.json` and `npm run setup:models` exist for
the bundled-model workflow if you ever ship a model with the build.
The shipped Poncho doesn't.
