import { describe, expect, it } from 'vitest';
import { Flag } from '../../src/core/cpu/flags';
import { makeCpu } from './helpers';

describe('Loads', () => {
  it('LDA #$42 sets A and clears Z, N', () => {
    const { cpu } = makeCpu({ program: [0xa9, 0x42] });
    cpu.step();
    expect(cpu.a).toBe(0x42);
    expect(cpu.getFlag(Flag.Z)).toBe(false);
    expect(cpu.getFlag(Flag.N)).toBe(false);
  });

  it('LDA #$00 sets Z', () => {
    const { cpu } = makeCpu({ program: [0xa9, 0x00] });
    cpu.step();
    expect(cpu.getFlag(Flag.Z)).toBe(true);
  });

  it('LDA #$FF sets N', () => {
    const { cpu } = makeCpu({ program: [0xa9, 0xff] });
    cpu.step();
    expect(cpu.getFlag(Flag.N)).toBe(true);
  });

  it('LDX zp loads from zero page', () => {
    const { cpu, mem } = makeCpu({ program: [0xa6, 0x10] });
    mem[0x0010] = 0x77;
    cpu.step();
    expect(cpu.x).toBe(0x77);
  });

  it('LDA abs,X with page cross costs an extra cycle', () => {
    const { cpu, mem } = makeCpu({ program: [0xbd, 0xff, 0x12] });
    cpu.x = 0x02;
    mem[0x1301] = 0xaa;
    const cycles = cpu.step();
    expect(cpu.a).toBe(0xaa);
    expect(cycles).toBe(5); // 4 base + 1 page-cross
  });

  it('LDA abs,X same-page costs 4 cycles', () => {
    const { cpu, mem } = makeCpu({ program: [0xbd, 0x10, 0x12] });
    cpu.x = 0x02;
    mem[0x1212] = 0xaa;
    expect(cpu.step()).toBe(4);
  });
});

describe('Stores', () => {
  it('STA zp writes A to zero page', () => {
    const { cpu, mem } = makeCpu({ program: [0x85, 0x40] });
    cpu.a = 0xab;
    cpu.step();
    expect(mem[0x40]).toBe(0xab);
  });

  it('STA abs,X always pays 5 cycles regardless of page cross', () => {
    const { cpu } = makeCpu({ program: [0x9d, 0xff, 0x12] });
    cpu.x = 0x02;
    cpu.a = 0x11;
    expect(cpu.step()).toBe(5);
  });
});

describe('Transfers', () => {
  it('TAX copies A to X and updates flags', () => {
    const { cpu } = makeCpu({ program: [0xaa] });
    cpu.a = 0x80;
    cpu.step();
    expect(cpu.x).toBe(0x80);
    expect(cpu.getFlag(Flag.N)).toBe(true);
  });

  it('TXS does not touch flags', () => {
    const { cpu } = makeCpu({ program: [0x9a] });
    cpu.x = 0x00;
    const before = cpu.p;
    cpu.step();
    expect(cpu.sp).toBe(0x00);
    expect(cpu.p).toBe(before);
  });
});

describe('Stack', () => {
  it('PHA + PLA round-trips A and updates flags on PLA', () => {
    const { cpu } = makeCpu({ program: [0x48, 0xa9, 0x00, 0x68] });
    cpu.a = 0x80;
    cpu.step(); // PHA
    cpu.step(); // LDA #$00
    cpu.step(); // PLA
    expect(cpu.a).toBe(0x80);
    expect(cpu.getFlag(Flag.N)).toBe(true);
  });

  it('PHP pushes P with B and U set', () => {
    const { cpu, mem } = makeCpu({ program: [0x08] });
    cpu.p = 0x20; // U only
    cpu.step();
    expect(mem[0x0100 | 0xfd]).toBe(0x30); // U|B
  });

  it('PLP forces B=0 and U=1', () => {
    const { cpu } = makeCpu({ program: [0x28] });
    cpu.sp = 0xfc;
    cpu.write8(0x01fd, 0xff); // all bits set
    cpu.step();
    expect(cpu.p & Flag.B).toBe(0);
    expect(cpu.p & Flag.U).toBe(Flag.U);
  });
});

describe('Logical', () => {
  it('AND zeroes A correctly', () => {
    const { cpu } = makeCpu({ program: [0x29, 0x0f] });
    cpu.a = 0xf0;
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.getFlag(Flag.Z)).toBe(true);
  });

  it('BIT copies operand bits 7,6 into N,V regardless of A', () => {
    const { cpu, mem } = makeCpu({ program: [0x24, 0x10] });
    mem[0x10] = 0xc0; // bits 7 and 6 set
    cpu.a = 0x00;
    cpu.step();
    expect(cpu.getFlag(Flag.N)).toBe(true);
    expect(cpu.getFlag(Flag.V)).toBe(true);
    expect(cpu.getFlag(Flag.Z)).toBe(true); // A & M == 0
  });
});

