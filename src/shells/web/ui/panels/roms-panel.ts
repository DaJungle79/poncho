import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';
import type { FilePicker, RomLibrary, ServerRomLoader } from '../../../../platform/types';
import type { LoadedRom, RomMeta, StoredRomEntry } from '../../../../domain/rom';
import { ConvertError, convertInesToPoncho } from '../../../../convert/ines-to-poncho';
import {
  AiConvertCancelled,
  convertInesToPonchoAi,
  type AiConvertProgress,
} from '../../../../convert/ines-to-poncho-ai';
import { MockUpscaleClient, NanoBananaClient, QuotaExceededError } from '../../../../convert/upscale-client';
import { buildGameUpscalePrompt } from '../../../../convert/prompt-builder';

export interface RomsPanelDeps {
  /** Persistent local library — uploaded ROMs (web: IndexedDB). */
  romLibrary: RomLibrary;
  /** Server-folder ROM loader. `null` on shells without a dev server (Electron). */
  serverRoms: ServerRomLoader | null;
  /** "Open file" dialog. */
  filePicker: FilePicker;
  /** Called when a ROM has been loaded successfully. */
  onLoaded: (rom: LoadedRom) => void | Promise<void>;
  /** Optional callback for transient status messages (routed to the bottom status bar). */
  onStatus?: (text: string) => void;
  /** Read the configured Gemini API key. Empty string = no key. */
  getApiKey?: () => string;
  /** Open Settings + focus the API key input. Used by the "Configure key" hint. */
  onConfigureApiKey?: () => void;
  /**
   * Resolve display metadata (title / genre / year / publisher) for a
   * picked ROM. Used by the bake-now flow to build a game-specific
   * upscale prompt. Falls back to filename-based metadata internally.
   */
  lookupRomMeta?: (rom: LoadedRom) => Promise<RomMeta>;
}

/**
 * ROMs panel — two ROM sources stacked vertically.
 *
 * Playback controls (Power / Reset / Pause) live in the sidebar instead
 * of inside this panel, so they're reachable without opening it.
 *
 *   Browser storage  — ROMs the user has uploaded. Persisted via IndexedDB
 *                      so they survive page reloads. The Upload button
 *                      stays visible after each upload so the user can
 *                      build up a library. Click an entry to load it.
 *                      Click the × on an entry to remove it.
 *
 *   Server           — ROMs sitting in the project's `roms/` folder,
 *                      served by the Vite dev middleware. Listed by name;
 *                      click to load.
 */
export class RomsPanel implements Panel {
  readonly id = 'roms';
  readonly root: HTMLElement;

  private readonly panelTitle: HTMLHeadingElement;
  private readonly browserList: HTMLUListElement;
  private readonly serverList: HTMLUListElement;
  private readonly serverSection: HTMLElement;
  private readonly btnUpload: HTMLButtonElement;
  private readonly uploadLabel: HTMLSpanElement;
  private readonly btnConvert: HTMLButtonElement;
  private readonly aiToggleWrap: HTMLLabelElement;
  private readonly aiCheckbox: HTMLInputElement;
  private readonly aiHint: HTMLElement;
  private consoleId = 'nes';

