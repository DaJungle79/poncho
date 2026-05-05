/**
 * 6502 instruction implementations.
 *
 * Each instruction is a plain function that takes the CPU and a resolved
 * address (as produced by an addressing-mode resolver). Implied/Accumulator
 * instructions ignore the address argument.
 *
 * All flag manipulations follow the standard NMOS 6502 / 2A03 behavior. The
 * 2A03 has no decimal mode, so ADC/SBC ignore the D flag.
 *
 * Cycle costs and page-cross penalties are decided by the opcode table; this
 * file only sets `cpu.extraCycles` for the variable cost of *taken* branches.
 *
 * References:
 *   - http://www.obelisk.me.uk/6502/instructions.html
 *   - https://www.nesdev.org/wiki/CPU_unofficial_opcodes
 */
import type { Cpu } from './cpu';
import { Flag } from './flags';

export type InstructionFn = (cpu: Cpu, addr: number) => void;

// ============================================================================
// Loads
// ============================================================================

/** LDA — A = M. Sets N from bit 7 of A, Z when A is zero. */
export const lda: InstructionFn = (cpu, addr) => {
  cpu.a = cpu.read8(addr);
  cpu.setZN(cpu.a);
};

/** LDX — X = M. Sets N, Z. */
export const ldx: InstructionFn = (cpu, addr) => {
  cpu.x = cpu.read8(addr);
  cpu.setZN(cpu.x);
};

/** LDY — Y = M. Sets N, Z. */
export const ldy: InstructionFn = (cpu, addr) => {
  cpu.y = cpu.read8(addr);
  cpu.setZN(cpu.y);
};

// ============================================================================
// Stores (no flags affected)
// ============================================================================

/** STA — M = A. Flags unchanged. */
export const sta: InstructionFn = (cpu, addr) => {
  cpu.write8(addr, cpu.a);
};

/** STX — M = X. Flags unchanged. */
export const stx: InstructionFn = (cpu, addr) => {
  cpu.write8(addr, cpu.x);
};

/** STY — M = Y. Flags unchanged. */
export const sty: InstructionFn = (cpu, addr) => {
  cpu.write8(addr, cpu.y);
};

// ============================================================================
// Register transfers
// ============================================================================

/** TAX — X = A. Sets N, Z. */
export const tax: InstructionFn = (cpu) => {
  cpu.x = cpu.a;
  cpu.setZN(cpu.x);
};

/** TAY — Y = A. Sets N, Z. */
export const tay: InstructionFn = (cpu) => {
  cpu.y = cpu.a;
  cpu.setZN(cpu.y);
};

/** TXA — A = X. Sets N, Z. */
export const txa: InstructionFn = (cpu) => {
  cpu.a = cpu.x;
  cpu.setZN(cpu.a);
};

/** TYA — A = Y. Sets N, Z. */
export const tya: InstructionFn = (cpu) => {
  cpu.a = cpu.y;
  cpu.setZN(cpu.a);
};

/** TSX — X = SP. Sets N, Z (yes, even though SP is "system" state). */
export const tsx: InstructionFn = (cpu) => {
  cpu.x = cpu.sp;
  cpu.setZN(cpu.x);
};

/**
 * TXS — SP = X. Notably does NOT touch N or Z. The 6502 designers omitted
 * flag updates here because TXS is normally used during program init to
 * reset the stack and you don't want unrelated flag side effects.
 */
export const txs: InstructionFn = (cpu) => {
  cpu.sp = cpu.x;
};

// ============================================================================
// Stack
// ============================================================================

/** PHA — push A. SP-- after write. */
export const pha: InstructionFn = (cpu) => {
  cpu.push8(cpu.a);
};

/**
 * PHP — push P. The pushed byte has B=1 and U=1 set explicitly: software-
 * initiated pushes always look like a BRK to anyone reading the stack frame.
 */
export const php: InstructionFn = (cpu) => {
  cpu.push8(cpu.p | Flag.B | Flag.U);
};

/**
 * PLA — pull A. Sets N, Z from the pulled value.
 *
 * Bus pattern (4 cycles):
 *   C1 opcode (in step()), C2 implied dummy PC read (in addressing),
 *   C3 dummy stack read (the chip "warms up" the stack pointer here),
 *   C4 real read at $0100|(sp+1).
 */
