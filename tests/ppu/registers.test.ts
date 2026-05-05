import { describe, expect, it } from 'vitest';
import { PpuCtrl, PpuStatus } from '../../src/core/ppu/registers';
import { VBLANK_FIRST_SCANLINE } from '../../src/core/ppu/timing';
import { makePpu } from './helpers';

describe('$2000 PPUCTRL', () => {
  it('writes the byte and patches t nametable bits 10-11', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2000, 0x03);
    expect(ppu.regs.ctrl).toBe(0x03);
    // t bits 10..11 should be 0b11
    expect((ppu.regs.t >>> 10) & 0x03).toBe(0x03);
  });
});

describe('$2002 PPUSTATUS', () => {
  it('clears VBlank on read and resets the write toggle', () => {
    const { ppu } = makePpu();
    ppu.regs.status |= PpuStatus.VBlank;
    ppu.regs.w = 1;
    const v = ppu.cpuRead(0x2002);
    expect(v & PpuStatus.VBlank).toBe(PpuStatus.VBlank);
    expect(ppu.regs.status & PpuStatus.VBlank).toBe(0);
    expect(ppu.regs.w).toBe(0);
  });

  it('low 5 bits return open-bus (the latch)', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2000, 0x5a); // sets openBus to 0x5A
    ppu.regs.status = 0; // upper bits all clear
    const v = ppu.cpuRead(0x2002);
    expect(v & 0x1f).toBe(0x5a & 0x1f);
  });
});

describe('$2003 / $2004 OAM access', () => {
  it('writing $2004 stores at OAMADDR and post-increments', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2003, 0x10);
    ppu.cpuWrite(0x2004, 0xab);
    expect(ppu.oam[0x10]).toBe(0xab);
    expect(ppu.regs.oamAddr).toBe(0x11);
  });

  it('byte 2 of each sprite has bits 2-4 forced to 0', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2003, 0x02);
    ppu.cpuWrite(0x2004, 0xff);
    expect(ppu.oam[0x02]).toBe(0xff & 0xe3);
  });
});

describe('$2005 PPUSCROLL two-write', () => {
  it('first write loads coarse-X (t bits 0-4) and fine-X (x latch)', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2005, 0b1011_0101);
    expect(ppu.regs.t & 0x1f).toBe(0b10110); // coarse X = bits 7..3
    expect(ppu.regs.x).toBe(0b101);          // fine X = bits 2..0
    expect(ppu.regs.w).toBe(1);
  });

  it('second write loads fine-Y (t 12..14) and coarse-Y (t 5..9)', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2005, 0); // first write
    ppu.cpuWrite(0x2005, 0b1100_0011);
    // fine Y = bits 0..2 of value -> t bits 12..14
    expect((ppu.regs.t >>> 12) & 0x07).toBe(0b011);
    // coarse Y = bits 7..3 of value -> t bits 5..9
    expect((ppu.regs.t >>> 5) & 0x1f).toBe(0b11000);
    expect(ppu.regs.w).toBe(0);
  });
});

describe('$2006 PPUADDR two-write', () => {
  it('first write sets t high byte (with bit 14 forced 0); second copies t→v', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2006, 0x7f); // high
    expect(ppu.regs.t >>> 8).toBe(0x3f); // bit 14 cleared
    expect(ppu.regs.v).toBe(0); // not yet copied
    ppu.cpuWrite(0x2006, 0x21); // low
    expect(ppu.regs.t).toBe(0x3f21);
    expect(ppu.regs.v).toBe(0x3f21);
    expect(ppu.regs.w).toBe(0);
  });
});

describe('$2007 PPUDATA', () => {
  it('reads of $0000-$3EFF go through a one-byte buffer', () => {
    const h = makePpu();
    h.mapper.chr[0] = 0xaa;
    h.mapper.chr[1] = 0xbb;
    h.ppu.cpuWrite(0x2006, 0x00);
    h.ppu.cpuWrite(0x2006, 0x00); // v = $0000
    expect(h.ppu.cpuRead(0x2007)).toBe(0x00); // first read returns stale buffer
    expect(h.ppu.cpuRead(0x2007)).toBe(0xaa); // returns previous buffered byte
    expect(h.ppu.cpuRead(0x2007)).toBe(0xbb);
  });

  it('palette reads ($3F00+) bypass the buffer', () => {
    const h = makePpu();
    h.bus.write(0x3f00, 0x12);
    h.ppu.cpuWrite(0x2006, 0x3f);
    h.ppu.cpuWrite(0x2006, 0x00); // v = $3F00
    expect(h.ppu.cpuRead(0x2007)).toBe(0x12);
  });

  it('writes go through the bus and advance v by 1 by default', () => {
    const h = makePpu();
    h.ppu.cpuWrite(0x2006, 0x00);
    h.ppu.cpuWrite(0x2006, 0x10); // v = $0010
    h.ppu.cpuWrite(0x2007, 0x77);
    expect(h.mapper.chr[0x10]).toBe(0x77);
    expect(h.ppu.regs.v).toBe(0x0011);
  });

  it('VramIncrement bit makes v advance by 32', () => {
    const h = makePpu();
    h.ppu.cpuWrite(0x2000, PpuCtrl.VramIncrement);
    h.ppu.cpuWrite(0x2006, 0x00);
    h.ppu.cpuWrite(0x2006, 0x00);
    h.ppu.cpuWrite(0x2007, 0x01);
    expect(h.ppu.regs.v).toBe(0x0020);
  });
});

describe('Open-bus on write-only registers', () => {
  it('reads of $2000 return the last value written to any PPU reg', () => {
    const { ppu } = makePpu();
    ppu.cpuWrite(0x2001, 0xa5);
    expect(ppu.cpuRead(0x2000)).toBe(0xa5);
  });
});

describe('reading $2002 right after vblank set still shows the flag', () => {
  it('keeps cycle independence (we set status = vblank manually)', () => {
    const h = makePpu();
    h.tickUntil(VBLANK_FIRST_SCANLINE, 0);
    h.tickDots(1);
    const v = h.ppu.cpuRead(0x2002);
    expect(v & PpuStatus.VBlank).toBe(PpuStatus.VBlank);
  });
});
