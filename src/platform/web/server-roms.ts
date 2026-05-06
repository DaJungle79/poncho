import { UrlRomLoader } from './url-loader';
import type { LoadedRom } from '../../domain/rom';
import type { ServerRomLoader } from '../types';

/**
 * Web-shell implementation of `ServerRomLoader`. Reads from the
 * project's top-level `roms/` folder, served by the Vite middleware
 * defined in `vite.config.ts`. `list()` GETs `/roms/` for a JSON
 * directory listing; `load(filename)` GETs `/roms/<filename>`.
 *
 * Desktop shells (Electron, Tauri) provide their own implementation
 * that reads the user's library directory directly via `fs`, or
 * return `null` for `serverRoms` and hide the section in the UI.
 */
export class WebServerRomLoader implements ServerRomLoader {
  private readonly url = new UrlRomLoader();

  async list(): Promise<string[]> {
    try {
      const res = await fetch('/roms/');
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json) ? (json as string[]) : [];
    } catch {
      return [];
    }
  }

  async load(filename: string): Promise<LoadedRom> {
    if (filename.length === 0) {
      throw new Error('WebServerRomLoader.load expects a filename.');
    }
    const safe = filename.replace(/^\/+/, '').replace(/\.\.\//g, '');
    return this.url.load(`/roms/${safe}`);
  }
}
