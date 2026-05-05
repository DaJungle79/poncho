/**
 * 256-entry 6502 opcode dispatch table.
 *
 * Cycle counting is implicit: each entry's `addressing` and `execute`
 * functions consume exactly the right number of bus cycles via the CPU's
 * tick-aware helpers (read8, write8, dummyRead, dummyWrite, internalCycle).
 * The `cycles` field stays for documentation/diagnostics — it's the
 * canonical 6502 expected count — and tests can still assert against it,
 * but the dispatcher does NOT add it to the cycle total.
 *
 * Indexed addressing modes have read-, write-, and RMW-specific variants:
 *   AbsoluteX  / AbsoluteXWrite  (Y mirrors)
 *   IndirectY  / IndirectYWrite
 * The "Write" variant always performs the un-corrected dummy read; the
 * read variant only does it on a real page cross. Read-modify-write
 * instructions also use the "Write" variant since they always read the
 * effective address before writing.
 *
 * Reference: nesdev wiki "CPU unofficial opcodes" + "6502 reference".
 */
import {
  ADDRESSING_FNS,
  AddressingMode,
  MODE_BYTES,
  type AddressingFn,
} from './addressing';
import {
  adc, alr, anc, and_, arr, aslAcc, aslMem, axs,
  bcc, bcs, beq, bit, bmi, bne, bpl, brk, bvc, bvs,
  clc, cld, cli, clv, cmp, cpx, cpy,
  dcp, dec, dex, dey,
  eor,
  inc, inx, iny, isc,
  jmp, jsr,
  lax, lda, ldx, ldy, lsrAcc, lsrMem,
  nop, nopRead,
  ora,
  pha, php, pla, plp,
  rla, rolAcc, rolMem, rorAcc, rorMem, rra, rti, rts,
  sax, sbc, sec, sed, sei, slo, sre, sta, stx, sty,
  tax, tay, tsx, txa, txs, tya,
  type InstructionFn,
} from './instructions';

export interface OpcodeEntry {
  mnemonic: string;
  mode: AddressingMode;
  addressing: AddressingFn;
  execute: InstructionFn;
  /** Canonical 6502 cycle count. Diagnostic-only; the dispatcher counts
   *  cycles via tick-aware bus helpers, so this is the *expectation*. */
  cycles: number;
  /** Total instruction length in bytes (opcode + operands). */
  bytes: number;
  /** Documented-but-illegal opcodes and the unfilled stub bucket. */
  illegal: boolean;
}

const TABLE: OpcodeEntry[] = new Array(256);

function op(
  opcode: number,
  mnemonic: string,
  mode: AddressingMode,
  execute: InstructionFn,
  cycles: number,
  illegal = false,
): void {
  TABLE[opcode] = {
    mnemonic,
    mode,
    addressing: ADDRESSING_FNS[mode],
    execute,
    cycles,
    bytes: MODE_BYTES[mode],
    illegal,
  };
}

// --- Loads -----------------------------------------------------------------
op(0xa9, 'LDA', AddressingMode.Immediate, lda, 2);
op(0xa5, 'LDA', AddressingMode.ZeroPage, lda, 3);
op(0xb5, 'LDA', AddressingMode.ZeroPageX, lda, 4);
op(0xad, 'LDA', AddressingMode.Absolute, lda, 4);
op(0xbd, 'LDA', AddressingMode.AbsoluteX, lda, 4);
op(0xb9, 'LDA', AddressingMode.AbsoluteY, lda, 4);
op(0xa1, 'LDA', AddressingMode.IndirectX, lda, 6);
op(0xb1, 'LDA', AddressingMode.IndirectY, lda, 5);

op(0xa2, 'LDX', AddressingMode.Immediate, ldx, 2);
op(0xa6, 'LDX', AddressingMode.ZeroPage, ldx, 3);
op(0xb6, 'LDX', AddressingMode.ZeroPageY, ldx, 4);
op(0xae, 'LDX', AddressingMode.Absolute, ldx, 4);
op(0xbe, 'LDX', AddressingMode.AbsoluteY, ldx, 4);

