import { DEFAULT_CONFIG } from './defaults';
import { CONFIG_VERSION, type Config } from './schema';
import { NesButton } from '../core/input/source';

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
 * Migrate a stored config blob to the current schema version.
 *
 * v1 → v2: overscan was briefly a boolean, then an object with wrong
 *   defaults (8/8/8/8). Reset it to the v2 defaults so all users get
 *   the correct Left-8-only crop out of the box.
 */
function migrate(parsed: Partial<Config>): Config {
  const rawVideo = parsed.video ?? {};
  const rawInput = (parsed.input ?? {}) as Partial<Config['input']>;

  // v1 → v2: always reset overscan to defaults so stale 8/8/8/8 values
  // (and the old boolean shape) are discarded.
  const overscan = (parsed.version ?? 0) >= 2
    ? mergeOverscan((rawVideo as Record<string, unknown>)['overscan'])
    : DEFAULT_CONFIG.video.overscan;
  const player1Keys = shouldUseV3Player1Defaults(parsed.version, rawInput.player1Keys)
    ? DEFAULT_CONFIG.input.player1Keys
    : { ...DEFAULT_CONFIG.input.player1Keys, ...(rawInput.player1Keys ?? {}) };

  const merged: Config = {
    version: CONFIG_VERSION,
    video: { ...DEFAULT_CONFIG.video, ...rawVideo, overscan },
    audio: { ...DEFAULT_CONFIG.audio, ...(parsed.audio ?? {}) },
    input: {
      player1Type: rawInput.player1Type ?? DEFAULT_CONFIG.input.player1Type,
      player2Type: rawInput.player2Type ?? DEFAULT_CONFIG.input.player2Type,
      player1Keys,
      player2Keys: { ...DEFAULT_CONFIG.input.player2Keys, ...(rawInput.player2Keys ?? {}) },
    },
    general: { ...DEFAULT_CONFIG.general, ...(parsed.general ?? {}) },
    ai: { ...DEFAULT_CONFIG.ai, ...(parsed.ai ?? {}) },
  };
  return merged;
}

function mergeOverscan(raw: unknown) {
  if (raw !== null && typeof raw === 'object') {
    return { ...DEFAULT_CONFIG.video.overscan, ...(raw as object) };
  }
  return DEFAULT_CONFIG.video.overscan;
}

function shouldUseV3Player1Defaults(version: number | undefined, raw: unknown): boolean {
  if ((version ?? 0) >= 3) return false;
  if (raw === undefined) return true;
  if (raw === null || typeof raw !== 'object') return false;

  const keys = raw as Record<string, unknown>;
  const legacy = {
    ArrowUp: NesButton.Up,
    ArrowDown: NesButton.Down,
    ArrowLeft: NesButton.Left,
    ArrowRight: NesButton.Right,
    KeyZ: NesButton.B,
    KeyX: NesButton.A,
    KeyC: NesButton.Select,
    KeyV: NesButton.Start,
  };
  const rawKeys = Object.keys(keys).sort();
  const legacyKeys = Object.keys(legacy).sort();
  return rawKeys.length === legacyKeys.length
    && rawKeys.every((key, index) =>
      key === legacyKeys[index] && keys[key] === legacy[key as keyof typeof legacy],
    );
}
