/**
 * Renders a single still from a ROM and writes it to a PNG file.
 *
 * Usage:
 *   npx tsx scripts/render-screenshot.ts <rom-path> <out-png> [frames] [scale]
 *
 * Defaults: 240 frames, 2x nearest-neighbour scale.
 *
 * No external deps: PNG is encoded inline using Node's built-in zlib.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { Nes } from '../src/core/nes';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: render-screenshot.ts <rom-path> <out-png> [frames] [scale]');
    process.exit(1);
  }
  const [romPath, outPath, framesArg, scaleArg] = args;
  const frames = framesArg ? Number.parseInt(framesArg, 10) : 240;
  const scale = scaleArg ? Number.parseInt(scaleArg, 10) : 2;

  const rom = fs.readFileSync(path.resolve(romPath!));
  const nes = new Nes();
  nes.loadRom(new Uint8Array(rom));

  let fb;
  for (let i = 0; i < frames; i++) fb = nes.runFrame();
  if (!fb) throw new Error('No framebuffer produced');

  const png = encodePng(fb.data, fb.width, fb.height, scale);
  fs.writeFileSync(path.resolve(outPath!), png);
  console.log(`wrote ${outPath} (${fb.width * scale}×${fb.height * scale})`);
}

function encodePng(pixels: Uint32Array, w: number, h: number, s: number): Buffer {
  const W = w * s;
  const H = h * s;
  const rowSize = W * 3 + 1;
  const raw = Buffer.alloc(rowSize * H);
  for (let y = 0; y < H; y++) {
    const srcY = (y / s) | 0;
    let off = y * rowSize;
    raw[off++] = 0;
    for (let x = 0; x < W; x++) {
      const srcX = (x / s) | 0;
      const p = pixels[srcY * w + srcX]!;
      raw[off++] = p & 0xff;
      raw[off++] = (p >>> 8) & 0xff;
      raw[off++] = (p >>> 16) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 2;     // color type: truecolor
  ihdr[10] = 0;    // compression
  ihdr[11] = 0;    // filter
  ihdr[12] = 0;    // interlace
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

main();