describe('Arithmetic', () => {
  it('ADC sets C on unsigned overflow', () => {
    const { cpu } = makeCpu({ program: [0x69, 0x01] });
    cpu.a = 0xff;
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.getFlag(Flag.C)).toBe(true);
    expect(cpu.getFlag(Flag.Z)).toBe(true);
  });

  it('ADC sets V on signed overflow', () => {
    const { cpu } = makeCpu({ program: [0x69, 0x01] });
    cpu.a = 0x7f;
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.getFlag(Flag.V)).toBe(true);
    expect(cpu.getFlag(Flag.N)).toBe(true);
  });

  it('SBC subtracts with borrow', () => {
    const { cpu } = makeCpu({ program: [0xe9, 0x01] });
    cpu.a = 0x10;
    cpu.setFlag(Flag.C, true); // no borrow
    cpu.step();
    expect(cpu.a).toBe(0x0f);
  });

  it('CMP sets C when A >= M', () => {
    const { cpu } = makeCpu({ program: [0xc9, 0x10] });
    cpu.a = 0x20;
    cpu.step();
    expect(cpu.getFlag(Flag.C)).toBe(true);
    expect(cpu.getFlag(Flag.Z)).toBe(false);
  });

  it('CMP sets Z when A == M', () => {
    const { cpu } = makeCpu({ program: [0xc9, 0x20] });
    cpu.a = 0x20;
    cpu.step();
    expect(cpu.getFlag(Flag.Z)).toBe(true);
    expect(cpu.getFlag(Flag.C)).toBe(true);
  });
});

describe('Inc/Dec', () => {
  it('INX rolls over and sets Z', () => {
    const { cpu } = makeCpu({ program: [0xe8] });
    cpu.x = 0xff;
    cpu.step();
    expect(cpu.x).toBe(0x00);
    expect(cpu.getFlag(Flag.Z)).toBe(true);
  });

  it('DEC mem zero-page', () => {
    const { cpu, mem } = makeCpu({ program: [0xc6, 0x10] });
    mem[0x10] = 0x01;
    cpu.step();
    expect(mem[0x10]).toBe(0x00);
    expect(cpu.getFlag(Flag.Z)).toBe(true);
  });
});

describe('Shifts and rotates', () => {
  it('ASL A shifts left and sets C', () => {
    const { cpu } = makeCpu({ program: [0x0a] });
    cpu.a = 0x81;
    cpu.step();
    expect(cpu.a).toBe(0x02);
    expect(cpu.getFlag(Flag.C)).toBe(true);
  });

  it('LSR A clears N', () => {
    const { cpu } = makeCpu({ program: [0x4a] });
    cpu.a = 0x80;
    cpu.setFlag(Flag.N, true);
    cpu.step();
    expect(cpu.a).toBe(0x40);
    expect(cpu.getFlag(Flag.N)).toBe(false);
  });

  it('ROL A rotates carry into bit 0', () => {
    const { cpu } = makeCpu({ program: [0x2a] });
    cpu.a = 0x40;
    cpu.setFlag(Flag.C, true);
    cpu.step();
    expect(cpu.a).toBe(0x81);
    expect(cpu.getFlag(Flag.C)).toBe(false);
  });

  it('ROR A rotates carry into bit 7', () => {
    const { cpu } = makeCpu({ program: [0x6a] });
    cpu.a = 0x02;
    cpu.setFlag(Flag.C, true);
    cpu.step();
    expect(cpu.a).toBe(0x81);
    expect(cpu.getFlag(Flag.C)).toBe(false);
  });
});

describe('Jumps and calls', () => {
  it('JMP abs sets PC', () => {
    const { cpu } = makeCpu({ program: [0x4c, 0x34, 0x12] });
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
  });

  it('JSR pushes PC-1 then jumps', () => {
    const { cpu, mem } = makeCpu({ program: [0x20, 0x34, 0x12] });
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
    expect(mem[0x01fd]).toBe(0x80); // hi
    expect(mem[0x01fc]).toBe(0x02); // lo  (PC-1 = 0x8002)
  });

  it('JSR/RTS round-trip', () => {
    const { cpu, mem } = makeCpu({ program: [0x20, 0x10, 0x80] });
    mem[0x8010] = 0x60; // RTS
    cpu.step(); // JSR
    cpu.step(); // RTS
    expect(cpu.pc).toBe(0x8003);
  });
});

