/**
 * Web shell platform implementation.
 *
 * Builds a `Platform` whose pieces all use browser APIs:
 *   - `audio`: AudioWorklet via Web Audio
 *   - `configStorage` / `romInfoStorage`: window.localStorage
 *   - `romLibrary`: IndexedDB
 *   - `serverRoms`: the dev-server's `/roms/` middleware (web-only)
 *   - `filePicker`: programmatically-clicked `<input type="file">`
 *
 * Other shells (Electron, Tauri, …) ship their own factory next to
 * this one, e.g. `src/platform/electron/index.ts`.
 */
import type { Platform } from '../types';
import { WebAudioSink } from './audio-sink';
import { WebRomLibrary } from './rom-library';
import { WebServerRomLoader } from './server-roms';
import { WebFilePicker } from './file-picker';
import { WebModelAssetCache } from './model-asset-cache';

export function createWebPlatform(): Platform {
  return {
    audio: new WebAudioSink(),
    configStorage: window.localStorage,
    romInfoStorage: window.localStorage,
    romLibrary: new WebRomLibrary(),
    serverRoms: new WebServerRomLoader(),
    filePicker: new WebFilePicker(),
    modelAssetCache: new WebModelAssetCache(),
  };
}

// Re-exports for unit tests / debug consumers that want to construct
// individual platform pieces directly.
export {
  WebAudioSink,
  WebRomLibrary,
  WebServerRomLoader,
  WebFilePicker,
  WebModelAssetCache,
};
