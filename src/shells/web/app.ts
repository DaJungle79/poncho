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
import { Nes } from '../../console/nes';
import { PonchoNes } from '../../console/poncho-nes';
import { ALL_SPECS, NES_SPEC, PONCHO_NES_SPEC } from '../../console/specs';
import type { ConsoleSpec } from '../../console/console';
import { KeyboardSource } from '../../core/input/keyboard-source';
import { ConfigStore } from '../../config/store';
import { Canvas2DRenderer } from '../../renderer/canvas-renderer';
import { createScaler } from '../../renderer/scalers';
import { createFilter } from '../../renderer/filters';
import { NES_OVERSCAN } from '../../renderer/filters/overscan';
import type { RenderPipeline } from '../../renderer/renderer';
import { applyLogLevelsFromQuery, log } from '../../debug/logger';
import { gameIcon, mountLucideIcons } from './ui/icons';
import { PanelStack } from './ui/panel-stack';
import { Sidebar } from './ui/sidebar';
import { ConsolesPanel } from './ui/panels/consoles-panel';
import { RomsPanel } from './ui/panels/roms-panel';
import { SettingsPanel } from './ui/panels/settings-panel';
import { ControlsPanel } from './ui/panels/controls-panel';
import { RomInfoClient } from '../../rom/info-client';
import type { LoadedRom, RomMeta } from '../../domain/rom';
import type { Platform } from '../../platform/types';
import logoLight from './ui/logo-light.svg?url';
import logoDark from './ui/logo-dark.svg?url';

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
  /** Active virtual console. Replaced when the user picks a different one. */
  nes: Nes | PonchoNes;
  readonly renderer: Canvas2DRenderer;
  readonly keyboard: KeyboardSource;
  readonly romInfo: RomInfoClient;

  // ----- UI ---------------------------------------------------------------
  private readonly stack: PanelStack;
  private readonly sidebar: Sidebar;
  private readonly romsPanel: RomsPanel;
  private readonly settingsPanel: SettingsPanel;

  // ----- Run-loop state ---------------------------------------------------
  private activeConsoleId: string;
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
    this.applyStatusBar(this.config.get().general.showStatusBar);

    // ----- Emulator + renderer ------------------------------------------
    this.activeConsoleId = this.config.get().general.selectedConsoleId;
    this.nes = createConsole(this.activeConsoleId);
    this.renderer = new Canvas2DRenderer(dom.canvas);
    this.renderer.setPipeline(this.buildPipeline());

    this.keyboard = new KeyboardSource(this.config.get().input.player1Keys);
    this.nes.setController(1, this.keyboard);

    this.romInfo = new RomInfoClient(platform.romInfoStorage);

    // ----- Panels + sidebar ---------------------------------------------
    this.stack = new PanelStack(dom.layoutRoot, dom.panelL2Host, dom.panelL3Host);
    this.sidebar = new Sidebar(this.stack);
    dom.sidebarHost.appendChild(this.sidebar.root);

    const consolesPanel = new ConsolesPanel({
      specs: ALL_SPECS,
      initialSelectedId: this.config.get().general.selectedConsoleId,
      onSelect: (spec) => this.selectConsole(spec),
    });
    this.stack.registerL2(consolesPanel);

    this.romsPanel = new RomsPanel({
      romLibrary: platform.romLibrary,
      serverRoms: platform.serverRoms,
      filePicker: platform.filePicker,
      onLoaded: (rom) => this.loadRom(rom),
      onStatus: (text) => this.setStatus(text),
    });
    this.stack.registerL2(this.romsPanel);
    const initialSpec = ALL_SPECS.find((s) => s.id === this.config.get().general.selectedConsoleId) ?? ALL_SPECS[0]!;
    this.romsPanel.setConsoleId(initialSpec.id, initialSpec.name);

    this.settingsPanel = new SettingsPanel({
      config: this.config,
      onOpenControls: () => this.stack.toggleL3('controls'),
      onConfigChanged: (cfg) => {
        this.renderer.setPipeline(this.buildPipeline());
        this.platform.audio.setVolume(cfg.audio.volume);
        this.platform.audio.setMuted(cfg.audio.muted);
        this.applyTheme(cfg.general.theme);
        this.applyStatusBar(cfg.general.showStatusBar);
      },
    });
    this.stack.registerL2(this.settingsPanel);
    // Apply scaler availability for the boot-time console (poncho-nes
    // restricts to 1× since its native frame is already 1024×960).
    this.settingsPanel.setConsoleId(this.config.get().general.selectedConsoleId);

    const controlsPanel = new ControlsPanel({
      config: this.config,
      onBindingsChanged: (bindings) => this.keyboard.setBindings(bindings),
    });
    this.stack.registerL3(controlsPanel);

    this.sidebar.add({
      id: 'consoles',
      panelId: 'consoles',
      label: this.consoleLabelFromId(this.config.get().general.selectedConsoleId),
      position: 'top',
      hotkey: '0',
      icon: () => lucide('cpu'),
    });
    this.sidebar.add({
      id: 'roms',
      panelId: 'roms',
      label: `${initialSpec.name} ROMs`,
      position: 'top',
      hotkey: '1',
      icon: () => {
        const el = gameIcon('cassette');
        el.setAttribute('width', '22');
        el.setAttribute('height', '22');
        return el;
      },
    });
    this.sidebar.add({
      id: 'pause',
      label: 'Pause',
      position: 'top',
      hotkey: '2',
      icon: () => lucide('pause'),
      onClick: () => this.togglePause(),
    });
    this.sidebar.add({
      id: 'reset',
      label: 'Reset',
      position: 'top',
      hotkey: '3',
      icon: () => lucide('rotate-ccw'),
      onClick: () => this.resetEmu(),
    });
    this.sidebar.add({
      id: 'off',
      label: 'Off / Eject',
      position: 'top',
      hotkey: '4',
      icon: () => lucide('power'),
      onClick: () => this.togglePower(),
    });
    this.sidebar.add({
      id: 'settings',
      panelId: 'settings',
      label: 'Settings',
      position: 'bottom',
      hotkey: '5',
      icon: () => lucide('settings'),
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

  /**
   * Switch the active virtual console. Persists the choice, replaces
   * the running engine, and rewires the input + audio plumbing. Any
   * loaded ROM is ejected — the user picks a fresh one for the new
   * console (formats may differ).
   */
  private selectConsole(spec: ConsoleSpec): void {
    if (this.config.get().general.selectedConsoleId === spec.id) return;

    if (this.powered) this.togglePower(); // ejects current ROM, stops audio

    this.config.update((cfg) => {
      cfg.general.selectedConsoleId = spec.id;
      return cfg;
    });

    this.activeConsoleId = spec.id;
    this.nes = createConsole(spec.id);
    this.nes.setController(1, this.keyboard);
    this.renderer.setPipeline(this.buildPipeline());

    this.sidebar.setTooltip('consoles', this.consoleLabelFromId(spec.id));
    this.sidebar.setTooltip('roms', `${spec.name} ROMs`);
    this.settingsPanel.setConsoleId(spec.id);
    this.romsPanel.setConsoleId(spec.id, spec.name);
    this.setStatus(`${spec.name} selected.`);
  }

  private consoleLabelFromId(id: string): string {
    const spec = ALL_SPECS.find((s) => s.id === id);
    return spec ? spec.name : 'Console';
  }

  private setStatus(text: string): void {
    this.dom.statusEl.textContent = text;
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
    const cropFilters = (cfg.overscan && this.activeConsoleId === 'nes') ? [NES_OVERSCAN] : [];
    return {
      preFilters: [...cropFilters, ...cfg.preFilters.map(createFilter)],
      scaler: createScaler(cfg.scaler),
      postFilters: cfg.postFilters.map(createFilter),
    };
  }

  private applyTheme(theme: 'dark' | 'light'): void {
    document.documentElement.dataset.theme = theme;
    const logo = document.getElementById('brand-logo') as HTMLImageElement | null;
    if (logo) logo.src = theme === 'dark' ? logoDark : logoLight;
  }

  private applyStatusBar(visible: boolean): void {
    document.documentElement.dataset.statusBar = visible ? 'visible' : 'hidden';
  }
}

function lucide(name: string): HTMLElement {
  const i = document.createElement('i');
  i.dataset.lucide = name;
  return i;
}

/**
 * Instantiate the runtime for a given console-spec id. Falls back to
 * Classic NES if the id is unknown — keeps the boot path resilient
 * against stale config values.
 */
function createConsole(id: string): Nes | PonchoNes {
  if (id === PONCHO_NES_SPEC.id) return new PonchoNes();
  if (id === NES_SPEC.id) return new Nes();
  log.warn('rom', `Unknown console id "${id}", falling back to Classic NES.`);
  return new Nes();
}