op(0xa0, 'LDY', AddressingMode.Immediate, ldy, 2);
op(0xa4, 'LDY', AddressingMode.ZeroPage, ldy, 3);
op(0xb4, 'LDY', AddressingMode.ZeroPageX, ldy, 4);
op(0xac, 'LDY', AddressingMode.Absolute, ldy, 4);
op(0xbc, 'LDY', AddressingMode.AbsoluteX, ldy, 4);

// --- Stores ----------------------------------------------------------------
op(0x85, 'STA', AddressingMode.ZeroPage, sta, 3);
op(0x95, 'STA', AddressingMode.ZeroPageX, sta, 4);
op(0x8d, 'STA', AddressingMode.Absolute, sta, 4);
op(0x9d, 'STA', AddressingMode.AbsoluteXWrite, sta, 5);
op(0x99, 'STA', AddressingMode.AbsoluteYWrite, sta, 5);
op(0x81, 'STA', AddressingMode.IndirectX, sta, 6);
op(0x91, 'STA', AddressingMode.IndirectYWrite, sta, 6);

op(0x86, 'STX', AddressingMode.ZeroPage, stx, 3);
op(0x96, 'STX', AddressingMode.ZeroPageY, stx, 4);
op(0x8e, 'STX', AddressingMode.Absolute, stx, 4);

op(0x84, 'STY', AddressingMode.ZeroPage, sty, 3);
op(0x94, 'STY', AddressingMode.ZeroPageX, sty, 4);
op(0x8c, 'STY', AddressingMode.Absolute, sty, 4);

// --- Transfers -------------------------------------------------------------
op(0xaa, 'TAX', AddressingMode.Implied, tax, 2);
op(0xa8, 'TAY', AddressingMode.Implied, tay, 2);
op(0x8a, 'TXA', AddressingMode.Implied, txa, 2);
op(0x98, 'TYA', AddressingMode.Implied, tya, 2);
op(0xba, 'TSX', AddressingMode.Implied, tsx, 2);
op(0x9a, 'TXS', AddressingMode.Implied, txs, 2);

// --- Stack -----------------------------------------------------------------
op(0x48, 'PHA', AddressingMode.Implied, pha, 3);
op(0x08, 'PHP', AddressingMode.Implied, php, 3);
op(0x68, 'PLA', AddressingMode.Implied, pla, 4);
op(0x28, 'PLP', AddressingMode.Implied, plp, 4);

// --- Logical ---------------------------------------------------------------
op(0x29, 'AND', AddressingMode.Immediate, and_, 2);
op(0x25, 'AND', AddressingMode.ZeroPage, and_, 3);
op(0x35, 'AND', AddressingMode.ZeroPageX, and_, 4);
op(0x2d, 'AND', AddressingMode.Absolute, and_, 4);
op(0x3d, 'AND', AddressingMode.AbsoluteX, and_, 4);
op(0x39, 'AND', AddressingMode.AbsoluteY, and_, 4);
op(0x21, 'AND', AddressingMode.IndirectX, and_, 6);
op(0x31, 'AND', AddressingMode.IndirectY, and_, 5);

op(0x49, 'EOR', AddressingMode.Immediate, eor, 2);
op(0x45, 'EOR', AddressingMode.ZeroPage, eor, 3);
op(0x55, 'EOR', AddressingMode.ZeroPageX, eor, 4);
op(0x4d, 'EOR', AddressingMode.Absolute, eor, 4);
op(0x5d, 'EOR', AddressingMode.AbsoluteX, eor, 4);
op(0x59, 'EOR', AddressingMode.AbsoluteY, eor, 4);
op(0x41, 'EOR', AddressingMode.IndirectX, eor, 6);
op(0x51, 'EOR', AddressingMode.IndirectY, eor, 5);

