/**
 * Tiny inline PNG encoder. Used by `scripts/render-screenshot.ts` and
 * by the synthetic-ROM generators that produce expected-frame fixtures.
 *
 * No external deps — uses Node's `node:zlib` for IDAT compression and
 * the project's `crc32` helper for chunk CRCs.
 */

import zlib from 'node:zlib';

import { crc32 } from '../../src/core/cart-poncho/crc32';

/**
 * Encode a flat 8-bit-per-channel RGBA buffer into a PNG file. The
 * input must be `width * height * 4` bytes long.
 */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodePngRgba: rgba is ${rgba.length} bytes, expected ${expected}`);
  }

  // Add a filter byte (0 = none) at the start of every row.
  const rowSize = width * 4 + 1;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowSize + 1);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour + alpha
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
