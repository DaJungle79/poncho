import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';
import type { FilePicker, RomLibrary, ServerRomLoader } from '../../../../platform/types';
import type { LoadedRom, StoredRomEntry } from '../../../../domain/rom';

export interface RomsPanelDeps {
  /** Persistent local library — uploaded ROMs (web: IndexedDB). */
  romLibrary: RomLibrary;
  /** Server-folder ROM loader. `null` on shells without a dev server (Electron). */
  serverRoms: ServerRomLoader | null;
  /** "Open file" dialog. */
  filePicker: FilePicker;
  /** Called when a ROM has been loaded successfully. */
  onLoaded: (rom: LoadedRom) => void | Promise<void>;
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

  private readonly browserList: HTMLUListElement;
  private readonly serverList: HTMLUListElement;
  private readonly serverSection: HTMLElement;
  private readonly btnUpload: HTMLButtonElement;
  private readonly status: HTMLDivElement;

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
          <button type="button" class="file-button file-button-compact" data-upload>
            <i data-lucide="upload"></i>
            <span>Upload .nes</span>
          </button>
        </section>

        <section class="rom-section" data-server-section>
          <h3><i data-lucide="folder"></i><span>Server</span> <span class="hint">/roms/</span></h3>
          <ul class="rom-list" data-server-list></ul>
        </section>

        <div class="rom-status" data-status></div>
      </div>
    `;

    // Match the Settings header pattern: icon as a sibling of h2.
    const head = this.root.querySelector<HTMLElement>('.panel-head')!;
    const cassette = gameIcon('cassette');
    cassette.classList.add('panel-head-icon');
    head.prepend(cassette);

    this.browserList = this.root.querySelector<HTMLUListElement>('[data-browser-list]')!;
    this.serverList = this.root.querySelector<HTMLUListElement>('[data-server-list]')!;
    this.serverSection = this.root.querySelector<HTMLElement>('[data-server-section]')!;
    this.btnUpload = this.root.querySelector<HTMLButtonElement>('[data-upload]')!;
    this.status = this.root.querySelector<HTMLDivElement>('[data-status]')!;

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
  }

  setStatus(text: string): void { this.status.textContent = text; }

  // ----- Browser-storage list ----------------------------------------------

  private async refreshBrowserList(): Promise<void> {
    this.browserList.innerHTML = '<li class="rom-empty">…</li>';
    let entries: StoredRomEntry[] = [];
    try {
      entries = await this.deps.romLibrary.list();
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
    let files: string[] = [];
    try {
      files = await this.deps.serverRoms.list();
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
      this.setStatus('Choose a .nes file…');
      let rom: LoadedRom | null;
      try {
        rom = await this.deps.filePicker.pick();
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
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
