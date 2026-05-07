import type { NesButton } from '../core/input/source';
import type { ScalerId } from '../renderer/scalers';
import type { FilterId } from '../renderer/filters';

export const CONFIG_VERSION = 2;

export type KeyBindings = Record<string, NesButton>;

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

export interface Config {
  version: number;
  video: VideoConfig;
  audio: AudioConfig;
  input: InputConfig;
  general: GeneralConfig;
}
