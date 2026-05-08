import { NesButton } from '../core/input/source';
import { CONFIG_VERSION, type Config, type KeyBindings } from './schema';

export const DEFAULT_PLAYER1_KEYS: KeyBindings = {
  ArrowUp: NesButton.Up,
  ArrowDown: NesButton.Down,
  ArrowLeft: NesButton.Left,
  ArrowRight: NesButton.Right,
  KeyZ: NesButton.B,
  KeyX: NesButton.A,
  KeyC: NesButton.Select,
  KeyV: NesButton.Start,
};

export const DEFAULT_PLAYER2_KEYS: KeyBindings = {};

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  video: {
    scaler: 'nearest-2x',
    preFilters: [],
    postFilters: [],
    overscan: { enabled: true, top: 0, bottom: 0, left: 8, right: 0 },
  },
  audio: {
    volume: 0.7,
    muted: false,
  },
  input: {
    player1Keys: DEFAULT_PLAYER1_KEYS,
    player2Keys: DEFAULT_PLAYER2_KEYS,
  },
  general: {
    lastRomUrl: null,
    theme: 'dark',
    showStatusBar: true,
    selectedConsoleId: 'nes',
  },
  ai: {
    apiKey: '',
  },
};
