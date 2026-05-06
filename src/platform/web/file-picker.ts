import { validateInes } from './ines-validator';
import type { LoadedRom } from '../../domain/rom';
import type { FilePicker } from '../types';

/**
 * Web-shell implementation of `FilePicker`. Lazily creates a hidden
 * `<input type="file">`, programmatically opens it, and resolves with
 * the picked-and-validated ROM (or `null` on cancel).
 *
 * Why hide the input behind a method instead of letting panels host
 * it directly? So non-web shells can swap in `dialog.showOpenDialog`
 * (Electron) or a Tauri equivalent without panel changes.
 */
export class WebFilePicker implements FilePicker {
  private readonly input: HTMLInputElement;

  constructor() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.nes';
    input.style.display = 'none';
    document.body.appendChild(input);
    this.input = input;
  }

  pick(): Promise<LoadedRom | null> {
    return new Promise<LoadedRom | null>((resolve, reject) => {
      const cleanup = () => {
        this.input.removeEventListener('change', onChange);
        this.input.removeEventListener('cancel', onCancel);
      };
      const onChange = async () => {
        cleanup();
        const file = this.input.files?.[0];
        // Reset so the user can re-pick the same file later.
        this.input.value = '';
        if (!file) return resolve(null);
        try {
          const buf = await file.arrayBuffer();
          const data = new Uint8Array(buf);
          validateInes(data);
          resolve({ name: file.name, source: `file:${file.name}`, data });
        } catch (err) {
          reject(err);
        }
      };
      const onCancel = () => {
        cleanup();
        resolve(null);
      };
      this.input.addEventListener('change', onChange);
      // The `cancel` event fires when the user closes the dialog without
      // picking — modern Chromium / Firefox / Safari all support it.
      this.input.addEventListener('cancel', onCancel);
      this.input.click();
    });
  }
}