op(0x09, 'ORA', AddressingMode.Immediate, ora, 2);
op(0x05, 'ORA', AddressingMode.ZeroPage, ora, 3);
op(0x15, 'ORA', AddressingMode.ZeroPageX, ora, 4);
op(0x0d, 'ORA', AddressingMode.Absolute, ora, 4);
op(0x1d, 'ORA', AddressingMode.AbsoluteX, ora, 4);
op(0x19, 'ORA', AddressingMode.AbsoluteY, ora, 4);
op(0x01, 'ORA', AddressingMode.IndirectX, ora, 6);
op(0x11, 'ORA', AddressingMode.IndirectY, ora, 5);

op(0x24, 'BIT', AddressingMode.ZeroPage, bit, 3);
op(0x2c, 'BIT', AddressingMode.Absolute, bit, 4);

// --- Arithmetic ------------------------------------------------------------
op(0x69, 'ADC', AddressingMode.Immediate, adc, 2);
op(0x65, 'ADC', AddressingMode.ZeroPage, adc, 3);
op(0x75, 'ADC', AddressingMode.ZeroPageX, adc, 4);
op(0x6d, 'ADC', AddressingMode.Absolute, adc, 4);
op(0x7d, 'ADC', AddressingMode.AbsoluteX, adc, 4);
op(0x79, 'ADC', AddressingMode.AbsoluteY, adc, 4);
op(0x61, 'ADC', AddressingMode.IndirectX, adc, 6);
op(0x71, 'ADC', AddressingMode.IndirectY, adc, 5);

op(0xe9, 'SBC', AddressingMode.Immediate, sbc, 2);
op(0xe5, 'SBC', AddressingMode.ZeroPage, sbc, 3);
op(0xf5, 'SBC', AddressingMode.ZeroPageX, sbc, 4);
op(0xed, 'SBC', AddressingMode.Absolute, sbc, 4);
op(0xfd, 'SBC', AddressingMode.AbsoluteX, sbc, 4);
op(0xf9, 'SBC', AddressingMode.AbsoluteY, sbc, 4);
op(0xe1, 'SBC', AddressingMode.IndirectX, sbc, 6);
op(0xf1, 'SBC', AddressingMode.IndirectY, sbc, 5);

op(0xc9, 'CMP', AddressingMode.Immediate, cmp, 2);
op(0xc5, 'CMP', AddressingMode.ZeroPage, cmp, 3);
op(0xd5, 'CMP', AddressingMode.ZeroPageX, cmp, 4);
op(0xcd, 'CMP', AddressingMode.Absolute, cmp, 4);
op(0xdd, 'CMP', AddressingMode.AbsoluteX, cmp, 4);
op(0xd9, 'CMP', AddressingMode.AbsoluteY, cmp, 4);
op(0xc1, 'CMP', AddressingMode.IndirectX, cmp, 6);
op(0xd1, 'CMP', AddressingMode.IndirectY, cmp, 5);

op(0xe0, 'CPX', AddressingMode.Immediate, cpx, 2);
op(0xe4, 'CPX', AddressingMode.ZeroPage, cpx, 3);
op(0xec, 'CPX', AddressingMode.Absolute, cpx, 4);

op(0xc0, 'CPY', AddressingMode.Immediate, cpy, 2);
op(0xc4, 'CPY', AddressingMode.ZeroPage, cpy, 3);
op(0xcc, 'CPY', AddressingMode.Absolute, cpy, 4);

// --- Increments / decrements (read-modify-write) --------------------------
op(0xe6, 'INC', AddressingMode.ZeroPage, inc, 5);
op(0xf6, 'INC', AddressingMode.ZeroPageX, inc, 6);
op(0xee, 'INC', AddressingMode.Absolute, inc, 6);
op(0xfe, 'INC', AddressingMode.AbsoluteXWrite, inc, 7);

