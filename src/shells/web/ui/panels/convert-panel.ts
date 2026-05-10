/**
 * Convert .nes → .poncho L3 panel.
 *
 * Workflow:
 *   1. Click "Choose .nes file" → platform file picker.
 *   2. The "Upscale" checkbox is on by default. With it on the panel
 *      runs the AI bake-now pipeline; with it off the conversion is a
 *      plain verbatim wrap.
 *   3. (Optional) attach a custom `.onnx` model. Without one, upscale
 *      uses the deterministic 4× nearest-neighbour fallback.
 *   4. Click "Convert" → run the bake (with the progress modal),
 *      save into the ROM library, dismiss the panel.
 *
 * The shipped registry only exposes `nearest-neighbour`; the previous
 * ESRGAN/AnimeSharp/SPAN entries were dropped after their quality on
 * pixel-art primer didn't justify the runtime cost. The
 * "Attach custom model…" affordance keeps the path open for users who
 * want to drop in their own ONNX export.
 */

import { ConvertError, convertInesToPoncho } from '../../../../convert/ines-to-poncho';
import {
  AiConvertCancelled,
  convertInesToPonchoAi,
  type AiConvertProgress,
} from '../../../../convert/ines-to-poncho-ai';
import {
  createUpscaleClient,
  type UpscaleModelConfig,
  type UpscaleModelContext,
} from '../../../../convert/upscale-registry';
import {
  OnnxUpscaleClient,
  type OnnxUpscaleClientConfig,
} from '../../../../convert/clients/onnx-upscale-client';
import { AI_CACHE_MODEL_UNSPECIFIED } from '../../../../core/cart-poncho/ai-cache';
import type { UpscaleClient } from '../../../../convert/upscale-client';
import type { ConfigStore } from '../../../../config/store';
import type { LoadedRom } from '../../../../domain/rom';
import type { FilePicker, RomLibrary } from '../../../../platform/types';
import { mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';

export interface ConvertPanelDeps {
  config: ConfigStore;
  filePicker: FilePicker;
  romLibrary: RomLibrary;
  /** Pulls the per-model config blob (model URLs etc.) from `config.ai`. */
  getModelConfig: (modelId: string) => UpscaleModelConfig;
  /** Platform-level loader hooks so model assets cache across reloads. */
  getUpscaleContext: () => UpscaleModelContext | undefined;
  /** Bottom-status-bar callback — borrowed from RomsPanel. */
  onStatus?: (text: string) => void;
  /** Fires after a successful save so RomsPanel can refresh its list. */
  onConverted?: () => void | Promise<void>;
  /** Dismiss the convert flow — closes L3 (and any L2). */
  onClose?: () => void;
}

export class ConvertPanel implements Panel {
  readonly id = 'convert';
  readonly root: HTMLElement;

  private readonly fileButton: HTMLButtonElement;
  private readonly fileLabel: HTMLElement;
  private readonly aiCheckbox: HTMLInputElement;
  private readonly aiOptionsEl: HTMLElement;
  private readonly attachBtn: HTMLButtonElement;
  private readonly attachedRow: HTMLElement;
  private readonly attachedNameEl: HTMLElement;
  private readonly detachBtn: HTMLButtonElement;
  private readonly convertBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;

  /** File picked but not yet converted. Cleared on submit / cancel. */
  private picked: LoadedRom | null = null;
  /** User-attached custom ONNX model (bytes + display name). Optional. */
  private attachedModel: { name: string; bytes: Uint8Array } | null = null;

  constructor(private readonly deps: ConvertPanelDeps) {
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l3';
    this.root.innerHTML = `
      <header class="panel-head">
        <i data-lucide="file-input" class="panel-head-icon"></i>
        <h2>Convert .nes</h2>
      </header>
      <div class="panel-body">
        <button type="button" class="file-button" data-pick>
          <i data-lucide="folder-open"></i>
          <span data-pick-label>Choose .nes file…</span>
        </button>

        <label class="rom-ai-toggle convert-ai-toggle">
          <input type="checkbox" data-ai-checkbox checked>
          <span>Upscale</span>
        </label>

        <div class="convert-ai-options" data-ai-options>
          <button type="button" class="file-button file-button-compact" data-attach-model>
            <i data-lucide="paperclip"></i>
            <span>Attach custom model (.onnx)</span>
          </button>
          <p class="convert-attached-row" data-attached-model hidden>
            <span data-attached-name></span>
            <button type="button" class="rom-item-del" data-detach-model title="Detach">
              <i data-lucide="x"></i>
            </button>
          </p>
        </div>

        <button type="button" class="settings-link convert-submit" data-convert disabled>
          <i data-lucide="play"></i>
          <span>Convert</span>
        </button>

        <p class="settings-hint convert-status" data-status></p>
      </div>
    `;

    this.fileButton = this.root.querySelector<HTMLButtonElement>('[data-pick]')!;
    this.fileLabel = this.root.querySelector<HTMLElement>('[data-pick-label]')!;
    this.aiCheckbox = this.root.querySelector<HTMLInputElement>('[data-ai-checkbox]')!;
    this.aiOptionsEl = this.root.querySelector<HTMLElement>('[data-ai-options]')!;
    this.attachBtn = this.root.querySelector<HTMLButtonElement>('[data-attach-model]')!;
    this.attachedRow = this.root.querySelector<HTMLElement>('[data-attached-model]')!;
    this.attachedNameEl = this.root.querySelector<HTMLElement>('[data-attached-name]')!;
    this.detachBtn = this.root.querySelector<HTMLButtonElement>('[data-detach-model]')!;
    this.convertBtn = this.root.querySelector<HTMLButtonElement>('[data-convert]')!;
    this.statusEl = this.root.querySelector<HTMLElement>('[data-status]')!;

    this.bindEvents();
    this.syncAiOptions();
  }

  onShow(): void {
    mountLucideIcons();
    this.refreshSubmit();
    this.syncAiOptions();
  }

  // ----- Wiring -------------------------------------------------------------

  private bindEvents(): void {
    this.fileButton.addEventListener('click', () => { void this.handlePickFile(); });
    this.aiCheckbox.addEventListener('change', () => this.syncAiOptions());
    this.attachBtn.addEventListener('click', () => { void this.handleAttachModel(); });
    this.detachBtn.addEventListener('click', () => this.detachModel());
    this.convertBtn.addEventListener('click', () => { void this.handleSubmit(); });
  }

  private syncAiOptions(): void {
    this.aiOptionsEl.hidden = !this.aiCheckbox.checked;
  }

  private async handleAttachModel(): Promise<void> {
    let picked: LoadedRom | null;
    try {
      picked = await this.deps.filePicker.pick({ accept: ['.onnx'] });
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
      return;
    }
    if (!picked) return;
    this.attachedModel = { name: picked.name, bytes: picked.data };
    this.attachedNameEl.textContent = `${picked.name} (${formatSize(picked.data.length)})`;
    this.attachedRow.hidden = false;
    mountLucideIcons();
    this.setStatus(`Attached ${picked.name}.`);
  }

  private detachModel(): void {
    this.attachedModel = null;
    this.attachedRow.hidden = true;
    this.setStatus('Detached custom model.');
  }

  private async handlePickFile(): Promise<void> {
    let picked: LoadedRom | null;
    try {
      picked = await this.deps.filePicker.pick({ accept: ['.nes'] });
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
      return;
    }
    if (!picked) {
      this.setStatus('Pick cancelled.');
      return;
    }
    this.picked = picked;
    this.fileLabel.textContent = picked.name;
    this.refreshSubmit();
    this.setStatus(`${picked.name} (${formatSize(picked.data.length)}) ready.`);
  }

  private refreshSubmit(): void {
    this.convertBtn.disabled = this.picked === null;
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
    this.deps.onStatus?.(text);
  }

  // ----- Convert ------------------------------------------------------------

  private async handleSubmit(): Promise<void> {
    const picked = this.picked;
    if (!picked) return;

    const useAi = this.aiCheckbox.checked;
    const baseTitle = picked.name
      .replace(/\.nes$/i, '')
      .replace(/\s*\([^)]*\)/g, '')
      .trim();

    // CHR-ROM detection from iNES byte 5; 0 = CHR-RAM.
    const isChrRam = picked.data[5] === 0;

    let resultPoncho: Uint8Array;
    let summary: string;
    try {
      if (useAi && isChrRam) {
        // CHR-RAM tiles aren't known at conversion time — they're
        // generated by PRG at runtime, so bake-now has nothing to
        // process. Wrap verbatim; the runtime worker can fill the AI
        // cache lazily during play (currently NN-only).
        const result = convertInesToPoncho(picked.data, { title: baseTitle });
        resultPoncho = result.poncho;
        summary = `CHR-RAM ${result.notes.chrRamKb} KB (runtime upscale fills lazily)`;
      } else if (useAi) {
        const aiResult = await this.runAiConvert(picked.data, baseTitle);
        if (!aiResult) {
          this.setStatus('AI conversion cancelled.');
          return;
        }
        resultPoncho = aiResult.poncho;
        const n = aiResult.notes;
        const tilesDone = n.apiCalls + n.cacheHits;
        const partialPrefix = n.cancelled
          ? `Cancelled at ${tilesDone} / ${n.uniqueTiles} tiles — partial saved. `
          : '';
        summary =
          `${partialPrefix}native CHR ${n.chrKb} KB, ` +
          `${n.uniqueTiles} unique tiles, ` +
          `${n.failedTiles + n.cancelledTiles} fallbacks`;
      } else {
        const result = convertInesToPoncho(picked.data, { title: baseTitle });
        resultPoncho = result.poncho;
        const n = result.notes;
        const chrLabel = n.chrRamKb > 0 ? `CHR-RAM ${n.chrRamKb} KB` : `CHR ${n.chrKb} KB`;
        summary = `mapper ${n.sourceMapper}, ${chrLabel}, PRG ${n.prgKb} KB`;
      }
    } catch (err) {
      if (err instanceof ConvertError) {
        this.setStatus(`Conversion failed: ${err.message}`);
      } else {
        this.setStatus(`Conversion failed: ${(err as Error).message}`);
      }
      return;
    }

    const ponchoName = picked.name.replace(/\.nes$/i, '') + '.poncho';
    try {
      await this.deps.romLibrary.add(ponchoName, resultPoncho);
      await this.deps.onConverted?.();
    } catch (err) {
      this.setStatus(`Saved-to-library failed: ${(err as Error).message}`);
      return;
    }

    this.setStatus(`Converted ${picked.name} → ${ponchoName} (${summary})`);
    this.resetForm();
    this.deps.onClose?.();
  }

  private resetForm(): void {
    this.picked = null;
    this.fileLabel.textContent = 'Choose .nes file…';
    this.aiCheckbox.checked = true;
    this.syncAiOptions();
    this.refreshSubmit();
  }

  /**
   * Runs the AI bake-now pipeline behind a modal progress dialog.
   *
   * Without an attached custom model, falls through to the registry's
   * default — currently `nearest-neighbour`. With one attached, builds
   * an `OnnxUpscaleClient` over the user-supplied bytes assuming the
   * standard 8×8 → 32×32 NCHW RGB [0..1] fp32 contract (matches the
   * usual pixel-art SR exports). Mismatched models will throw inside
   * `OnnxUpscaleClient`'s preflight; the surrounding try/catch in
   * `handleSubmit` surfaces that to the status line.
   *
   * Returns null only on user-cancel hard errors; cancelled bakes that
   * preserved partial results return a result with `notes.cancelled`.
   */
  private async runAiConvert(
    inesBytes: Uint8Array,
    baseTitle: string,
  ): Promise<Awaited<ReturnType<typeof convertInesToPonchoAi>> | null> {
    const modal = createAiProgressModal('…resolving model…');
    document.body.appendChild(modal.root);

    const baseCtx = this.deps.getUpscaleContext();
    const ctx: UpscaleModelContext = {
      ...(baseCtx ?? {}),
      onModelLoadProgress: (p) => modal.setLoadingModel(p),
      onSessionPhase: (phase) => modal.setSessionPhase(phase),
    };

    let client: UpscaleClient;
    let modalLabel: string;
    if (this.attachedModel) {
      client = this.buildAttachedOnnxClient(this.attachedModel.bytes);
      modalLabel = `Custom: ${this.attachedModel.name}`;
    } else {
      const modelConfig: UpscaleModelConfig = {};
      const resolved = createUpscaleClient('nearest-neighbour', 'rom-bake', modelConfig, ctx);
      client = resolved.client;
      modalLabel = resolved.model.label;
    }
    modal.setModelLabel(modalLabel);

    const ctrl = new AbortController();
    modal.onCancel(() => ctrl.abort());

    try {
      const result = await convertInesToPonchoAi(inesBytes, {
        title: baseTitle,
        client,
        signal: ctrl.signal,
        onProgress: (p) => modal.update(p),
      });
      modal.complete();
      return result;
    } catch (err) {
      if (err instanceof AiConvertCancelled) return null;
      throw err;
    } finally {
      modal.root.remove();
    }
  }

  /**
   * Build an `OnnxUpscaleClient` that loads the user-attached bytes
   * directly. The I/O contract assumed here matches typical pixel-art
   * 4× SR ONNX exports (SPAN, ESRGAN-light, etc.):
   *   - input  : 8×8 fp32 NCHW RGB in [0..1], pin name `input`
   *   - output : 32×32 fp32 NCHW RGB in [0..1], pin name `output`
   *
   * If a user supplies a model with different shape/precision, the
   * preflight will throw and the convert error will bubble to the
   * status line. (Configuring those is a future feature.)
   */
  private buildAttachedOnnxClient(bytes: Uint8Array): UpscaleClient {
    const cfg: OnnxUpscaleClientConfig = {
      modelId: AI_CACHE_MODEL_UNSPECIFIED,
      modelUrl: 'attached://custom.onnx',
      executionProviders: ['webgpu', 'wasm'],
      input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'input' },
      output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'output' },
    };
    // Copy into a fresh ArrayBuffer to satisfy the loader's return
    // type (`SharedArrayBuffer.slice` widens the union otherwise).
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    return new OnnxUpscaleClient(cfg, {
      modelLoader: async () => buf,
    });
  }
}

