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

applyLogLevelsFromQuery(window.location.search);

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('screen');
const romList = $<HTMLSelectElement>('rom-list');
const romUrlInput = $<HTMLInputElement>('rom-url');
const romUrlLoadBtn = $<HTMLButtonElement>('rom-url-load');
const romFileInput = $<HTMLInputElement>('rom-file');
const scaleSelect = $<HTMLSelectElement>('scale-select');
const btnPower = $<HTMLButtonElement>('btn-power');
const btnReset = $<HTMLButtonElement>('btn-reset');
const btnPause = $<HTMLButtonElement>('btn-pause');
const fpsEl = $<HTMLSpanElement>('fps');
const statusEl = $<HTMLSpanElement>('status-text');

const config = new ConfigStore();
const nes = new Nes();
const renderer = new Canvas2DRenderer(canvas);
const audioSink = new WebAudioSink();
const keyboard = new KeyboardSource(config.get().input.player1Keys);
nes.setController(1, keyboard);

const localLoader = new LocalRomLoader();
const urlLoader = new UrlRomLoader();
const fileLoader = new FileRomLoader();

function buildPipeline(): RenderPipeline {
  const cfg = config.get().video;
  return {
    preFilters: cfg.preFilters.map(createFilter),
    scaler: createScaler(cfg.scaler),
    postFilters: cfg.postFilters.map(createFilter),
  };
}

renderer.setPipeline(buildPipeline());

(() => {
  const id = config.get().video.scaler;
  scaleSelect.value = id === 'nearest-1x' ? '1' : id === 'nearest-4x' ? '4' : '2';
})();

scaleSelect.addEventListener('change', () => {
  const scale = scaleSelect.value as '1' | '2' | '4';
  const id = scale === '1' ? 'nearest-1x' : scale === '4' ? 'nearest-4x' : 'nearest-2x';
  config.update((c) => ({ ...c, video: { ...c.video, scaler: id } }));
  renderer.setPipeline(buildPipeline());
});

let paused = false;
let powered = false;
let lastFrameTs = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function loadRomData(name: string, source: string, data: Uint8Array): Promise<void> {
  try {
    nes.loadRom(data);
    powered = true;
    paused = false;
    btnPause.textContent = 'Pause';
    config.update((c) => ({ ...c, general: { ...c.general, lastRomUrl: source } }));
    setStatus(`Loaded ${name} (${data.length.toLocaleString()} bytes, mapper ${nes.cartridge?.mapper.id})`);
    await audioSink.start();
    // The audio context may run at a different rate than we asked for
    // (e.g. 48 kHz on most systems even if we requested 44.1k). Tell
    // the APU so its cycles-per-sample math matches.
    nes.apu.setSampleRate(audioSink.sampleRate);
  } catch (err) {
    log.error('rom', err);
    setStatus(`Failed: ${(err as Error).message}`);
  }
}

romUrlLoadBtn.addEventListener('click', async () => {
  const url = romUrlInput.value.trim();
  if (!url) return;
  setStatus(`Fetching ${url}…`);
  try {
    const rom = await urlLoader.load(url);
    await loadRomData(rom.name, rom.source, rom.data);
  } catch (err) {
    setStatus(`Failed: ${(err as Error).message}`);
  }
});

romFileInput.addEventListener('change', async () => {
  const file = romFileInput.files?.[0];
  if (!file) return;
  setStatus(`Reading ${file.name}…`);
  try {
    const rom = await fileLoader.load(file);
    await loadRomData(rom.name, rom.source, rom.data);
  } catch (err) {
    setStatus(`Failed: ${(err as Error).message}`);
  }
});

romList.addEventListener('change', async () => {
  const name = romList.value;
  if (!name) return;
  setStatus(`Loading /roms/${name}…`);
  try {
    const rom = await localLoader.load(name);
    await loadRomData(rom.name, rom.source, rom.data);
  } catch (err) {
    setStatus(`Failed: ${(err as Error).message}`);
  }
});

btnPower.addEventListener('click', async () => {
  if (!powered) {
    if (!nes.cartridge) {
      setStatus('Load a ROM first.');
      return;
    }
    powered = true;
    paused = false;
    nes.reset();
    await audioSink.start();
    nes.apu.setSampleRate(audioSink.sampleRate);
  } else {
    powered = false;
    nes.unload();
    await audioSink.stop();
    setStatus('Powered off.');
  }
});

btnReset.addEventListener('click', () => {
  if (powered) nes.reset();
});

btnPause.addEventListener('click', () => {
  paused = !paused;
  btnPause.textContent = paused ? 'Resume' : 'Pause';
});

void localLoader.list().then((files) => {
  romList.innerHTML = '<option value="">— local /roms —</option>';
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    romList.appendChild(opt);
  }
  if (files.length === 0) {
    const opt = document.createElement('option');
    opt.disabled = true;
    opt.textContent = '(drop .nes files in /roms/)';
    romList.appendChild(opt);
  }
});

keyboard.attach();

// Pre-allocated audio drain buffer. ~1 NTSC frame at 48 kHz = 800 samples;
// 2048 gives plenty of headroom even if the host is slow on a frame.
const audioBuffer = new Float32Array(2048);

function tick(ts: number): void {
  if (lastFrameTs > 0) {
    const dt = ts - lastFrameTs;
    fpsAccum += dt;
    fpsFrames += 1;
    if (fpsAccum >= 500) {
      const fps = (fpsFrames * 1000) / fpsAccum;
      fpsEl.textContent = `${fps.toFixed(1)} FPS`;
      fpsAccum = 0;
      fpsFrames = 0;
    }
  }
  lastFrameTs = ts;

  if (!paused) {
    const fb = nes.runFrame();
    renderer.render(fb);

    // Drain APU samples produced this frame and forward to the audio
    // worklet. The worklet keeps its own buffer; we just need to keep
    // it fed faster than it drains at the audio rate.
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
