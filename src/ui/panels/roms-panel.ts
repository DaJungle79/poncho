import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';
import type { LocalRomLoader } from '../../rom/local-loader';
import type { UrlRomLoader } from '../../rom/url-loader';
import type { FileRomLoader } from '../../rom/file-loader';
import type { LoadedRom } from '../../rom/loader';

export interface RomsPanelDeps {
  localLoader: LocalRomLoader;
  urlLoader: UrlRomLoader;
  fileLoader: FileRomLoader;
  /** Called when a ROM has been loaded successfully. */
  onLoaded: (rom: LoadedRom) => void | Promise<void>;
  /** Power / Reset / Pause callbacks. Pause toggles. */
  onPower: () => void;
  onReset: () => void;
  onPause: () => void;
  /** Whether the emulator is currently powered. Used for button states. */
  isPowered: () => boolean;
  /** Whether playback is currently paused. */
  isPaused: () => boolean;
}

/**
 * Slide-out ROM browser. Replaces the old top-bar dropdown with a
 * structured list of local files (`/roms/`), a URL input, and a file
 * picker, plus the always-visible Power / Reset / Pause controls.
 */
export class RomsPanel implements Panel {
  readonly id = 'roms';
  readonly root: HTMLElement;

  private readonly localList: HTMLUListElement;
  private readonly urlInput: HTMLInputElement;
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
          <h3>Local <span class="hint">/roms/</span></h3>
          <ul class="rom-list" data-list></ul>
        </section>

        <section class="rom-section">
          <h3>From URL</h3>
          <form class="rom-url-form">
            <input type="text" placeholder="https://…/game.nes" data-url />
            <button type="submit">Load</button>
          </form>
        </section>

        <section class="rom-section">
          <h3>Upload</h3>
          <label class="file-button">
            <i data-lucide="upload"></i>
            <span>Choose .nes file</span>
            <input type="file" accept=".nes" data-file hidden />
          </label>
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

    // Match the Settings header pattern: icon as a sibling of h2 inside
    // panel-head (not inside the h2). Keeps padding/alignment uniform.
    const head = this.root.querySelector<HTMLElement>('.panel-head')!;
    const cassette = gameIcon('cassette');
    cassette.classList.add('panel-head-icon');
    head.prepend(cassette);

    this.localList = this.root.querySelector<HTMLUListElement>('[data-list]')!;
    this.urlInput = this.root.querySelector<HTMLInputElement>('[data-url]')!;
    this.fileInput = this.root.querySelector<HTMLInputElement>('[data-file]')!;
    this.status = this.root.querySelector<HTMLDivElement>('[data-status]')!;
    this.btnPower = this.root.querySelector<HTMLButtonElement>('[data-power]')!;
    this.btnReset = this.root.querySelector<HTMLButtonElement>('[data-reset]')!;
    this.btnPause = this.root.querySelector<HTMLButtonElement>('[data-pause]')!;

    this.bindEvents();
  }

  onShow(): void {
    mountLucideIcons();
    this.refreshLocalList();
    this.refreshButtonStates();
  }

  /** Update Power / Pause button labels to match the current state. */
  refreshButtonStates(): void {
    this.btnPower.querySelector('span')!.textContent = this.deps.isPowered() ? 'Off' : 'Power';
    this.btnPause.querySelector('span')!.textContent = this.deps.isPaused() ? 'Resume' : 'Pause';
  }

  setStatus(text: string): void { this.status.textContent = text; }

  private async refreshLocalList(): Promise<void> {
    this.localList.innerHTML = '<li class="rom-empty">Scanning…</li>';
    const files = await this.deps.localLoader.list();
    if (files.length === 0) {
      this.localList.innerHTML =
        '<li class="rom-empty">Drop .nes files in the <code>roms/</code> folder.</li>';
      return;
    }
    this.localList.innerHTML = '';
    for (const filename of files) {
      const li = document.createElement('li');
      li.className = 'rom-item';
      li.innerHTML = `<button class="rom-item-btn"><span>${filename}</span></button>`;
      li.querySelector('button')!.addEventListener('click', () => this.loadLocal(filename));
      this.localList.appendChild(li);
    }
  }

  private async loadLocal(filename: string): Promise<void> {
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

  private bindEvents(): void {
    const form = this.root.querySelector<HTMLFormElement>('.rom-url-form')!;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = this.urlInput.value.trim();
      if (!url) return;
      this.setStatus(`Fetching ${url}…`);
      try {
        const rom = await this.deps.urlLoader.load(url);
        await this.deps.onLoaded(rom);
        this.setStatus(`Loaded ${rom.name}`);
        this.refreshButtonStates();
      } catch (err) {
        this.setStatus(`Failed: ${(err as Error).message}`);
      }
    });

    this.fileInput.addEventListener('change', async () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      this.setStatus(`Reading ${file.name}…`);
      try {
        const rom = await this.deps.fileLoader.load(file);
        await this.deps.onLoaded(rom);
        this.setStatus(`Loaded ${rom.name}`);
        this.refreshButtonStates();
      } catch (err) {
        this.setStatus(`Failed: ${(err as Error).message}`);
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
