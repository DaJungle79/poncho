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
import { repackPonchoWithAiCache } from '../../core/cart-poncho/repack';
import { createUpscaleClient } from '../../convert/upscale-registry';
import { UpscaleWorker } from '../../runtime/upscale-worker';
import type { ConsoleSpec } from '../../console/console';
import { KeyboardSource } from '../../core/input/keyboard-source';
import { ConfigStore } from '../../config/store';
import { Canvas2DRenderer } from '../../renderer/canvas-renderer';
import { createScaler } from '../../renderer/scalers';
import { createFilter } from '../../renderer/filters';
import { OverscanCropFilter } from '../../renderer/filters/overscan';
import type { RenderPipeline } from '../../renderer/renderer';
import { applyLogLevelsFromQuery, log } from '../../debug/logger';
import { mountLucideIcons } from './ui/icons';
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
  private readonly consolesPanel: ConsolesPanel;
  private readonly romsPanel: RomsPanel;
  private readonly settingsPanel: SettingsPanel;

  // ----- Run-loop state ---------------------------------------------------
  private activeConsoleId: string;
  private romsOpenConsoleId: string | null = null;
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

  // ----- Runtime AI upscale (Phase 3 of v0.4) -----------------------------
  /** Active CHR-RAM upscale worker. Null when the loaded cart isn't eligible. */
  private aiWorker: UpscaleWorker | null = null;
  /** Latest `.poncho` bytes for the running cart, for write-back. */
  private aiCartBytes: Uint8Array | null = null;
  /** ROM library key for write-back. Null skips persistence. */
  private aiCartName: string | null = null;
  /** 60 s flush handle. */
  private aiFlushTimer: ReturnType<typeof setInterval> | null = null;

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

    this.consolesPanel = new ConsolesPanel({
      specs: ALL_SPECS,
      initialSelectedId: this.config.get().general.selectedConsoleId,
      onSelect: (spec) => this.selectConsole(spec),
      onToggleRoms: (spec) => this.toggleConsoleRoms(spec),
    });
    this.stack.registerL2(this.consolesPanel);

    this.romsPanel = new RomsPanel({
      romLibrary: platform.romLibrary,
      serverRoms: platform.serverRoms,
      filePicker: platform.filePicker,
      onLoaded: (rom) => this.loadRom(rom),
      onStatus: (text) => this.setStatus(text),
      getUpscaleContext: () => {
        const cache = this.platform.modelAssetCache;
        if (!cache) return undefined;
        return {
          loadAsset: (url, opts) => cache.load(url, opts),
          evictAsset: (url) => cache.remove(url),
        };
      },
    });
    this.stack.registerL3(this.romsPanel);
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
      id: 'pause',
      label: 'Pause',
      position: 'top',
      hotkey: '1',
      icon: () => lucide('pause'),
      onClick: () => this.togglePause(),
    });
    this.sidebar.add({
      id: 'reset',
      label: 'Reset',
      position: 'top',
      hotkey: '2',
      icon: () => lucide('rotate-ccw'),
      onClick: () => this.resetEmu(),
    });
    this.sidebar.add({
      id: 'off',
      label: 'Off / Eject',
      position: 'top',
      hotkey: '3',
      icon: () => lucide('power'),
      onClick: () => this.togglePower(),
    });
    this.sidebar.add({
      id: 'settings',
      panelId: 'settings',
      label: 'Settings',
      position: 'bottom',
      hotkey: '4',
      icon: () => lucide('settings'),
    });

    mountLucideIcons();

    // Open Consoles on first load, with the active console's ROM bay beside it.
    this.stack.openL2('consoles');
    this.stack.openL3('roms');
    this.romsOpenConsoleId = initialSpec.id;
    this.consolesPanel.setRomsOpen(initialSpec.id);
    this.sidebar.syncActive();

    this.keyboard.attach();

    // ----- Click-outside dismissal of L2/L3 ------------------------------
    const layoutMain = document.querySelector<HTMLElement>('.layout-main')!;
    layoutMain.addEventListener('click', () => {
      if (this.stack.activeL3()) {
        this.stack.closeL3();
        this.romsOpenConsoleId = null;
        this.consolesPanel.setRomsOpen(null);
      } else if (this.stack.activeL2()) {
        this.stack.closeAll();
        this.romsOpenConsoleId = null;
        this.consolesPanel.setRomsOpen(null);
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
    // Tear down any prior cart's upscale worker, flushing one last time.
    await this.teardownAiWorker();
    try {
      this.nes.loadRom(rom.data);
      this.maybeStartAiWorker(rom);
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
      void this.teardownAiWorker();
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
    this.settingsPanel.setConsoleId(spec.id);
    this.romsPanel.setConsoleId(spec.id, spec.name);
    if (this.stack.activeL3() === 'roms') {
      this.romsOpenConsoleId = spec.id;
      this.consolesPanel.setRomsOpen(spec.id);
    }
    this.setStatus(`${spec.name} selected.`);
  }

  private toggleConsoleRoms(spec: ConsoleSpec): void {
    const shouldClose = this.stack.activeL3() === 'roms' && this.romsOpenConsoleId === spec.id;
    if (this.config.get().general.selectedConsoleId !== spec.id) {
      this.consolesPanel.setSelected(spec.id);
      this.selectConsole(spec);
    }
    if (shouldClose) {
      this.stack.closeL3();
      this.romsOpenConsoleId = null;
      this.consolesPanel.setRomsOpen(null);
      return;
    }
    this.stack.openL3('roms');
    this.romsOpenConsoleId = spec.id;
    this.consolesPanel.setRomsOpen(spec.id);
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
    const { overscan } = cfg;
    const cropFilters =
      (overscan.enabled && this.activeConsoleId === 'nes')
        ? [new OverscanCropFilter(overscan.top, overscan.bottom, overscan.left, overscan.right)]
        : [];
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

  // ----- AI upscale worker lifecycle ----------------------------------------

  /**
   * Spin up the runtime upscale worker iff:
   *   - we're on Poncho-NES,
   *   - the cart is upscaled-mode + CHR-RAM (CHR-ROM games are baked
   *     ahead of time via `convertInesToPonchoAi`; the runtime worker
   *     would have nothing to do).
   *
   * Wires the worker as PpuUltra's tile resolver, kicks off a 60 s
   * periodic flush, and remembers the cart's source-of-truth bytes for
   * later write-back. Best-effort — any failure is swallowed; AI just
   * doesn't engage.
   */
  private maybeStartAiWorker(rom: LoadedRom): void {
    if (!(this.nes instanceof PonchoNes)) return;
    const cart = this.nes.cartridge;
    if (!cart) return;
    if (!cart.layout.header.flags.upscaledMode) return;
    // Two scenarios trigger the worker:
    //   - CHR-RAM upscaled cart (runtime PRG-uploaded tiles get baked
    //     in the background; user needs an API key)
    //   - Any cart with a pre-populated AI cache section (CHR-ROM that
    //     was AI-baked at conversion time → resolver pulls from cache,
    //     no API calls needed; misses fall back to NN via MockClient)
    const hasCache = cart.aiCache !== null && cart.aiCache.entries.length > 0;
    if (!cart.chrIsRam && !hasCache) return;

    const ai = this.config.get().ai;
    const cache = this.platform.modelAssetCache;
    const ctx = cache
      ? {
          loadAsset: (url: string, opts?: { signal?: AbortSignal; onProgress?: (p: { loaded: number; total: number | null; fromCache: boolean }) => void }) => cache.load(url, opts),
          evictAsset: (url: string) => cache.remove(url),
        }
      : undefined;
    const { client, model, usedFallback } = createUpscaleClient(
      ai.ramModelId,
      'ram-runtime',
      ai.modelConfig[ai.ramModelId] ?? {},
      ctx,
    );
    if (usedFallback) {
      log.warn('rom', `runtime upscale: requested model "${ai.ramModelId}" unavailable; falling back to "${model.id}"`);
    } else {
      log.info('rom', `runtime upscale: using model "${model.id}"`);
    }
    // Fire-and-forget preflight: surface a clear console warning if the
    // model can't initialise (missing weights, WebGPU init failure).
    // Per-tile NN-fallback still keeps the game playable, but at least
    // the developer sees *why* every tile is rendering as nearest-neighbour.
    if (client.preflight) {
      void client.preflight().catch((err) => {
        log.warn('rom', `runtime upscale: model "${model.id}" preflight failed; per-tile NN fallback will run for the whole session — ${(err as Error).message ?? String(err)}`);
      });
    }

    const worker = new UpscaleWorker({
      client,
      seed: cart.aiCache,
      // Note: PpuUltra renders every frame anyway, so we don't strictly
      // need the onTileReady hook — the next frame picks up the tile
      // automatically. Hook left null to avoid extra invalidation work.
    });
    this.aiWorker = worker;
    // Only enable write-back for CHR-RAM carts. AI-baked CHR-ROM carts
    // ship with their cache pre-populated; any "fresh" tile the worker
    // produces during play would be a mock NN fallback for a tile that
    // wasn't in the bake — flushing that would pollute the cart with
    // garbage. CHR-RAM is where new genuine AI work happens.
    const persistEnabled = cart.chrIsRam && this.shouldPersistAiCache(rom);
    this.aiCartBytes = persistEnabled ? rom.data : null;
    this.aiCartName = persistEnabled ? rom.name : null;

    this.nes.ppu.setUpscaledTileResolver((nesTile, subPalette) =>
      worker.resolveSync(nesTile, subPalette));

    // Periodic flush — every 60 s. Only for CHR-RAM, since baked
    // CHR-ROM has nothing meaningful to write back.
    if (this.aiFlushTimer) clearInterval(this.aiFlushTimer);
    if (persistEnabled) {
      this.aiFlushTimer = setInterval(() => { void this.flushAiCache(); }, 60_000);
    }
  }

  /**
   * Final flush + cleanup. Called from `loadRom` (before installing a
   * new cart), `togglePower` (eject), and `selectConsole` (which itself
   * calls togglePower first).
   */
  private async teardownAiWorker(): Promise<void> {
    if (this.aiFlushTimer) {
      clearInterval(this.aiFlushTimer);
      this.aiFlushTimer = null;
    }
    if (this.aiWorker) {
      await this.flushAiCache();
      this.aiWorker = null;
    }
    this.aiCartBytes = null;
    this.aiCartName = null;
    if (this.nes instanceof PonchoNes) {
      this.nes.ppu.setUpscaledTileResolver(null);
    }
  }

  /**
   * Snapshot the worker's current entries, repack the `.poncho` bytes
   * with the merged AI cache, and persist back into the ROM library.
   * No-ops when the worker is clean or the cart isn't eligible for
   * persistence (e.g. server ROMs).
   */
  private async flushAiCache(): Promise<void> {
    const worker = this.aiWorker;
    const bytes = this.aiCartBytes;
    const name = this.aiCartName;
    if (!worker || !bytes || !name) return;
    if (!worker.isDirty()) return;

    try {
      const section = worker.toSection();
      const updated = repackPonchoWithAiCache(bytes, section);
      await this.platform.romLibrary.add(name, updated);
      this.aiCartBytes = updated;
      worker.clearDirty();
      log.info('rom', `Wrote AI cache (${section.entries.length} tiles) to ${name}`);
    } catch (err) {
      log.warn('rom', 'AI cache write-back failed; will retry on next flush.', err);
    }
  }

  /**
   * Persistence policy: write back to ROM library only for sources that
   * imply browser-storage ownership. Server-loaded ROMs would otherwise
   * silently materialise as library entries — surprising.
   */
  private shouldPersistAiCache(rom: LoadedRom): boolean {
    return rom.source.startsWith('browser:') || rom.source.startsWith('file:');
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
