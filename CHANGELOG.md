# Changelog

All notable changes to Poncho are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project loosely tracks [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed - UI/UX ROM add flow

- **ROMs move under Consoles** - the standalone ROMs sidebar item is gone. The app now opens on Consoles, and each console card has a selected-state ROMs button to show/hide that console's adjacent ROM bay.
- **Cartridge icon for ROMs** - the console card ROMs button now uses a cartridge-shaped SVG instead of the old cassette icon.
- **ROMs panel Add ROM subview** - the old inline Upload / Convert buttons are replaced by one stable `Add ROM` action at the top of the ROMs panel. It toggles a darker local `Add new ROM` subview with a drag-and-drop zone, click-to-pick fallback, selected-file summary, and Esc-to-close behavior.
- **Unified upload + conversion** - Classic NES accepts `.nes`; Poncho-NES accepts `.poncho` directly and `.nes` via client-side conversion to `.poncho`. The Upscale checkbox and optional custom ONNX model attach appear only when the selected Poncho-NES file needs conversion.

### Added — v0.5 phase 5: settings UI + scaler defaults

- **Scaler dropdown groups** — the Scale selector in Settings is now split into three `<optgroup>`s: Nearest-neighbour (1×/2×/4×), xBRZ (2×–6×), and MMPX (2×). A hint below the selector describes the tradeoff.
- **Classic NES defaults to xBRZ 4×** — when NES is selected and the stored scaler is `nearest-1x` (e.g. arriving from Poncho-NES which forces that value), it is automatically bumped to `xbrz-4x`. New installs also start at `xbrz-4x` (changed `DEFAULT_CONFIG.video.scaler`).
- **Poncho-NES scaler guard (fixed)** — all non-`nearest-1x` pipeline scalers are now disabled in the dropdown and auto-downgraded when Poncho-NES is active. The previous fix only caught `nearest-2x`/`nearest-4x`; xBRZ and MMPX scalers slipped through, causing ~12 fps on the 1024×960 framebuffer. The downgrade now reads from `ConfigStore` directly (not `scaleSelect.value`) so it fires correctly at boot before `onShow` has synced the `<select>`.

### Changed — v0.5 phase 5: performance

- **`XbrzUpscaleClient` extended-palette cache** — the per-tile `buildExtendedSubPalette` call (252 Oklab lerps ≈ 2 500 transcendental operations) is now cached by 4-byte sub-palette key with a 32-entry LRU eviction. Tiles sharing a sub-palette (the common case) skip the build entirely on subsequent calls.
- **`XbrzUpscaleClient` scratch buffers** — `primerU32` and `xbrzOut` are pre-allocated once on the client instance and reused each `upscaleTile` call, avoiding two per-tile `Uint32Array` allocations.
- **`fillRamp` Oklab anchor pre-computation** — the three Oklab anchor points (black, base, white) are now computed once per ramp call rather than inside the per-shade loop, cutting redundant `sRGB→Oklab` conversions from ~84 to 3 per ramp.
- **`UpscaleWorker` scheduler** — changed from `queueMicrotask` to `setTimeout(fn, 0)`. `queueMicrotask` drained the entire bake queue before the next paint, freezing the UI during warm-up. `setTimeout(0)` yields back to the browser between bakes so render frames interleave. Tests inject a microtask-based scheduler explicitly to keep `await flush()` working.

## [0.4.0] — 2026-05-10

v0.4.0 — AI-driven CHR upscaling for Poncho-NES carts. Originally targeted Google's nanobanana / Gemini 2.5 Flash Image cloud API; pivoted to local ONNX models (Phase 4.7) and ultimately to a UI-stripped "attach your own model" path after the Phase 5a candidate models (Real-ESRGAN, AnimeSharp, SPAN-x4) all failed quality / runtime / export bars on pixel-art primer. The infrastructure that survived (PonchoROM AI cache section, runtime upscale worker, PpuUltra resolver hook, repack/write-back, model registry, `OnnxUpscaleClient`, browser model-asset cache, Node CLI bake) is what Phase 5b/5c will build the next-generation pixel-art-trained model on top of. See [`docs/v0.4.0-plan.md`](docs/v0.4.0-plan.md). Game-by-game validation + regression harness moved to [`docs/v0.6.0-plan.md`](docs/v0.6.0-plan.md).

### Added — v0.4 Phase 1: foundation

- **PonchoROM AI cache section** (optional, gated by header flag bit 2: `flags.aiCachePresent`). 12-byte sub-header (`AICH` magic + format version + model id + entry count) followed by N × 1056-byte entries (16-byte palette-aware hash + 16-byte source NES tile + 1024-byte upscaled native tile). [`src/core/cart-poncho/ai-cache.ts`](src/core/cart-poncho/ai-cache.ts) implements parser + writer; [`PonchoCartridge`](src/core/cart-poncho/cartridge.ts) loads it on construction. Format spec in [`docs/poncho-rom.md`](docs/poncho-rom.md).
- **Tile cache** ([`src/convert/tile-cache.ts`](src/convert/tile-cache.ts)) — three-tier lookup (per-cart `FileTileCache` → cross-cart `GlobalTileCache` → `UpscaleClient`) with promotion on hit. SHA-256-truncated-128 palette-aware tile hashing via Web Crypto, with a pure-JS RFC 6234 fallback. Model-id mismatched entries are treated as cache misses (not destructively purged) so the on-disk cache is preserved when the user switches upscalers.
- **Upscale client interface** ([`src/convert/upscale-client.ts`](src/convert/upscale-client.ts)) — `UpscaleClient` boundary with two implementations: `MockUpscaleClient` (deterministic 4× nearest-neighbour, used by tests + as the no-key fallback) and `NanoBananaClient` (Phase 1: stub).

### Added — v0.4 Phase 2: CHR-ROM bake-now pipeline

- **`convertInesToPonchoAi`** ([`src/convert/ines-to-poncho-ai.ts`](src/convert/ines-to-poncho-ai.ts)) — high-level converter for CHR-ROM cartridges. Dedupes tiles by content hash, pumps unique tiles through the cache layers with bounded concurrency (default 4), reassembles CHR with each NES tile replaced by its 1024-byte upscaled native counterpart, and emits a native-mode `.poncho`. Per-tile API failures fall back to nearest-neighbour so a flaky network doesn't fail the whole conversion. Reports progress via `onProgress` callback; cancellable via `AbortSignal`. CHR-RAM cartridges are rejected at the boundary — they take the runtime upscale path instead.
- **`NanoBananaClient` real transport** — Gemini 2.5 Flash Image API client with PNG encode/decode via the Canvas API. Browser-only by design; CLI sticks with `MockUpscaleClient` until a Node-side codec lands.
- **CLI**: `npm run poncho:convert -- <input.nes> --ai` runs the AI pipeline with the mock client (deterministic NN expansion).
- **Web UI**: "Use AI upscale" checkbox under "Convert .nes" (Poncho-NES mode only). For CHR-ROM games it shows a modal with progress bar, tile counter, and Cancel button. For CHR-RAM games it converts instantly with a hint that AI will run during play. Uses `NanoBananaClient` if `window.PONCHO_GEMINI_API_KEY` is set; otherwise falls back to `MockUpscaleClient`.

### Added — v0.4 Phase 3: CHR-RAM runtime + self-upgrading file

- **Runtime upscale worker** ([`src/runtime/upscale-worker.ts`](src/runtime/upscale-worker.ts)) — async tile-fetch orchestrator with a sync `resolveSync(nesTile, subPalette)` hot-path lookup. Two parallel indices: `byRaw` (20-byte raw key, no hashing — populated as tiles resolve) and `byHash` (TileHashHex — populated when seeding from a cart's `aiCache` section, promoted into `byRaw` on first runtime query via a sync SHA-256). Dedupes in-flight requests by raw bytes; per-tile API failures are swallowed (next frame retries). Emits an optional `onTileReady` for UI invalidation; tracks dirty state for write-back.
- **PpuUltra render-path bridging** ([`src/core/ppu-ultra/ppu-ultra.ts`](src/core/ppu-ultra/ppu-ultra.ts)) — new `setUpscaledTileResolver(fn)` hook. In upscaled-mode BG render, every tile-change snapshots the 16-byte NES tile + 4-byte sub-palette and calls the resolver. Hit → paint from the 1024-byte native tile (1 native px ↔ 1 Poncho px) using runtime palette; miss → existing 4× nearest-neighbour expansion. Per-tile granularity: a single frame can mix native and NN tiles freely, so the framebuffer becomes incrementally AI-correct as the worker delivers tiles.
- **Self-upgrading file write-back** ([`src/core/cart-poncho/repack.ts`](src/core/cart-poncho/repack.ts)) — `repackPonchoWithAiCache(originalBytes, freshSection)` rebuilds a `.poncho` with a merged AI cache section embedded. Header fields, palette, PRG, CHR, and trailer are preserved verbatim. `mergeAiCacheSections(existing, fresh)` does the union (fresh wins on hash collision); existing entries from a different model are dropped (the section format only carries one model id at a time).
- **Web app integration** ([`src/shells/web/app.ts`](src/shells/web/app.ts)) — wires the worker on Poncho-NES + CHR-RAM + upscaled-mode carts. Triggers: cart load installs the resolver and starts a 60 s periodic flush; cart eject / power-off / console switch / next-load all force a final flush. Persistence is opt-in by source (`browser:` and `file:` only — server ROMs are skipped to avoid surprise library entries). Uses `NanoBananaClient` when `window.PONCHO_GEMINI_API_KEY` is set, `MockUpscaleClient` otherwise.
- **Tile hashing** — `hashTileSync` exported from `tile-cache.ts` for use in the render hot path (Web Crypto's `subtle.digest` is async-only and can't be invoked from synchronous PPU code).

### Added — v0.4 Phase 4: polish + UX

- **API key in Settings** — masked input under "AI upscale" with show/hide toggle; persisted via `ConfigStore` (new `config.ai.apiKey` field). Replaces the `window.PONCHO_GEMINI_API_KEY` developer hatch from earlier phases. "Get a key" link points to Google AI Studio.
- **Bake-now modal: ETA** — modal now shows elapsed time + ETA based on average per-tile rate. When no key is configured the modal also surfaces a "Configure key" link that deep-links to Settings.
- **Fallback messaging** — under the "Use AI upscale" checkbox, a hint appears whenever no Gemini key is set, with an inline "Configure" button that opens Settings + focuses the API key field.
- **README + `docs/consoles.md`** updated to describe the AI upscale workflows (bake-now, lazy runtime, self-upgrading file) and the API-key UX.
- **Rate-limit handling in `NanoBananaClient`** — retry-with-backoff (max 4 attempts by default; exponential 1 → 8 s + jitter) on `429` and `5xx`, honouring `Retry-After`. New `RateLimitError` subclass surfaces "exhausted retries" cleanly. Default bake-now concurrency lowered from 4 to 2 since Gemini's free tier is aggressive about throttling.
- **Permanent quota detection** — when Gemini reports `limit: 0` (the free tier has no quota for the image model) or `RESOURCE_EXHAUSTED` with billing-required messaging, the client throws `QuotaExceededError` immediately without retries. The bake-now pipeline propagates the error instead of silently falling back to nearest-neighbour for every tile, so the UI can show a useful "enable billing" message instead of a misleading success.
- **Per-game upscale prompt** ([`src/convert/prompt-builder.ts`](src/convert/prompt-builder.ts)) — at the start of each AI conversion (bake-now) and on Poncho-NES + CHR-RAM cart load (runtime), call the *text* Gemini model (`gemini-2.5-flash`, separate quota from the image model) once with the game's `RomMeta` (title, year, publisher, developer, genre, subtitle). The model drafts a 3-5 sentence directive — genre / vibe / standard upscaling rules / sprite-detail guidance — that's used as the per-tile prompt for every image API call.
  - `UpscaleClient.upscaleTile` gets an optional 3rd `prompt` arg (mock ignores; nano-banana uses per-call override or constructor default).
  - `convertInesToPonchoAi` accepts `customPrompt`; `UpscaleWorker` accepts `prompt` config + `setPrompt(...)` for async swap-in.
  - In-memory `Map<title, prompt>` cache; one text call per game per browser session.
  - The bake-now modal exposes the generated prompt under a collapsible "Per-tile prompt" section.
  - Failures silently fall back to the client's default prompt — conversion never breaks because of the optional polish.
- **Cancel keeps the partial bake** — pressing Cancel mid-conversion no longer throws away the work. `convertInesToPonchoAi` fills remaining tiles with nearest-neighbour, assembles the `.poncho`, and returns with `notes.cancelled = true` + `notes.cancelledTiles`. The web UI saves the partial cartridge and shows e.g. "Cancelled at 50/512 tiles — partial saved." Useful for sampling: bake the first N tiles, hit Cancel, play the half-baked cartridge to inspect AI output before committing to the full run.
- **Fix: pv3 collapsed to pv2 in AI bake** — the bake-now neutral palette `[0x00, 0x10, 0x20, 0x30]` had `0x20` and `0x30` both at pure white in the canonical NES master palette. The primer image sent to Gemini therefore showed pv2 and pv3 as identical pixels; the snap-back step couldn't recover the original distinction and silently mapped every pv3 to pv2, breaking colour-3 in every AI-baked tile. Replaced with four hue-distinct indices `[0x0f, 0x16, 0x2a, 0x12]` (black / red / green / blue) and added a regression test that asserts all four entries map to RGB-distinct colours in the canonical master palette.

### Changed — v0.4 Phase 4.5 (stabilisation): bake-now output shape rework

The previous bake-now output (`upscaledMode = false`, 64×-larger CHR, no
cache section) was structurally wrong for iNES-derived games: PpuUltra's
native render path doesn't honour `PPUCTRL.bgPatternBase`, doesn't go
through the mapper for CHR banking, and uses 8-byte sprite OAM with
512-byte $4014 DMA. Any cart that switched CHR banks (CNROM, MMC1, MMC3,
…) or used the second pattern table (most games) rendered scrambled.

Bake-now now produces an **upscaled-mode** `.poncho` with the original
NES CHR verbatim and a populated AI cache section. PpuUltra's existing
upscaled-mode resolver path (built in Phase 3 for CHR-RAM) splices the
AI tiles in per-tile during render — banking, pattern-base, and 4-byte
OAM all work correctly because the cart still looks NES-shape to the
mapper + PPU.

- `convertInesToPonchoAi` outputs `upscaledMode: true`, `aiCachePresent: true`, `chr = ines.chrRom` verbatim, AI cache section populated with one entry per unique tile.
- `App.maybeStartAiWorker` now installs the resolver for any upscaled-mode cart with an AI cache section (not just CHR-RAM). Without an API key, the worker uses `MockUpscaleClient` so seeded AI tiles still render; periodic 60 s flush + write-back is still gated on CHR-RAM (no point polluting a baked CHR-ROM cart with mock NN content on a miss).
- New shared `TILE_HASH_PALETTE` constant in `tile-cache.ts` — bake-now and the runtime worker now hash with the *same* fixed palette, so a baked tile's hash matches the runtime resolver's lookup hash. Drops the per-render-context palette discrimination from the cache key (palette is still passed to the AI client as primer context for visual fidelity).
- `UpscaleWorker` no longer drops seeded entries on `model` mismatch — AI-baked carts loaded without an API key still render their seeded tiles via the mock client.
- **Tighten upscale prompt against content invention** — Bomberman BG decoration tiles were rendering as tiny full Bomberman characters because the per-game prompt said "encourage tasteful HD-detail additions" and the model used the game name to invent subjects in every tile. Both `buildMetaPrompt` (per-game directive) and `DEFAULT_PROMPT` (fallback) now explicitly forbid content invention: the prompt frames each input as "one small fragment of pixel art — likely abstract or partial, NOT a complete scene or character" and tells the model not to add characters, faces, objects, or "details". Added a regression test that rejects future relaxations of this rule.
- **Per-tile prompt now carries deterministic game context + HD-remake framing** — previously the per-tile prompt was just whatever 3-5 sentence directive Gemini's text model wrote (which mentioned game info only at Gemini's discretion). Now `buildGameUpscalePrompt` always composes a deterministic preamble — structured `RomMeta` line ("Castlevania (Konami, 1986, Platformer / Horror). USA · Rev A.") + an "imagine ONE tile from a hypothetical modern HD remake of <game>…" framing + the anti-invention guard — and prepends it to whatever creative seasoning Gemini provides. Network failures fall back to the preamble alone (still useful) instead of returning null. The Gemini meta-prompt has been retuned to ask for *complementary* creative seasoning (art-direction era, dominant materials, lighting/mood, palette character) since the structured context is now reliably in place. Encourages the model to imagine each tile as a fragment of an HD remake of the specific game without inventing new subjects.
- **Encourage HD detail within each colour region (without inventing new content)** — Phase 4.5's "do not invent" pass overcorrected and stripped out shading/gradient instructions too. The prompts now explicitly distinguish "ENCOURAGED: refining edges, subtle shading, hinted material (stone / metal / cloth), depth/bevel/glow consistent with the game's aesthetic" from "FORBIDDEN: new shapes, characters, faces, logos, scenes, objects, recognisable subjects". Both `buildMetaPrompt` and `DEFAULT_PROMPT` updated; the preamble explicitly invokes the HD-remake aesthetic.

### Changed — v0.4 Phase 4.7: NanoBanana strip + model-registry pivot

The Gemini 2.5 Flash Image cloud-API path has been removed entirely. The supporting infrastructure built for it survives unchanged — the AI cache section format, the `UpscaleClient` boundary, the `UpscaleWorker`, the PpuUltra resolver hook, the bake-now pipeline, the repack/write-back flow, the tile cache + hashing — these are all generic and now slot behind a model registry.

- **New: `src/convert/upscale-registry.ts`** — `UpscaleModel` interface (id, label, description, `cacheModelId`, `supportedWorkflows`, `create()` factory) plus a small set of helpers (`listUpscaleModels`, `getUpscaleModel`, `resolveUpscaleModel`, `createUpscaleClient`). Adding a new model (e.g. ESRGAN on WebGPU) is one file: implement `UpscaleClient`, allocate a `cacheModelId` in `ai-cache.ts`, register the model definition. Only the deterministic 4× nearest-neighbour fallback ships in this phase; real models land in Phase 5.
- **Removed**: `NanoBananaClient` + `RateLimitError` + `QuotaExceededError` + the inline NES master palette + the per-tile PNG codec from `upscale-client.ts`. Removed `src/convert/prompt-builder.ts` (Gemini-text-specific) and its tests. Removed `tests/convert/upscale-client-retry.test.ts` and `tests/integration/ai-upscale-bombjack.test.ts`. Removed `customPrompt` from `convertInesToPonchoAi`, `prompt` from `UpscaleWorker`, and the optional 3rd `prompt` argument from `UpscaleClient.upscaleTile`. Removed `App.applyAiGamePrompt`. Removed `AI_CACHE_MODEL_NANOBANANA_25_FLASH`.
- **Config schema change**: `config.ai` is now `{ romModelId, ramModelId, modelConfig: Record<id, blob> }` (was `{ apiKey: string }`). Defaults: both ids set to `"nearest-neighbour"`. Per-model arbitrary config lives under `modelConfig[id]` so a future model can carry its own settings without a schema migration.
- **Settings UI change**: replaced the masked Gemini API-key field with two dropdowns — "CHR-ROM (bake-now)" and "CHR-RAM (runtime)" — populated from the registry. A live description blurb beneath the dropdowns explains the trade-off the user just picked. Workflow-incompatible (model, workflow) pairs are greyed out.
- **App / RomsPanel / CLI**: bake-now + runtime worker now construct their client via `createUpscaleClient(modelId, workflow, modelConfig)`. Modal label reflects the selected model + flags fallback when the requested model is unavailable. CLI `--ai` always runs the deterministic NN client (a Node-side model runner is a future addition).
- **Tests**: added `tests/convert/upscale-registry.test.ts` (8 tests). 443 tests total, typecheck clean.

### Added — v0.4 Phase 4.6: extended sub-palettes (richer-than-4-colour BG)

PpuUltra's resolver-hit BG render branch can now address up to 256
distinct pv values per tile, indexing into a 256-entry RGBA "extended
sub-palette" built lazily from the cartridge's NES-shape 4-entry sub-
palette. AI / future-model output gains room to express gradients,
soft shading, and material highlights; the framebuffer renders them
without any format change to `.poncho`.

- **New module**: [`src/runtime/extended-palette.ts`](src/runtime/extended-palette.ts).
  - `buildExtendedSubPalette(subPalette, masterPalette): Uint32Array(256)`
  - `snapToExtendedPalette(r, g, b, ext)` — closest-pv lookup for
    future RGB-output clients (e.g. ESRGAN snap-back).
- **Encoding** (backward-compatible, **no format-version bump**):
  - `pv 0..3` → sub-palette entries 0..3 verbatim. Pre-4.6 AI caches
    that only used `pv 0..3` render unchanged.
  - `pv 4..87` → 84-shade ramp of base 1 (sub-palette entry 1):
    shade 0 = black, shade 41 = base 1, shade 83 = white. Linear RGB
    interpolation.
  - `pv 88..171` → ramp of base 2.
  - `pv 172..255` → ramp of base 3.
- **PpuUltra**: drops the `pv & 3` mask in the resolver-hit BG branch;
  indexes the 256-entry extended palette directly. The 4 BG extended
  sub-palettes are rebuilt lazily on first scanline after a palette-RAM
  or master-palette write (the existing `refreshBgColor()` path
  invalidates them; the existing `$2007` palette write site already
  funnels through that).
- **Sprites unchanged in this phase** — still go through the NES-tile
  NN path. Native-tile sprite rendering with the extended palette
  needs a separate design pass for transparency semantics; deferred.
- **MockUpscaleClient unchanged** — its `pv 0..3` output still hits
  the legacy slots in the extended palette, producing identical
  pre-4.6 colours via the new code path.
- **Tests**: [`tests/runtime/extended-palette.test.ts`](tests/runtime/extended-palette.test.ts)
  (10 tests: layout, legacy-pv mirroring, ramp endpoints, ramp-base
  shade, monotonic luminance, alpha preservation, error paths,
  snap-back). All existing PPU regression tests still pass — the
  legacy `pv 0..3` slots match the old behaviour exactly. Total now
  453 tests pass / 1 skipped (was 443).

### Added — v0.4 Phase 5a: ONNX runtime + Real-ESRGAN-x4plus (first local model)

- **`OnnxUpscaleClient`** ([`src/convert/clients/onnx-upscale-client.ts`](src/convert/clients/onnx-upscale-client.ts)) — generic ONNX-runtime-backed `UpscaleClient`. Lazy dynamic import of `onnxruntime-web` (heavy WASM bundle stays out of the main bundle until the user picks the model). Per-tile pipeline: `renderPrimer` → preprocess to NCHW/NHWC tensor in [0..1] or [-1..1] → `session.run` → postprocess → `snapToExtendedPalette` (Phase 4.6 helper). Test seam: `OrtFacade` interface + `ortFactory` / `modelLoader` hooks.
- **Real-ESRGAN-x4plus** registered in `upscale-registry.ts`. Hard-coded I/O shape (8×8 → 32×32, NCHW, RGB, [0..1]) matches the standard export. `cacheModelId = 1`.
- **Browser model-asset cache** ([`src/platform/web/model-asset-cache.ts`](src/platform/web/model-asset-cache.ts)) — `WebModelAssetCache` implements the new `ModelAssetCache` Platform interface using the browser Cache Storage API. Persistent across reloads; progress events for the Settings UI bar; sidecar JSON entries for size + cachedAt metadata. Wired into the registry via `UpscaleModelContext.loadAsset` so ESRGAN weights cache after the first load.
- **Bundled model files (`npm run setup:models`)** ([`scripts/download-models.ts`](scripts/download-models.ts), [`scripts/models-manifest.json`](scripts/models-manifest.json)) — manifest-driven downloader fetches ONNX weights into `public/models/` (gitignored). Idempotent, verifies optional `expectedSize`/`sha256`, streams with progress. The build serves files at `/models/<filename>.onnx` (Vite's `public/` convention) so prod inherits them via the deploy pipeline.
- **Settings UI** for the per-model state (under "AI upscale", visible when ESRGAN is selected): "Installed (X MB)" / "Available (Y MB on server). Click Pre-cache to download into the browser cache" / "Model file not installed. Run `npm run setup:models`." Plus Pre-cache / Clear-browser-cache buttons + progress bar. **No URL paste field** — the model file ships with the application.

The runtime CHR-RAM flow is unchanged from the NanoBanana days — just routed through the new client. Cart load → `UpscaleWorker` with the cart's existing aiCache as seed → PpuUltra resolver wired → tiles upscale in the background → 60 s flush + cart-eject write-back persists to the `.poncho`. ESRGAN's per-tile latency (5–50 ms on WebGPU) means tiles "pop in" sub-frame instead of multi-second.

**Tally:** 489 tests pass / 1 skipped (was 457; +32 from `OnnxUpscaleClient`, `WebModelAssetCache`, registry context-passing). Build emits the same code-split chunks — main bundle stays small until the user opts in.

### Changed — Convert UX: dedicated L3 panel, model picks per conversion

- **New L3 "Convert .nes" panel** ([`src/shells/web/ui/panels/convert-panel.ts`](src/shells/web/ui/panels/convert-panel.ts)) replaces the inline checkbox + auto-fired file picker that lived in `RomsPanel`. Click "Convert .nes" → slide-out with file picker, "Use AI upscale" toggle, and (when AI is on) bake-now + runtime model dropdowns. After a successful save the form resets and L2/L3 dismiss.
- **Model selection moved out of Settings.** AI is a per-conversion decision, not a global preference; Settings is back to Appearance / Video / Audio / Controls. `config.ai.romModelId`/`ramModelId` are kept as boot-time defaults for the ConvertPanel dropdowns.
- **`RomsPanel` slimmed down** — no more `handleConvert` / `runAiConvert` / progress modal / AI hint markup. The Convert button now just opens the L3 panel.

### Changed — Convert UI simplified: only NN, attach-your-own model

After Phase 5a's three model candidates (Real-ESRGAN-x4plus, AnimeSharpV4, SPAN-x4-ch48) all failed the quality bar on pixel-art primer — sub-perceptual edges, fp16 binding edge cases, scrambled-tile output respectively — the shipped registry now exposes only the deterministic NN fallback:

- **Convert .nes panel UX**: the "Use AI upscale" checkbox is renamed **Upscale** and is **on by default**. The bake-now / runtime model dropdowns + the long explanatory paragraph are removed. The panel now offers a single **Attach custom model (.onnx)** button so users can drop in their own ONNX export.
- **Custom-model wiring** assumes the standard pixel-art SR contract (8×8 → 32×32, NCHW, RGB, [0..1] fp32, pin names `input`/`output`). Mismatched models surface a clear preflight error to the status line instead of silently NN-fallbacking every tile.
- **Registry**: `ESRGAN_X4_PLUS_MODEL` removed from the `MODELS` map. The `ESRGAN_X4_PLUS_MODEL_URL` constant + `OnnxUpscaleClient` exports stay — used by the Node CLI and the new attach-your-own path.
- **Node CLI** (`npm run poncho:convert`) gained `--model Real-ESRGAN-x4plus` and `--model 4x-spanx4-ch48` flags for offline baking via `onnxruntime-node` (CoreML on macOS at 60 ms / 1.4 ms per tile respectively, CPU fallback). Useful when in-browser inference freezes or you want to validate a model without browser-side dependencies. `onnxruntime-node` joins as a `devDependency`.
- **Hardening** before the simplification landed: pre-flight session creation in `OnnxUpscaleClient` (`preflight()`) so missing-model failures abort the bake instead of NN-fallbacking 100% of tiles; `onSessionPhase('compiling' | 'ready')` callback drives a "Compiling model and warming up GPU…" status when the bar is at 100% but `InferenceSession.create` is still parsing protobuf; `evictAsset` ctx hook auto-clears poisoned Cache Storage entries on parse failure; `wasmPaths = '/ort/'` set explicitly so Safari's strict URL parser doesn't reject ORT's `import.meta.url`-relative sidecar resolution.

### Fixed — Poncho-NES: dynamic nametable mirroring now reaches PpuUltra

**Bug.** Battletoads and other dynamic-mirroring carts rendered with
the wrong nametable mid-game. `PonchoNes.loadRom` called
`ppu.setMirroring(cart.mapper.mirroring())` exactly once at boot;
PpuUltra cached the value and read from cache during render. AxROM
flips single-low ↔ single-high on every PRG write to `$8000-$FFFF`,
MMC1 changes mirroring via its control register, MMC3 via `$A000` —
all silently lost. Stage transitions, status-bar splits, and
parallax effects rendered against stale mirroring.

**Fix.** PpuUltra grows a `setMirroringSource(fn: () => Mirroring)`
callback that mirrors the design of the existing `chrReader` —
installed once, queried live on every nametable fetch. `PonchoNes`
wires it to `() => cart.mapper.mirroring()` in `loadRom`, clears it
in `unload`. The cached `nametableMirroring` field stays as a
fallback for hand-crafted Poncho-NES games + tests that drive the
PPU directly without a cartridge mapper.

The change parallels classic NES — `PpuBus.mirrorNametable()` already
does `mapper.mirroring()` on every fetch — so both PPUs now share
the same architectural pattern for mapper-driven dynamic state.

- [`src/core/ppu-ultra/ppu-ultra.ts`](src/core/ppu-ultra/ppu-ultra.ts):
  new `mirroringSource` field + `setMirroringSource()` setter +
  private `currentMirroring()` getter. Six render-path call sites
  (BG fixed-Y native render, BG upscaled-mode render, native
  per-tile-pixel helper, sprite render, `readVramByte`, `vramWrite`)
  switched from direct field reads to the getter.
- [`src/console/poncho-nes.ts`](src/console/poncho-nes.ts): `loadRom`
  installs `() => cart.mapper.mirroring()` after `setMasterPalette`;
  `unload` clears it.
- [`tests/ppu-ultra/mirroring-source.test.ts`](tests/ppu-ultra/mirroring-source.test.ts):
  4 new tests covering source-overrides-cached, source-then-null,
  AxROM-style mid-game flip, and initial-fallback-without-source.

Total now 457 pass / 1 skipped (was 453).

## [0.3.0] — 2026-05-07

> Poncho-NES native runtime + iNES converter. The runtime gains everything needed
> to play a converted Contra: per-scanline rendering, sprite-0 hit, 8×16 sprites,
> all major mapper banking variants, CHR-RAM, palette mirroring, and `$2007` read
> buffering. The converter wraps any iNES ROM (NROM/MMC1/UxROM/CNROM/MMC3/AxROM)
> as an upscaled-mode `.poncho` cartridge that runs on PpuUltra without any
> compatibility shims at runtime. A "Convert .nes" UI button puts the workflow
> directly in the web shell. See [`docs/v0.3.0-plan.md`](docs/v0.3.0-plan.md) for
> the full release plan.
>
> Validation: Contra title screen + first level boot through the converter and
> render essentially identically to the classic NES emulator (99–100% pixel match
> outside of heavy-sprite scenes where Poncho-NES legitimately renders more
> sprites than NES would due to the latter's 8-per-scanline hardware limit).

### Added — Track A: runtime

- **PonchoROM format extension (Phase 1)**
  - `flags.upscaledMode` (bit 0): renamed from `nesCompat` and re-purposed. When set, the cartridge declares NES-shape CHR (8×8 2 bpp) and NES-shape OAM (4-byte sprites at 8-bit coords); PpuUltra renders each NES pixel as a 4×4 block. Both upscaled and native (clear) modes are first-class native capabilities of the chip — no compat layer.
  - `mapperSubmode` formalised: bits 0–7 = PonchoMapper banking variant (0 = NROM-style, 2 = UxROM-style, 4 = MMC3-style, etc., matching iNES mapper numbers); bits 8–9 = boot-time nametable mirroring; bits 10–15 reserved. Codec helpers `encodeMapperSubmode` / `decodeMapperSubmode` exported from [`src/core/cart-poncho/header.ts`](src/core/cart-poncho/header.ts).
  - **CHR-RAM allocation**: when `chrRamKb > 0`, [`PonchoCartridge`](src/core/cart-poncho/cartridge.ts) allocates a writable CHR-RAM buffer of the declared size and exposes `chrIsRam = true`.
- **PonchoMapper banking variants (Phases 2 + 8)** — full set of variants in [`src/core/mappers-poncho/variants/`](src/core/mappers-poncho/variants/), each implementing `Mapper` directly with its own state. Selected at construction from `mapper_submode` low byte:
  - **NROM-style** (variant 0) — flat mirror, no banking.
  - **UxROM-style** (variant 2) — 16 KB switchable @ $8000-$BFFF, fixed last bank @ $C000-$FFFF, bank-select on any write to $8000-$FFFF.
  - **MMC1-style** (variant 1) — 5-bit serial register protocol; PRG modes 0/1 (32 KB), 2 (fixed first / switch second), 3 (switch first / fixed last); CHR modes 0 (single 8 KB) / 1 (two 4 KB); runtime mirroring control. Bit-7 reset forces PRG mode 3.
  - **CNROM-style** (variant 3) — any write to $8000-$FFFF selects an 8 KB CHR bank.
  - **MMC3-style** (variant 4) — per-1 KB CHR banking with two layout modes; PRG/CHR mode swap; scanline IRQ counter clocked by filtered PPU A12 0→1 edges (10-dot low filter via `tickPpu`). Four-screen mirroring locked when boot mirroring is four-screen.
  - **AxROM-style** (variant 7) — 32 KB switchable PRG bank; bit 4 of bank-select toggles single-low vs single-high mirroring.
  - PonchoMapper restructured as a thin delegating wrapper.
- **Multi-nametable + mirroring (Phase 3)** — PpuUltra honors the four logical nametables ($2000/$2400/$2800/$2C00) under horizontal / vertical / single-low / single-high. Four-screen falls back to vertical until cart-supplied 4 KB VRAM lands. PPUCTRL `baseNametable` + $2005 scroll fold into a 2 × 2 virtual nametable grid; tile + attribute fetches re-base on nametable-boundary crossings. Exported helper `resolvePhysicalNT(logicalNT, mirroring)`.
- **Upscaled-CHR render path (Phase 4)** — PpuUltra walks 8×8 2 bpp NES tiles in 256×240 NES-pixel coordinate space, painting each NES pixel as a 4×4 block in the 1024×960 framebuffer. CHR fetched via `chrReader` callback (wired to `mapper.ppuRead`); `$2007` writes in `$0000-$1FFF` route through `chrWriter` so PRG-driven CHR-RAM uploads persist. `setUpscaledMode(bool)` toggles the path.
- **Upscaled-OAM render path (Phase 5)** — `$4014` OAM DMA copies 256 bytes when `upscaledMode` is set; PpuUltra walks 64 × 4-byte NES OAM (`[y, tile, attr, x]`); position scaled ×4 from NES → Poncho px; sub-palette from attr bits 0–1, flip-H bit 6, flip-V bit 7; off-screen `y >= 0xEF` skipped.
- **Sprite-0 hit + 8×16 sprite mode (Phase 6)** — sprite-0 hit pre-computed at the pre-render scanline, fired during the matching visible-scanline dot. PPUCTRL bit 5 selects 8×16 sprites: tile LSB picks pattern table, `tile & 0xFE` is the top tile, `+1` is the bottom; renders as a 32×64 Poncho block.
- **Per-scanline BG rendering (Phase 7)** — PpuUltra's BG render moved out of vblank-entry into a per-scanline event in `tick()`. `renderScanlineUpscaled(nesY)` paints the 4 Poncho rows for one NES scanline using the chip's CURRENT state; called at dot 340 of each visible scanline. Mid-frame palette / scroll / `showBg` writes take effect on the next-rendered scanline. Eager `renderFrameUpscaled()` becomes a thin loop over the new method (used by direct-render unit tests). `refreshBgColor` no longer fills the framebuffer (would wipe per-scanline output on mid-frame palette writes).

### Added — Track B: converter

- **iNES → upscaled-mode PonchoROM converter v2 (Phase 9)** — [`src/convert/ines-to-poncho.ts`](src/convert/ines-to-poncho.ts). Replaces the v0.2 NROM-only converter. Supports all 6 PonchoMapper banking variants. PRG copied verbatim. CHR-ROM embedded verbatim; CHR-RAM games get `chrRamKb=8`. iNES mirroring maps into the boot-mirroring sub-field of `mapper_submode`. `flags.upscaledMode = 1`. Source iNES CRC32 recorded in the header. Lives under `src/` so the web shell imports client-side; `scripts/lib/ines-to-poncho.ts` is a thin re-export.
- **"Convert .nes" button in the ROMs panel** (web shell) — visible only when Poncho-NES is the active console; sits next to "Upload .poncho". Opens a file picker accepting `.nes`. On selection: client-side conversion, result stored in the IndexedDB library under `basename.poncho`, list refreshed. Conversion errors surface in the status bar.
- **Phase 10 — Contra end-to-end validation** — found and fixed four PpuUltra correctness issues that surface only against real games:
  - **Palette mirroring** — `$3F10/$3F14/$3F18/$3F1C` writes now mirror to `$3F00/$3F04/$3F08/$3F0C` per NES hardware. Universal-BG was going stale when PRG wrote via the mirror. New free function `mirrorPaletteAddr(addr)`.
  - **`$2007` (PPUDATA) reads** — implemented with the standard 1-byte read buffer for `$0000-$3EFF` and direct read for `$3F00-$3FFF` (with buffer refilled from `addr-$1000`). Previously returned 0.
  - **Sprite y-coordinate hardware delay** — NES OAM y stores `actual_y - 1`; sprites display at `(yNes + 1)..(yNes + height)`. PpuUltra was rendering one scanline too high. Fixed in `renderSpritesUpscaled` and `computeSprite0HitScanline`.
  - **Sprite priority order** — NES draws lower-index sprites *in front of* higher-index. Iteration reversed (63 → 0).
- **Diagnostic harness** — [`scripts/diagnose-contra.ts`](scripts/diagnose-contra.ts): converts Contra, runs both consoles in parallel for N frames, dumps cross-console state diff (CPU PC, CPU RAM, OAM, palette, nametable, CHR), per-pixel match count, and a register-write timeline. Reusable for future game debugging.

### Synthetic test ROMs (committed under `tests/roms/poncho/`)

One per phase, generated via `npm run gen:poncho:<name>`:
`uxrom-bankswitch`, `multi-nametable`, `upscaled-chr`, `upscaled-sprite`, `sprite0-hit`, `sprite-8x16`, `scanline-split`, `mmc1-bankswitch`.

### Tests

84 net new tests across the v0.3.0 cycle. Final count: **366 passed, 1 skipped** (up from 276 at v0.2.0).

### Format spec

[`docs/poncho-rom.md`](docs/poncho-rom.md) updated with the new "Upscaled vs native modes" table, the formalised "Mapper submode" section, and the rewritten "Conversion from iNES" pipeline that matches the v0.3 architecture (verbatim PRG/CHR, no transpiler).

### Documentation

- New [`docs/v0.3.0-plan.md`](docs/v0.3.0-plan.md) — phased roadmap (this release).
- New [`docs/v0.4.0-plan.md`](docs/v0.4.0-plan.md) — wider game coverage + regression harness + AI upscaling.

### Pre-v0.3-plan changes (still part of the 0.3 release)

These shipped on `main` between v0.2.0 and the v0.3.0 plan kickoff:

- **Overscan crop** for Classic NES ([`src/renderer/filters/overscan.ts`](src/renderer/filters/overscan.ts)). `OverscanCropFilter` trims a configurable number of pixels from each edge, hiding the BG-LEFT clip region that games expose during horizontal scrolling. Defaults: Left 8, Top/Bottom/Right 0. Per-side values editable in Settings → Video (4 inputs appear when the checkbox is ticked). Hidden entirely for Poncho-NES (native 1024 × 960 output).
- **ROMs panel filters by active console's extension** — `.nes` for Classic NES, `.poncho` for Poncho-NES. Upload button label and panel title update on console switch.
- **NES-compat sub-mode removed** from Poncho-NES (initial pre-Phase-1 cleanup; replaced by the v0.3 upscaled-mode flag). `PpuUltra.setNesCompat()` / `setChrReader()` / `renderFrameNesCompat()` removed. `BusCartridge` structural interface dropped; the bus is typed directly to `PonchoCartridge`.

### Fixed (overscan UI bugs)

- Overscan inputs were visible on panel open even when overscan was disabled. Root cause: `display: grid` on `.overscan-inputs` overrode the `hidden` attribute. Fixed with `.overscan-inputs[hidden] { display: none; }`.
- Users with configs from earlier sessions received stale overscan values (8/8/8/8). Config version bumped 1 → 2; the v1 → v2 migration resets overscan to the correct defaults.
- White/black border appeared around the viewport when overscan was active. Removed the hardcoded `aspect-ratio: 16 / 15` from `#screen`; the canvas's intrinsic dimensions already encode the correct ratio.

### Known divergence vs Classic NES

- **8-sprites-per-scanline limit** — Poncho-NES renders all 64 sprites without per-scanline truncation. Classic NES drops sprites past 8 on a given scanline (causing the famous flicker). For Contra and similar sprite-heavy games, this means Poncho-NES shows ~5–20% more pixels per frame in heavy scenes. This is an intentional design enhancement, not a bug.

## [0.2.0] — 2026-05-06

### Added
- **Console abstraction layer** at `src/console/`. `src/core/` is now a pure chip library; both `nes.ts` and `poncho-nes.ts` compositions wire chips into a virtual console behind a shared `Console` interface.
- **Poncho-NES** — second virtual console (status: `beta`). 4× linear resolution (1024×960), 32-bit RGBA palette, 32×32 sprites, custom PonchoROM cartridge format. The Ultra PPU additionally exposes a NES-compat sub-mode that boots ordinary `.nes` files at 4× pixel-block scale via the existing iNES mappers. See `docs/consoles.md` and `docs/poncho-rom.md`.
- Console-selector UI: top sidebar icon (Lucide `cpu`, hotkey `0`) opens an L2 panel listing every console from `ALL_SPECS`. Selection persists in `general.selectedConsoleId`; the sidebar tooltip dynamically reflects the active console's name.
- `ConsoleSpec` data type + [`src/console/specs.ts`](src/console/specs.ts) — single source of truth for UI panels and the README. `status` enum is `'working' | 'beta'`.
- [`docs/consoles.md`](docs/consoles.md) — virtual-console catalogue and architecture rationale.
- [`docs/poncho-rom.md`](docs/poncho-rom.md) — full design spec for the PonchoROM format.
- PonchoROM header parser + writer at [`src/core/cart-poncho/`](src/core/cart-poncho/). 29 unit tests cover round-trip, every header field, accept/reject paths, CRC32, and alignment errors.
- 2C02-Ultra PPU at [`src/core/ppu-ultra/`](src/core/ppu-ultra/) — 1024×960 framebuffer, NES-compatible scanline timing, NES-shaped 32-byte palette RAM, register file for `$2000` (auto-increment), `$2006` (VRAM address latch), `$2007` (auto-incrementing data write). Master palette stored as ABGR Uint32.
- BG tile-render pipeline in the Ultra PPU: 32×32 8 bpp tiles fetched from cartridge CHR, 30×32 nametable cells, NES-style attribute-table decode → sub-palette selection (4 sub-palettes × 4 colours), eager full-frame render at vblank-start. Tile-pixel values currently masked `& 3` to fit NES-shape sub-palettes; expansion to 256-entry sub-palettes is additive.
- Sprite OAM + sprite render path: 64 sprites × 8 bytes (Poncho-NES layout: y(16), x(16), tile(16), attr, size). Power-on OAM = `0xFF` so uninitialised sprites are off-screen. Registers `$2003` OAMADDR / `$2004` OAMDATA implemented; `$4014` OAM DMA copies 512 bytes from a CPU page. Sprite renderer: 32×32 sprites only (v1), per-spec attr bits (sub-palette in 0-1, BG priority in 2 — not yet enforced — flip-H in 3, flip-V in 4), sprite-pixel-0 = transparent. Drawn after BG, no per-scanline limit yet.
- Full PPU register file: `$2000` PPUCTRL (all bits decoded — base nametable, VRAM increment, BG/sprite pattern bases, sprite size, NMI enable), `$2001` PPUMASK (BG/sprite enable + greyscale + emphasis tracked), `$2002` PPUSTATUS (vblank flag, sprite-0 hit, sprite overflow; reading clears vblank + the $2005/$2006 toggle), `$2005` PPUSCROLL (two-write X then Y, toggle shared with `$2006`).
- NMI delivery: `PpuUltra.setNmiCallback()` wired by `PonchoNes` to `cpu.triggerNmi()`. NMI fires at vblank-start when PPUCTRL bit 7 is set; flags clear at the pre-render scanline.
- BG scrolling: per-pixel BG render with `scrollX` / `scrollY` offsets. Source coords wrap at the single-screen nametable edge (4-screen / mirroring lands when needed).
- New synthetic test ROM `tests/roms/poncho/nmi-scroll.poncho` — PRG enables NMI, NMI handler increments a zero-page counter and writes the new scroll value via `$2005`. Integration test runs 9 frames and verifies the BG has shifted by 8 pixels.
- **NES-compat sub-mode** in the Ultra PPU. Poncho-NES now boots iNES `.nes` files alongside `.poncho` ROMs:
  - `PpuUltra.setNesCompat(true)` switches the renderer to walk 8×8 2 bpp NES tile data, painting each NES pixel as a 4×4 block in the 1024×960 framebuffer
  - CHR fetches go through `mapper.ppuRead()` so existing iNES mappers (NROM, MMC1, UxROM, CNROM, MMC3, AxROM) work unchanged
  - Built-in NES master palette at [`src/core/ppu-ultra/nes-master-palette.ts`](src/core/ppu-ultra/nes-master-palette.ts) — 64 RGBA entries derived from `src/core/ppu/palette.ts`
  - Sprite render in compat mode: 64 × 4-byte NES OAM entries, 8×8 sprites only (8×16 pending), per-NES attribute bits (sub-palette, flip-H bit 6, flip-V bit 7), drawn after BG
  - OAM DMA size selects 256 vs 512 bytes based on the compat flag
  - `PonchoNes.loadRom` magic-byte sniffs: `PNCH` → native PonchoROM path; `NES\x1A` → iNES NROM/MMC1/etc. via the existing `Cartridge` wrapper, with the Ultra PPU configured for compat
  - Bus accepts a structural `BusCartridge { mapper }` so iNES and PonchoROM cartridges share routing
- New synthetic iNES test ROM `tests/roms/poncho/compat-bg.nes` (NROM, 24 KB). Integration test loads it through `PonchoNes`, runs a frame, and verifies every pixel is `NES_PALETTE[1]` (master index 1, dark blue) — the BG → CHR → palette → master pipeline.
- Pending compat features (next batch): sprite-0 hit, 8×16 sprite mode, MMC3 IRQ counter accuracy, per-scanline timing, conversion CLI (`scripts/poncho-convert.ts`).
- **Console-selector UI**: a new sidebar icon at the top (Lucide `cpu`, hotkey `0`) opens an L2 panel listing every console from `ALL_SPECS` with name, description, status, PPU, and cart format. Clicking switches the active runtime — the App re-instantiates the chosen console class (`Nes` or `PonchoNes`), persists the selection in `general.selectedConsoleId`, and the sidebar tooltip dynamically reflects the active console name. Switching ejects any loaded ROM (different consoles accept different formats); the user re-picks from the library.
- PonchoMapper stub at [`src/core/mappers-poncho/`](src/core/mappers-poncho/) (flat PRG mirroring across $8000-$FFFF, no banking) and PonchoCartridge wrapper at [`src/core/cart-poncho/cartridge.ts`](src/core/cart-poncho/cartridge.ts).
- PonchoCpuBus at [`src/core/bus-poncho/`](src/core/bus-poncho/) — Poncho-NES CPU memory map.
- Poncho-NES composition at [`src/console/poncho-nes.ts`](src/console/poncho-nes.ts) — full chipset wired (CPU + APU + Ultra PPU + bus + PonchoMapper) with the same per-cycle CPU↔PPU↔APU sync model as the NES. `solid-bg.poncho` now boots through real 6502 PRG (a halt loop) instead of cycle-spinning the PPU directly.
- Console-detection registry at [`src/console/detect.ts`](src/console/detect.ts) — magic-byte sniff routes iNES bytes to `Nes`, PonchoROM bytes to `PonchoNes`. Adding a new console is one line.
- Three synthetic test ROMs (committed):
  - `tests/roms/poncho/solid-bg.poncho` — halt-loop PRG, single-colour master palette. Verifies header parse, palette upload, BG-colour render path.
  - `tests/roms/poncho/palette-write.poncho` — PRG writes a known index to `$3F00` via `$2006/$2007`, then halts. Verifies the full PRG → bus → PPU register-file → palette RAM → framebuffer pipeline.
  - `tests/roms/poncho/solid-tile.poncho` — PRG installs palette + writes 1024 nametable bytes (NES-shaped attribute table included), then halts; CHR tile 0 is filled with pixel value 1. Verifies the BG tile renderer end-to-end (CHR fetch → attribute decode → palette lookup → framebuffer).
  - `tests/roms/poncho/single-sprite.poncho` — PRG sets BG palette, sprite palette, and OAM[0..7] for one 32×32 sprite at (100, 80) using sprite sub-palette 0; halts. Verifies the OAM register file + sprite render path. Integration test counts exactly 1024 red pixels in the framebuffer.
  - Built by `npm run gen:poncho:{solid-bg,palette-write,solid-tile,single-sprite}`. Integration tests in `tests/integration/poncho-synthetic.test.ts` re-load each ROM via `detectConsole` and check pixel output.
- Shared `scripts/lib/png.ts` PNG encoder.
- Poncho logo (light + dark variants) at `src/shells/web/ui/`; brand area in the title bar now shows the theme-matched logo SVG instead of the text glyph. Logo also added to the README.
- [`ROADMAP.md`](ROADMAP.md) — themed list of near-term / mid-term / long-term work.
- Architecture overview at [`docs/architecture.md`](docs/architecture.md) with data-flow and module-layering diagrams.
- GitHub Pages deployment workflow (`.github/workflows/deploy.yml`).
- Browser-support matrix in the README.
- `scripts/render-screenshot.ts` — headless single-frame renderer used to refresh the README screenshot.
- Sidebar playback controls: Pause / Reset / Off — Eject buttons next to ROMs, with `1`–`5` keyboard shortcuts and instant retro tooltips.
- Sticky bottom status bar with a Settings → Appearance toggle to hide it.

### Changed
- `src/core/nes.ts` moved to `src/console/nes.ts` and now formally implements the new `Console` interface. Behaviour unchanged; 7 import paths updated across `src/shells/`, `tests/`, and `scripts/`.
- Each shell now owns its own App orchestrator and UI tree. `src/app.ts` and `src/ui/` moved into `src/shells/web/`. UI is no longer shared across shells.

## [0.1.0] — 2026-05-05

First public release.

### Emulation
- Cycle-accurate 6502 / 2A03 CPU: 151 official + 25 illegal opcodes, per-cycle bus accesses with phantom reads on indexed addressing and dummy writes on read-modify-write.
- Full 2C02 PPU: scanline-stepped background + sprite shifters, sprite-0 hit, sprite overflow, runtime mirroring, OAM DMA.
- All five APU channels (pulse × 2, triangle, noise, DMC) feeding the canonical NES non-linear mixer through 90 Hz / 440 Hz / 14 kHz analog filters.
- Cartridge mappers: NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 (4), AxROM (7).
- Passes `nestest` cleanly and the bulk of the blargg `apu_mixer`, `oam_*`, `apu_test`, and `sprite_*` suites; remaining failures share a single sub-cycle-timing root cause documented in [`DEFERRED.md`](DEFERRED.md).

### User interface
- Retro-NES aesthetic with `Press Start 2P` headers, `JetBrains Mono` data, NES-palette colours, optional scanline overlay.
- Light + dark themes, persisted across reloads.
- Three-level sliding panel layout (sidebar / detail / sub-detail), overlay-style on top of the canvas.
- Auto-extracted game title from filename (No-Intro / GoodNES naming) via the RomInfo client, cached by SHA-1.
- Rebindable keyboard controls; adjustable scale (1×, 2×, 4×) and audio volume.

### ROM management
- Browser storage: uploaded `.nes` files persist in IndexedDB across browser sessions.
- Server folder: files in `roms/` are served by a Vite middleware in development.
- Persistent metadata cache keyed by SHA-1.

### Architecture
- Shell-decoupled: emulator core, renderer, audio mixer, and UI panels are platform-agnostic; web shell lives behind a `Platform` interface in `src/platform/web/`.
- Pluggable rendering pipeline: separate filter and scaler stages.
- Pluggable RomInfo sources behind a unified cache.

[Unreleased]: https://github.com/DaJungle79/poncho/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/DaJungle79/poncho/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DaJungle79/poncho/releases/tag/v0.2.0
[0.1.0]: https://github.com/DaJungle79/poncho/releases/tag/v0.1.0
