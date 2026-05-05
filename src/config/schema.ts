import type { NesButton } from '../core/input/source';
import type { ScalerId } from '../renderer/scalers';
import type { FilterId } from '../renderer/filters';

export const CONFIG_VERSION = 1;

export type KeyBindings = Record<string, NesButton>;

export interface VideoConfig {
  scaler: ScalerId;
  preFilters: FilterId[];
  postFilters: FilterId[];
}

export interface AudioConfig {
  volume: number;
  muted: boolean;
}

export interface InputConfig {
  player1Keys: KeyBindings;
  player2Keys: KeyBindings;
}

export interface GeneralConfig {
  lastRomUrl: string | null;
}

export interface Config {
  version: number;
  video: VideoConfig;
  audio: AudioConfig;
  input: InputConfig;
  general: GeneralConfig;
}