op(0xc6, 'DEC', AddressingMode.ZeroPage, dec, 5);
op(0xd6, 'DEC', AddressingMode.ZeroPageX, dec, 6);
op(0xce, 'DEC', AddressingMode.Absolute, dec, 6);
op(0xde, 'DEC', AddressingMode.AbsoluteXWrite, dec, 7);

op(0xe8, 'INX', AddressingMode.Implied, inx, 2);
op(0xc8, 'INY', AddressingMode.Implied, iny, 2);
op(0xca, 'DEX', AddressingMode.Implied, dex, 2);
op(0x88, 'DEY', AddressingMode.Implied, dey, 2);

// --- Shifts and rotates (memory variants are read-modify-write) ----------
op(0x0a, 'ASL', AddressingMode.Accumulator, aslAcc, 2);
op(0x06, 'ASL', AddressingMode.ZeroPage, aslMem, 5);
op(0x16, 'ASL', AddressingMode.ZeroPageX, aslMem, 6);
op(0x0e, 'ASL', AddressingMode.Absolute, aslMem, 6);
op(0x1e, 'ASL', AddressingMode.AbsoluteXWrite, aslMem, 7);

op(0x4a, 'LSR', AddressingMode.Accumulator, lsrAcc, 2);
op(0x46, 'LSR', AddressingMode.ZeroPage, lsrMem, 5);
op(0x56, 'LSR', AddressingMode.ZeroPageX, lsrMem, 6);
op(0x4e, 'LSR', AddressingMode.Absolute, lsrMem, 6);
op(0x5e, 'LSR', AddressingMode.AbsoluteXWrite, lsrMem, 7);

op(0x2a, 'ROL', AddressingMode.Accumulator, rolAcc, 2);
op(0x26, 'ROL', AddressingMode.ZeroPage, rolMem, 5);
op(0x36, 'ROL', AddressingMode.ZeroPageX, rolMem, 6);
op(0x2e, 'ROL', AddressingMode.Absolute, rolMem, 6);
op(0x3e, 'ROL', AddressingMode.AbsoluteXWrite, rolMem, 7);

op(0x6a, 'ROR', AddressingMode.Accumulator, rorAcc, 2);
op(0x66, 'ROR', AddressingMode.ZeroPage, rorMem, 5);
op(0x76, 'ROR', AddressingMode.ZeroPageX, rorMem, 6);
op(0x6e, 'ROR', AddressingMode.Absolute, rorMem, 6);
op(0x7e, 'ROR', AddressingMode.AbsoluteXWrite, rorMem, 7);

// --- Jumps and calls -------------------------------------------------------
op(0x4c, 'JMP', AddressingMode.Absolute, jmp, 3);
op(0x6c, 'JMP', AddressingMode.Indirect, jmp, 5);
op(0x20, 'JSR', AddressingMode.Absolute, jsr, 6);
op(0x60, 'RTS', AddressingMode.Implied, rts, 6);

// --- Branches (base 2 cycles; +1 if taken, +1 more if page cross) ---------
op(0x90, 'BCC', AddressingMode.Relative, bcc, 2);
op(0xb0, 'BCS', AddressingMode.Relative, bcs, 2);
op(0xf0, 'BEQ', AddressingMode.Relative, beq, 2);
op(0xd0, 'BNE', AddressingMode.Relative, bne, 2);
op(0x30, 'BMI', AddressingMode.Relative, bmi, 2);
op(0x10, 'BPL', AddressingMode.Relative, bpl, 2);
op(0x50, 'BVC', AddressingMode.Relative, bvc, 2);
op(0x70, 'BVS', AddressingMode.Relative, bvs, 2);

