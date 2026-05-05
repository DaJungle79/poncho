/**
 * 6502 addressing modes — per-cycle accurate.
 *
 * Each resolver consumes the operand bytes from PC (advancing PC past them)
 * and *all* the bus operations and internal cycles required to compute the
 * effective memory address. Cycle counting is implicit: every read/dummyRead/
 * internalCycle ticks the surrounding system.
 *
 * Indexed modes have **two** variants because the bus-access pattern differs
 * between read instructions (which only do the "wrong page" dummy read on
 * an actual page cross) and write/read-modify-write instructions (which
 * always do the dummy read, whether or not a page cross occurred):
 *
 *   absoluteX        / absoluteXWrite
 *   absoluteY        / absoluteYWrite
 *   indirectY        / indirectYWrite
 *
 * The opcode table picks the right variant per instruction class. Returning
 * `pageCrossed` is no longer needed for cycle accounting (it's already
 * spent inside the addressing function), but we keep it on the result for
 * documentation/diagnostics — most instructions ignore it.
 *
 * Reference: nesdev wiki "Addressing modes" + "Cycle reference chart"
 *            (atarihq.com/danb/files/64doc.txt) for the per-cycle bus
 *            access patterns we replicate.
 */
import type { Cpu } from './cpu';

export const enum AddressingMode {
  Implied,
  Accumulator,
  Immediate,
  ZeroPage,
  ZeroPageX,
  ZeroPageY,
  Absolute,
  AbsoluteX,
  AbsoluteXWrite,
  AbsoluteY,
  AbsoluteYWrite,
  Indirect,
  IndirectX,
  IndirectY,
  IndirectYWrite,
  Relative,
}

export interface AddressResult {
  /** Effective memory address (0..0xFFFF), or 0 for Implied/Accumulator. */
  addr: number;
  /** Whether the indexed calculation crossed a 256-byte page boundary. */
  pageCrossed: boolean;
}

export type AddressingFn = (cpu: Cpu) => AddressResult;

/** Read one byte at PC and advance PC. Ticks the bus. */
function fetchByte(cpu: Cpu): number {
  const v = cpu.read8(cpu.pc);
  cpu.pc = (cpu.pc + 1) & 0xffff;
  return v;
}

/** Read the next two bytes at PC as a little-endian word. Ticks twice. */
function fetchWord(cpu: Cpu): number {
  const lo = fetchByte(cpu);
  const hi = fetchByte(cpu);
  return (hi << 8) | lo;
}

/**
 * Implied — most "no-operand" instructions (NOP, INX, CLC, etc.). The
 * 6502 always burns 2 cycles minimum on these: cycle 1 is the opcode
 * fetch (in step()), cycle 2 is a dummy read of the byte at PC.
 */
export const implied: AddressingFn = (cpu) => {
  cpu.internalCycle();
  return { addr: 0, pageCrossed: false };
};

/**
 * Accumulator — same 2-cycle cost as Implied. The "operand" is A; the
 * instruction handles A directly.
 */
export const accumulator: AddressingFn = (cpu) => {
  cpu.internalCycle();
  return { addr: 0, pageCrossed: false };
};

/**
 * Immediate — operand is the byte after the opcode. We return its address
 * so the instruction reads it through the bus (one cycle) like every
 * other addressing mode.
 */
export const immediate: AddressingFn = (cpu) => {
  const addr = cpu.pc;
  cpu.pc = (cpu.pc + 1) & 0xffff;
  return { addr, pageCrossed: false };
};

/** Zero Page — one-byte operand giving an address in $0000-$00FF. */
export const zeroPage: AddressingFn = (cpu) => ({
  addr: fetchByte(cpu),
  pageCrossed: false,
});

/**
 * Zero Page,X — `(zp + X) & 0xFF`. The 6502 spends a cycle adding X to
 * the operand, modelled as a dummy read at the un-indexed zp address.
 */
export const zeroPageX: AddressingFn = (cpu) => {
  const zp = fetchByte(cpu);
  cpu.dummyRead(zp);
  return { addr: (zp + cpu.x) & 0xff, pageCrossed: false };
};

