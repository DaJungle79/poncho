import type { FrameBuffer } from './frame-buffer';

/**
 * A single step in the render pipeline. Two specializations exist:
 *   - `Scaler` (renderer/scalers): purpose is to change resolution.
 *   - `Filter` (renderer/filters): purpose is to apply effects.
 *
 * Both implement this same shape so the pipeline can compose them uniformly.
 */
export interface RenderStage {
  readonly name: string;
  /** Compute the output dimensions for a given input size. */
  outputSize(inputWidth: number, inputHeight: number): { width: number; height: number };
  /** Write transformed pixels into `output`. `output` is sized per `outputSize`. */
  apply(input: FrameBuffer, output: FrameBuffer): void;
}