  constructor(private readonly deps: RomsPanelDeps) {
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l2';
    this.root.innerHTML = `
      <header class="panel-head">
        <h2 data-panel-title>NES ROMs</h2>
      </header>
      <div class="panel-body">
        <section class="rom-section">
          <h3><i data-lucide="hard-drive"></i><span>Browser storage</span></h3>
          <ul class="rom-list" data-browser-list></ul>
          <div class="rom-actions">
            <button type="button" class="file-button file-button-compact" data-upload>
              <i data-lucide="upload"></i>
              <span data-upload-label>Upload .nes</span>
            </button>
            <button type="button" class="file-button file-button-compact" data-convert hidden>
              <i data-lucide="file-input"></i>
              <span>Convert .nes</span>
            </button>
          </div>
          <label class="rom-ai-toggle" data-ai-toggle hidden>
            <input type="checkbox" data-ai-checkbox>
            <span>Use AI upscale (CHR-ROM games only)</span>
          </label>
          <p class="rom-ai-hint" data-ai-hint hidden>
            No Gemini API key set — converts will use the deterministic
            4× fallback.
            <button type="button" class="rom-ai-configure" data-ai-configure>Configure</button>
          </p>
        </section>

        <section class="rom-section" data-server-section>
          <h3><i data-lucide="folder"></i><span>Server</span> <span class="hint">/roms/</span></h3>
          <ul class="rom-list" data-server-list></ul>
        </section>
      </div>
    `;

    // Match the Settings header pattern: icon as a sibling of h2.
    const head = this.root.querySelector<HTMLElement>('.panel-head')!;
    const cassette = gameIcon('cassette');
    cassette.classList.add('panel-head-icon');
    head.prepend(cassette);

    this.panelTitle = this.root.querySelector<HTMLHeadingElement>('[data-panel-title]')!;
    this.browserList = this.root.querySelector<HTMLUListElement>('[data-browser-list]')!;
    this.serverList = this.root.querySelector<HTMLUListElement>('[data-server-list]')!;
    this.serverSection = this.root.querySelector<HTMLElement>('[data-server-section]')!;
    this.btnUpload = this.root.querySelector<HTMLButtonElement>('[data-upload]')!;
    this.uploadLabel = this.root.querySelector<HTMLSpanElement>('[data-upload-label]')!;
    this.btnConvert = this.root.querySelector<HTMLButtonElement>('[data-convert]')!;
    this.aiToggleWrap = this.root.querySelector<HTMLLabelElement>('[data-ai-toggle]')!;
    this.aiCheckbox = this.root.querySelector<HTMLInputElement>('[data-ai-checkbox]')!;
    this.aiHint = this.root.querySelector<HTMLElement>('[data-ai-hint]')!;
    this.root.querySelector<HTMLButtonElement>('[data-ai-configure]')!
      .addEventListener('click', () => this.deps.onConfigureApiKey?.());

    // Hide the Server section on platforms that have no dev-server-style
    // ROM loader (e.g. Electron). The platform passes `serverRoms: null`
    // and the section disappears entirely.
    if (!this.deps.serverRoms) this.serverSection.hidden = true;

    this.bindEvents();
  }

  onShow(): void {
    mountLucideIcons();
    void this.refreshBrowserList();
    void this.refreshServerList();
    this.syncAiHint();
  }

  private syncAiHint(): void {
    const aiVisible = !this.aiToggleWrap.hidden;
    const hasKey = (this.deps.getApiKey?.() ?? '').length > 0;
    this.aiHint.hidden = !aiVisible || hasKey;
  }

  /** Update panel chrome and ROM lists for the newly-active console. */
  setConsoleId(consoleId: string, consoleName: string): void {
    this.consoleId = consoleId;
    this.panelTitle.textContent = `${consoleName} ROMs`;
    this.uploadLabel.textContent = consoleId === 'poncho-nes'
      ? 'Upload .poncho'
      : 'Upload .nes';
    // The "Convert .nes" button is Poncho-NES-only — its job is to
    // bridge an iNES file into the Poncho-NES library by wrapping it
    // as an upscaled-mode `.poncho` cartridge.
    this.btnConvert.hidden = consoleId !== 'poncho-nes';
    this.aiToggleWrap.hidden = consoleId !== 'poncho-nes';
    this.syncAiHint();
  }

  private setStatus(text: string): void {
    this.deps.onStatus?.(text);
  }

  // ----- Browser-storage list ----------------------------------------------

