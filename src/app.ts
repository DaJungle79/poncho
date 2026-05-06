/**
 * Application orchestrator. Owns the wiring between the emulator core,
 * the renderer, the audio sink, the panels, and the platform layer.
 *
 * Each shell (web, Electron, …) builds a `Platform` and constructs an
 * `App`, then calls `run()`. The class is platform-agnostic — every
 * touchpoint that depends on the host environment goes through `Platform`.
 *
 * The DOM-based UI (sidebar + panels) lives in `src/ui/` and is reused
 * by every shell that runs in a Chromium-based renderer (web, Electron,
 * Tauri's webview). For non-DOM shells, this class would be replaced
 * by a different orchestrator that consumes the same emulator core.
 */
import { Nes } from './core/nes';
import { KeyboardSource } from './core/input/keyboard-source';
import { ConfigStore } from './config/store';
import { Canvas2DRenderer } from './renderer/canvas-renderer';
import { createScaler } from './renderer/scalers';
import { createFilter } from './renderer/filters';
import type { RenderPipeline } from './renderer/renderer';
import { applyLogLevelsFromQuery, log } from './debug/logger';
import { gameIcon, mountLucideIcons } from './ui/icons';
import { PanelStack } from './ui/panel-stack';
import { Sidebar } from './ui/sidebar';
import { RomsPanel } from './ui/panels/roms-panel';
import { SettingsPanel } from './ui/panels/settings-panel';
import { ControlsPanel } from './ui/panels/controls-panel';
import { RomInfoClient } from './rom/info-client';
import type { LoadedRom, RomMeta } from './domain/rom';
import type { Platform } from './platform/types';

/**
 * Required DOM elements the App expects to find. The shell's
 * `index.html` must mount these IDs.
 */
export interface AppDom {
  layoutRoot: HTMLDivElement;
  sidebarHost: HTMLElement;
  panelL2Host: HTMLElement;
  panelL3Host: HTMLElement;
  canvas: HTMLCanvasElement;
  statusEl: HTMLSpanElement;
  fpsEl: HTMLSpanElement;
  gameTitleEl: HTMLDivElement;
}

export class App {
  // ----- Core --------------------------------------------------------------
  readonly config: ConfigStore;
  readonly nes: Nes;
  readonly renderer: Canvas2DRenderer;
  readonly keyboard: KeyboardSource;
  readonly romInfo: RomInfoClient;

  // ----- UI ---------------------------------------------------------------
  private readonly stack: PanelStack;
  private readonly sidebar: Sidebar;
  private readonly romsPanel: RomsPanel;

  // ----- Run-loop state ---------------------------------------------------
  private powered = false;
  private paused = false;
  private lastFrameTs = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private readonly audioBuffer = new Float32Array(2048);

  // ----- DOM refs ---------------------------------------------------------
  private readonly dom: AppDom;
  private readonly gameTitleNameEl: HTMLHeadingElement;
  private readonly gameTitleSubEl: HTMLParagraphElement;

  constructor(
    private readonly platform: Platform,
    dom: AppDom,
  ) {
    applyLogLevelsFromQuery(window.location.search);

    this.dom = dom;
    this.gameTitleNameEl = dom.gameTitleEl.querySelector<HTMLHeadingElement>('[data-title]')!;
    this.gameTitleSubEl = dom.gameTitleEl.querySelector<HTMLParagraphElement>('[data-subtitle]')!;

    // ----- Config (with theme applied to <html>) -------------------------
    this.config = new ConfigStore(platform.configStorage);
    this.applyTheme(this.config.get().general.theme);

    // ----- Emulator + renderer ------------------------------------------
    this.nes = new Nes();
    this.renderer = new Canvas2DRenderer(dom.canvas);
    this.renderer.setPipeline(this.buildPipeline());

    this.keyboard = new KeyboardSource(this.config.get().input.player1Keys);
    this.nes.setController(1, this.keyboard);

    this.romInfo = new RomInfoClient(platform.romInfoStorage);

    // ----- Panels + sidebar ---------------------------------------------
    this.stack = new PanelStack(dom.layoutRoot, dom.panelL2Host, dom.panelL3Host);
    this.sidebar = new Sidebar(this.stack);
    dom.sidebarHost.appendChild(this.sidebar.root);

    this.romsPanel = new RomsPanel({
      romLibrary: platform.romLibrary,
      serverRoms: platform.serverRoms,
      filePicker: platform.filePicker,
      onLoaded: (rom) => this.loadRom(rom),
      onPower: () => this.togglePower(),
      onReset: () => this.resetEmu(),
      onPause: () => this.togglePause(),
      isPowered: () => this.powered,
      isPaused: () => this.paused,
    });
    this.stack.registerL2(this.romsPanel);

    const settingsPanel = new SettingsPanel({
      config: this.config,
      onOpenControls: () => this.stack.toggleL3('controls'),
      onConfigChanged: (cfg) => {
        this.renderer.setPipeline(this.buildPipeline());
        this.platform.audio.setVolume(cfg.audio.volume);
        this.platform.audio.setMuted(cfg.audio.muted);
        this.applyTheme(cfg.general.theme);
      },
    });
    this.stack.registerL2(settingsPanel);

    const controlsPanel = new ControlsPanel({
      config: this.config,
      onBindingsChanged: (bindings) => this.keyboard.setBindings(bindings),
    });
    this.stack.registerL3(controlsPanel);

    this.sidebar.add({
      panelId: 'roms',
      label: 'ROMs',
      position: 'top',
      icon: () => {
        const el = gameIcon('cassette');
        el.setAttribute('width', '22');
        el.setAttribute('height', '22');
        return el;
      },
    });
    this.sidebar.add({
      panelId: 'settings',
      label: 'Settings',
      position: 'bottom',
      icon: () => {
        const i = document.createElement('i');
        i.dataset.lucide = 'settings';
        return i;
      },
    });

    mountLucideIcons();

    // Open the ROMs panel on first load — user lands on something useful.
    this.stack.openL2('roms');
    this.sidebar.syncActive();

    this.keyboard.attach();

    // ----- Click-outside dismissal of L2/L3 ------------------------------
    const layoutMain = document.querySelector<HTMLElement>('.layout-main')!;
    layoutMain.addEventListener('click', () => {
      if (this.stack.activeL3()) {
        this.stack.closeL3();
      } else if (this.stack.activeL2()) {
        this.stack.closeAll();
        this.sidebar.syncActive();
      }
    });
  }

