import { validateInes } from './ines-validator';
import type { LoadedRom, RomLoader } from './loader';

export class FileRomLoader implements RomLoader {
  readonly id = 'file';

  async load(file: unknown): Promise<LoadedRom> {
    if (!(file instanceof File)) {
      throw new Error('FileRomLoader.load expects a File.');
    }
    const buf = await file.arrayBuffer();
    const data = new Uint8Array(buf);
    validateInes(data);
    return { name: file.name, source: `file:${file.name}`, data };
  }
}
