import type { RenderStage } from '../stage';

/** A render stage whose purpose is to change resolution (e.g. 1x/2x/4x). */
export interface Scaler extends RenderStage {
  readonly scale: number;
}
