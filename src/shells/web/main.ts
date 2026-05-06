/**
 * Web shell entry point.
 *
 * Builds the web `Platform` (Web Audio + IndexedDB + localStorage +
 * dev-server `/roms/`) and hands it to this shell's `App`, whose UI tree
 * lives next door in `./ui/`. Other shells (Electron, Tauri, native) own
 * their own App + UI under `src/shells/<name>/`.
 */
import { App } from './app';
import { createWebPlatform } from '../../platform/web';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const platform = createWebPlatform();
const app = new App(platform, {
  layoutRoot: $<HTMLDivElement>('layout'),
  sidebarHost: $<HTMLElement>('sidebar-host'),
  panelL2Host: $<HTMLElement>('panel-l2-host'),
  panelL3Host: $<HTMLElement>('panel-l3-host'),
  canvas: $<HTMLCanvasElement>('screen'),
  statusEl: $<HTMLSpanElement>('status-text'),
  fpsEl: $<HTMLSpanElement>('fps'),
  gameTitleEl: $<HTMLDivElement>('game-title'),
});
app.run();
