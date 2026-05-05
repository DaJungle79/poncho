/**
 * Single-instruction disassembler used by the trace logger.
 *
 * Format approximates the standard nestest log:
 *
 *   C000  4C F5 C5  JMP $C5F5                       A:00 X:00 Y:00 P:24 SP:FD
 *
 * Notes on side effects: this routine reads through `cpu.read8`, which
 * routes through the regular CPU bus. Touching certain memory-mapped
 * registers (e.g. $2002, $2007) has hardware side effects. For runtime
 * tracing we accept that — the tracer is opt-in and only enabled when
 * debugging — but if/when we add a peek path on the bus we'll route disasm
 * through that instead.
 */
import { AddressingMode } from './addressing';
import type { Cpu } from './cpu';
import { OPCODES } from './opcodes';

const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

/** Format one instruction at `pc` without advancing the CPU. */
export function disasmAt(cpu: Cpu, pc: number): string {
  const opcode = cpu.read8(pc);
  const entry = OPCODES[opcode];
  const len = entry.bytes;

  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(cpu.read8((pc + i) & 0xffff));

  const bytesStr = bytes.map(hex2).join(' ').padEnd(8, ' ');
  const operand = formatOperand(entry.mode, bytes, pc);
  const flag = entry.illegal ? '*' : ' ';
  const instr = `${flag}${entry.mnemonic} ${operand}`.padEnd(32, ' ');

  return (
    `${hex4(pc)}  ${bytesStr}  ${instr}` +
    `A:${hex2(cpu.a)} X:${hex2(cpu.x)} Y:${hex2(cpu.y)} P:${hex2(cpu.p)} SP:${hex2(cpu.sp)}`
  );
}

function formatOperand(mode: AddressingMode, bytes: number[], pc: number): string {
  switch (mode) {
    case AddressingMode.Implied:
      return '';
    case AddressingMode.Accumulator:
      return 'A';
    case AddressingMode.Immediate:
      return `#$${hex2(bytes[1])}`;
    case AddressingMode.ZeroPage:
      return `$${hex2(bytes[1])}`;
    case AddressingMode.ZeroPageX:
      return `$${hex2(bytes[1])},X`;
    case AddressingMode.ZeroPageY:
      return `$${hex2(bytes[1])},Y`;
    case AddressingMode.Absolute:
      return `$${hex4(bytes[1] | (bytes[2] << 8))}`;
    case AddressingMode.AbsoluteX:
      return `$${hex4(bytes[1] | (bytes[2] << 8))},X`;
    case AddressingMode.AbsoluteY:
      return `$${hex4(bytes[1] | (bytes[2] << 8))},Y`;
    case AddressingMode.Indirect:
      return `($${hex4(bytes[1] | (bytes[2] << 8))})`;
    case AddressingMode.IndirectX:
      return `($${hex2(bytes[1])},X)`;
    case AddressingMode.IndirectY:
      return `($${hex2(bytes[1])}),Y`;
    case AddressingMode.Relative: {
      const offset = bytes[1] < 0x80 ? bytes[1] : bytes[1] - 0x100;
      const target = (pc + 2 + offset) & 0xffff;
      return `$${hex4(target)}`;
    }
    default:
      return '';
  }
}
