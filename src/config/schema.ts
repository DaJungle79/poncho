import type { NesButton } from '../core/input/source';
import type { ScalerId } from '../renderer/scalers';
import type { FilterId } from '../renderer/filters';

export const CONFIG_VERSION = 3;

export type KeyBindings = Record<string, NesButton>;
export type InputType = 'keyboard' | 'gamepad' | 'virtual';

export interface OverscanConfig {
  enabled: boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface VideoConfig {
  scaler: ScalerId;
  preFilters: FilterId[];
  postFilters: FilterId[];
  /** Crop the BG-LEFT clip area (classic NES only). */
  overscan: OverscanConfig;
}

export interface AudioConfig {
  volume: number;
  muted: boolean;
}

export interface InputConfig {
  player1Type: InputType;
  player2Type: InputType;
  player1Keys: KeyBindings;
  player2Keys: KeyBindings;
}

export type ThemeId = 'dark' | 'light';

export interface GeneralConfig {
  lastRomUrl: string | null;
  theme: ThemeId;
  showStatusBar: boolean;
  /** Active virtual console (id from `src/console/specs.ts`). */
  selectedConsoleId: string;
}

/**
 * AI upscale settings (v0.4). Picks one model id for CHR-ROM bake-now
 * conversions and one for the CHR-RAM runtime worker. Both default to
 * `nearest-neighbour` — the deterministic 4× fallback — until the user
 * explicitly opts into a richer model. Per-model config (e.g. ONNX
 * file URL, quantisation level, future API keys) is stored under
 * `modelConfig[modelId]` so adding a model doesn't require a config
 * schema migration.
 */
export interface AiConfig {
  /** Stable id (matches `UpscaleModel.id` in the registry). */
  romModelId: string;
  /** Stable id for the runtime worker. May equal `romModelId`. */
  ramModelId: string;
  /** Per-model arbitrary config bag. Keyed by model id. */
  modelConfig: Record<string, Record<string, unknown>>;
}

export interface Config {
  version: number;
  video: VideoConfig;
  audio: AudioConfig;
  input: InputConfig;
  general: GeneralConfig;
  ai: AiConfig;
}
