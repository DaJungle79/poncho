import { DEFAULT_CONFIG } from './defaults';
import { CONFIG_VERSION, type Config } from './schema';

const STORAGE_KEY = 'poncho.nes.config';

export class ConfigStore {
  private current: Config;

  constructor(private readonly storage: Storage = window.localStorage) {
    this.current = this.load();
  }

  get(): Config {
    return this.current;
  }

  update(patch: (cfg: Config) => Config): Config {
    this.current = patch(structuredClone(this.current));
    this.persist();
    return this.current;
  }

  reset(): Config {
    this.current = structuredClone(DEFAULT_CONFIG);
    this.persist();
    return this.current;
  }

  private load(): Config {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_CONFIG);
      const parsed = JSON.parse(raw) as Partial<Config>;
      return migrate(parsed);
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  private persist(): void {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Quota exceeded or storage disabled — silent for now.
    }
  }
}

/**
 * Future-proof migration. For v1 we only fill missing fields with defaults.
 * When the schema bumps, branch on `parsed.version` here.
 */
function migrate(parsed: Partial<Config>): Config {
  const merged: Config = {
    version: CONFIG_VERSION,
    video: { ...DEFAULT_CONFIG.video, ...(parsed.video ?? {}) },
    audio: { ...DEFAULT_CONFIG.audio, ...(parsed.audio ?? {}) },
    input: {
      player1Keys: { ...DEFAULT_CONFIG.input.player1Keys, ...(parsed.input?.player1Keys ?? {}) },
      player2Keys: { ...DEFAULT_CONFIG.input.player2Keys, ...(parsed.input?.player2Keys ?? {}) },
    },
    general: { ...DEFAULT_CONFIG.general, ...(parsed.general ?? {}) },
  };
  return merged;
}
