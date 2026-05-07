import type { FrameBuffer } from '../frame-buffer';
import type { Filter } from './filter';

/**
 * Crops a fixed border from each edge of the input frame.
 *
 * Classic NES games write PPUMASK with the BG-LEFT / SP-LEFT clip bits clear
 * during horizontal scrolling to hide tile-seam artifacts at column 0-7. Real
 * CRT TVs hid this area via overscan (~8 px per side). Without cropping, the
 * clip region is visible as a blank 8-pixel strip on the left.
 *
 * Default values (8 px per side) convert the NES chip output (256×240) to the
 * TV-visible area (240×224), matching the appearance of period-accurate CRT
 * displays.
 */
export class OverscanCropFilter implements Filter {
  readonly name = 'overscan-crop';
  readonly stage = 'pre-scale' as const;

  constructor(
    public readonly top: number,
    public readonly bottom: number,
    public readonly left: number,
    public readonly right: number,
  ) {}

  outputSize(w: number, h: number): { width: number; height: number } {
    return { width: w - this.left - this.right, height: h - this.top - this.bottom };
  }

  apply(input: FrameBuffer, output: FrameBuffer): void {
    const ow = output.width;
    const oh = output.height;
    const iw = input.width;
    const src = input.data;
    const dst = output.data;
    for (let y = 0; y < oh; y++) {
      const srcRow = (y + this.top) * iw + this.left;
      const dstRow = y * ow;
      dst.set(src.subarray(srcRow, srcRow + ow), dstRow);
    }
  }
}

/** Standard 8-px-per-side NES overscan crop (256×240 → 240×224). */
export const NES_OVERSCAN = new OverscanCropFilter(8, 8, 8, 8);
