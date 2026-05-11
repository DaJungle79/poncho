import { ConvertError, convertInesToPoncho } from '../../../../convert/ines-to-poncho';
import {
  AiConvertCancelled,
  convertInesToPonchoAi,
  type AiConvertProgress,
} from '../../../../convert/ines-to-poncho-ai';
import {
  createUpscaleClient,
  DEFAULT_UPSCALE_MODEL_ID,
  type UpscaleModelContext,
} from '../../../../convert/upscale-registry';
import {
  OnnxUpscaleClient,
  type OnnxUpscaleClientConfig,
} from '../../../../convert/clients/onnx-upscale-client';
import { AI_CACHE_MODEL_UNSPECIFIED } from '../../../../core/cart-poncho/ai-cache';
import type { UpscaleClient } from '../../../../convert/upscale-client';
import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';
import type { FilePicker, RomLibrary, ServerRomLoader } from '../../../../platform/types';
import { InvalidRomError, validateRom } from '../../../../platform/web/ines-validator';
import type { LoadedRom, StoredRomEntry } from '../../../../domain/rom';

export interface RomsPanelDeps {
  /** Persistent local library - uploaded ROMs (web: IndexedDB). */
  romLibrary: RomLibrary;
  /** Server-folder ROM loader. `null` on shells without a dev server (Electron). */
  serverRoms: ServerRomLoader | null;
  /** "Open file" dialog. */
  filePicker: FilePicker;
  /** Called when a ROM has been loaded successfully. */
  onLoaded: (rom: LoadedRom) => void | Promise<void>;
  /** Optional callback for transient status messages (routed to the bottom status bar). */
  onStatus?: (text: string) => void;
  /** Platform-level loader hooks so model assets cache across reloads. */
  getUpscaleContext?: () => UpscaleModelContext | undefined;
}

interface RomTarget {
  consoleId: string;
  consoleName: string;
  libraryExtensions: readonly string[];
  uploadExtensions: readonly string[];
  convertsFrom: readonly string[];
  convertedExtension: string | null;
}

const ROM_TARGETS: Record<string, Omit<RomTarget, 'consoleName'>> = {
  nes: {
    consoleId: 'nes',
    libraryExtensions: ['.nes'],
    uploadExtensions: ['.nes'],
    convertsFrom: [],
    convertedExtension: null,
  },
  'poncho-nes': {
    consoleId: 'poncho-nes',
    libraryExtensions: ['.poncho'],
    uploadExtensions: ['.nes', '.poncho'],
    convertsFrom: ['.nes'],
    convertedExtension: '.poncho',
  },
};

/**
 * ROMs panel - lists playable ROMs for the active console and owns the
 * "Add ROM" flow. The add flow is a local panel state, not a separate
 * top-level menu item, so upload/conversion stays attached to the ROM bay.
 */
export class RomsPanel implements Panel {
  readonly id = 'roms';
  readonly root: HTMLElement;

  private readonly panelTitle: HTMLHeadingElement;
  private readonly listView: HTMLElement;
  private readonly addView: HTMLElement;
  private readonly browserList: HTMLUListElement;
  private readonly serverList: HTMLUListElement;
  private readonly serverSection: HTMLElement;
  private readonly btnAdd: HTMLButtonElement;
  private readonly btnBack: HTMLButtonElement;
  private readonly dropZone: HTMLButtonElement;
  private readonly acceptHint: HTMLElement;
  private readonly pickedNameEl: HTMLElement;
  private readonly pickedMetaEl: HTMLElement;
  private readonly convertNotice: HTMLElement;
  private readonly aiToggle: HTMLElement;
  private readonly aiCheckbox: HTMLInputElement;
  private readonly aiOptionsEl: HTMLElement;
  private readonly attachBtn: HTMLButtonElement;
  private readonly attachedRow: HTMLElement;
  private readonly attachedNameEl: HTMLElement;
  private readonly detachBtn: HTMLButtonElement;
  private readonly uploadBtn: HTMLButtonElement;
  private readonly uploadStatusEl: HTMLElement;

