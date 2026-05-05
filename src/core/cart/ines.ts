/**
 * Nametable mirroring mode.
 *
 *   horizontal     — pairs of horizontally adjacent nametables share VRAM.
 *                    Effective for vertically scrolling games.
 *   vertical       — pairs of vertically adjacent nametables share VRAM.
 *                    Effective for horizontally scrolling games.
 *   four-screen    — cart provides extra VRAM, all four nametables distinct.
 *   single-low     — every nametable maps to the first 1 KiB of on-board VRAM.
 *   single-high    — every nametable maps to the second 1 KiB.
 *
 * iNES headers can only encode the first three; single-low/high are
 * mapper-controlled at runtime (e.g. MMC1 selects them via its control reg).
 */
export type Mirroring =
  | 'horizontal'
  | 'vertical'
  | 'four-screen'
  | 'single-low'
  | 'single-high';

export interface InesHeader {
  prgRomBanks: number;
  chrRomBanks: number;
  mapper: number;
  mirroring: Mirroring;
  hasBattery: boolean;
  hasTrainer: boolean;
}

export interface InesRom {
  header: InesHeader;
  prgRom: Uint8Array;
  chrRom: Uint8Array;
  trainer: Uint8Array | null;
}

const MAGIC = [0x4e, 0x45, 0x53, 0x1a];

export function isInes(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  for (let i = 0; i < 4; i++) if (data[i] !== MAGIC[i]) return false;
  return true;
}

export function parseInes(data: Uint8Array): InesRom {
  if (!isInes(data)) throw new Error('Not an iNES ROM (bad magic)');

  const prgRomBanks = data[4];
  const chrRomBanks = data[5];
  const flags6 = data[6];
  const flags7 = data[7];

  const fourScreen = (flags6 & 0x08) !== 0;
  const verticalMirror = (flags6 & 0x01) !== 0;
  const mirroring: Mirroring = fourScreen
    ? 'four-screen'
    : verticalMirror
      ? 'vertical'
      : 'horizontal';

  const hasBattery = (flags6 & 0x02) !== 0;
  const hasTrainer = (flags6 & 0x04) !== 0;
  const mapper = (flags7 & 0xf0) | ((flags6 & 0xf0) >>> 4);

  let offset = 16;
  let trainer: Uint8Array | null = null;
  if (hasTrainer) {
    trainer = data.slice(offset, offset + 512);
    offset += 512;
  }

  const prgSize = prgRomBanks * 16384;
  const prgRom = data.slice(offset, offset + prgSize);
  offset += prgSize;

  const chrSize = chrRomBanks * 8192;
  const chrRom = chrSize > 0 ? data.slice(offset, offset + chrSize) : new Uint8Array(8192);

  return {
    header: { prgRomBanks, chrRomBanks, mapper, mirroring, hasBattery, hasTrainer },
    prgRom,
    chrRom,
    trainer,
  };
}
