# AI upscale models — setup

Poncho's Phase 5a AI upscale path runs a local ONNX model (no cloud
API). Two pieces of setup are needed; **`npm run setup` handles both**:

1. **ONNX Runtime Web** WASM files at `public/ort/*` — served at
   `/ort/*` so the runtime's loader fetches them from a stable URL
   instead of from Vite's pre-bundled deps cache (which doesn't
   ship the .wasm sidecars).
2. **Model file** at `public/models/<filename>.onnx` — served at
   `/models/<filename>.onnx`. The Real-ESRGAN export is the first
   model registered.

```bash
npm run setup
# Equivalent to: npm run setup:ort && npm run setup:models
```

After that the Settings UI shows the model as "Installed and ready"
and the AI upscale path works end-to-end.

## Updating the model

Edit `scripts/models-manifest.json` to point at a different ONNX
export (`url` field; `"PLACEHOLDER"` triggers the manual-install
fallback). Then:

```bash
npm run setup:models -- --force   # re-download
```

The script downloads with progress reporting, verifies size + hash
(when you set them in the manifest), atomic-renames into place.

## Path 2 — drop the file manually

If you can't find a public URL or HF auth is in the way:

1. Find any Real-ESRGAN x4 Anime ONNX export. Sources to try:
   - [openmodeldb.info](https://openmodeldb.info/) — search "Real-ESRGAN x4 Anime"
   - Hugging Face — search `realesrgan onnx` (may require login for some)
   - Convert from a PyTorch checkpoint via [`onnxruntime`](https://onnxruntime.ai/)'s `convert.py` from any of the public Real-ESRGAN forks
2. Save the file at:
   ```
   public/models/realesrgan-x4-anime.onnx
   ```
3. Reload the Poncho dev server (or rebuild for production). In
   **Settings → AI upscale**, picking the model should now show
   "Available (NN MB on server)".

The download script doesn't care which way you got the file — it
detects already-installed entries by filename and skips them.

## What the model needs to accept

The bundled `OnnxUpscaleClient` configures the ESRGAN registry entry
with this contract:

|              | Input | Output |
|--------------|------:|-------:|
| Image size   | 8 × 8 | 32 × 32 |
| Tensor shape | `[1, 3, 8, 8]` | `[1, 3, 32, 32]` |
| Layout       | NCHW | NCHW |
| Channel order| RGB | RGB |
| Numeric range| `[0..1]` Float32 | `[0..1]` Float32 |
| Pin name     | `input` | `output` |

If your ONNX export uses different pin names, override them via
`config.ai.modelConfig['esrgan-x4-anime'].inputPinName` /
`outputPinName` in `localStorage` (key `poncho.nes.config`) — or
patch the registry entry in
[`src/convert/upscale-registry.ts`](../src/convert/upscale-registry.ts).

If your model has different I/O dimensions (most generic Real-ESRGAN
exports take any input size and produce 4× output), the contract
still works — `OnnxUpscaleClient` only insists `output.size === 32`
because that's the Poncho native tile size.

## Adding a new model

1. Allocate a numeric `cacheModelId` in
   [`src/core/cart-poncho/ai-cache.ts`](../src/core/cart-poncho/ai-cache.ts).
2. Append an entry to `scripts/models-manifest.json` with id, filename,
   URL.
3. Register an `UpscaleModel` definition in
   [`src/convert/upscale-registry.ts`](../src/convert/upscale-registry.ts) —
   reuse `OnnxUpscaleClient` with the model's I/O config, or implement
   a different `UpscaleClient` if it needs a different runtime.
4. The Settings dropdowns + per-model UI pick up the new entry
   automatically.
