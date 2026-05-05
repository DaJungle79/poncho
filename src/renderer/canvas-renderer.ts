import { createFrameBuffer, type FrameBuffer } from './frame-buffer';
import { applyStages, type Renderer, type RenderPipeline } from './renderer';

/**
 * Canvas2D output. The pipeline produces a final framebuffer; we copy its
 * Uint32 pixel data byte-aliased into ImageData and blit. Canvas size is
 * resized to match the pipeline output so no browser-side scaling occurs
 * (combined with `image-rendering: pixelated`, the result is exact).
 */
export class Canvas2DRenderer implements Renderer {
  private ctx: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;
  private pipeline: RenderPipeline | null = null;
  private scratchA: { current: FrameBuffer | null } = { current: null };
  private scratchB: { current: FrameBuffer | null } = { current: null };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire 2D context');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  setPipeline(pipeline: RenderPipeline): void {
    this.pipeline = pipeline;
    this.scratchA.current = null;
    this.scratchB.current = null;
    this.imageData = null;
  }

  render(input: FrameBuffer): void {
    if (!this.pipeline) return;

    const stages = [
      ...this.pipeline.preFilters,
      this.pipeline.scaler,
      ...this.pipeline.postFilters,
    ];

    const output = stages.length === 0
      ? input
      : applyStages(input, stages, this.scratchA, this.scratchB);

    if (this.canvas.width !== output.width || this.canvas.height !== output.height) {
      this.canvas.width = output.width;
      this.canvas.height = output.height;
      this.ctx.imageSmoothingEnabled = false;
      this.imageData = this.ctx.createImageData(output.width, output.height);
    }
    if (!this.imageData) {
      this.imageData = this.ctx.createImageData(output.width, output.height);
    }

    this.imageData.data.set(
      new Uint8ClampedArray(output.data.buffer, output.data.byteOffset, output.data.byteLength),
    );
    this.ctx.putImageData(this.imageData, 0, 0);
  }
}

/** Helper for callers that just want a default scratch-free buffer to hand in. */
export function blankFrameBuffer(width: number, height: number): FrameBuffer {
  return createFrameBuffer(width, height);
}
