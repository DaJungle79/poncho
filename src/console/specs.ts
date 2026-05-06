/**
 * Hardware specs for every console Poncho knows about. Source of truth
 * for the UI (console-picker, capability panels) and for the README
 * comparison table. Add a spec when you propose a new console; flip
 * `status` from `'beta'` to `'working'` once feature parity is reached.
 */

import type { ConsoleSpec } from './console';

export const NES_SPEC: ConsoleSpec = {
  id: 'nes',
  name: 'NES',
  fullName: 'Nintendo Entertainment System',
  shortDesc: 'The original 8-bit console. 1985.',
  releaseYear: 1985,
  status: 'working',
  cpu: {
    name: 'Ricoh 2A03',
    clockMhz: 1.789773,
    notes: '6502 core minus decimal mode; integrated APU.',
  },
  ppu: {
    name: 'Ricoh 2C02',
    resolution: { width: 256, height: 240 },
    paletteMaster: 64,
    colorsOnScreen: 32,
    palettes: { background: 4, sprite: 4, entriesPerPalette: 4 },
    spriteSize: { width: 8, height: 8 },
    spritesTotal: 64,
    spritesPerLine: 8,
    notes: 'Sprite size flips to 8×16 via $2000 bit 5.',
  },
  apu: {
    name: '2A03 audio',
    channels: ['Pulse 1', 'Pulse 2', 'Triangle', 'Noise', 'DMC'],
    notes: 'Non-linear mixer with 90 Hz / 440 Hz / 14 kHz analog filters.',
  },
  cart: {
    format: 'iNES',
    magic: 'NES\\x1A',
    mappersSupported: 6,
    notes: 'NROM, MMC1, UxROM, CNROM, MMC3, AxROM — covers ~85% of the commercial library.',
  },
};

export const PONCHO_NES_SPEC: ConsoleSpec = {
  id: 'poncho-nes',
  name: 'Poncho-NES',
  fullName: 'Poncho Enhanced NES',
  shortDesc: 'Virtual successor: 4× resolution, 32-bit colour, 32×32 sprites.',
  status: 'beta',
  cpu: {
    name: 'Ricoh 2A03',
    clockMhz: 1.789773,
    notes: 'Same chip as the NES — full instruction-set compatibility.',
  },
  ppu: {
    name: '2C02-Ultra',
    resolution: { width: 1024, height: 960 },
    paletteMaster: 'rgba',
    colorsOnScreen: 2048,
    palettes: { background: 4, sprite: 4, entriesPerPalette: 256 },
    spriteSize: { width: 32, height: 32 },
    spritesTotal: 64,
    spritesPerLine: 32,
    notes: '8bpp tile data; per-ROM RGBA master palette; NES-compat register set for converted ROMs.',
  },
  apu: {
    name: '2A03 audio',
    channels: ['Pulse 1', 'Pulse 2', 'Triangle', 'Noise', 'DMC'],
    notes: 'Identical to NES. Future revisions may add channels.',
  },
  cart: {
    format: 'PonchoROM',
    magic: 'PNCH',
    mappersSupported: 1,
    notes: 'PonchoMapper with NES-compat sub-mode for converted iNES ROMs.',
  },
};

export const ALL_SPECS: readonly ConsoleSpec[] = [NES_SPEC, PONCHO_NES_SPEC];
