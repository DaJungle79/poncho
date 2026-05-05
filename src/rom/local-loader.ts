import { UrlRomLoader } from './url-loader';
import type { LoadedRom, RomLoader } from './loader';

/**
 * Loads ROMs from the project's `/roms/` folder, served by the dev middleware
 * defined in vite.config.ts. `list()` returns the filenames it finds; `load`
 * fetches one of them by name.
 */
export class LocalRomLoader implements RomLoader {
  readonly id = 'local';

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

  async load(filename: unknown): Promise<LoadedRom> {
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new Error('LocalRomLoader.load expects a filename.');
    }
    const safe = filename.replace(/^\/+/, '').replace(/\.\.\//g, '');
    return this.url.load(`/roms/${safe}`);
  }
}