export const pla: InstructionFn = (cpu) => {
  cpu.dummyRead(0x0100 | cpu.sp);
  cpu.a = cpu.pull8();
  cpu.setZN(cpu.a);
};

/**
 * PLP — pull P. The pulled value is masked: B is forced to 0 (B is not a
 * real bit) and U is forced to 1 (always reads high). All other bits are
 * taken verbatim, including I — so PLP can re-enable IRQs.
 *
 * Same 4-cycle pattern as PLA.
 */
export const plp: InstructionFn = (cpu) => {
  cpu.dummyRead(0x0100 | cpu.sp);
  cpu.p = (cpu.pull8() & ~Flag.B) | Flag.U;
};

// ============================================================================
// Logical
// ============================================================================

/** AND — A = A & M. Sets N, Z. */
export const and_: InstructionFn = (cpu, addr) => {
  cpu.a = cpu.a & cpu.read8(addr);
  cpu.setZN(cpu.a);
};

/** EOR — A = A ^ M. Sets N, Z. */
export const eor: InstructionFn = (cpu, addr) => {
  cpu.a = cpu.a ^ cpu.read8(addr);
  cpu.setZN(cpu.a);
};

/** ORA — A = A | M. Sets N, Z. */
export const ora: InstructionFn = (cpu, addr) => {
  cpu.a = cpu.a | cpu.read8(addr);
  cpu.setZN(cpu.a);
};

/**
 * BIT — flags-only test. Z is set from `(A & M) == 0`, while N and V copy
 * bits 7 and 6 of M directly (NOT of the AND result). Game code commonly
 * uses BIT for tight bit checks without trashing A.
 */
export const bit: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.setFlag(Flag.Z, (cpu.a & m) === 0);
  cpu.setFlag(Flag.N, (m & 0x80) !== 0);
  cpu.setFlag(Flag.V, (m & 0x40) !== 0);
};

// ============================================================================
// Arithmetic
// ============================================================================

/**
 * ADC — A = A + M + C.
 * Flags:
 *   C: set if the unsigned sum exceeds 0xFF.
 *   V: set when the signed sum overflows — the classic test is
 *      `((A ^ result) & (M ^ result) & 0x80) != 0` (operand signs match
 *      and result sign differs).
 *   N, Z: from the low 8 bits of the result.
 *
 * Decimal mode is disabled on the 2A03; we never enter BCD even if D is set.
 */
export const adc: InstructionFn = (cpu, addr) => {
  const a = cpu.a;
  const m = cpu.read8(addr);
  const c = cpu.getFlag(Flag.C) ? 1 : 0;
  const sum = a + m + c;
  const result = sum & 0xff;
  cpu.setFlag(Flag.C, sum > 0xff);
  cpu.setFlag(Flag.V, ((a ^ result) & (m ^ result) & 0x80) !== 0);
  cpu.a = result;
  cpu.setZN(cpu.a);
};

/**
 * SBC — A = A - M - (1-C).
 * Implementation detail: SBC is exactly `ADC` of `~M` with the same flag
 * logic. Flags identical to ADC.
 */
export const sbc: InstructionFn = (cpu, addr) => {
  const a = cpu.a;
  const m = cpu.read8(addr) ^ 0xff;
  const c = cpu.getFlag(Flag.C) ? 1 : 0;
  const sum = a + m + c;
  const result = sum & 0xff;
  cpu.setFlag(Flag.C, sum > 0xff);
  cpu.setFlag(Flag.V, ((a ^ result) & (m ^ result) & 0x80) !== 0);
  cpu.a = result;
  cpu.setZN(cpu.a);
};

/** Helper: register-vs-memory compare. C set when reg >= m, plus N, Z from reg-m. */
function compareReg(cpu: Cpu, reg: number, m: number): void {
  const r = (reg - m) & 0xff;
  cpu.setFlag(Flag.C, reg >= m);
  cpu.setZN(r);
}

/** CMP — flags from A - M. */
export const cmp: InstructionFn = (cpu, addr) => compareReg(cpu, cpu.a, cpu.read8(addr));

/** CPX — flags from X - M. */
export const cpx: InstructionFn = (cpu, addr) => compareReg(cpu, cpu.x, cpu.read8(addr));

/** CPY — flags from Y - M. */
export const cpy: InstructionFn = (cpu, addr) => compareReg(cpu, cpu.y, cpu.read8(addr));

// ============================================================================
// Increments and decrements
// ============================================================================