  private target = makeRomTarget('nes', 'NES');
  private addOpen = false;
  private picked: LoadedRom | null = null;
  private attachedModel: { name: string; bytes: Uint8Array } | null = null;

  constructor(private readonly deps: RomsPanelDeps) {
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l2 roms-panel';
    this.root.innerHTML = `
      <header class="panel-head">
        <h2 data-panel-title>NES ROMs</h2>
      </header>
      <div class="panel-body rom-panel-body">
        <button type="button" class="settings-link rom-add-toggle" data-add-toggle aria-pressed="false">
          <i data-lucide="plus"></i>
          <span>Add ROM</span>
        </button>

        <div class="rom-view rom-list-view" data-list-view>
          <section class="rom-section">
            <h3><i data-lucide="hard-drive"></i><span>Browser storage</span></h3>
            <ul class="rom-list" data-browser-list></ul>
          </section>

          <section class="rom-section" data-server-section>
            <h3><i data-lucide="folder"></i><span>Server</span> <span class="hint">/roms/</span></h3>
            <ul class="rom-list" data-server-list></ul>
          </section>
        </div>

        <div class="rom-view rom-add-view" data-add-view hidden>
          <div class="rom-add-head">
            <button type="button" class="rom-add-back" data-add-back title="Back to ROMs" aria-label="Back to ROMs">
              <i data-lucide="chevron-left"></i>
            </button>
            <h3>Add new ROM</h3>
          </div>

          <button type="button" class="rom-drop-zone" data-drop-zone>
            <i data-lucide="file-plus-2"></i>
            <span>Drop a file or click to pick</span>
            <small data-accept-hint>Accepts .nes</small>
          </button>

          <div class="rom-picked" data-picked hidden>
            <span class="rom-picked-name" data-picked-name></span>
            <span class="rom-picked-meta" data-picked-meta></span>
          </div>

          <p class="settings-hint rom-convert-notice" data-convert-notice hidden>
            The selected .nes ROM will be converted to .poncho format.
          </p>

          <label class="rom-ai-toggle convert-ai-toggle" data-ai-toggle hidden>
            <input type="checkbox" data-ai-checkbox checked>
            <span>Upscale</span>
          </label>

          <div class="convert-ai-options" data-ai-options hidden>
            <button type="button" class="file-button file-button-compact" data-attach-model>
              <i data-lucide="paperclip"></i>
              <span>Attach custom model (.onnx)</span>
            </button>
            <p class="convert-attached-row" data-attached-model hidden>
              <span data-attached-name></span>
              <button type="button" class="rom-item-del" data-detach-model title="Detach" aria-label="Detach model">
                <i data-lucide="x"></i>
              </button>
            </p>
          </div>

          <button type="button" class="settings-link convert-submit" data-upload-submit disabled>
            <i data-lucide="upload"></i>
            <span>Upload</span>
          </button>

          <p class="settings-hint convert-status" data-upload-status></p>
        </div>
      </div>
    `;

    const head = this.root.querySelector<HTMLElement>('.panel-head')!;
    const cassette = gameIcon('cassette');
    cassette.classList.add('panel-head-icon');
    head.prepend(cassette);

    this.panelTitle = this.root.querySelector<HTMLHeadingElement>('[data-panel-title]')!;
    this.listView = this.root.querySelector<HTMLElement>('[data-list-view]')!;
    this.addView = this.root.querySelector<HTMLElement>('[data-add-view]')!;
    this.browserList = this.root.querySelector<HTMLUListElement>('[data-browser-list]')!;
    this.serverList = this.root.querySelector<HTMLUListElement>('[data-server-list]')!;
    this.serverSection = this.root.querySelector<HTMLElement>('[data-server-section]')!;
    this.btnAdd = this.root.querySelector<HTMLButtonElement>('[data-add-toggle]')!;
    this.btnBack = this.root.querySelector<HTMLButtonElement>('[data-add-back]')!;
    this.dropZone = this.root.querySelector<HTMLButtonElement>('[data-drop-zone]')!;
    this.acceptHint = this.root.querySelector<HTMLElement>('[data-accept-hint]')!;
    this.pickedNameEl = this.root.querySelector<HTMLElement>('[data-picked-name]')!;
    this.pickedMetaEl = this.root.querySelector<HTMLElement>('[data-picked-meta]')!;
    this.convertNotice = this.root.querySelector<HTMLElement>('[data-convert-notice]')!;
    this.aiToggle = this.root.querySelector<HTMLElement>('[data-ai-toggle]')!;
    this.aiCheckbox = this.root.querySelector<HTMLInputElement>('[data-ai-checkbox]')!;
    this.aiOptionsEl = this.root.querySelector<HTMLElement>('[data-ai-options]')!;
    this.attachBtn = this.root.querySelector<HTMLButtonElement>('[data-attach-model]')!;
    this.attachedRow = this.root.querySelector<HTMLElement>('[data-attached-model]')!;
    this.attachedNameEl = this.root.querySelector<HTMLElement>('[data-attached-name]')!;
    this.detachBtn = this.root.querySelector<HTMLButtonElement>('[data-detach-model]')!;
    this.uploadBtn = this.root.querySelector<HTMLButtonElement>('[data-upload-submit]')!;
    this.uploadStatusEl = this.root.querySelector<HTMLElement>('[data-upload-status]')!;

    if (!this.deps.serverRoms) this.serverSection.hidden = true;

    this.bindEvents();
    this.syncAddView();
    this.syncPicked();
  }

