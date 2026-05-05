import { validateInes } from './ines-validator';
import type { LoadedRom, RomLoader } from './loader';

export class UrlRomLoader implements RomLoader {
  readonly id = 'url';

  constructor(private readonly timeoutMs = 15_000) {}

  async load(url: unknown): Promise<LoadedRom> {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('UrlRomLoader.load expects a non-empty URL string.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Failed to fetch ROM (${res.status} ${res.statusText})`);
      const buf = await res.arrayBuffer();
      const data = new Uint8Array(buf);
      validateInes(data);
      return { name: basenameOf(url), source: url, data };
    } finally {
      clearTimeout(timer);
    }
  }
}

function basenameOf(url: string): string {
  try {
    const u = new URL(url, 'http://localhost');
    const segs = u.pathname.split('/').filter(Boolean);
    return segs[segs.length - 1] ?? url;
  } catch {
    return url;
  }
}