/**
 * INC — M = M + 1. Sets N, Z. C is unchanged.
 *
 * Bus pattern (read-modify-write): read M, write M (old value, the dummy),
 * write M (new value). The dummy write is observable on memory-mapped
 * registers — software can rely on it firing twice.
 */
export const inc: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  const v = (m + 1) & 0xff;
  cpu.write8(addr, v);
  cpu.setZN(v);
};

/** DEC — M = M - 1. Same RMW bus pattern as INC. Sets N, Z. */
export const dec: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  const v = (m - 1) & 0xff;
  cpu.write8(addr, v);
  cpu.setZN(v);
};

/** INX — X++. Sets N, Z. */
export const inx: InstructionFn = (cpu) => {
  cpu.x = (cpu.x + 1) & 0xff;
  cpu.setZN(cpu.x);
};

/** INY — Y++. Sets N, Z. */
export const iny: InstructionFn = (cpu) => {
  cpu.y = (cpu.y + 1) & 0xff;
  cpu.setZN(cpu.y);
};

/** DEX — X--. Sets N, Z. */
export const dex: InstructionFn = (cpu) => {
  cpu.x = (cpu.x - 1) & 0xff;
  cpu.setZN(cpu.x);
};

/** DEY — Y--. Sets N, Z. */
export const dey: InstructionFn = (cpu) => {
  cpu.y = (cpu.y - 1) & 0xff;
  cpu.setZN(cpu.y);
};

// ============================================================================
// Shifts and rotates
//
// Each comes in two variants: an Accumulator-mode entry (suffix Acc) and a
// memory entry. Carry receives the bit shifted out; rotates feed the old
// carry into the bit shifted in.
// ============================================================================

/**
 * ASL (memory) — M = M << 1. C = old bit 7. Sets N, Z.
 * Read-modify-write: read M, dummy write M back, write new value.
 */
export const aslMem: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  cpu.setFlag(Flag.C, (m & 0x80) !== 0);
  const r = (m << 1) & 0xff;
  cpu.write8(addr, r);
  cpu.setZN(r);
};

/** ASL A — A = A << 1. C = old bit 7. Sets N, Z. */
export const aslAcc: InstructionFn = (cpu) => {
  cpu.setFlag(Flag.C, (cpu.a & 0x80) !== 0);
  cpu.a = (cpu.a << 1) & 0xff;
  cpu.setZN(cpu.a);
};

/** LSR (memory) — M = M >> 1. C = old bit 0. N is always 0. RMW pattern. */
export const lsrMem: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  cpu.setFlag(Flag.C, (m & 0x01) !== 0);
  const r = m >>> 1;
  cpu.write8(addr, r);
  cpu.setZN(r);
};

/** LSR A — A = A >> 1. C = old bit 0. N=0. */
export const lsrAcc: InstructionFn = (cpu) => {
  cpu.setFlag(Flag.C, (cpu.a & 0x01) !== 0);
  cpu.a = cpu.a >>> 1;
  cpu.setZN(cpu.a);
};

/** ROL (memory) — rotate left through carry. RMW pattern. */
export const rolMem: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  const carry = cpu.getFlag(Flag.C) ? 1 : 0;
  cpu.setFlag(Flag.C, (m & 0x80) !== 0);
  const r = ((m << 1) | carry) & 0xff;
  cpu.write8(addr, r);
  cpu.setZN(r);
};

/** ROL A — same as rolMem but operates on A. */
export const rolAcc: InstructionFn = (cpu) => {
  const carry = cpu.getFlag(Flag.C) ? 1 : 0;
  cpu.setFlag(Flag.C, (cpu.a & 0x80) !== 0);
  cpu.a = ((cpu.a << 1) | carry) & 0xff;
  cpu.setZN(cpu.a);
};

/** ROR (memory) — rotate right through carry. RMW pattern. */
export const rorMem: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  const carry = cpu.getFlag(Flag.C) ? 0x80 : 0;
  cpu.setFlag(Flag.C, (m & 0x01) !== 0);
  const r = (m >>> 1) | carry;
  cpu.write8(addr, r);
  cpu.setZN(r);
};

/** ROR A — same as rorMem but operates on A. */
export const rorAcc: InstructionFn = (cpu) => {
  const carry = cpu.getFlag(Flag.C) ? 0x80 : 0;
  cpu.setFlag(Flag.C, (cpu.a & 0x01) !== 0);
  cpu.a = (cpu.a >>> 1) | carry;
  cpu.setZN(cpu.a);
};