describe('Branches', () => {
  it('BCC taken adds 1 cycle, page-cross adds 1 more', () => {
    const { cpu } = makeCpu({ pcStart: 0x80fa, program: [0x90, 0x10] });
    cpu.setFlag(Flag.C, false);
    const cycles = cpu.step();
    // After fetch: PC = 0x80FC. Target = 0x80FC + 0x10 = 0x810C (different page).
    expect(cpu.pc).toBe(0x810c);
    expect(cycles).toBe(4); // 2 base + 1 taken + 1 cross
  });

  it('BCC taken without page cross is 3 cycles', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0x90, 0x05] });
    cpu.setFlag(Flag.C, false);
    const cycles = cpu.step();
    expect(cpu.pc).toBe(0x8007);
    expect(cycles).toBe(3);
  });

  it('BCC not taken stays at PC and costs 2', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0x90, 0x05] });
    cpu.setFlag(Flag.C, true);
    const cycles = cpu.step();
    expect(cpu.pc).toBe(0x8002);
    expect(cycles).toBe(2);
  });

  it('BEQ branches when Z is set', () => {
    const { cpu } = makeCpu({ pcStart: 0x8000, program: [0xf0, 0x10] });
    cpu.setFlag(Flag.Z, true);
    cpu.step();
    expect(cpu.pc).toBe(0x8012);
  });
});

describe('Status flags', () => {
  it('SEC, CLC toggle C', () => {
    const { cpu } = makeCpu({ program: [0x38, 0x18] });
    cpu.step();
    expect(cpu.getFlag(Flag.C)).toBe(true);
    cpu.step();
    expect(cpu.getFlag(Flag.C)).toBe(false);
  });

  it('SED, CLD toggle D (D is inert on 2A03 but the bit still flips)', () => {
    const { cpu } = makeCpu({ program: [0xf8, 0xd8] });
    cpu.step();
    expect(cpu.getFlag(Flag.D)).toBe(true);
    cpu.step();
    expect(cpu.getFlag(Flag.D)).toBe(false);
  });
});

describe('Illegal opcodes', () => {
  it('LAX loads A and X simultaneously', () => {
    const { cpu, mem } = makeCpu({ program: [0xa7, 0x10] });
    mem[0x10] = 0x55;
    cpu.step();
    expect(cpu.a).toBe(0x55);
    expect(cpu.x).toBe(0x55);
  });

  it('SAX writes A AND X', () => {
    const { cpu, mem } = makeCpu({ program: [0x87, 0x10] });
    cpu.a = 0xf0;
    cpu.x = 0x33;
    cpu.step();
    expect(mem[0x10]).toBe(0x30);
  });

  it('DCP decrements memory then compares against A', () => {
    const { cpu, mem } = makeCpu({ program: [0xc7, 0x10] });
    mem[0x10] = 0x06;
    cpu.a = 0x05;
    cpu.step();
    expect(mem[0x10]).toBe(0x05);
    expect(cpu.getFlag(Flag.Z)).toBe(true);
    expect(cpu.getFlag(Flag.C)).toBe(true);
  });

  it('illegal NOP imm consumes the operand byte', () => {
    const { cpu } = makeCpu({ program: [0x80, 0x55] });
    const cycles = cpu.step();
    expect(cycles).toBe(2);
    expect(cpu.pc).toBe(0x8002);
  });
});

describe('Small integration program', () => {
  it('sums 1..5 in A', () => {
    // LDX #$05; LDA #$00; loop: clc; adc x; dex; bne loop; brk
    const { cpu, mem } = makeCpu({
      pcStart: 0x8000,
      program: [
        0xa2, 0x05,   // LDX #$05
        0xa9, 0x00,   // LDA #$00
        0x18,         // CLC      (resets C each loop start)
        0x8a,         // TXA      (would touch A — no, we want to add X so use a different shape)
      ],
    });
    // Replace with cleaner program:
    const prog = [
      0xa2, 0x05,       // LDX #$05
      0xa9, 0x00,       // LDA #$00
      0x18,             // CLC                ; $8004
      0x86, 0x10,       // STX $10
      0x65, 0x10,       // ADC $10
      0xca,             // DEX
      0xd0, 0xf8,       // BNE $8004           ; back to CLC
      0x00,             // BRK
    ];
    for (let i = 0; i < prog.length; i++) mem[0x8000 + i] = prog[i];
    cpu.reset();

    let safety = 1000;
    while (cpu.read8(cpu.pc) !== 0x00 && safety-- > 0) cpu.step();

    expect(cpu.a).toBe(15);
  });
});