  /** Start the requestAnimationFrame loop. */
  run(): void {
    const tick = (ts: number) => {
      if (this.lastFrameTs > 0) {
        const dt = ts - this.lastFrameTs;
        this.fpsAccum += dt;
        this.fpsFrames += 1;
        if (this.fpsAccum >= 500) {
          this.dom.fpsEl.textContent = `${((this.fpsFrames * 1000) / this.fpsAccum).toFixed(1)} FPS`;
          this.fpsAccum = 0;
          this.fpsFrames = 0;
        }
      }
      this.lastFrameTs = ts;

      if (!this.paused) {
        const fb = this.nes.runFrame();
        this.renderer.render(fb);

        let drained = 0;
        while (this.nes.apu.queuedSamples() > 0 && drained < this.audioBuffer.length) {
          const fresh = this.nes.apu.pullSamples(this.audioBuffer);
          if (fresh === 0) break;
          this.platform.audio.push(this.audioBuffer, fresh);
          drained += fresh;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ----- Lifecycle helpers --------------------------------------------------

  private async loadRom(rom: LoadedRom): Promise<void> {
    try {
      this.nes.loadRom(rom.data);
      this.powered = true;
      this.paused = false;
      this.config.update((c) => ({ ...c, general: { ...c.general, lastRomUrl: rom.source } }));
      this.setStatus(
        `Loaded ${rom.name} · mapper ${this.nes.cartridge?.mapper.id} (${this.nes.cartridge?.mapper.name})`,
      );
      await this.platform.audio.start();
      this.nes.apu.setSampleRate(this.platform.audio.sampleRate);
      this.platform.audio.setVolume(this.config.get().audio.volume);
      this.platform.audio.setMuted(this.config.get().audio.muted);
      // Async, non-blocking — title appears once the lookup resolves.
      this.romInfo
        .lookup(rom)
        .then((meta) => this.setGameTitle(meta))
        .catch((err) => {
          log.warn('rom', 'rominfo lookup failed', err);
          this.setGameTitle({
            title: rom.name.replace(/\.nes$/i, ''),
            subtitle: null,
            source: 'filename',
          });
        });
    } catch (err) {
      log.error('rom', err);
      this.setStatus(`Failed: ${(err as Error).message}`);
    }
  }

  private togglePower(): void {
    if (!this.powered) {
      if (!this.nes.cartridge) { this.setStatus('Load a ROM first.'); return; }
      this.nes.reset();
      this.powered = true;
      this.paused = false;
      void this.platform.audio.start().then(() =>
        this.nes.apu.setSampleRate(this.platform.audio.sampleRate),
      );
    } else {
      this.powered = false;
      this.nes.unload();
      void this.platform.audio.stop();
      this.setStatus('Powered off.');
      this.setGameTitle(null);
    }
  }

  private resetEmu(): void {
    if (this.powered) this.nes.reset();
  }

  private togglePause(): void {
    this.paused = !this.paused;
  }

  private setStatus(text: string): void {
    this.dom.statusEl.textContent = text;
    this.romsPanel.setStatus(text);
  }

  /** Toggle the game title block visibility + retrigger the slide-in animation. */
  private setGameTitle(meta: RomMeta | null): void {
    if (meta) {
      this.gameTitleNameEl.textContent = meta.title;
      this.gameTitleSubEl.textContent = meta.subtitle ?? '';
      this.dom.gameTitleEl.hidden = false;
      // Force a CSS animation restart: drop the class, reflow, re-add.
      this.dom.gameTitleEl.classList.remove('title-anim');
      void this.dom.gameTitleEl.offsetWidth;
      this.dom.gameTitleEl.classList.add('title-anim');
      document.title = `Poncho — ${meta.title}`;
    } else {
      this.dom.gameTitleEl.hidden = true;
      document.title = 'Poncho — NES Emulator';
    }
  }

  private buildPipeline(): RenderPipeline {
    const cfg = this.config.get().video;
    return {
      preFilters: cfg.preFilters.map(createFilter),
      scaler: createScaler(cfg.scaler),
      postFilters: cfg.postFilters.map(createFilter),
    };
  }

  private applyTheme(theme: 'dark' | 'light'): void {
    document.documentElement.dataset.theme = theme;
  }
}
