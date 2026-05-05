export const NES_WIDTH = 256;
export const NES_HEIGHT = 240;

/**
 * Pixel layout: 0xAABBGGRR (little-endian, matches the canvas ImageData byte
 * order on every browser we care about). Always packed tightly: row-major,
 * stride = width.
 */
export interface FrameBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint32Array;
}

export function createFrameBuffer(width: number, height: number): FrameBuffer {
  return { width, height, data: new Uint32Array(width * height) };
}
