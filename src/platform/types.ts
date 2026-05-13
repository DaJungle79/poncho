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
 * Persistent cache for large model assets (e.g. ONNX files for AI
 * upscale). Backed by the browser's Cache Storage API on web, and by
 * the local filesystem on Electron / Tauri.
 *
 * Models are megabyte- to tens-of-megabyte-sized; caching them across
 * reloads is essential UX. Surface is small on purpose — load-or-fetch,
 * remove, query.
 */
export interface ModelAssetCache {
  /** True if `url` is already cached (fast lookup, no network). */
  has(url: string): Promise<boolean>;
  /**
   * Load model bytes — returns the cached copy if present, else fetches
   * from `url`, caches, and returns. Progress callback is invoked for
   * fetched bytes (`fromCache: false`); on cache hit, fired once with
   * `loaded === total === byte length` and `fromCache: true`.
   */
  load(url: string, opts?: ModelLoadOptions): Promise<ArrayBuffer>;
  /** Drop the cached copy if present. No-op if absent. */
  remove(url: string): Promise<void>;
  /** Return cached metadata for a URL, or null if not cached. */
  getInfo(url: string): Promise<CachedModelInfo | null>;
  /** List every cached entry (used by the "manage models" UI). */
  list(): Promise<CachedModelInfo[]>;
}

export interface ModelLoadOptions {
  signal?: AbortSignal;
  onProgress?: (p: ModelLoadProgress) => void;
}

export interface ModelLoadProgress {
  loaded: number;
  /** Total expected bytes — `null` when the server omits Content-Length. */
  total: number | null;
  /** True when this progress event is from the cache, not a live fetch. */
  fromCache: boolean;
}

export interface CachedModelInfo {
  url: string;
  size: number;
  /** Wall-clock ms when the entry was first cached. */
  cachedAt: number;
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
export interface FilePickerOptions {
  /**
   * Filename extensions to advertise in the OS picker, e.g. `['.nes']`
   * or `['.nes', '.poncho']`. Default: `['.nes']`.
   */
  accept?: string[];
  /**
   * Run ROM magic validation before resolving. Defaults to true. Non-ROM
   * assets, such as attached ONNX upscale models, set this to false.
   */
  validate?: boolean;
}

export interface FilePicker {
  pick(options?: FilePickerOptions): Promise<LoadedRom | null>;
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
   * Persistent cache for large model assets (ONNX upscalers etc.).
   * `null` on platforms without one — callers fall back to plain
   * `fetch()` + no caching. The web shell always provides one.
   */
  readonly modelAssetCache: ModelAssetCache | null;
  /**
   * Server-side ROM loader. `null` on shells without a development
   * server (most desktop builds).
   */
  readonly serverRoms: ServerRomLoader | null;
  /** "Open file" dialog. */
  readonly filePicker: FilePicker;
}
