import type { Cpu } from '../core/cpu/cpu';
import { disasmAt } from '../core/cpu/disasm';

/**
 * CPU instruction tracer. When enabled, `capture()` is called from the
 * console run loop *before* each instruction executes, producing one
 * formatted line of trace output. Lines are kept in a ring buffer so very
 * long traces don't blow memory; consumers (the dev panel) can drain the
 * buffer to inspect or save it.
 */
export class Tracer {
  enabled = false;

  private buffer: string[] = [];
  private capacity = 100_000;

  setCapacity(n: number): void {
    this.capacity = Math.max(1, n);
    while (this.buffer.length > this.capacity) this.buffer.shift();
  }

  /** Snapshot one instruction at the current PC. Cheap when disabled. */
  capture(cpu: Cpu): void {
    if (!this.enabled) return;
    const line = `${disasmAt(cpu, cpu.pc)} CYC:${cpu.cycles()}`;
    this.push(line);
  }

  push(line: string): void {
    if (this.buffer.length >= this.capacity) this.buffer.shift();
    this.buffer.push(line);
  }

  /** Return all captured lines, clearing the buffer. */
  drain(): string[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  size(): number {
    return this.buffer.length;
  }
}
