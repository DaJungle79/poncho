import type { FrameBuffer } from '../frame-buffer';
import type { Scaler } from './scaler';

export type NearestNeighborScale = 1 | 2 | 4;

export class NearestNeighborScaler implements Scaler {
  readonly name: string;

  constructor(public readonly scale: NearestNeighborScale) {
    this.name = `nearest-${scale}x`;
  }

  outputSize(width: number, height: number): { width: number; height: number } {
    return { width: width * this.scale, height: height * this.scale };
  }

  apply(input: FrameBuffer, output: FrameBuffer): void {
    const s = this.scale;
    const iw = input.width;
    const ih = input.height;
    const ow = output.width;
    const src = input.data;
    const dst = output.data;

    if (s === 1) {
      dst.set(src);
      return;
    }

    for (let y = 0; y < ih; y++) {
      const oy = y * s;
      for (let x = 0; x < iw; x++) {
        const px = src[y * iw + x];
        const ox = x * s;
        for (let dy = 0; dy < s; dy++) {
          const row = (oy + dy) * ow + ox;
          for (let dx = 0; dx < s; dx++) {
            dst[row + dx] = px;
          }
        }
      }
    }
  }
}
