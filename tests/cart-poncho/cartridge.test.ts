import { describe, expect, it } from 'vitest';

import { PonchoCartridge } from '../../src/core/cart-poncho/cartridge';
import { assemblePonchoRom, makePalette } from '../../src/core/cart-poncho/writer';

describe('PonchoCartridge + PonchoMapper', () => {
  function buildCart(opts: { prg?: Uint8Array; chr?: Uint8Array } = {}): PonchoCartridge {
    const prg = opts.prg ?? new Uint8Array(1024);
    const chr = opts.chr ?? new Uint8Array(1024);
    const rom = assemblePonchoRom({
      palette: makePalette([[0, 0, 0]]),
      prg,
      chr,
    });
    return new PonchoCartridge(rom);
  }

  it('exposes palette / PRG / CHR slices that match the source bytes', () => {
    const prg = new Uint8Array(1024);
    prg[5] = 0xab;
    const cart = buildCart({ prg });
    expect(cart.prg[5]).toBe(0xab);
    expect(cart.prg.length).toBe(1024);
    expect(cart.chr.length).toBe(1024);
    expect(cart.palette).toEqual(new Uint8Array([0, 0, 0, 0xff]));
  });

  it('mapper.cpuRead returns PRG bytes for $8000-$FFFF', () => {
    const prg = new Uint8Array(1024);
    prg[0] = 0x4c; // JMP
    prg[1] = 0x00;
    prg[2] = 0xc0;
    const cart = buildCart({ prg });
    expect(cart.mapper.cpuRead(0xc000)).toBe(0x4c);
    expect(cart.mapper.cpuRead(0xc001)).toBe(0x00);
    expect(cart.mapper.cpuRead(0xc002)).toBe(0xc0);
  });

  it('mapper.cpuRead mirrors a 1 KB PRG 32× across $8000-$FFFF', () => {
    const prg = new Uint8Array(1024);
    prg[0x3fc] = 0x00;
    prg[0x3fd] = 0xc0;
    const cart = buildCart({ prg });
    // Reset vector at $FFFC maps to PRG[0x3FC].
    expect(cart.mapper.cpuRead(0xfffc)).toBe(0x00);
    expect(cart.mapper.cpuRead(0xfffd)).toBe(0xc0);
    // First mirror copy at $8000 also maps to PRG[0].
    expect(cart.mapper.cpuRead(0x8000)).toBe(0x00);
    expect(cart.mapper.cpuRead(0x8001)).toBe(0x00);
  });

  it('mapper.cpuRead returns 0 below $8000', () => {
    const cart = buildCart();
    expect(cart.mapper.cpuRead(0x4020)).toBe(0);
    expect(cart.mapper.cpuRead(0x7fff)).toBe(0);
  });

  it('mapper.irqPending is always false in the stub', () => {
    expect(buildCart().mapper.irqPending()).toBe(false);
  });
});
