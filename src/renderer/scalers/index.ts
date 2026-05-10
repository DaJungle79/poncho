import { NearestNeighborScaler, type NearestNeighborScale } from './nearest-neighbor';
import { XbrzScaler } from './xbrz';
import { MmpxScaler } from './mmpx';
import type { Scaler } from './scaler';

export type ScalerId =
  | 'nearest-1x' | 'nearest-2x' | 'nearest-4x'
  | 'xbrz-2x' | 'xbrz-3x' | 'xbrz-4x' | 'xbrz-5x' | 'xbrz-6x'
  | 'mmpx-2x';

const FACTORIES: Record<ScalerId, () => Scaler> = {
  'nearest-1x': () => new NearestNeighborScaler(1),
  'nearest-2x': () => new NearestNeighborScaler(2),
  'nearest-4x': () => new NearestNeighborScaler(4),
  'xbrz-2x': () => new XbrzScaler(2),
  'xbrz-3x': () => new XbrzScaler(3),
  'xbrz-4x': () => new XbrzScaler(4),
  'xbrz-5x': () => new XbrzScaler(5),
  'xbrz-6x': () => new XbrzScaler(6),
  'mmpx-2x': () => new MmpxScaler(),
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
export { XbrzScaler };
export { MmpxScaler };
