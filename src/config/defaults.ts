import { NesButton } from '../core/input/source';
import { CONFIG_VERSION, type Config, type KeyBindings } from './schema';

export const DEFAULT_PLAYER1_KEYS: KeyBindings = {
  ArrowUp: NesButton.Up,
  ArrowDown: NesButton.Down,
  ArrowLeft: NesButton.Left,
  ArrowRight: NesButton.Right,
  Period: NesButton.A,
  Slash: NesButton.B,
  BracketLeft: NesButton.Select,
  BracketRight: NesButton.Start,
};

export const DEFAULT_PLAYER2_KEYS: KeyBindings = {
  KeyW: NesButton.Up,
  KeyS: NesButton.Down,
  KeyA: NesButton.Left,
  KeyD: NesButton.Right,
  KeyV: NesButton.A,
  KeyB: NesButton.B,
  KeyZ: NesButton.Select,
  KeyX: NesButton.Start,
};

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  video: {
    scaler: 'xbrz-4x',
    preFilters: [],
    postFilters: [],
    overscan: { enabled: true, top: 0, bottom: 0, left: 8, right: 0 },
  },
  audio: {
    volume: 0.7,
    muted: false,
  },
  input: {
    player1Type: 'keyboard',
    player2Type: 'keyboard',
    player1Keys: DEFAULT_PLAYER1_KEYS,
    player2Keys: DEFAULT_PLAYER2_KEYS,
  },
  general: {
    lastRomUrl: null,
    theme: 'dark',
    showStatusBar: true,
    showFps: true,
    selectedConsoleId: 'nes',
  },
  ai: {
    // v0.5: xbrz-4x-snap is the default for both bake-now (CHR-ROM)
    // and runtime (CHR-RAM) — deterministic, free, visibly better
    // than NN. Users can switch back to nearest-neighbour from the
    // Convert panel.
    romModelId: 'xbrz-4x-snap',
    ramModelId: 'xbrz-4x-snap',
    modelConfig: {},
  },
};
