import { describe, expect, it } from 'vitest';
import {
  absolute, absoluteX, absoluteY,
  immediate, implied, indirect, indirectX, indirectY,
  relative,
  zeroPage, zeroPageX, zeroPageY,
} from '../../src/core/cpu/addressing';
import { makeCpu } from './helpers';

describe('Addressing modes', () => {
  it('Implied returns sentinel and does not move PC', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000 });
    const before = cpu.pc;
    const r = implied(cpu);
    expect(r.addr).toBe(0);
    expect(r.pageCrossed).toBe(false);
    expect(cpu.pc).toBe(before);
  });

  it('Immediate returns the operand byte address and advances PC', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0x42] });
    const r = immediate(cpu);
    expect(r.addr).toBe(0x8000);
    expect(cpu.pc).toBe(0x8001);
  });

  it('Zero Page reads a one-byte operand', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0x55] });
    expect(zeroPage(cpu).addr).toBe(0x0055);
  });

  it('Zero Page,X wraps within $00-$FF', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0xff] });
    cpu.x = 0x05;
    expect(zeroPageX(cpu).addr).toBe(0x04);
  });

  it('Zero Page,Y wraps within $00-$FF', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0xfe] });
    cpu.y = 0x10;
    expect(zeroPageY(cpu).addr).toBe(0x0e);
  });

  it('Absolute is little-endian', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0x34, 0x12] });
    expect(absolute(cpu).addr).toBe(0x1234);
  });

  it('Absolute,X reports page cross', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0xff, 0x12] });
    cpu.x = 0x01;
    const r = absoluteX(cpu);
    expect(r.addr).toBe(0x1300);
    expect(r.pageCrossed).toBe(true);
  });

  it('Absolute,X reports no cross when staying on same page', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0x10, 0x12] });
    cpu.x = 0x05;
    expect(absoluteX(cpu).pageCrossed).toBe(false);
  });

  it('Absolute,Y reports page cross', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0xfe, 0x20] });
    cpu.y = 0x05;
    const r = absoluteY(cpu);
    expect(r.addr).toBe(0x2103);
    expect(r.pageCrossed).toBe(true);
  });

  it('Indirect reproduces the JMP page-wrap bug at $XXFF', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0xff, 0x30] });
    mem[0x30ff] = 0x80;
    mem[0x3100] = 0x50; // would be high byte if no bug
    mem[0x3000] = 0x40; // actual high byte due to bug
    expect(indirect(cpu).addr).toBe(0x4080);
  });

  it('(Indirect,X) wraps in zero page and reads pointer', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0xfe] });
    cpu.x = 0x03;
    // (0xFE + 0x03) & 0xFF = 0x01 -> pointer at $0001/$0002
    mem[0x01] = 0x34;
    mem[0x02] = 0x12;
    expect(indirectX(cpu).addr).toBe(0x1234);
  });

  it('(Indirect),Y reports page cross when adding Y crosses', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0x40] });
    mem[0x40] = 0xff;
    mem[0x41] = 0x20;
    cpu.y = 0x02;
    const r = indirectY(cpu);
    expect(r.addr).toBe(0x2101);
    expect(r.pageCrossed).toBe(true);
  });

  it('Relative encodes signed 8-bit offset from PC after operand', () => {
    const { cpu } = makeCpu({ pcStart: 0x80f0, program: [0xfe] }); // -2
    const r = relative(cpu);
    // After fetchByte, cpu.pc = 0x80f1; +(-2) = 0x80EF
    expect(r.addr).toBe(0x80ef);
  });
});