/** Zero Page,Y — same shape as ZeroPage,X but indexes by Y. */
export const zeroPageY: AddressingFn = (cpu) => {
  const zp = fetchByte(cpu);
  cpu.dummyRead(zp);
  return { addr: (zp + cpu.y) & 0xff, pageCrossed: false };
};

/** Absolute — full 16-bit address (3-byte instruction, 2 operand reads). */
export const absolute: AddressingFn = (cpu) => ({
  addr: fetchWord(cpu),
  pageCrossed: false,
});

// ----- Helpers for indexed addressing -------------------------------------

/** Compute (base + index) and the "early" address with low byte indexed but high byte un-corrected. */
function indexedTarget(base: number, index: number): { addr: number; earlyAddr: number; pageCrossed: boolean } {
  const addr = (base + index) & 0xffff;
  const earlyAddr = (base & 0xff00) | (addr & 0xff);
  return { addr, earlyAddr, pageCrossed: addr !== earlyAddr };
}

/**
 * Absolute,X — read variant. On page cross, the chip first reads from the
 * un-corrected address (dummy read at the wrong page), then re-reads from
 * the correct address. We do the dummy here; the instruction does the
 * real read of `addr`.
 */
export const absoluteX: AddressingFn = (cpu) => {
  const base = fetchWord(cpu);
  const { addr, earlyAddr, pageCrossed } = indexedTarget(base, cpu.x);
  if (pageCrossed) cpu.dummyRead(earlyAddr);
  return { addr, pageCrossed };
};

/**
 * Absolute,X — write/read-modify-write variant. The chip *always* does
 * the un-corrected dummy read, regardless of whether the page actually
 * crossed (it can't know in advance, so it always pays the cost).
 */
export const absoluteXWrite: AddressingFn = (cpu) => {
  const base = fetchWord(cpu);
  const { addr, earlyAddr, pageCrossed } = indexedTarget(base, cpu.x);
  cpu.dummyRead(earlyAddr);
  return { addr, pageCrossed };
};

/** Absolute,Y — read variant (mirrors absoluteX). */
export const absoluteY: AddressingFn = (cpu) => {
  const base = fetchWord(cpu);
  const { addr, earlyAddr, pageCrossed } = indexedTarget(base, cpu.y);
  if (pageCrossed) cpu.dummyRead(earlyAddr);
  return { addr, pageCrossed };
};

/** Absolute,Y — write / read-modify-write variant. */
export const absoluteYWrite: AddressingFn = (cpu) => {
  const base = fetchWord(cpu);
  const { addr, earlyAddr, pageCrossed } = indexedTarget(base, cpu.y);
  cpu.dummyRead(earlyAddr);
  return { addr, pageCrossed };
};

/**
 * Indirect — used only by JMP. Reads a 16-bit pointer at the supplied
 * address, then jumps there. Reproduces the 6502 indirect-JMP bug:
 * if the pointer's low byte is $FF the high byte is fetched from the
 * SAME page (i.e. wraps within $XX00-$XXFF instead of carrying).
 */
export const indirect: AddressingFn = (cpu) => {
  const ptr = fetchWord(cpu);
  const lo = cpu.read8(ptr);
  const hi = cpu.read8((ptr & 0xff00) | ((ptr + 1) & 0xff));
  return { addr: (hi << 8) | lo, pageCrossed: false };
};

/**
 * (Indirect,X) — pre-indexed indirect. zp = (operand + X) & 0xFF, then
 * read 16-bit pointer at $0000+zp (wrapping in zero page).
 *
 *   1  PC          R  opcode (in step())
 *   2  PC          R  fetch operand zp
 *   3  zp          R  dummy read while X is added
 *   4  (zp+X)&FF   R  read low byte of pointer
 *   5  (zp+X+1)&FF R  read high byte of pointer
 *   6  addr        R  (instruction's actual access)
 */
