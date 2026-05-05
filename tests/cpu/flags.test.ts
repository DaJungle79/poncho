import { describe, expect, it } from 'vitest';
import { Flag, RESET_P, pToString, setZN } from '../../src/core/cpu/flags';

describe('Flag bits', () => {
  it('have the expected bit positions', () => {
    expect(Flag.C).toBe(1 << 0);
    expect(Flag.Z).toBe(1 << 1);
    expect(Flag.I).toBe(1 << 2);
    expect(Flag.D).toBe(1 << 3);
    expect(Flag.B).toBe(1 << 4);
    expect(Flag.U).toBe(1 << 5);
    expect(Flag.V).toBe(1 << 6);
    expect(Flag.N).toBe(1 << 7);
  });

  it('reset P has I=1 and U=1', () => {
    expect(RESET_P).toBe(0x24);
  });
});

describe('setZN', () => {
  it('sets Z when value is zero', () => {
    expect(setZN(0, 0) & Flag.Z).toBe(Flag.Z);
  });

  it('clears Z for non-zero', () => {
    expect(setZN(Flag.Z, 0x01) & Flag.Z).toBe(0);
  });

  it('sets N from bit 7', () => {
    expect(setZN(0, 0x80) & Flag.N).toBe(Flag.N);
    expect(setZN(0, 0x7f) & Flag.N).toBe(0);
  });

  it('preserves unrelated flags', () => {
    const before = Flag.C | Flag.V | Flag.U;
    const after = setZN(before, 0x00);
    expect(after & Flag.C).toBe(Flag.C);
    expect(after & Flag.V).toBe(Flag.V);
    expect(after & Flag.U).toBe(Flag.U);
  });
});

describe('pToString', () => {
  it('formats RESET_P as "nv-Ub-dIzc" shape', () => {
    expect(pToString(RESET_P)).toBe('nvUbdIzc');
  });

  it('shows uppercase letters for set bits', () => {
    expect(pToString(0xff)).toBe('NVUBDIZC');
  });
});