// --- Status flag changes ---------------------------------------------------
op(0x18, 'CLC', AddressingMode.Implied, clc, 2);
op(0x38, 'SEC', AddressingMode.Implied, sec, 2);
op(0x58, 'CLI', AddressingMode.Implied, cli, 2);
op(0x78, 'SEI', AddressingMode.Implied, sei, 2);
op(0xb8, 'CLV', AddressingMode.Implied, clv, 2);
op(0xd8, 'CLD', AddressingMode.Implied, cld, 2);
op(0xf8, 'SED', AddressingMode.Implied, sed, 2);

// --- System ----------------------------------------------------------------
op(0x00, 'BRK', AddressingMode.Implied, brk, 7);
op(0x40, 'RTI', AddressingMode.Implied, rti, 6);
op(0xea, 'NOP', AddressingMode.Implied, nop, 2);

// --- Documented illegal opcodes -------------------------------------------
// LAX (read instruction)
op(0xa7, 'LAX', AddressingMode.ZeroPage, lax, 3, true);
op(0xb7, 'LAX', AddressingMode.ZeroPageY, lax, 4, true);
op(0xaf, 'LAX', AddressingMode.Absolute, lax, 4, true);
op(0xbf, 'LAX', AddressingMode.AbsoluteY, lax, 4, true);
op(0xa3, 'LAX', AddressingMode.IndirectX, lax, 6, true);
op(0xb3, 'LAX', AddressingMode.IndirectY, lax, 5, true);

// SAX (write instruction — single bus write)
op(0x87, 'SAX', AddressingMode.ZeroPage, sax, 3, true);
op(0x97, 'SAX', AddressingMode.ZeroPageY, sax, 4, true);
op(0x8f, 'SAX', AddressingMode.Absolute, sax, 4, true);
op(0x83, 'SAX', AddressingMode.IndirectX, sax, 6, true);

// DCP (read-modify-write — uses Write addressing variants)
op(0xc7, 'DCP', AddressingMode.ZeroPage, dcp, 5, true);
op(0xd7, 'DCP', AddressingMode.ZeroPageX, dcp, 6, true);
op(0xcf, 'DCP', AddressingMode.Absolute, dcp, 6, true);
op(0xdf, 'DCP', AddressingMode.AbsoluteXWrite, dcp, 7, true);
op(0xdb, 'DCP', AddressingMode.AbsoluteYWrite, dcp, 7, true);
op(0xc3, 'DCP', AddressingMode.IndirectX, dcp, 8, true);
op(0xd3, 'DCP', AddressingMode.IndirectYWrite, dcp, 8, true);

// ISC
op(0xe7, 'ISC', AddressingMode.ZeroPage, isc, 5, true);
op(0xf7, 'ISC', AddressingMode.ZeroPageX, isc, 6, true);
op(0xef, 'ISC', AddressingMode.Absolute, isc, 6, true);
op(0xff, 'ISC', AddressingMode.AbsoluteXWrite, isc, 7, true);
op(0xfb, 'ISC', AddressingMode.AbsoluteYWrite, isc, 7, true);
op(0xe3, 'ISC', AddressingMode.IndirectX, isc, 8, true);
op(0xf3, 'ISC', AddressingMode.IndirectYWrite, isc, 8, true);

// SLO
op(0x07, 'SLO', AddressingMode.ZeroPage, slo, 5, true);
op(0x17, 'SLO', AddressingMode.ZeroPageX, slo, 6, true);
op(0x0f, 'SLO', AddressingMode.Absolute, slo, 6, true);
op(0x1f, 'SLO', AddressingMode.AbsoluteXWrite, slo, 7, true);
op(0x1b, 'SLO', AddressingMode.AbsoluteYWrite, slo, 7, true);
op(0x03, 'SLO', AddressingMode.IndirectX, slo, 8, true);
op(0x13, 'SLO', AddressingMode.IndirectYWrite, slo, 8, true);

