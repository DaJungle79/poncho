import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';
import type { LocalRomLoader } from '../../rom/local-loader';
import type { FileRomLoader } from '../../rom/file-loader';
import type { BrowserRomStorage, StoredRomEntry } from '../../rom/browser-storage';
import type { LoadedRom } from '../../rom/loader';

export interface RomsPanelDeps {
  /** Reads ROMs from the project's `/roms/` folder via the dev server. */
  localLoader: LocalRomLoader;
  /** Validates + reads an uploaded `<input type=file>` File. */
  fileLoader: FileRomLoader;
  /** Persistent IndexedDB storage for uploaded ROMs. */
  storage: BrowserRomStorage;
  /** Called when a ROM has been loaded successfully. */
  onLoaded: (rom: LoadedRom) => void | Promise<void>;
  /** Power / Reset / Pause callbacks. Pause toggles. */
  onPower: () => void;
  onReset: () => void;
  onPause: () => void;
  /** Whether the emulator is currently powered. Used for button labels. */
  isPowered: () => boolean;
  /** Whether playback is currently paused. */
  isPaused: () => boolean;
}

/**
 * ROMs panel — two distinct sources, plus the always-visible playback
 * footer (Power / Reset / Pause).
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

  private readonly browserList: HTMLUListElement;
  private readonly serverList: HTMLUListElement;
  private readonly fileInput: HTMLInputElement;
  private readonly status: HTMLDivElement;
  private readonly btnPower: HTMLButtonElement;
  private readonly btnReset: HTMLButtonElement;
  private readonly btnPause: HTMLButtonElement;

  constructor(private readonly deps: RomsPanelDeps) {
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l2';
    this.root.innerHTML = `
      <header class="panel-head">
        <h2>ROMs</h2>
      </header>
      <div class="panel-body">
        <section class="rom-section">
          <h3><i data-lucide="hard-drive"></i><span>Browser storage</span></h3>
          <ul class="rom-list" data-browser-list></ul>
          <label class="file-button file-button-compact">
            <i data-lucide="upload"></i>
            <span>Upload .nes</span>
            <input type="file" accept=".nes" data-file hidden />
          </label>
        </section>

        <section class="rom-section">
          <h3><i data-lucide="folder"></i><span>Server</span> <span class="hint">/roms/</span></h3>
          <ul class="rom-list" data-server-list></ul>
        </section>

        <div class="rom-status" data-status></div>
      </div>

      <footer class="panel-footer">
        <button data-power class="rom-action">
          <i data-lucide="power"></i><span>Power</span>
        </button>
        <button data-reset class="rom-action">
          <i data-lucide="rotate-ccw"></i><span>Reset</span>
        </button>
        <button data-pause class="rom-action">
          <i data-lucide="pause"></i><span>Pause</span>
        </button>
      </footer>
    `;

    // Match the Settings header pattern: icon as a sibling of h2.
    const head = this.root.querySelector<HTMLElement>('.panel-head')!;
    const cassette = gameIcon('cassette');
    cassette.classList.add('panel-head-icon');
    head.prepend(cassette);

    this.browserList = this.root.querySelector<HTMLUListElement>('[data-browser-list]')!;
    this.serverList = this.root.querySelector<HTMLUListElement>('[data-server-list]')!;
    this.fileInput = this.root.querySelector<HTMLInputElement>('[data-file]')!;
    this.status = this.root.querySelector<HTMLDivElement>('[data-status]')!;
    this.btnPower = this.root.querySelector<HTMLButtonElement>('[data-power]')!;
    this.btnReset = this.root.querySelector<HTMLButtonElement>('[data-reset]')!;
    this.btnPause = this.root.querySelector<HTMLButtonElement>('[data-pause]')!;

    this.bindEvents();
  }

  onShow(): void {
    mountLucideIcons();
    void this.refreshBrowserList();
    void this.refreshServerList();
    this.refreshButtonStates();
  }

  /** Update Power / Pause button labels to match the current state. */
  refreshButtonStates(): void {
    this.btnPower.querySelector('span')!.textContent = this.deps.isPowered() ? 'Off' : 'Power';
    this.btnPause.querySelector('span')!.textContent = this.deps.isPaused() ? 'Resume' : 'Pause';
  }

  setStatus(text: string): void { this.status.textContent = text; }

  // ----- Browser-storage list ----------------------------------------------

  private async refreshBrowserList(): Promise<void> {
    this.browserList.innerHTML = '<li class="rom-empty">…</li>';
    let entries: StoredRomEntry[] = [];
    try {
      entries = await this.deps.storage.list();
    } catch (err) {
      this.browserList.innerHTML =
        `<li class="rom-empty">Storage unavailable: ${(err as Error).message}</li>`;
      return;
    }
    if (entries.length === 0) {
      this.browserList.innerHTML =
        '<li class="rom-empty">Upload a .nes file to add it here.</li>';
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
      const data = await this.deps.storage.get(name);
      if (!data) {
        this.setStatus(`${name} is gone from storage. Refreshing.`);
        await this.refreshBrowserList();
        return;
      }
      const rom: LoadedRom = { name, source: `browser:${name}`, data };
      await this.deps.onLoaded(rom);
      this.setStatus(`Loaded ${name}`);
      this.refreshButtonStates();
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
    }
  }

  private async removeFromBrowser(name: string): Promise<void> {
    try {
      await this.deps.storage.remove(name);
      await this.refreshBrowserList();
      this.setStatus(`Removed ${name} from browser storage.`);
    } catch (err) {
      this.setStatus(`Failed to remove: ${(err as Error).message}`);
    }
  }

  // ----- Server list -------------------------------------------------------

  private async refreshServerList(): Promise<void> {
    this.serverList.innerHTML = '<li class="rom-empty">Scanning…</li>';
    let files: string[] = [];
    try {
      files = await this.deps.localLoader.list();
    } catch {
      this.serverList.innerHTML = '<li class="rom-empty">Server unreachable.</li>';
      return;
    }
    if (files.length === 0) {
      this.serverList.innerHTML =
        '<li class="rom-empty">Drop .nes files in <code>roms/</code>.</li>';
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
    this.setStatus(`Loading ${filename}…`);
    try {
      const rom = await this.deps.localLoader.load(filename);
      await this.deps.onLoaded(rom);
      this.setStatus(`Loaded ${rom.name}`);
      this.refreshButtonStates();
    } catch (err) {
      this.setStatus(`Failed: ${(err as Error).message}`);
    }
  }

  // ----- Upload + playback wiring ------------------------------------------

  private bindEvents(): void {
    this.fileInput.addEventListener('change', async () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      this.setStatus(`Reading ${file.name}…`);
      try {
        const rom = await this.deps.fileLoader.load(file);
        // Persist to IndexedDB *before* loading into the emulator so a
        // failure to start the game doesn't lose the upload.
        await this.deps.storage.add(rom.name, rom.data);
        await this.refreshBrowserList();
        await this.deps.onLoaded(rom);
        this.setStatus(`Loaded ${rom.name} (saved to browser storage)`);
        this.refreshButtonStates();
      } catch (err) {
        this.setStatus(`Failed: ${(err as Error).message}`);
      } finally {
        // Reset the input so re-uploading the same file fires `change` again.
        this.fileInput.value = '';
      }
    });

    this.btnPower.addEventListener('click', () => {
      this.deps.onPower();
      this.refreshButtonStates();
    });
    this.btnReset.addEventListener('click', () => this.deps.onReset());
    this.btnPause.addEventListener('click', () => {
      this.deps.onPause();
      this.refreshButtonStates();
    });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
