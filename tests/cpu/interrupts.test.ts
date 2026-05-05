import { describe, expect, it } from 'vitest';
import { Flag } from '../../src/core/cpu/flags';
import { makeCpu } from './helpers';

describe('Reset', () => {
  it('loads PC from $FFFC, sets I, and sets SP to $FD', () => {
    const { cpu } = makeCpu({ pcStart: 0xc000 });
    expect(cpu.pc).toBe(0xc000);
    expect(cpu.sp).toBe(0xfd);
    expect(cpu.getFlag(Flag.I)).toBe(true);
    expect(cpu.getFlag(Flag.U)).toBe(true);
  });
});

describe('NMI', () => {
  it('pushes PC and P (B=0, U=1) and jumps via $FFFA', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0xea] }); // NOP
    mem[0xfffa] = 0x00;
    mem[0xfffb] = 0x90;

    cpu.triggerNmi();
    const cycles = cpu.step();

    expect(cycles).toBe(7);
    expect(cpu.pc).toBe(0x9000);
    expect(cpu.getFlag(Flag.I)).toBe(true);
    // PC pushed: hi at SP+1, lo at SP+2. SP started at 0xFD, after 3 pushes -> 0xFA.
    expect(cpu.sp).toBe(0xfa);
    expect(mem[0x01fd]).toBe(0x80); // PC hi
    expect(mem[0x01fc]).toBe(0x00); // PC lo
    const pushedP = mem[0x01fb];
    expect(pushedP & Flag.B).toBe(0); // B clear for NMI
    expect(pushedP & Flag.U).toBe(Flag.U);
  });

  it('clears the latch after servicing — does not fire twice', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0xea, 0xea] });
    mem[0xfffa] = 0x10;
    mem[0xfffb] = 0x80;
    mem[0x8010] = 0xea; // NOP at NMI handler

    cpu.triggerNmi();
    cpu.step(); // services NMI -> 7 cycles
    expect(cpu.hasPendingNmi()).toBe(false);

    const cycles = cpu.step(); // should be a regular NOP
    expect(cycles).toBe(2);
  });
});

describe('IRQ', () => {
  it('is masked when I=1', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0xea] });
    mem[0xfffe] = 0x00;
    mem[0xffff] = 0x90;

    cpu.setFlag(Flag.I, true);
    cpu.setIrqLine(true);
    const cycles = cpu.step();
    expect(cycles).toBe(2); // ran NOP, IRQ deferred
    expect(cpu.pc).toBe(0x8001);
  });

  it('is serviced when I=0 and the line is asserted', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0xea] });
    mem[0xfffe] = 0x00;
    mem[0xffff] = 0x90;
    cpu.setFlag(Flag.I, false);
    cpu.setIrqLine(true);
    const cycles = cpu.step();
    expect(cycles).toBe(7);
    expect(cpu.pc).toBe(0x9000);
    expect(cpu.getFlag(Flag.I)).toBe(true);
  });
});

describe('BRK / RTI', () => {
  it('BRK pushes PC+2, sets B in pushed P, and jumps via $FFFE', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x8000, program: [0x00, 0x00] }); // BRK + signature
    mem[0xfffe] = 0x00;
    mem[0xffff] = 0x90;

    cpu.step();

    expect(cpu.pc).toBe(0x9000);
    expect(mem[0x01fd]).toBe(0x80); // PC hi
    expect(mem[0x01fc]).toBe(0x02); // PC lo (skipped over signature byte)
    const pushedP = mem[0x01fb];
    expect(pushedP & Flag.B).toBe(Flag.B);
    expect(pushedP & Flag.U).toBe(Flag.U);
    expect(cpu.getFlag(Flag.I)).toBe(true);
  });

  it('RTI restores P (B masked, U forced) and PC', () => {
    const { cpu, mem } = makeCpu({ pcStart: 0x9000, program: [0x40] }); // RTI
    cpu.sp = 0xfa;
    mem[0x01fb] = 0xff; // pushed P (all bits set)
    mem[0x01fc] = 0x05; // PC lo
    mem[0x01fd] = 0x80; // PC hi

    cpu.step();

    expect(cpu.pc).toBe(0x8005);
    expect(cpu.p & Flag.B).toBe(0); // B masked
    expect(cpu.p & Flag.U).toBe(Flag.U); // U forced on
  });
});

describe('Stall', () => {
  it('stall(n) parks the CPU for n cycles', () => {
    const { cpu } = makeCpu({ program: [0xea] }); // NOP
    cpu.stall(3);
    expect(cpu.step()).toBe(1); // burning stall
    expect(cpu.step()).toBe(1);
    expect(cpu.step()).toBe(1);
    expect(cpu.step()).toBe(2); // now NOP runs
  });
});
