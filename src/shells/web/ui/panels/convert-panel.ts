/**
 * Convert .nes → .poncho L3 panel.
 *
 * Replaces the inline "Use AI upscale" checkbox + auto-fired file
 * picker that used to live in `RomsPanel`. Conversion is now an
 * explicit slide-out workflow:
 *
 *   1. Click "Choose .nes file" → platform file picker
 *   2. (Optional) tick "Use AI upscale"
 *   3. (When checkbox is on) pick a bake-now model + a runtime model
 *      from the registry
 *   4. Click "Convert" → run the bake (with the same progress modal
 *      RomsPanel used to show), save into the ROM library
 *
 * The model selectors are intentionally NOT in Settings any more —
 * each conversion is its own decision. We persist the last-used model
 * ids in `config.ai` so the dropdowns boot to the user's previous
 * pick, but the choice belongs to the conversion, not to a global
 * preference.
 */

import { ConvertError, convertInesToPoncho } from '../../../../convert/ines-to-poncho';
import {
  AiConvertCancelled,
  convertInesToPonchoAi,
  type AiConvertProgress,
} from '../../../../convert/ines-to-poncho-ai';
import {
  createUpscaleClient,
  listUpscaleModels,
  type UpscaleModelConfig,
  type UpscaleModelContext,
} from '../../../../convert/upscale-registry';
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
  private readonly aiSelectorsEl: HTMLElement;
  private readonly bakeSelect: HTMLSelectElement;
  private readonly runtimeSelect: HTMLSelectElement;
  private readonly convertBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;

  /** File picked but not yet converted. Cleared on submit / cancel. */
  private picked: LoadedRom | null = null;

  constructor(private readonly deps: ConvertPanelDeps) {
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l3';
    this.root.innerHTML = `
      <header class="panel-head">
        <i data-lucide="file-input" class="panel-head-icon"></i>
        <h2>Convert .nes</h2>
      </header>
      <div class="panel-body">
        <p class="panel-hint">
          Wrap a Nintendo Entertainment System file as a Poncho-NES
          cartridge. The original PRG runs unchanged; CHR is rendered
          through the Ultra PPU at 1024×960. Optionally pre-bake AI
          upscaled tiles or pick a model that runs lazily during play.
        </p>

        <button type="button" class="file-button" data-pick>
          <i data-lucide="folder-open"></i>
          <span data-pick-label>Choose .nes file…</span>
        </button>

        <label class="rom-ai-toggle convert-ai-toggle">
          <input type="checkbox" data-ai-checkbox>
          <span>Use AI upscale</span>
        </label>

        <div class="convert-ai-selectors" data-ai-selectors hidden>
          <label class="settings-row settings-row-stack">
            <span>Bake-now model (CHR-ROM)</span>
            <select data-bake-model></select>
          </label>
          <label class="settings-row settings-row-stack">
            <span>Runtime model (CHR-RAM)</span>
            <select data-runtime-model></select>
          </label>
          <p class="settings-hint">
            <strong>Bake-now</strong> upscales every unique tile during
            this conversion (CHR-ROM games only) and embeds the
            results.
            <strong>Runtime</strong> upscales tiles in the background
            during play (CHR-RAM games), persisting back into the
            <code>.poncho</code> across sessions. CHR-ROM games ignore
            the runtime selection; CHR-RAM games ignore the bake-now
            selection.
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
    this.aiSelectorsEl = this.root.querySelector<HTMLElement>('[data-ai-selectors]')!;
    this.bakeSelect = this.root.querySelector<HTMLSelectElement>('[data-bake-model]')!;
    this.runtimeSelect = this.root.querySelector<HTMLSelectElement>('[data-runtime-model]')!;
    this.convertBtn = this.root.querySelector<HTMLButtonElement>('[data-convert]')!;
    this.statusEl = this.root.querySelector<HTMLElement>('[data-status]')!;

    this.populateModelSelectors();
    this.bindEvents();
  }

  onShow(): void {
    mountLucideIcons();
    // Boot the dropdowns to the user's last-used picks (kept in config).
    const cfg = this.deps.config.get();
    if (this.aiCheckbox.checked) {
      this.bakeSelect.value = cfg.ai.romModelId;
      this.runtimeSelect.value = cfg.ai.ramModelId;
    }
    this.refreshSubmit();
  }

  // ----- Model selectors ----------------------------------------------------

  private populateModelSelectors(): void {
    const models = listUpscaleModels();
    for (const sel of [this.bakeSelect, this.runtimeSelect]) {
      sel.innerHTML = '';
      const workflow = sel === this.bakeSelect ? 'rom-bake' : 'ram-runtime';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        opt.disabled = !m.supportedWorkflows.includes(workflow);
        sel.appendChild(opt);
      }
    }
    const cfg = this.deps.config.get();
    this.bakeSelect.value = cfg.ai.romModelId;
    this.runtimeSelect.value = cfg.ai.ramModelId;
  }

  // ----- Wiring -------------------------------------------------------------

  private bindEvents(): void {
    this.fileButton.addEventListener('click', () => { void this.handlePickFile(); });
    this.aiCheckbox.addEventListener('change', () => {
      this.aiSelectorsEl.hidden = !this.aiCheckbox.checked;
    });
    this.bakeSelect.addEventListener('change', () => {
      const id = this.bakeSelect.value;
      this.deps.config.update((c) => ({ ...c, ai: { ...c.ai, romModelId: id } }));
    });
    this.runtimeSelect.addEventListener('change', () => {
      const id = this.runtimeSelect.value;
      this.deps.config.update((c) => ({ ...c, ai: { ...c.ai, ramModelId: id } }));
    });
    this.convertBtn.addEventListener('click', () => { void this.handleSubmit(); });
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
        // CHR-RAM games can't be baked at conversion time; they take the
        // runtime path. The runtime model id has been written to config
        // by the change handler above; `App.maybeStartAiWorker` reads
        // it on cart load.
        const result = convertInesToPoncho(picked.data, { title: baseTitle });
        resultPoncho = result.poncho;
        summary =
          `CHR-RAM ${result.notes.chrRamKb} KB; ` +
          `runtime AI: ${this.runtimeSelect.value}`;
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
    this.aiCheckbox.checked = false;
    this.aiSelectorsEl.hidden = true;
    this.refreshSubmit();
  }

  /**
   * Runs the AI bake-now pipeline behind a modal progress dialog (the
   * same UX RomsPanel used to own). Returns null when the user
   * cancelled — but per `convertInesToPonchoAi`'s "save partial on
   * cancel" semantics, the modal returns a partial result rather than
   * throwing, so this `null` only fires on hard errors.
   */
  private async runAiConvert(
    inesBytes: Uint8Array,
    baseTitle: string,
  ): Promise<Awaited<ReturnType<typeof convertInesToPonchoAi>> | null> {
    const modelId = this.bakeSelect.value;
    const modelConfig = this.deps.getModelConfig(modelId);
    const ctx = this.deps.getUpscaleContext();
    const { client, model, usedFallback } = createUpscaleClient(modelId, 'rom-bake', modelConfig, ctx);

    const modalLabel = usedFallback
      ? `${model.label} (fallback — "${modelId}" unavailable)`
      : model.label;
    const modal = createAiProgressModal(modalLabel);
    document.body.appendChild(modal.root);

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
}

// ---------------------------------------------------------------------------
// Progress modal — same shape as the previous RomsPanel implementation.
// ---------------------------------------------------------------------------

function createAiProgressModal(modelLabel: string): {
  root: HTMLElement;
  update(p: AiConvertProgress): void;
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
      <p class="ai-progress-count" data-count>0 / 0 tiles</p>
      <p class="ai-progress-eta" data-eta>elapsed —, eta —</p>
      <button type="button" class="ai-progress-cancel" data-cancel>Cancel</button>
    </div>
  `;
  root.querySelector<HTMLSpanElement>('[data-model]')!.textContent = modelLabel;
  const fill = root.querySelector<HTMLElement>('[data-fill]')!;
  const count = root.querySelector<HTMLElement>('[data-count]')!;
  const eta = root.querySelector<HTMLElement>('[data-eta]')!;
  const cancel = root.querySelector<HTMLButtonElement>('[data-cancel]')!;
  let cancelHandler: (() => void) | null = null;
  cancel.addEventListener('click', () => cancelHandler?.());

  const startedAt = performance.now();

  return {
    root,
    update(p) {
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