  private async refreshBrowserList(): Promise<void> {
    this.browserList.innerHTML = '<li class="rom-empty">…</li>';
    let all: StoredRomEntry[] = [];
    try {
      all = await this.deps.romLibrary.list();
    } catch (err) {
      this.browserList.innerHTML =
        `<li class="rom-empty">Storage unavailable: ${(err as Error).message}</li>`;
      return;
    }
    const ext = this.consoleId === 'poncho-nes' ? '.poncho' : '.nes';
    const entries = all.filter((e) => e.name.toLowerCase().endsWith(ext));
    if (entries.length === 0) {
      this.browserList.innerHTML =
        `<li class="rom-empty">Upload a ${ext} file to add it here.</li>`;
      return;
    }
    this.browserList.innerHTML = '';
    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = 'rom-item';
      li.innerHTML = `
        <button class="rom-item-btn" data-load>
          <span class="rom-item-name"></span>
          <span class="rom-item-meta"></span>
        </button>
        <button class="rom-item-del" data-del title="Remove from browser storage" aria-label="Remove">
          <i data-lucide="x"></i>
        </button>
      `;
      li.querySelector<HTMLSpanElement>('.rom-item-name')!.textContent = entry.name;
      li.querySelector<HTMLSpanElement>('.rom-item-meta')!.textContent = formatSize(entry.size);
      li.querySelector<HTMLButtonElement>('[data-load]')!.addEventListener('click', () =>
        this.loadFromBrowser(entry.name),
      );
      li.querySelector<HTMLButtonElement>('[data-del]')!.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.removeFromBrowser(entry.name);
      });
      this.browserList.appendChild(li);
    }
    mountLucideIcons();
  }

  private async loadFromBrowser(name: string): Promise<void> {
    this.setStatus(`Loading ${name}…`);
    try {
      const data = await this.deps.romLibrary.get(name);
      if (!data) {
        this.setStatus(`${name} is gone from storage. Refreshing.`);
        await this.refreshBrowserList();
        return;
      }
      const rom: LoadedRom = { name, source: `browser:${name}`, data };
      await this.deps.onLoaded(rom);
      this.setStatus(`Loaded ${name}`);
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
    }
  }

  private async removeFromBrowser(name: string): Promise<void> {
    try {
      await this.deps.romLibrary.remove(name);
      await this.refreshBrowserList();
      this.setStatus(`Removed ${name} from browser storage.`);
    } catch (err) {
      this.setStatus(`Failed to remove: ${(err as Error).message}`);
    }
  }

  // ----- Server list -------------------------------------------------------

  private async refreshServerList(): Promise<void> {
    if (!this.deps.serverRoms) return;
    this.serverList.innerHTML = '<li class="rom-empty">Scanning…</li>';
    let all: string[] = [];
    try {
      all = await this.deps.serverRoms.list();
    } catch {
      this.serverList.innerHTML = '<li class="rom-empty">Server unreachable.</li>';
      return;
    }
    const ext = this.consoleId === 'poncho-nes' ? '.poncho' : '.nes';
    const files = all.filter((f) => f.toLowerCase().endsWith(ext));
    if (files.length === 0) {
      this.serverList.innerHTML =
        `<li class="rom-empty">Drop ${ext} files in <code>roms/</code>.</li>`;
      return;
    }
    this.serverList.innerHTML = '';
    for (const filename of files) {
      const li = document.createElement('li');
      li.className = 'rom-item';
      li.innerHTML = `
        <button class="rom-item-btn" data-load>
          <span class="rom-item-name"></span>
        </button>
      `;
      li.querySelector<HTMLSpanElement>('.rom-item-name')!.textContent = filename;
      li.querySelector<HTMLButtonElement>('[data-load]')!.addEventListener('click', () =>
        this.loadFromServer(filename),
      );
      this.serverList.appendChild(li);
    }
  }

  private async loadFromServer(filename: string): Promise<void> {
    if (!this.deps.serverRoms) return;
    this.setStatus(`Loading ${filename}…`);
    try {
      const rom = await this.deps.serverRoms.load(filename);
      await this.deps.onLoaded(rom);
      this.setStatus(`Loaded ${rom.name}`);
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
    }
  }

  // ----- Upload + playback wiring ------------------------------------------

  private bindEvents(): void {
    this.btnUpload.addEventListener('click', async () => {
      const accept = this.consoleId === 'poncho-nes' ? ['.poncho'] : ['.nes'];
      this.setStatus(`Choose a ${accept[0]} file…`);
      let rom: LoadedRom | null;
      try {
        rom = await this.deps.filePicker.pick({ accept });
      } catch (err) {
        this.setStatus(`Failed: ${(err as Error).message}`);
        return;
      }
      if (!rom) {
        this.setStatus('Upload cancelled.');
        return;
      }
      try {
        // Persist to the library *before* loading into the emulator so a
        // failure to start the game doesn't lose the upload.
        await this.deps.romLibrary.add(rom.name, rom.data);
        await this.refreshBrowserList();
        await this.deps.onLoaded(rom);
        this.setStatus(`Loaded ${rom.name} (saved to browser storage)`);
      } catch (err) {
        this.setStatus(`Failed: ${(err as Error).message}`);
      }
    });

    this.btnConvert.addEventListener('click', () => void this.handleConvert());
  }

  /**
   * "Convert .nes" — picks an iNES file, wraps it as an upscaled-mode
   * PonchoROM via `convertInesToPoncho`, stores the result in the
   * browser library, and refreshes the listing. The original .nes file
   * is *not* stored — only the converted .poncho.
   *
   * Convert is offered exclusively in Poncho-NES mode: the converted
   * cartridge runs natively on PpuUltra + PonchoMapper and shows up
   * alongside hand-authored Poncho games in the library.
   */
  private async handleConvert(): Promise<void> {
    this.setStatus('Choose an .nes file to convert…');
    let picked: LoadedRom | null;
    try {
      picked = await this.deps.filePicker.pick({ accept: ['.nes'] });
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
      return;
    }
    if (!picked) {
      this.setStatus('Conversion cancelled.');
      return;
    }

    const baseTitle = picked.name.replace(/\.nes$/i, '').replace(/\s*\([^)]*\)/g, '').trim();
    const useAi = this.aiCheckbox.checked;
    // CHR-RAM detection: iNES byte 5 = 0 means the cart has CHR-RAM, not
    // CHR-ROM. CHR-RAM games can't be baked at conversion time — they go
    // through the runtime upscale path instead.
    const isChrRam = picked.data[5] === 0;

    let resultPoncho: Uint8Array;
    let summary: string;
    try {
      if (useAi && isChrRam) {
        // CHR-RAM game with AI requested — convert without AI here, the
        // runtime AI worker (Phase 3) handles upscaling during play.
        const result = convertInesToPoncho(picked.data, { title: baseTitle });
        resultPoncho = result.poncho;
        summary =
          `(mapper ${result.notes.sourceMapper}, CHR-RAM ${result.notes.chrRamKb} KB; ` +
          `AI upscale will run during play)`;
      } else if (useAi) {
        // CHR-ROM bake-now: show progress modal.
        const aiResult = await this.runAiConvert(picked.data, baseTitle, picked);
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
          `${partialPrefix}(mapper ${n.sourceMapper}, native CHR ${n.chrKb} KB, ` +
          `${n.uniqueTiles} unique tiles, ${n.failedTiles + n.cancelledTiles} fallbacks)`;
      } else {
        const result = convertInesToPoncho(picked.data, { title: baseTitle });
        resultPoncho = result.poncho;
        const n = result.notes;
        const chrLabel = n.chrRamKb > 0 ? `CHR-RAM ${n.chrRamKb} KB` : `CHR ${n.chrKb} KB`;
        summary = `(mapper ${n.sourceMapper}, ${chrLabel}, PRG ${n.prgKb} KB)`;
      }
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        this.setStatus(
          'Gemini quota exhausted — the free tier has 0 requests/day for ' +
          'the image model. Enable billing on your Google Cloud project, ' +
          'or untick "Use AI upscale" to convert with the 4× fallback.',
        );
      } else if (err instanceof ConvertError) {
        this.setStatus(`Conversion failed: ${err.message}`);
      } else {
        this.setStatus(`Conversion failed: ${(err as Error).message}`);
      }
      return;
    }

    const ponchoName = picked.name.replace(/\.nes$/i, '') + '.poncho';
    try {
      await this.deps.romLibrary.add(ponchoName, resultPoncho);
      await this.refreshBrowserList();
    } catch (err) {
      this.setStatus(`Saved-to-library failed: ${(err as Error).message}`);
      return;
    }

    this.setStatus(`Converted ${picked.name} → ${ponchoName} ${summary}`);
  }

  /**
   * Run the AI bake-now pipeline behind a modal progress dialog. Returns
   * `null` if the user cancelled. Picks the right upscale client based
   * on whether a Gemini API key is configured (window-scoped for now —
   * a settings panel field is a Phase 4 polish item).
   */
  private async runAiConvert(
    inesBytes: Uint8Array,
    baseTitle: string,
    rom: LoadedRom,
  ): Promise<Awaited<ReturnType<typeof convertInesToPonchoAi>> | null> {
    const apiKey = this.deps.getApiKey?.() ?? '';
    const client = apiKey
      ? new NanoBananaClient({ apiKey })
      : new MockUpscaleClient();

    const modal = createAiProgressModal(
      apiKey ? 'Gemini 2.5 Flash Image' : 'Nearest-neighbour (no API key)',
      apiKey ? null : (() => this.deps.onConfigureApiKey?.()),
    );
    document.body.appendChild(modal.root);

    const ctrl = new AbortController();
    modal.onCancel(() => ctrl.abort());

    // Build the per-game upscale prompt before starting the bake.
    // Cheap (single text-Gemini call) and cached per title in memory.
    // Fails open: null prompt → client uses its default. Inspectable via
    // devtools console at log level `rom:info`.
    let customPrompt: string | undefined;
    if (apiKey) {
      try {
        const meta = this.deps.lookupRomMeta
          ? await this.deps.lookupRomMeta(rom)
          : { title: baseTitle, subtitle: null, source: 'filename' as const };
        const built = await buildGameUpscalePrompt({
          apiKey,
          game: {
            title: meta.title || baseTitle,
            subtitle: meta.subtitle ?? null,
            ...(meta.year !== undefined ? { year: meta.year } : {}),
            ...(meta.publisher ? { publisher: meta.publisher } : {}),
            ...(meta.developer ? { developer: meta.developer } : {}),
            ...(meta.genre ? { genre: meta.genre } : {}),
          },
          signal: ctrl.signal,
        });
        customPrompt = built ?? undefined;
      } catch {
        // Already logged inside buildGameUpscalePrompt; just fall through.
      }
    }

    try {
      const result = await convertInesToPonchoAi(inesBytes, {
        title: baseTitle,
        client,
        signal: ctrl.signal,
        onProgress: (p) => modal.update(p),
        ...(customPrompt ? { customPrompt } : {}),
      });
      modal.complete();
      return result;
    } catch (err) {
      // AbortSignal-driven cancel is no longer thrown — `convertInesToPonchoAi`
      // returns the partial result with `notes.cancelled = true` instead,
      // so the caller can save the half-baked `.poncho`. Anything thrown
      // here is a real error.
      if (err instanceof AiConvertCancelled) return null;
      throw err;
    } finally {
      modal.root.remove();
    }
  }
}

