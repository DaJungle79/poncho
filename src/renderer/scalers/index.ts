import { NearestNeighborScaler, type NearestNeighborScale } from './nearest-neighbor';
import type { Scaler } from './scaler';

export type ScalerId = 'nearest-1x' | 'nearest-2x' | 'nearest-4x';

const FACTORIES: Record<ScalerId, () => Scaler> = {
  'nearest-1x': () => new NearestNeighborScaler(1),
  'nearest-2x': () => new NearestNeighborScaler(2),
  'nearest-4x': () => new NearestNeighborScaler(4),
};

export function createScaler(id: ScalerId): Scaler {
  return FACTORIES[id]();
}

export function scalerForScale(scale: NearestNeighborScale): Scaler {
  return new NearestNeighborScaler(scale);
}

export const AVAILABLE_SCALERS: readonly ScalerId[] = Object.keys(FACTORIES) as ScalerId[];

export type { Scaler };
export { NearestNeighborScaler };
