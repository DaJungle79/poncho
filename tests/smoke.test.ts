import { describe, expect, it } from 'vitest';
import { parseInes, isInes } from '../src/core/cart/ines';
import { Nrom } from '../src/core/mappers/nrom';
import { NearestNeighborScaler } from '../src/renderer/scalers/nearest-neighbor';
import { createFrameBuffer } from '../src/renderer/frame-buffer';
import { Controller } from '../src/core/input/controller';
import { NesButton, type ControllerSource } from '../src/core/input/source';
import { ConfigStore } from '../src/config/store';
import { DEFAULT_CONFIG } from '../src/config/defaults';

function buildInesRom(prgBanks = 1, chrBanks = 1, mapperId = 0): Uint8Array {
  const headerSize = 16;
  const prgSize = prgBanks * 16384;
  const chrSize = chrBanks * 8192;
  const data = new Uint8Array(headerSize + prgSize + chrSize);
  data.set([0x4e, 0x45, 0x53, 0x1a]);
  data[4] = prgBanks;
  data[5] = chrBanks;
  data[6] = (mapperId & 0xf) << 4;
  data[7] = mapperId & 0xf0;
  data[headerSize] = 0xab;
  return data;
}

describe('iNES parser', () => {
  it('detects iNES magic', () => {
    expect(isInes(buildInesRom())).toBe(true);
    expect(isInes(new Uint8Array([0, 0, 0, 0]))).toBe(false);
  });

  it('extracts PRG/CHR sizes', () => {
    const rom = parseInes(buildInesRom(2, 1, 0));
    expect(rom.prgRom.length).toBe(2 * 16384);
    expect(rom.chrRom.length).toBe(8192);
    expect(rom.header.mapper).toBe(0);
  });
});

describe('NROM mapper', () => {
  it('mirrors a single 16KB PRG bank into $C000-$FFFF', () => {
    const rom = parseInes(buildInesRom(1, 1, 0));
    const m = new Nrom(rom);
    expect(m.cpuRead(0x8000)).toBe(0xab);
    expect(m.cpuRead(0xc000)).toBe(0xab);
  });
});

describe('NearestNeighborScaler', () => {
  it('passes through 1x', () => {
    const s = new NearestNeighborScaler(1);
    const a = createFrameBuffer(4, 4);
    a.data[0] = 0x12345678;
    const b = createFrameBuffer(4, 4);
    s.apply(a, b);
    expect(b.data[0]).toBe(0x12345678);
  });

  it('upscales 2x by replicating pixels', () => {
    const s = new NearestNeighborScaler(2);
    const a = createFrameBuffer(2, 2);
    a.data[0] = 0xaa;
    a.data[1] = 0xbb;
    a.data[2] = 0xcc;
    a.data[3] = 0xdd;
    const b = createFrameBuffer(4, 4);
    s.apply(a, b);
    expect(b.data[0]).toBe(0xaa);
    expect(b.data[1]).toBe(0xaa);
    expect(b.data[4]).toBe(0xaa);
    expect(b.data[5]).toBe(0xaa);
    expect(b.data[15]).toBe(0xdd);
  });
});

describe('Controller serial protocol', () => {
  it('shifts out A,B,Select,Start,Up,Down,Left,Right on falling-edge strobe', () => {
    const c = new Controller();
    const source: ControllerSource = {
      name: 'test',
      pressed: (b) => b === NesButton.A || b === NesButton.Start,
    };
    c.setSource(source);
    c.writeStrobe(1);
    c.writeStrobe(0);
    expect(c.read()).toBe(1); // A
    expect(c.read()).toBe(0); // B
    expect(c.read()).toBe(0); // Select
    expect(c.read()).toBe(1); // Start
    expect(c.read()).toBe(0); // Up
  });
});

describe('ConfigStore', () => {
  it('returns defaults on a clean storage', () => {
    const storage = new MemoryStorage();
    const store = new ConfigStore(storage);
    expect(store.get().video.scaler).toBe(DEFAULT_CONFIG.video.scaler);
    expect(store.get().input.player1Keys.Slash).toBe(NesButton.B);
    expect(store.get().input.player2Keys.KeyB).toBe(NesButton.B);
  });

  it('persists updates and reloads them', () => {
    const storage = new MemoryStorage();
    new ConfigStore(storage).update((c) => ({
      ...c,
      audio: { ...c.audio, volume: 0.25 },
    }));
    const reopened = new ConfigStore(storage);
    expect(reopened.get().audio.volume).toBe(0.25);
  });

  it('migrates old stock player 1 bindings to the two-player defaults', () => {
    const storage = new MemoryStorage();
    storage.setItem('poncho.nes.config', JSON.stringify({
      version: 2,
      input: {
        player1Keys: {
          ArrowUp: NesButton.Up,
          ArrowDown: NesButton.Down,
          ArrowLeft: NesButton.Left,
          ArrowRight: NesButton.Right,
          KeyZ: NesButton.B,
          KeyX: NesButton.A,
          KeyC: NesButton.Select,
          KeyV: NesButton.Start,
        },
        player2Keys: {},
      },
    }));
    const migrated = new ConfigStore(storage).get();
    expect(migrated.input.player1Keys.Slash).toBe(NesButton.B);
    expect(migrated.input.player1Keys.KeyZ).toBeUndefined();
    expect(migrated.input.player2Keys.KeyW).toBe(NesButton.Up);
  });
});

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}