  onShow(): void {
    mountLucideIcons();
    void this.refreshBrowserList();
    void this.refreshServerList();
  }

  onHide(): void {
    this.closeAddView();
  }

  /** Update panel chrome and ROM lists for the newly-active console. */
  setConsoleId(consoleId: string, consoleName: string): void {
    this.target = makeRomTarget(consoleId, consoleName);
    this.panelTitle.textContent = `${consoleName} ROMs`;
    this.acceptHint.textContent = `Accepts ${this.target.uploadExtensions.join(', ')}`;
    this.clearPicked();
    void this.refreshBrowserList();
    void this.refreshServerList();
  }

  /** Public so external flows can refresh us after a save. */
  async refreshBrowserList(): Promise<void> {
    return this.refreshBrowserListInternal();
  }

  private setStatus(text: string): void {
    this.deps.onStatus?.(text);
  }

  private setUploadStatus(text: string): void {
    this.uploadStatusEl.textContent = text;
    this.setStatus(text);
  }

  // ----- View state ---------------------------------------------------------

  private openAddView(): void {
    this.addOpen = true;
    this.syncAddView();
  }

  private closeAddView(): void {
    if (!this.addOpen) return;
    this.addOpen = false;
    this.clearPicked();
    this.syncAddView();
  }

  private toggleAddView(): void {
    if (this.addOpen) {
      this.closeAddView();
    } else {
      this.openAddView();
    }
  }

  private syncAddView(): void {
    this.listView.hidden = this.addOpen;
    this.addView.hidden = !this.addOpen;
    this.btnAdd.classList.toggle('selected', this.addOpen);
    this.btnAdd.setAttribute('aria-pressed', this.addOpen ? 'true' : 'false');
    if (this.addOpen) {
      mountLucideIcons();
    }
  }

  // ----- Browser-storage list ----------------------------------------------

