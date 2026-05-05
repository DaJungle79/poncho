/**
 * 6502 P (status) register bit definitions and helpers.
 *
 * Layout (high to low): N V U B D I Z C
 *   N  Negative   — bit 7 of the last result.
 *   V  Overflow   — set by ADC/SBC when the signed result overflows 8 bits;
 *                   set by BIT to bit 6 of the operand.
 *   U  Unused     — physically not present, but reads as 1 when P is pushed.
 *   B  Break      — not a real bit; controls bit 4 of the value pushed during
 *                   BRK vs. NMI/IRQ. PHP / BRK push P with B=1; NMI / IRQ
 *                   push it with B=0. PLP / RTI ignore the pulled bit.
 *   D  Decimal    — settable but inert on the 2A03 (the NES variant has no
 *                   BCD mode); we still update it so PHP/PLP round-trip.
 *   I  IRQ disable — when set, maskable IRQs are deferred.
 *   Z  Zero       — set if the last result equals 0.
 *   C  Carry      — set on add overflow / subtract no-borrow / shifted-out bit.
 *
 * Reference: nesdev wiki "Status flags".
 */
export const enum Flag {
  C = 1 << 0,
  Z = 1 << 1,
  I = 1 << 2,
  D = 1 << 3,
  B = 1 << 4,
  U = 1 << 5,
  V = 1 << 6,
  N = 1 << 7,
}

/** P value at power-on / reset: I=1 (IRQs masked), U=1 (always reads high). */
export const RESET_P = Flag.U | Flag.I;

/**
 * Update the N and Z bits of `p` from a result byte.
 * Z is set when the low 8 bits are zero. N is a copy of bit 7.
 * Returns the new P value (no mutation).
 */
export function setZN(p: number, value: number): number {
  p &= ~(Flag.Z | Flag.N);
  if ((value & 0xff) === 0) p |= Flag.Z;
  if (value & 0x80) p |= Flag.N;
  return p;
}

/** Render P as the 8-character mnemonic string used in trace logs ("nvUbdIzC"). */
export function pToString(p: number): string {
  return (
    (p & Flag.N ? 'N' : 'n') +
    (p & Flag.V ? 'V' : 'v') +
    (p & Flag.U ? 'U' : 'u') +
    (p & Flag.B ? 'B' : 'b') +
    (p & Flag.D ? 'D' : 'd') +
    (p & Flag.I ? 'I' : 'i') +
    (p & Flag.Z ? 'Z' : 'z') +
    (p & Flag.C ? 'C' : 'c')
  );
}
