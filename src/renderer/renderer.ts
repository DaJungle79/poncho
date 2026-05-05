import { createFrameBuffer, type FrameBuffer } from './frame-buffer';
import type { Filter } from './filters/filter';
import type { Scaler } from './scalers/scaler';

export interface RenderPipeline {
  readonly preFilters: readonly Filter[];
  readonly scaler: Scaler;
  readonly postFilters: readonly Filter[];
}

export interface Renderer {
  setPipeline(pipeline: RenderPipeline): void;
  render(input: FrameBuffer): void;
}

/**
 * Apply a chain of stages, hopping between two scratch buffers as the size
 * changes. Caller supplies the input and final output via the pipeline.
 */
export function applyStages(
  input: FrameBuffer,
  stages: readonly { outputSize: (w: number, h: number) => { width: number; height: number }; apply: (i: FrameBuffer, o: FrameBuffer) => void }[],
  scratchA: { current: FrameBuffer | null },
  scratchB: { current: FrameBuffer | null },
): FrameBuffer {
  let current = input;
  for (const stage of stages) {
    const size = stage.outputSize(current.width, current.height);
    const next = pickScratch(scratchA, scratchB, current, size.width, size.height);
    stage.apply(current, next);
    current = next;
  }
  return current;
}

function pickScratch(
  a: { current: FrameBuffer | null },
  b: { current: FrameBuffer | null },
  avoid: FrameBuffer,
  width: number,
  height: number,
): FrameBuffer {
  const slot = a.current === avoid ? b : a;
  if (!slot.current || slot.current.width !== width || slot.current.height !== height) {
    slot.current = createFrameBuffer(width, height);
  }
  return slot.current;
}