// ============================================================================
// Jumps and calls
// ============================================================================

/** JMP — PC = addr. */
export const jmp: InstructionFn = (cpu, addr) => {
  cpu.pc = addr;
};

/**
 * JSR — push (PC-1) hi, lo; then PC = addr.
 *
 * Canonical 6502 bus pattern (6 cycles total):
 *   1  PC      R  fetch opcode
 *   2  PC      R  fetch low byte of target
 *   3  $0100,S R  internal "predecrement"
 *   4  $0100,S W  push PCH
 *   5  $0100,S W  push PCL
 *   6  PC      R  fetch high byte of target
 *
 * We use the regular Absolute addressing mode (which fetches both bytes
 * back-to-back at C2-3) and add an internalCycle here to bring the count
 * to 6. The bus *order* differs from real silicon — most blargg suites
 * don't observe the order, only the count, but this is a known shortcut.
 *
 * The "-1" on the pushed PC is intentional: RTS pulls and adds 1, landing
 * on the byte after the JSR's last operand byte.
 */
export const jsr: InstructionFn = (cpu, addr) => {
  cpu.internalCycle();
  cpu.push16((cpu.pc - 1) & 0xffff);
  cpu.pc = addr;
};

/**
 * RTS — pull PC, then increment.
 *
 * Bus pattern (6 cycles):
 *   1 opcode (in step()), 2 implied dummy PC read,
 *   3 dummy stack read,
 *   4 pull PCL, 5 pull PCH,
 *   6 dummy PC read (the "tick PC" cycle that increments).
 */
export const rts: InstructionFn = (cpu) => {
  cpu.dummyRead(0x0100 | cpu.sp);
  cpu.pc = cpu.pull16();
  cpu.dummyRead(cpu.pc);
  cpu.pc = (cpu.pc + 1) & 0xffff;
};

// ============================================================================
// Branches
//
// All branches share the same shape: 2 cycles base; +1 if taken; +1 more if
// taken AND the new PC is on a different page. We push these surcharges onto
// `cpu.extraCycles`; the dispatcher in cpu.ts adds them to the base cycles.
// ============================================================================

/**
 * Branch instructions share the same shape: 2 cycles base, +1 if taken,
 * +1 more if the new PC is on a different page. The "if taken" cycle is a
 * dummy read of the next-instruction PC (chip's pipeline staging); the
 * page-cross cycle is another dummy read at the not-yet-fixed PC.
 *
 *   1  PC  R  fetch opcode, ++PC
 *   2  PC  R  fetch operand (signed offset), ++PC
 *   3  PC  R  (if taken) dummy read of next opcode
 *   4  *   R  (if taken AND page crossed) dummy read at "wrong page"
 *
 * Cycles 1-2 are already consumed by step() and the relative addressing
 * mode; cycles 3 and 4 are added here when applicable.
 */
function takeBranch(cpu: Cpu, addr: number, condition: boolean): void {
  if (!condition) return;
  const oldPc = cpu.pc;
  cpu.dummyRead(oldPc); // C3: dummy read at next-opcode PC
  if ((oldPc & 0xff00) !== (addr & 0xff00)) {
    // C4: dummy read at the address with the low byte fixed but the high
    // byte still uncorrected (the "wrong page").
    const wrongAddr = (oldPc & 0xff00) | (addr & 0xff);
    cpu.dummyRead(wrongAddr);
  }
  cpu.pc = addr;
}

/** BCC — branch if Carry clear. */
export const bcc: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, !cpu.getFlag(Flag.C));
/** BCS — branch if Carry set. */
export const bcs: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, cpu.getFlag(Flag.C));
/** BEQ — branch if Zero set ("equal"). */
export const beq: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, cpu.getFlag(Flag.Z));
/** BNE — branch if Zero clear ("not equal"). */
export const bne: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, !cpu.getFlag(Flag.Z));
/** BMI — branch if Negative set ("minus"). */
export const bmi: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, cpu.getFlag(Flag.N));
/** BPL — branch if Negative clear ("plus"). */
export const bpl: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, !cpu.getFlag(Flag.N));
/** BVC — branch if Overflow clear. */
export const bvc: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, !cpu.getFlag(Flag.V));
/** BVS — branch if Overflow set. */
export const bvs: InstructionFn = (cpu, addr) => takeBranch(cpu, addr, cpu.getFlag(Flag.V));

