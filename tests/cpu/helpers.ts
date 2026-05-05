import { Cpu, type MemoryBus } from '../../src/core/cpu/cpu';

export interface CpuHarness {
  cpu: Cpu;
  mem: Uint8Array;
  bus: MemoryBus;
  /** Run until the CPU has consumed at least `cycles` cycles. */
  runForCycles(cycles: number): void;
  /** Step exactly `instructions` times. */
  steps(instructions: number): void;
}

export interface HarnessOpts {
  /** Reset vector target. Defaults to $8000. */
  pcStart?: number;
  /** P value to load *after* reset (overrides the default RESET_P). */
  initialP?: number;
  /** Bytes to lay down at `pcStart`. */
  program?: number[];
}

/**
 * Build a CPU bound to a flat 64KB RAM-only bus, with a reset vector pointing
 * at `pcStart` and (optionally) program bytes laid at that address.
 */
export function makeCpu(opts: HarnessOpts = {}): CpuHarness {
  const pcStart = opts.pcStart ?? 0x8000;
  const mem = new Uint8Array(0x10000);

  mem[0xfffc] = pcStart & 0xff;
  mem[0xfffd] = (pcStart >>> 8) & 0xff;

  if (opts.program) {
    for (let i = 0; i < opts.program.length; i++) {
      mem[(pcStart + i) & 0xffff] = opts.program[i] & 0xff;
    }
  }

  const bus: MemoryBus = {
    read: (addr) => mem[addr & 0xffff],
    write: (addr, value) => {
      mem[addr & 0xffff] = value & 0xff;
    },
  };

  const cpu = new Cpu(bus);
  cpu.reset();
  if (opts.initialP !== undefined) cpu.p = opts.initialP & 0xff;

  return {
    cpu,
    mem,
    bus,
    runForCycles(cycles: number): void {
      let consumed = 0;
      while (consumed < cycles) consumed += cpu.step();
    },
    steps(n: number): void {
      for (let i = 0; i < n; i++) cpu.step();
    },
  };
}