  private async refreshBrowserListInternal(): Promise<void> {
    this.browserList.innerHTML = '<li class="rom-empty">...</li>';
    let all: StoredRomEntry[] = [];
    try {
      all = await this.deps.romLibrary.list();
    } catch (err) {
      this.browserList.innerHTML =
        `<li class="rom-empty">Storage unavailable: ${(err as Error).message}</li>`;
      return;
    }
    const entries = all.filter((e) => hasAnyExtension(e.name, this.target.libraryExtensions));
    if (entries.length === 0) {
      this.browserList.innerHTML =
        `<li class="rom-empty">Add a ${this.target.libraryExtensions.join(' or ')} file to store it here.</li>`;
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
    this.setStatus(`Loading ${name}...`);
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
    this.serverList.innerHTML = '<li class="rom-empty">Scanning...</li>';
    let all: string[] = [];
    try {
      all = await this.deps.serverRoms.list();
    } catch {
      this.serverList.innerHTML = '<li class="rom-empty">Server unreachable.</li>';
      return;
    }
    const files = all.filter((f) => hasAnyExtension(f, this.target.libraryExtensions));
    if (files.length === 0) {
      this.serverList.innerHTML =
        `<li class="rom-empty">Drop ${this.target.libraryExtensions.join(' or ')} files in <code>roms/</code>.</li>`;
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
    this.setStatus(`Loading ${filename}...`);
    try {
      const rom = await this.deps.serverRoms.load(filename);
      await this.deps.onLoaded(rom);
      this.setStatus(`Loaded ${rom.name}`);
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
    }
  }

  // ----- Add ROM -----------------------------------------------------------

  private bindEvents(): void {
    this.btnAdd.addEventListener('click', () => this.toggleAddView());
    this.btnBack.addEventListener('click', () => this.closeAddView());
    this.dropZone.addEventListener('click', () => { void this.pickRomFile(); });
    this.dropZone.addEventListener('dragenter', (event) => this.handleDrag(event));
    this.dropZone.addEventListener('dragover', (event) => this.handleDrag(event));
    this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('drag-over'));
    this.dropZone.addEventListener('drop', (event) => { void this.handleDrop(event); });
    this.aiCheckbox.addEventListener('change', () => this.syncAiOptions());
    this.attachBtn.addEventListener('click', () => { void this.handleAttachModel(); });
    this.detachBtn.addEventListener('click', () => this.detachModel());
    this.uploadBtn.addEventListener('click', () => { void this.handleUpload(); });

    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.addOpen) return;
      event.preventDefault();
      this.closeAddView();
    });
  }

  private handleDrag(event: DragEvent): void {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
    this.dropZone.classList.add('drag-over');
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dropZone.classList.remove('drag-over');
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    try {
      const rom = await readRomFile(file, this.target.uploadExtensions);
      this.setPicked(rom);
    } catch (err) {
      this.rejectPickedFile(err);
    }
  }

  private async pickRomFile(): Promise<void> {
    try {
      const rom = await this.deps.filePicker.pick({ accept: [...this.target.uploadExtensions] });
      if (!rom) {
        this.setUploadStatus('Pick cancelled.');
        return;
      }
      assertAcceptedExtension(rom.name, this.target.uploadExtensions);
      this.setPicked(rom);
    } catch (err) {
      this.rejectPickedFile(err);
    }
  }

  private rejectPickedFile(err: unknown): void {
    this.clearPicked();
    this.setUploadStatus(`Failed: ${(err as Error).message}`);
  }

  private setPicked(rom: LoadedRom): void {
    this.picked = rom;
    this.syncPicked();
    this.setUploadStatus(`${rom.name} (${formatSize(rom.data.length)}) ready.`);
  }

  private clearPicked(): void {
    this.picked = null;
    this.uploadStatusEl.textContent = '';
    this.syncPicked();
  }

  private syncPicked(): void {
    const pickedBox = this.root.querySelector<HTMLElement>('[data-picked]')!;
    const picked = this.picked;
    pickedBox.hidden = !picked;
    this.pickedNameEl.textContent = picked?.name ?? '';
    this.pickedMetaEl.textContent = picked ? formatSize(picked.data.length) : '';

    const converting = picked ? this.shouldConvert(picked.name) : false;
    this.convertNotice.hidden = !converting;
    this.aiToggle.hidden = !converting;
    this.aiOptionsEl.hidden = !converting || !this.aiCheckbox.checked;
    this.uploadBtn.disabled = picked === null;
    mountLucideIcons();
  }

  private syncAiOptions(): void {
    this.aiOptionsEl.hidden = this.aiToggle.hidden || !this.aiCheckbox.checked;
  }

  private shouldConvert(name: string): boolean {
    return hasAnyExtension(name, this.target.convertsFrom);
  }

  private async handleAttachModel(): Promise<void> {
    let picked: LoadedRom | null;
    try {
      picked = await this.deps.filePicker.pick({ accept: ['.onnx'], validate: false });
    } catch (err) {
      this.setUploadStatus(`Failed: ${(err as Error).message}`);
      return;
    }
    if (!picked) return;
    this.attachedModel = { name: picked.name, bytes: picked.data };
    this.attachedNameEl.textContent = `${picked.name} (${formatSize(picked.data.length)})`;
    this.attachedRow.hidden = false;
    mountLucideIcons();
    this.setUploadStatus(`Attached ${picked.name}.`);
  }

  private detachModel(): void {
    this.attachedModel = null;
    this.attachedRow.hidden = true;
    this.setUploadStatus('Detached custom model.');
  }

  private async handleUpload(): Promise<void> {
    const picked = this.picked;
    if (!picked) return;

    if (this.shouldConvert(picked.name)) {
      await this.uploadConverted(picked);
    } else {
      await this.uploadDirect(picked);
    }
  }

  private async uploadDirect(rom: LoadedRom): Promise<void> {
    try {
      await this.deps.romLibrary.add(rom.name, rom.data);
      await this.refreshBrowserList();
      await this.deps.onLoaded(rom);
      this.setStatus(`Loaded ${rom.name} (saved to browser storage)`);
      this.closeAddView();
    } catch (err) {
      this.setUploadStatus(`Failed: ${(err as Error).message}`);
    }
  }

  private async uploadConverted(rom: LoadedRom): Promise<void> {
    const useAi = this.aiCheckbox.checked;
    const baseTitle = rom.name
      .replace(/\.[^.]+$/i, '')
      .replace(/\s*\([^)]*\)/g, '')
      .trim();

    const isChrRam = rom.data[5] === 0;
    let resultPoncho: Uint8Array;
    let summary: string;
    try {
      if (useAi && isChrRam) {
        const result = convertInesToPoncho(rom.data, { title: baseTitle });
        resultPoncho = result.poncho;
        summary = `CHR-RAM ${result.notes.chrRamKb} KB (runtime upscale fills lazily)`;
      } else if (useAi) {
        const aiResult = await this.runAiConvert(rom.data, baseTitle);
        if (!aiResult) {
          this.setUploadStatus('AI conversion cancelled.');
          return;
        }
        resultPoncho = aiResult.poncho;
        const n = aiResult.notes;
        const tilesDone = n.apiCalls + n.cacheHits;
        const partialPrefix = n.cancelled
          ? `Cancelled at ${tilesDone} / ${n.uniqueTiles} tiles - partial saved. `
          : '';
        summary =
          `${partialPrefix}native CHR ${n.chrKb} KB, ` +
          `${n.uniqueTiles} unique tiles, ` +
          `${n.failedTiles + n.cancelledTiles} fallbacks`;
      } else {
        const result = convertInesToPoncho(rom.data, { title: baseTitle });
        resultPoncho = result.poncho;
        const n = result.notes;
        const chrLabel = n.chrRamKb > 0 ? `CHR-RAM ${n.chrRamKb} KB` : `CHR ${n.chrKb} KB`;
        summary = `mapper ${n.sourceMapper}, ${chrLabel}, PRG ${n.prgKb} KB`;
      }
    } catch (err) {
      if (err instanceof ConvertError) {
        this.setUploadStatus(`Conversion failed: ${err.message}`);
      } else {
        this.setUploadStatus(`Conversion failed: ${(err as Error).message}`);
      }
      return;
    }

    const ponchoName = replaceExtension(rom.name, this.target.convertedExtension ?? '.poncho');
    const convertedRom: LoadedRom = {
      name: ponchoName,
      source: `browser:${ponchoName}`,
      data: resultPoncho,
    };
    try {
      await this.deps.romLibrary.add(ponchoName, resultPoncho);
      await this.refreshBrowserList();
      await this.deps.onLoaded(convertedRom);
    } catch (err) {
      this.setUploadStatus(`Saved-to-library failed: ${(err as Error).message}`);
      return;
    }

    this.setStatus(`Converted ${rom.name} to ${ponchoName} (${summary})`);
    this.closeAddView();
  }

  private async runAiConvert(
    inesBytes: Uint8Array,
    baseTitle: string,
  ): Promise<Awaited<ReturnType<typeof convertInesToPonchoAi>> | null> {
    const modal = createAiProgressModal('...resolving model...');
    document.body.appendChild(modal.root);

    const baseCtx = this.deps.getUpscaleContext?.();
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
      const resolved = createUpscaleClient(DEFAULT_UPSCALE_MODEL_ID, 'rom-bake', {}, ctx);
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

  private buildAttachedOnnxClient(bytes: Uint8Array): UpscaleClient {
    const cfg: OnnxUpscaleClientConfig = {
      modelId: AI_CACHE_MODEL_UNSPECIFIED,
      modelUrl: 'attached://custom.onnx',
      executionProviders: ['webgpu', 'wasm'],
      input: { size: 8, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'input' },
      output: { size: 32, layout: 'nchw', channelOrder: 'rgb', range: '[0..1]', pinName: 'output' },
    };
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    return new OnnxUpscaleClient(cfg, {
      modelLoader: async () => buf,
    });
  }
}