/**
 * Lightweight modal with a progress bar + counter + cancel button. Built
 * inline rather than as a generic dialog component — it's the only modal
 * in the shell so far and a shared abstraction is premature.
 */
function createAiProgressModal(
  modelLabel: string,
  onConfigureKey: (() => void) | null,
): {
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
      <p class="ai-progress-model">
        Model: <span data-model></span>
        <button type="button" class="ai-progress-link" data-configure hidden>Configure key</button>
      </p>
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
  const configure = root.querySelector<HTMLButtonElement>('[data-configure]')!;
  if (onConfigureKey) {
    configure.hidden = false;
    configure.addEventListener('click', onConfigureKey);
  }
  let cancelHandler: (() => void) | null = null;
  cancel.addEventListener('click', () => cancelHandler?.());

  const startedAt = performance.now();

  return {
    root,
    update(p) {
      const pct = p.total === 0 ? 100 : Math.floor((p.done / p.total) * 100);
      fill.style.width = `${pct}%`;
      count.textContent = `${p.done} / ${p.total} tiles · ${p.cached} cached · ${p.failed} fallbacks`;

      // ETA: linear extrapolation of elapsed × remaining/done. Cached
      // hits resolve effectively instantly, so we compute rate over
      // *all* completed work (cached + api-calls + failed).
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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