// ============================================================================
// Status flag changes
// ============================================================================

/** CLC — Carry := 0. */
export const clc: InstructionFn = (cpu) => cpu.setFlag(Flag.C, false);
/** SEC — Carry := 1. */
export const sec: InstructionFn = (cpu) => cpu.setFlag(Flag.C, true);
/** CLI — IRQ disable := 0 (re-enable IRQs). */
export const cli: InstructionFn = (cpu) => cpu.setFlag(Flag.I, false);
/** SEI — IRQ disable := 1 (mask IRQs). */
export const sei: InstructionFn = (cpu) => cpu.setFlag(Flag.I, true);
/** CLV — Overflow := 0. (No SEV exists; V is set by ADC/SBC/BIT.) */
export const clv: InstructionFn = (cpu) => cpu.setFlag(Flag.V, false);
/** CLD — Decimal := 0. Inert on 2A03 but still flips the bit. */
export const cld: InstructionFn = (cpu) => cpu.setFlag(Flag.D, false);
/** SED — Decimal := 1. Inert on 2A03 but still flips the bit. */
export const sed: InstructionFn = (cpu) => cpu.setFlag(Flag.D, true);

// ============================================================================
// System
// ============================================================================

/**
 * BRK — software interrupt. 7 cycles total:
 *   1 opcode (in step()), 2 implied dummy read of "signature" byte at PC,
 *   3 push PCH, 4 push PCL, 5 push P (with B set),
 *   6 read $FFFE, 7 read $FFFF.
 *
 * The implied addressing already burns C2 and incidentally reads the byte
 * at PC, but BRK *also* skips that byte. We advance PC explicitly here so
 * the saved PC points to the byte AFTER the signature (matching what real
 * silicon pushes).
 */
export const brk: InstructionFn = (cpu) => {
  cpu.pc = (cpu.pc + 1) & 0xffff;
  cpu.push8((cpu.pc >>> 8) & 0xff);
  cpu.push8(cpu.pc & 0xff);
  cpu.push8(cpu.p | Flag.B | Flag.U);
  cpu.setFlag(Flag.I, true);
  const lo = cpu.read8(0xfffe);
  const hi = cpu.read8(0xffff);
  cpu.pc = (hi << 8) | lo;
};

/**
 * RTI — return from interrupt. 6 cycles:
 *   1 opcode, 2 implied dummy PC read, 3 dummy stack read,
 *   4 pull P (B masked, U forced), 5 pull PCL, 6 pull PCH.
 *
 * Unlike RTS, the pulled PC is used verbatim (no +1).
 */
export const rti: InstructionFn = (cpu) => {
  cpu.dummyRead(0x0100 | cpu.sp);
  cpu.p = (cpu.pull8() & ~Flag.B) | Flag.U;
  cpu.pc = cpu.pull16();
};

/** NOP — no operation. The official $EA NOP, plus several illegal NOPs. */
export const nop: InstructionFn = () => {};

/**
 * "Illegal NOP with operand" — opcodes that read a memory operand and
 * discard it. The dummy read can have hardware side effects (e.g. on the
 * APU status register), so we *do* perform the read.
 */
export const nopRead: InstructionFn = (cpu, addr) => {
  cpu.read8(addr);
};

// ============================================================================
// Illegal opcodes (the ones used in the wild and in nestest)
//
// Many illegals are documented combinations of two legal operations. We
// implement the common, "stable" ones; rarer unstable opcodes are mapped to
// NOP in the opcode table.
// ============================================================================

/** LAX — A = X = M. Sets N, Z. */
export const lax: InstructionFn = (cpu, addr) => {
  const v = cpu.read8(addr);
  cpu.a = v;
  cpu.x = v;
  cpu.setZN(v);
};

/** SAX — M = A & X. No flag changes. */
export const sax: InstructionFn = (cpu, addr) => {
  cpu.write8(addr, cpu.a & cpu.x);
};

// All six illegal RMW instructions follow the same bus pattern:
//   read M, dummy write M (old), real write of new M.

/** DCP — DEC M, then CMP A. RMW. Sets N, Z, C as if CMP. */
export const dcp: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  const v = (m - 1) & 0xff;
  cpu.write8(addr, v);
  compareReg(cpu, cpu.a, v);
};