export const indirectX: AddressingFn = (cpu) => {
  const operand = fetchByte(cpu);
  cpu.dummyRead(operand);
  const ptr = (operand + cpu.x) & 0xff;
  const lo = cpu.read8(ptr);
  const hi = cpu.read8((ptr + 1) & 0xff);
  return { addr: (hi << 8) | lo, pageCrossed: false };
};

/**
 * (Indirect),Y — read variant. Read pointer at zp (wraps in zero page),
 * then add Y. On page cross, do a dummy read at the un-corrected address.
 */
export const indirectY: AddressingFn = (cpu) => {
  const zp = fetchByte(cpu);
  const lo = cpu.read8(zp);
  const hi = cpu.read8((zp + 1) & 0xff);
  const base = (hi << 8) | lo;
  const { addr, earlyAddr, pageCrossed } = indexedTarget(base, cpu.y);
  if (pageCrossed) cpu.dummyRead(earlyAddr);
  return { addr, pageCrossed };
};

/** (Indirect),Y — write / read-modify-write variant; always dummies. */
export const indirectYWrite: AddressingFn = (cpu) => {
  const zp = fetchByte(cpu);
  const lo = cpu.read8(zp);
  const hi = cpu.read8((zp + 1) & 0xff);
  const base = (hi << 8) | lo;
  const { addr, earlyAddr, pageCrossed } = indexedTarget(base, cpu.y);
  cpu.dummyRead(earlyAddr);
  return { addr, pageCrossed };
};

/**
 * Relative — branch instructions only. Operand is a signed 8-bit offset;
 * the resolved address is PC-after-operand + offset. Cycle-cost extras
 * (taken/cross) are handled by the branch instruction itself, not here.
 */
export const relative: AddressingFn = (cpu) => {
  const offset = fetchByte(cpu);
  const signed = offset < 0x80 ? offset : offset - 0x100;
  const addr = (cpu.pc + signed) & 0xffff;
  return { addr, pageCrossed: false };
};

/** Map enum -> resolver. Used by the disassembler and tests. */
export const ADDRESSING_FNS: Record<AddressingMode, AddressingFn> = {
  [AddressingMode.Implied]: implied,
  [AddressingMode.Accumulator]: accumulator,
  [AddressingMode.Immediate]: immediate,
  [AddressingMode.ZeroPage]: zeroPage,
  [AddressingMode.ZeroPageX]: zeroPageX,
  [AddressingMode.ZeroPageY]: zeroPageY,
  [AddressingMode.Absolute]: absolute,
  [AddressingMode.AbsoluteX]: absoluteX,
  [AddressingMode.AbsoluteXWrite]: absoluteXWrite,
  [AddressingMode.AbsoluteY]: absoluteY,
  [AddressingMode.AbsoluteYWrite]: absoluteYWrite,
  [AddressingMode.Indirect]: indirect,
  [AddressingMode.IndirectX]: indirectX,
  [AddressingMode.IndirectY]: indirectY,
  [AddressingMode.IndirectYWrite]: indirectYWrite,
  [AddressingMode.Relative]: relative,
};

/** Bytes consumed (opcode + operands). Read- and write-variants of the
 *  same canonical addressing mode share the byte count. */
export const MODE_BYTES: Record<AddressingMode, number> = {
  [AddressingMode.Implied]: 1,
  [AddressingMode.Accumulator]: 1,
  [AddressingMode.Immediate]: 2,
  [AddressingMode.ZeroPage]: 2,
  [AddressingMode.ZeroPageX]: 2,
  [AddressingMode.ZeroPageY]: 2,
  [AddressingMode.Absolute]: 3,
  [AddressingMode.AbsoluteX]: 3,
  [AddressingMode.AbsoluteXWrite]: 3,
  [AddressingMode.AbsoluteY]: 3,
  [AddressingMode.AbsoluteYWrite]: 3,
  [AddressingMode.Indirect]: 3,
  [AddressingMode.IndirectX]: 2,
  [AddressingMode.IndirectY]: 2,
  [AddressingMode.IndirectYWrite]: 2,
  [AddressingMode.Relative]: 2,
};
