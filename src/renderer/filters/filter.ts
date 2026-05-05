import type { RenderStage } from '../stage';

/**
 * A render stage whose purpose is to apply visual effects. Filters preserve
 * resolution by default but are not required to — a future NTSC composite
 * filter, for instance, runs at a different intermediate resolution.
 *
 * Filters can run *before* the scaler (pixel-domain effects like NTSC color
 * bleed) or *after* the scaler (display-domain effects like CRT scanlines).
 */
export interface Filter extends RenderStage {
  /** Hint to the pipeline about where this filter expects to run. */
  readonly stage: 'pre-scale' | 'post-scale';
}
