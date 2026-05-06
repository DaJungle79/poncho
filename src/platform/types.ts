/**
 * Platform abstraction.
 *
 * The emulator core, renderer, audio mixer, and DOM-based UI panels
 * are all platform-agnostic. The pieces that *aren't* — file dialogs,
 * persistent storage, audio output — are abstracted behind the
 * interfaces in this file. Each shell (web today; Electron, Tauri,
 * native, etc. tomorrow) provides its own implementation by exporting
 * a `Platform` from its `createXxxPlatform()` factory.
 *
 * Anything imported here must be pure (no DOM / Node / browser APIs).
 * Use `import type` whenever possible to keep the dependency graph
 * traceable at a glance.
 */
import type { AudioSink } from '../audio/audio-sink';
import type { LoadedRom, StoredRomEntry } from '../domain/rom';

/**
 * Persistent ROM library — uploaded games stored locally so they
 * survive reloads. Web ⟶ IndexedDB; Electron ⟶ on-disk JSON +
 * `<userData>/roms/`; Tauri ⟶ similar.
 *
 * Bytes are owned by the library after `add()` (the implementation
 * may copy). `get()` returns a fresh `Uint8Array`.
 */
export interface RomLibrary {
  list(): Promise<StoredRomEntry[]>;
  add(name: string, data: Uint8Array): Promise<void>;
  get(name: string): Promise<Uint8Array | null>;
  remove(name: string): Promise<void>;
}

/**
 * Lists / loads ROMs from a "server" source — meaningful only on the
 * web shell during development (the Vite middleware that exposes the
 * project's `roms/` folder at `/roms/`). Desktop shells return `null`
 * here, and the UI hides the section.
 */
export interface ServerRomLoader {
  list(): Promise<string[]>;
  load(filename: string): Promise<LoadedRom>;
}

/**
 * Lets the user pick a `.nes` file from disk. The web shell wraps an
 * `<input type="file">`; Electron uses `dialog.showOpenDialog`; etc.
 *
 * `pick()` resolves with the loaded ROM, or `null` if the user
 * cancelled.
 *
 * The web shell additionally exposes the underlying `<input>` element
 * so the UI can wire `change` listeners directly. To keep that detail
 * out of the cross-platform interface, callers use `attachToElement`
 * to register an HTMLInputElement; non-web shells make `attachToElement`
 * a no-op.
 */
export interface FilePicker {
  pick(): Promise<LoadedRom | null>;
}

/**
 * Everything the App needs that is not the emulator core.
 */
export interface Platform {
  /** Audio output — implements `AudioSink`. */
  readonly audio: AudioSink;
  /**
   * `Storage`-shaped key/value store for `ConfigStore`. Web → localStorage,
   * Electron → fs-backed JSON, etc. Must support synchronous
   * getItem/setItem/removeItem semantics.
   */
  readonly configStorage: Storage;
  /** Storage for ROM info / metadata cache (`Storage`-shaped). */
  readonly romInfoStorage: Storage;
  /** Persistent uploaded-ROM library. */
  readonly romLibrary: RomLibrary;
  /**
   * Server-side ROM loader. `null` on shells without a development
   * server (most desktop builds).
   */
  readonly serverRoms: ServerRomLoader | null;
  /** "Open file" dialog. */
  readonly filePicker: FilePicker;
}
