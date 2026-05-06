import { describe, expect, it } from 'vitest';

import { CONSOLE_FACTORIES, detectConsole } from '../../src/console/detect';
import { Nes } from '../../src/console/nes';
import { PonchoNes } from '../../src/console/poncho-nes';

describe('detectConsole', () => {
  it('returns the NES factory for iNES magic', () => {
    const ines = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, 0, 0, 0, 0]);
    const factory = detectConsole(ines);
    expect(factory).not.toBeNull();
    expect(factory!.spec.id).toBe('nes');
    expect(factory!.create()).toBeInstanceOf(Nes);
  });

  it('returns the Poncho-NES factory for PNCH magic', () => {
    const pnch = new Uint8Array([0x50, 0x4e, 0x43, 0x48, 0, 0, 0, 0]);
    const factory = detectConsole(pnch);
    expect(factory).not.toBeNull();
    expect(factory!.spec.id).toBe('poncho-nes');
    expect(factory!.create()).toBeInstanceOf(PonchoNes);
  });

  it('returns null when no factory recognises the bytes', () => {
    expect(detectConsole(new Uint8Array(0))).toBeNull();
    expect(detectConsole(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG header
    expect(detectConsole(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBeNull();
  });

  it('exposes both factories on CONSOLE_FACTORIES', () => {
    const ids = CONSOLE_FACTORIES.map((f) => f.spec.id).sort();
    expect(ids).toEqual(['nes', 'poncho-nes']);
  });
});
