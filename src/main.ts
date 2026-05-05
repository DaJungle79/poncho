import { Nes } from './core/nes';
import { KeyboardSource } from './core/input/keyboard-source';
import { ConfigStore } from './config/store';
import { Canvas2DRenderer } from './renderer/canvas-renderer';
import { createScaler } from './renderer/scalers';
import { createFilter } from './renderer/filters';
import type { RenderPipeline } from './renderer/renderer';
import { LocalRomLoader } from './rom/local-loader';
import { UrlRomLoader } from './rom/url-loader';
import { FileRomLoader } from './rom/file-loader';
import { WebAudioSink } from './audio/web-audio-sink';
import { applyLogLevelsFromQuery, log } from './debug/logger';
import { gameIcon, mountLucideIcons } from './ui/icons';
import { PanelStack } from './ui/panel-stack';
import { Sidebar } from './ui/sidebar';
import { RomsPanel } from './ui/panels/roms-panel';
import { SettingsPanel } from './ui/panels/settings-panel';
import { ControlsPanel } from './ui/panels/controls-panel';
import type { LoadedRom } from './rom/loader';
import { RomInfoClient, type RomMeta } from './rom/info-client';

applyLogLevelsFromQuery(window.location.search);

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

// ---------------------------------------------------------------------------
// Core wiring
// ---------------------------------------------------------------------------

const config = new ConfigStore();

/**
 * Apply the configured theme to <html data-theme="..."> so the CSS
 * variables in styles.css switch between dark and light palettes.
 */
function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
}
applyTheme(config.get().general.theme);

const nes = new Nes();
const renderer = new Canvas2DRenderer($<HTMLCanvasElement>('screen'));
const audioSink = new WebAudioSink();
const keyboard = new KeyboardSource(config.get().input.player1Keys);
nes.setController(1, keyboard);

const localLoader = new LocalRomLoader();
const urlLoader = new UrlRomLoader();
const fileLoader = new FileRomLoader();
const romInfo = new RomInfoClient();
// Hook to add a remote source later, e.g.:
//   romInfo.addSource(new ScreenScraperSource({ devid, devpassword }));
// The client already caches by SHA-1, so any source is queried at most
// once per ROM per browser.

function buildPipeline(): RenderPipeline {
  const cfg = config.get().video;
  return {
    preFilters: cfg.preFilters.map(createFilter),
    scaler: createScaler(cfg.scaler),
    postFilters: cfg.postFilters.map(createFilter),
  };
}
renderer.setPipeline(buildPipeline());

// ---------------------------------------------------------------------------
// Run-loop state
// ---------------------------------------------------------------------------

let powered = false;
let paused = false;
let lastFrameTs = 0;
let fpsAccum = 0;
let fpsFrames = 0;
const audioBuffer = new Float32Array(2048);

const statusEl = $<HTMLSpanElement>('status-text');
const fpsEl = $<HTMLSpanElement>('fps');
const gameTitleEl = $<HTMLDivElement>('game-title');
const gameTitleNameEl = gameTitleEl.querySelector<HTMLHeadingElement>('[data-title]')!;
const gameTitleSubEl = gameTitleEl.querySelector<HTMLParagraphElement>('[data-subtitle]')!;

function setStatus(text: string): void {
  statusEl.textContent = text;
  romsPanel.setStatus(text);
}

/**
 * Show the loaded game's title underneath the (always-visible) Poncho
 * brand. Passing `null` hides the title block again. We retrigger the
 * `title-pop` CSS animation by toggling a class so each new ROM gets
 * the slide-fade-in, even when one was already showing.
 */
function setGameTitle(meta: RomMeta | null): void {
  if (meta) {
    gameTitleNameEl.textContent = meta.title;
    gameTitleSubEl.textContent = meta.subtitle ?? '';
    gameTitleEl.hidden = false;
    // Force a CSS animation restart: drop the class, trigger a reflow
    // (offsetWidth read), put it back — the browser re-runs keyframes.
    gameTitleEl.classList.remove('title-anim');
    void gameTitleEl.offsetWidth;
    gameTitleEl.classList.add('title-anim');
    document.title = `Poncho — ${meta.title}`;
  } else {
    gameTitleEl.hidden = true;
    document.title = 'Poncho — NES Emulator';
  }
}