// ---------------------------------------------------------------------------
// Progress modal — same shape as the previous RomsPanel implementation.
// ---------------------------------------------------------------------------

function createAiProgressModal(modelLabel: string): {
  root: HTMLElement;
  update(p: AiConvertProgress): void;
  setLoadingModel(p: { loaded: number; total: number | null; fromCache: boolean }): void;
  setSessionPhase(phase: 'compiling' | 'ready'): void;
  setModelLabel(label: string): void;
  complete(): void;
  onCancel(fn: () => void): void;
} {
  const root = document.createElement('div');
  root.className = 'ai-progress-overlay';
  root.innerHTML = `
    <div class="ai-progress-card">
      <h3>AI upscale in progress</h3>
      <p class="ai-progress-model">Model: <span data-model></span></p>
      <div class="ai-progress-bar"><div class="ai-progress-fill" data-fill></div></div>
      <p class="ai-progress-count" data-count>preparing…</p>
      <p class="ai-progress-eta" data-eta>elapsed —, eta —</p>
      <button type="button" class="ai-progress-cancel" data-cancel>Cancel</button>
    </div>
  `;
  const modelEl = root.querySelector<HTMLSpanElement>('[data-model]')!;
  modelEl.textContent = modelLabel;
  const fill = root.querySelector<HTMLElement>('[data-fill]')!;
  const count = root.querySelector<HTMLElement>('[data-count]')!;
  const eta = root.querySelector<HTMLElement>('[data-eta]')!;
  const cancel = root.querySelector<HTMLButtonElement>('[data-cancel]')!;
  let cancelHandler: (() => void) | null = null;
  cancel.addEventListener('click', () => cancelHandler?.());

  const startedAt = performance.now();
  let inferenceStarted = false;

  return {
    root,
    setModelLabel(label) {
      modelEl.textContent = label;
    },
    setLoadingModel(p) {
      // Once tile-inference progress arrives, ignore late model-load
      // events (cache reads can fire after the first tile completes).
      if (inferenceStarted) return;
      const pct = p.total && p.total > 0 ? Math.floor((p.loaded / p.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      const loadedMb = (p.loaded / (1024 * 1024)).toFixed(1);
      const totalMb = p.total ? (p.total / (1024 * 1024)).toFixed(1) : '?';
      count.textContent = p.fromCache
        ? `Loading model from cache (${loadedMb} MB)…`
        : `Downloading model: ${loadedMb} / ${totalMb} MB`;
      const elapsed = formatDuration(performance.now() - startedAt);
      eta.textContent = `elapsed ${elapsed}`;
    },
    setSessionPhase(phase) {
      if (inferenceStarted) return;
      if (phase === 'compiling') {
        // No determinate progress for shader compile / protobuf parse.
        // Keep the bar at 100% (download done) and show an animated /
        // textual hint that the bake is still alive.
        fill.style.width = '100%';
        count.textContent = 'Compiling model and warming up GPU… (10-30 s)';
        eta.textContent = `elapsed ${formatDuration(performance.now() - startedAt)}`;
      } else {
        count.textContent = 'Model ready — starting tile inference…';
      }
    },
    update(p) {
      inferenceStarted = true;
      const pct = p.total === 0 ? 100 : Math.floor((p.done / p.total) * 100);
      fill.style.width = `${pct}%`;
      count.textContent = `${p.done} / ${p.total} tiles · ${p.cached} cached · ${p.failed} fallbacks`;
      const elapsedMs = performance.now() - startedAt;
      const elapsed = formatDuration(elapsedMs);
      let etaText = '—';
      if (p.done > 0 && p.done < p.total) {
        const perTile = elapsedMs / p.done;
        const remainingMs = perTile * (p.total - p.done);
        etaText = formatDuration(remainingMs);
      } else if (p.done === p.total) {
        etaText = '0s';
      }
      eta.textContent = `elapsed ${elapsed}, eta ${etaText}`;
    },
    complete() {
      fill.style.width = '100%';
      cancel.disabled = true;
      cancel.textContent = 'Done';
    },
    onCancel(fn) { cancelHandler = fn; },
  };
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  return `${m}m ${rs.toString().padStart(2, '0')}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