// RLA
op(0x27, 'RLA', AddressingMode.ZeroPage, rla, 5, true);
op(0x37, 'RLA', AddressingMode.ZeroPageX, rla, 6, true);
op(0x2f, 'RLA', AddressingMode.Absolute, rla, 6, true);
op(0x3f, 'RLA', AddressingMode.AbsoluteXWrite, rla, 7, true);
op(0x3b, 'RLA', AddressingMode.AbsoluteYWrite, rla, 7, true);
op(0x23, 'RLA', AddressingMode.IndirectX, rla, 8, true);
op(0x33, 'RLA', AddressingMode.IndirectYWrite, rla, 8, true);

// SRE
op(0x47, 'SRE', AddressingMode.ZeroPage, sre, 5, true);
op(0x57, 'SRE', AddressingMode.ZeroPageX, sre, 6, true);
op(0x4f, 'SRE', AddressingMode.Absolute, sre, 6, true);
op(0x5f, 'SRE', AddressingMode.AbsoluteXWrite, sre, 7, true);
op(0x5b, 'SRE', AddressingMode.AbsoluteYWrite, sre, 7, true);
op(0x43, 'SRE', AddressingMode.IndirectX, sre, 8, true);
op(0x53, 'SRE', AddressingMode.IndirectYWrite, sre, 8, true);

// RRA
op(0x67, 'RRA', AddressingMode.ZeroPage, rra, 5, true);
op(0x77, 'RRA', AddressingMode.ZeroPageX, rra, 6, true);
op(0x6f, 'RRA', AddressingMode.Absolute, rra, 6, true);
op(0x7f, 'RRA', AddressingMode.AbsoluteXWrite, rra, 7, true);
op(0x7b, 'RRA', AddressingMode.AbsoluteYWrite, rra, 7, true);
op(0x63, 'RRA', AddressingMode.IndirectX, rra, 8, true);
op(0x73, 'RRA', AddressingMode.IndirectYWrite, rra, 8, true);

// Single-byte illegal NOPs (mirror the 2-cycle official NOP).
for (const code of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) {
  op(code, 'NOP', AddressingMode.Implied, nop, 2, true);
}

// Two-byte illegal NOPs that consume an immediate operand.
for (const code of [0x80, 0x82, 0x89, 0xc2, 0xe2]) {
  op(code, 'NOP', AddressingMode.Immediate, nopRead, 2, true);
}

// Zero-page-style illegal NOPs (read and discard).
op(0x04, 'NOP', AddressingMode.ZeroPage, nopRead, 3, true);
op(0x44, 'NOP', AddressingMode.ZeroPage, nopRead, 3, true);
op(0x64, 'NOP', AddressingMode.ZeroPage, nopRead, 3, true);
for (const code of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) {
  op(code, 'NOP', AddressingMode.ZeroPageX, nopRead, 4, true);
}
op(0x0c, 'NOP', AddressingMode.Absolute, nopRead, 4, true);
for (const code of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) {
  op(code, 'NOP', AddressingMode.AbsoluteX, nopRead, 4, true);
}

// Immediate illegal arithmetic.
op(0x0b, 'ANC', AddressingMode.Immediate, anc, 2, true);
op(0x2b, 'ANC', AddressingMode.Immediate, anc, 2, true);
op(0x4b, 'ALR', AddressingMode.Immediate, alr, 2, true);
op(0x6b, 'ARR', AddressingMode.Immediate, arr, 2, true);
op(0xcb, 'AXS', AddressingMode.Immediate, axs, 2, true);

// SBC alias.
op(0xeb, 'SBC', AddressingMode.Immediate, sbc, 2, true);

// Fill any remaining slot with a 1-byte 2-cycle illegal NOP. Covers the
// KIL / JAM family ($02, $12, …) and the unstable SHA/SHX/SHY/TAS/LAS/
// XAA/ATX opcodes that we deliberately don't implement.
for (let i = 0; i < 256; i++) {
  if (!TABLE[i]) {
    op(i, 'KIL', AddressingMode.Implied, nop, 2, true);
  }
}

export const OPCODES: readonly OpcodeEntry[] = TABLE;
