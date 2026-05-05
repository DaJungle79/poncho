/**
 * Persistent ROM storage in the browser, backed by IndexedDB.
 *
 * Why IndexedDB and not localStorage? localStorage is sync, capped at
 * ~5 MB per origin, and stores strings only — adequate for a few small
 * ROMs but awkward (base64 round-trip) and cramped. IndexedDB stores
 * `ArrayBuffer` natively and has a much higher quota (typically 50 % of
 * free disk space, browser-dependent). The async API also keeps ROM
 * uploads from blocking the UI thread.
 *
 * Data model: a single object store keyed by `name` (the ROM filename).
 * Each entry holds the raw bytes plus a couple of useful metadata
 * fields (size, addedAt) for the panel UI.
 *
 * Failure modes — quota exceeded, private mode storage disabled, user
 * blocking: every method rejects, the caller surfaces the error in
 * the status line. Nothing is persisted on failure.
 */

const DB_NAME = 'poncho-roms';
const DB_VERSION = 1;
const STORE = 'roms';

/** Public summary of a stored ROM (no bytes). */
export interface StoredRomEntry {
  name: string;
  size: number;
  /** Unix timestamp (ms) when the ROM was added. */
  addedAt: number;
}

interface StoredRomRecord extends StoredRomEntry {
  data: ArrayBuffer;
}

export class BrowserRomStorage {
  /** Lazily-opened DB connection. Re-uses the same handle for all calls. */
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Open (and migrate if needed) the IndexedDB database. Cached after
   * first call so subsequent operations share a single connection.
   */
  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'name' });
          }
        };
      });
    }
    return this.dbPromise;
  }

  /** Promisify a single IndexedDB request. */
  private run<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return this.getDb().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const store = tx.objectStore(STORE);
          const req = action(store);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
        }),
    );
  }

  /** Return all stored ROMs (metadata only — no data). Sorted A→Z by name. */
  async list(): Promise<StoredRomEntry[]> {
    const records = await this.run<StoredRomRecord[]>('readonly', (s) => s.getAll());
    return records
      .map(({ name, size, addedAt }) => ({ name, size, addedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Add (or overwrite) a ROM by name. The bytes are copied. */
  async add(name: string, data: Uint8Array): Promise<void> {
    const buf = data.slice().buffer; // own the bytes; don't share with caller
    const record: StoredRomRecord = {
      name,
      size: data.byteLength,
      addedAt: Date.now(),
      data: buf,
    };
    await this.run('readwrite', (s) => s.put(record));
  }

  /** Fetch a ROM's bytes by name, or null if not stored. */
  async get(name: string): Promise<Uint8Array | null> {
    const record = await this.run<StoredRomRecord | undefined>(
      'readonly',
      (s) => s.get(name),
    );
    if (!record) return null;
    return new Uint8Array(record.data);
  }

  /** Delete one stored ROM. No-op if it doesn't exist. */
  async remove(name: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(name));
  }

  /** Wipe every stored ROM. */
  async clear(): Promise<void> {
    await this.run('readwrite', (s) => s.clear());
  }
}