async function loadRom(rom: LoadedRom): Promise<void> {
  try {
    nes.loadRom(rom.data);
    powered = true;
    paused = false;
    config.update((c) => ({ ...c, general: { ...c.general, lastRomUrl: rom.source } }));
    setStatus(`Loaded ${rom.name} · mapper ${nes.cartridge?.mapper.id} (${nes.cartridge?.mapper.name})`);
    await audioSink.start();
    nes.apu.setSampleRate(audioSink.sampleRate);
    audioSink.setVolume(config.get().audio.volume);
    audioSink.setMuted(config.get().audio.muted);
    // RomInfo lookup is async but non-blocking. The ROM still loads
    // and starts running; the title appears as soon as the lookup
    // resolves (filename parsing alone is synchronous-ish — just a
    // SHA-1 hash + cache write).
    romInfo.lookup(rom).then(setGameTitle).catch((err) => {
      log.warn('rom', 'rominfo lookup failed', err);
      setGameTitle({ title: rom.name.replace(/\.nes$/i, ''), subtitle: null, source: 'filename' });
    });
  } catch (err) {
    log.error('rom', err);
    setStatus(`Failed: ${(err as Error).message}`);
  }
}

function powerToggle(): void {
  if (!powered) {
    if (!nes.cartridge) { setStatus('Load a ROM first.'); return; }
    nes.reset();
    powered = true;
    paused = false;
    void audioSink.start().then(() => nes.apu.setSampleRate(audioSink.sampleRate));
  } else {
    powered = false;
    nes.unload();
    void audioSink.stop();
    setStatus('Powered off.');
    setGameTitle(null);
  }
}

function resetEmu(): void {
  if (powered) nes.reset();
}

function pauseToggle(): void {
  paused = !paused;
}

// ---------------------------------------------------------------------------
// UI assembly
// ---------------------------------------------------------------------------

const layoutRoot = $<HTMLDivElement>('layout');
const stack = new PanelStack(
  layoutRoot,
  $<HTMLElement>('panel-l2-host'),
  $<HTMLElement>('panel-l3-host'),
);
const sidebar = new Sidebar(stack);
$<HTMLElement>('sidebar-host').appendChild(sidebar.root);

const romsPanel = new RomsPanel({
  localLoader,
  urlLoader,
  fileLoader,
  onLoaded: loadRom,
  onPower: powerToggle,
  onReset: resetEmu,
  onPause: pauseToggle,
  isPowered: () => powered,
  isPaused: () => paused,
});
stack.registerL2(romsPanel);

const settingsPanel = new SettingsPanel({
  config,
  onOpenControls: () => stack.toggleL3('controls'),
  onConfigChanged: (cfg) => {
    renderer.setPipeline(buildPipeline());
    audioSink.setVolume(cfg.audio.volume);
    audioSink.setMuted(cfg.audio.muted);
    applyTheme(cfg.general.theme);
  },
});
stack.registerL2(settingsPanel);

const controlsPanel = new ControlsPanel({
  config,
  onBindingsChanged: (bindings) => keyboard.setBindings(bindings),
});
stack.registerL3(controlsPanel);

sidebar.add({
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
sidebar.add({
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

// Open the ROMs panel on first load — the user lands on something useful.
stack.openL2('roms');
sidebar.syncActive();

/**
 * Click-outside dismissal. Clicking anywhere inside the main content
 * area (canvas, brand, status bar, padding) pops one level off the
 * panel stack: L3 closes first, then L2 on the next click. Sidebar
 * and panels are siblings of `.layout-main`, so their clicks never
 * bubble here — no stopPropagation needed.
 */
const layoutMain = document.querySelector<HTMLElement>('.layout-main')!;
layoutMain.addEventListener('click', () => {
  if (stack.activeL3()) {
    stack.closeL3();
  } else if (stack.activeL2()) {
    stack.closeAll();
    sidebar.syncActive();
  }
});

keyboard.attach();

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

function tick(ts: number): void {
  if (lastFrameTs > 0) {
    const dt = ts - lastFrameTs;
    fpsAccum += dt;
    fpsFrames += 1;
    if (fpsAccum >= 500) {
      fpsEl.textContent = `${((fpsFrames * 1000) / fpsAccum).toFixed(1)} FPS`;
      fpsAccum = 0;
      fpsFrames = 0;
    }
  }
  lastFrameTs = ts;

  if (!paused) {
    const fb = nes.runFrame();
    renderer.render(fb);

    let drained = 0;
    while (nes.apu.queuedSamples() > 0 && drained < audioBuffer.length) {
      const fresh = nes.apu.pullSamples(audioBuffer);
      if (fresh === 0) break;
      audioSink.push(audioBuffer, fresh);
      drained += fresh;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