/** ISC (a.k.a. ISB) — INC M, then SBC A. RMW. */
export const isc: InstructionFn = (cpu, addr) => {
  const orig = cpu.read8(addr);
  cpu.dummyWrite(addr, orig);
  const v = (orig + 1) & 0xff;
  cpu.write8(addr, v);
  const a = cpu.a;
  const m = v ^ 0xff;
  const c = cpu.getFlag(Flag.C) ? 1 : 0;
  const sum = a + m + c;
  const result = sum & 0xff;
  cpu.setFlag(Flag.C, sum > 0xff);
  cpu.setFlag(Flag.V, ((a ^ result) & (m ^ result) & 0x80) !== 0);
  cpu.a = result;
  cpu.setZN(cpu.a);
};

/** SLO — ASL M, then ORA A. RMW. */
export const slo: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  cpu.setFlag(Flag.C, (m & 0x80) !== 0);
  const v = (m << 1) & 0xff;
  cpu.write8(addr, v);
  cpu.a = cpu.a | v;
  cpu.setZN(cpu.a);
};

/** RLA — ROL M, then AND A. RMW. */
export const rla: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  const carryIn = cpu.getFlag(Flag.C) ? 1 : 0;
  cpu.setFlag(Flag.C, (m & 0x80) !== 0);
  const v = ((m << 1) | carryIn) & 0xff;
  cpu.write8(addr, v);
  cpu.a = cpu.a & v;
  cpu.setZN(cpu.a);
};

/** SRE — LSR M, then EOR A. RMW. */
export const sre: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  cpu.setFlag(Flag.C, (m & 0x01) !== 0);
  const v = m >>> 1;
  cpu.write8(addr, v);
  cpu.a = cpu.a ^ v;
  cpu.setZN(cpu.a);
};

/** RRA — ROR M, then ADC A. RMW. */
export const rra: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  cpu.dummyWrite(addr, m);
  const carryIn = cpu.getFlag(Flag.C) ? 0x80 : 0;
  const carryOut = (m & 0x01) !== 0;
  const v = (m >>> 1) | carryIn;
  cpu.write8(addr, v);
  cpu.setFlag(Flag.C, carryOut);
  const a = cpu.a;
  const c = cpu.getFlag(Flag.C) ? 1 : 0;
  const sum = a + v + c;
  const result = sum & 0xff;
  cpu.setFlag(Flag.C, sum > 0xff);
  cpu.setFlag(Flag.V, ((a ^ result) & (v ^ result) & 0x80) !== 0);
  cpu.a = result;
  cpu.setZN(cpu.a);
};

/** ANC — A = A & M, then C := bit 7 of A (i.e. C copies N). */
export const anc: InstructionFn = (cpu, addr) => {
  cpu.a = cpu.a & cpu.read8(addr);
  cpu.setZN(cpu.a);
  cpu.setFlag(Flag.C, (cpu.a & 0x80) !== 0);
};

/** ALR (a.k.a. ASR) — A = (A & M) >> 1. C = old bit 0 of (A & M). */
export const alr: InstructionFn = (cpu, addr) => {
  const v = cpu.a & cpu.read8(addr);
  cpu.setFlag(Flag.C, (v & 0x01) !== 0);
  cpu.a = v >>> 1;
  cpu.setZN(cpu.a);
};

/**
 * ARR — A = (A & M); ROR A. Flag handling differs from ROR:
 *   C = bit 6 of result, V = bit 6 XOR bit 5 of result.
 */
export const arr: InstructionFn = (cpu, addr) => {
  const v = cpu.a & cpu.read8(addr);
  const carryIn = cpu.getFlag(Flag.C) ? 0x80 : 0;
  const r = (v >>> 1) | carryIn;
  cpu.a = r;
  cpu.setZN(r);
  cpu.setFlag(Flag.C, (r & 0x40) !== 0);
  cpu.setFlag(Flag.V, (((r >>> 6) ^ (r >>> 5)) & 0x01) !== 0);
};

/** AXS (a.k.a. SBX) — X = (A & X) - M. C set on no borrow. Sets N, Z. */
export const axs: InstructionFn = (cpu, addr) => {
  const m = cpu.read8(addr);
  const t = (cpu.a & cpu.x) - m;
  cpu.setFlag(Flag.C, t >= 0);
  cpu.x = t & 0xff;
  cpu.setZN(cpu.x);
};