async function readRomFile(file: File, accept: readonly string[]): Promise<LoadedRom> {
  assertAcceptedExtension(file.name, accept);
  const buf = await file.arrayBuffer();
  const data = new Uint8Array(buf);
  validateRom(data);
  return { name: file.name, source: `file:${file.name}`, data };
}

function assertAcceptedExtension(name: string, accept: readonly string[]): void {
  if (hasAnyExtension(name, accept)) return;
  throw new InvalidRomError(`File must be one of: ${accept.join(', ')}.`);
}

function makeRomTarget(consoleId: string, consoleName: string): RomTarget {
  const target = ROM_TARGETS[consoleId] ?? ROM_TARGETS.nes!;
  return { ...target, consoleName };
}

function hasAnyExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function replaceExtension(name: string, ext: string): string {
  return name.replace(/\.[^.]+$/i, '') + ext;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
      <p class="ai-progress-count" data-count>preparing...</p>
      <p class="ai-progress-eta" data-eta>elapsed -, eta -</p>
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
      if (inferenceStarted) return;
      const pct = p.total && p.total > 0 ? Math.floor((p.loaded / p.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      const loadedMb = (p.loaded / (1024 * 1024)).toFixed(1);
      const totalMb = p.total ? (p.total / (1024 * 1024)).toFixed(1) : '?';
      count.textContent = p.fromCache
        ? `Loading model from cache (${loadedMb} MB)...`
        : `Downloading model: ${loadedMb} / ${totalMb} MB`;
      eta.textContent = `elapsed ${formatDuration(performance.now() - startedAt)}`;
    },
    setSessionPhase(phase) {
      if (inferenceStarted) return;
      if (phase === 'compiling') {
        fill.style.width = '100%';
        count.textContent = 'Compiling model and warming up GPU...';
      } else {
        count.textContent = 'Model ready - starting tile inference...';
      }
      eta.textContent = `elapsed ${formatDuration(performance.now() - startedAt)}`;
    },
    update(p) {
      inferenceStarted = true;
      const pct = p.total === 0 ? 100 : Math.floor((p.done / p.total) * 100);
      fill.style.width = `${pct}%`;
      count.textContent = `${p.done} / ${p.total} tiles - ${p.cached} cached - ${p.failed} fallbacks`;
      const elapsedMs = performance.now() - startedAt;
      const elapsed = formatDuration(elapsedMs);
      let etaText = '-';
      if (p.done > 0 && p.done < p.total) {
        const perTile = elapsedMs / p.done;
        etaText = formatDuration(perTile * (p.total - p.done));
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
