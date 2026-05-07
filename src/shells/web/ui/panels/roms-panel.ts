import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';
import type { FilePicker, RomLibrary, ServerRomLoader } from '../../../../platform/types';
import type { LoadedRom, StoredRomEntry } from '../../../../domain/rom';
import { ConvertError, convertInesToPoncho } from '../../../../convert/ines-to-poncho';

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
    let result;
    try {
      result = convertInesToPoncho(picked.data, { title: baseTitle });
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
      await this.deps.romLibrary.add(ponchoName, result.poncho);
      await this.refreshBrowserList();
    } catch (err) {
      this.setStatus(`Saved-to-library failed: ${(err as Error).message}`);
      return;
    }

    const { notes } = result;
    const chrLabel = notes.chrRamKb > 0 ? `CHR-RAM ${notes.chrRamKb} KB` : `CHR ${notes.chrKb} KB`;
    this.setStatus(
      `Converted ${picked.name} → ${ponchoName} ` +
      `(mapper ${notes.sourceMapper}, ${chrLabel}, PRG ${notes.prgKb} KB)`,
    );
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
