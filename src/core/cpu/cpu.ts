/**
 * 2A03 (NMOS 6502) CPU core — per-cycle accurate.
 *
 * Execution model: every bus access (read, write, or phantom) ticks the
 * surrounding system *before* it happens. The CPU's `tickCallback` is
 * invoked once per cycle; the typical implementation ticks the PPU 3× and
 * the APU 1× per call. This way mid-instruction reads of $2002, register
 * writes that race vblank, and OAM DMA stalls all see the right state at
 * the right cycle.
 *
 * Cycle counting is implicit: every bus access (real or phantom) counts
 * one cycle. Instructions that have an "internal" cycle (e.g. branches
 * burn a cycle to compute the new PC) call `internalCycle()` to keep the
 * count honest. Per-instruction cycle totals come out exactly right with
 * no separate accounting in the dispatch loop.
 *
 * Key helpers used by addressing modes and instruction implementations:
 *
 *   read8(addr)       Real bus read. Ticks. Returns byte.
 *   write8(addr, v)   Real bus write. Ticks.
 *   dummyRead(addr)   Phantom bus read (real cycle, real bus access; the
 *                     resulting value is discarded). Used for the wrong-
 *                     page reads on indexed addressing and the "extra"
 *                     PC reads that real branches perform.
 *   dummyWrite(a, v)  Phantom bus write — same as write8, called out
 *                     separately for clarity at the read-modify-write
 *                     "old value write" cycle. Many bus-mapped registers
 *                     fire side effects on dummy writes.
 *   internalCycle()   A cycle with no bus access (we model it as a dummy
 *                     read of the next opcode byte at PC, matching real
 *                     hardware behavior for these "idle" cycles).
 *
 * Reset, NMI, and IRQ servicing all go through the same helpers so their
 * 7-cycle costs come out by counting bus accesses.
 *
 * References:
 *   - https://www.nesdev.org/wiki/CPU
 *   - https://www.nesdev.org/wiki/CPU_unofficial_opcodes
 *   - http://www.atarihq.com/danb/files/64doc.txt   (per-cycle bus protocol)
 */
import { Flag, RESET_P, setZN } from './flags';
import { OPCODES } from './opcodes';

/** Minimal address space the CPU needs. CpuBus satisfies this structurally. */
export interface MemoryBus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

/**
 * Vectors:
 *   NMI     $FFFA-FFFB
 *   RESET   $FFFC-FFFD
 *   IRQ/BRK $FFFE-FFFF
 */
export const VEC_NMI = 0xfffa;
export const VEC_RESET = 0xfffc;
export const VEC_IRQ = 0xfffe;

export class Cpu {
  // ----- Architectural state -------------------------------------------------

  a = 0;
  x = 0;
  y = 0;
  pc = 0;
  sp = 0xfd;
  p = RESET_P;

  // ----- Wiring --------------------------------------------------------------

  private readonly bus: MemoryBus;
  private cyclesTotal = 0;
  /** Cycles consumed by the *current* call to step(). Reset on entry. */
  private cycleCount = 0;
  /**
   * Called once per CPU cycle, immediately *before* the bus access of that
   * cycle. The default no-op makes the CPU usable in unit tests with no
   * coupled PPU/APU.
   */
  private tickCb: () => void = () => {};

  /**
   * NMI is edge-triggered — latched here on `triggerNmi()` and serviced on
   * the next instruction boundary, then cleared.
   */
  private nmiPending = false;

  /**
   * IRQ is level-sensitive: APU/mapper hold the line high as long as they
   * want an interrupt. Serviced on instruction boundaries when I=0.
   */
  private irqLine = false;

  /**
   * Cycles the CPU is parked. Used by OAM DMA on legacy paths; the per-byte
   * DMA path (`dmaCopy`) burns cycles directly via internalCycle/read8/write8
   * and does not use stallCycles.
   */
  private stallCycles = 0;

  constructor(bus: MemoryBus) {
    this.bus = bus;
  }

  /**
   * Wire the per-cycle callback. Called *before* every bus access — i.e.
   * before the byte hits the bus, the surrounding system has already
   * advanced one cycle.
   */
  setTickCallback(cb: () => void): void {
    this.tickCb = cb;
  }

  // ----- Lifecycle -----------------------------------------------------------

  /**
   * Hardware reset.
   *
   * Real silicon takes 7 cycles for reset, all of which are bus accesses
   * (mostly dummy reads). We replicate the canonical sequence so the PPU
   * and APU advance by 21 dots / 7 cycles during the reset.
   *
   * Final state: PC = word at $FFFC, SP = $FD, P = U|I, A=X=Y = 0.
   */
  reset(): void {
    // Power-on / reset zeros the architectural state. SP starts at $00 so
    // that the three "phantom push" decrements during the reset sequence
    // land us at the canonical post-reset SP of $FD.
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0x00;
    this.p = RESET_P;
    this.nmiPending = false;
    this.irqLine = false;
    this.stallCycles = 0;
    this.cycleCount = 0;

    // Cycles 1-2: dummy fetches of opcode/operand at PC (PC undefined here,
    // we read from $0000 so the bus access is well-defined).
    this.dummyRead(0);
    this.dummyRead(1);

    // Cycles 3-5: phantom stack pushes (PC + P would be pushed on a real
    // interrupt; reset suppresses the writes but still decrements SP).
    this.dummyRead(0x0100 | this.sp); this.sp = (this.sp - 1) & 0xff;
    this.dummyRead(0x0100 | this.sp); this.sp = (this.sp - 1) & 0xff;
    this.dummyRead(0x0100 | this.sp); this.sp = (this.sp - 1) & 0xff;

    // Cycles 6-7: read reset vector.
    const lo = this.read8(VEC_RESET);
    const hi = this.read8(VEC_RESET + 1);
    this.pc = (hi << 8) | lo;

    this.cyclesTotal += this.cycleCount;
    this.cycleCount = 0;
  }

  // ----- Main loop -----------------------------------------------------------

  /**
   * Execute one instruction (or one interrupt service, or one stall cycle)
   * and return the cycles consumed. Order on each call:
   *
   *   1. If the CPU is stalled, burn one cycle (and tick the system).
   *   2. If NMI is pending, service it (7 cycles).
   *   3. Else if IRQ line is asserted and I=0, service IRQ (7 cycles).
   *   4. Otherwise: fetch opcode, resolve operand, execute. The cycle
   *      count is the number of bus accesses (or internal cycles) that
   *      happened during the instruction.
   */
  step(): number {
    if (this.stallCycles > 0) {
      this.stallCycles--;
      this.tickCb();
      this.cyclesTotal++;
      return 1;
    }

    if (this.nmiPending) {
      this.nmiPending = false;
      this.cycleCount = 0;
      this.serviceInterrupt(VEC_NMI, false);
      const cycles = this.cycleCount;
      this.cyclesTotal += cycles;
      return cycles;
    }

    if (this.irqLine && !this.getFlag(Flag.I)) {
      this.cycleCount = 0;
      this.serviceInterrupt(VEC_IRQ, false);
      const cycles = this.cycleCount;
      this.cyclesTotal += cycles;
      return cycles;
    }

    this.cycleCount = 0;

    const opcode = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    const entry = OPCODES[opcode];

    const result = entry.addressing(this);
    entry.execute(this, result.addr);

    const cycles = this.cycleCount;
    this.cyclesTotal += cycles;
    return cycles;
  }

  // ----- Bus access helpers --------------------------------------------------
  //
  // Every helper here ticks the system before the bus access and bumps the
  // per-step cycle counter. Instruction implementations should *only* go
  // through these helpers (never call this.bus.read/write directly).

  /**
   * Real bus read. One cycle.
   *
   * Cycle ordering: bus access happens FIRST (mid-cycle on real silicon
   * the address is latched here), then the tickCallback advances the rest
   * of the system by 3 PPU dots / 1 APU step. By the time the next bus
   * access begins, those 3 dots have happened. This matches the canonical
   * "bus access at the start, then PPU dots resolve" pattern used by
   * Mesen and FCEUX for the cycle 0/1/2 ordering.
   */
  read8(addr: number): number {
    this.cycleCount++;
    const v = this.bus.read(addr & 0xffff) & 0xff;
    this.tickCb();
    return v;
  }

  /** Real bus write. One cycle. Same ordering as read8. */
  write8(addr: number, value: number): void {
    this.cycleCount++;
    this.bus.write(addr & 0xffff, value & 0xff);
    this.tickCb();
  }

  /**
   * Phantom bus read — the cycle and the access happen for real, but the
   * value is discarded. Used by:
   *   - Indexed-addressing instructions (the "wrong page" read on cross).
   *   - Read-modify-write instructions (extra read of the same byte).
   *   - Branches (extra PC reads when taken / when crossing a page).
   *   - Reset/IRQ/NMI sequences (dummy fetches).
   *
   * The bus IS hit, so any side effects (e.g. open-bus latches, $2002
   * reads clearing vblank) happen as on real hardware.
   */
  dummyRead(addr: number): void {
    this.cycleCount++;
    this.bus.read(addr & 0xffff);
    this.tickCb();
  }

  /**
   * Phantom bus write — used between the read and the real write of a
   * read-modify-write instruction. The 6502 writes the *old* value back
   * before writing the new one; for memory-mapped registers (PPU/APU)
   * those dummy writes are observable.
   */
  dummyWrite(addr: number, value: number): void {
    this.cycleCount++;
    this.bus.write(addr & 0xffff, value & 0xff);
    this.tickCb();
  }

  /**
   * A cycle without an architecturally-meaningful bus operation. Real
   * silicon still does a bus access on these cycles (it has to — the bus
   * is busy every cycle); we model them as a dummy read of the byte at PC,
   * which is what the chip actually does.
   */
  internalCycle(): void {
    this.cycleCount++;
    this.bus.read(this.pc & 0xffff);
    this.tickCb();
  }

  /** Little-endian word read at `addr`. Wraps within 16 bits, NOT page-safe. */
  read16(addr: number): number {
    const lo = this.read8(addr);
    const hi = this.read8((addr + 1) & 0xffff);
    return (hi << 8) | lo;
  }

  // ----- Stack helpers -------------------------------------------------------
  //
  // Push/pull each take one bus cycle. SP wraps mod 256.

  push8(value: number): void {
    this.write8(0x0100 | this.sp, value);
    this.sp = (this.sp - 1) & 0xff;
  }

  pull8(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read8(0x0100 | this.sp);
  }

  /** Push high byte first so pull16 reads them back in order. */
  push16(value: number): void {
    this.push8((value >>> 8) & 0xff);
    this.push8(value & 0xff);
  }

  pull16(): number {
    const lo = this.pull8();
    const hi = this.pull8();
    return (hi << 8) | lo;
  }

  // ----- Flags ---------------------------------------------------------------

  setFlag(flag: Flag, value: boolean): void {
    if (value) this.p |= flag;
    else this.p &= ~flag;
  }

  getFlag(flag: Flag): boolean {
    return (this.p & flag) !== 0;
  }

  /** Set N and Z from an 8-bit value. */
  setZN(value: number): void {
    this.p = setZN(this.p, value);
  }

  // ----- Interrupt control ---------------------------------------------------

  triggerNmi(): void { this.nmiPending = true; }
  setIrqLine(level: boolean): void { this.irqLine = level; }
  hasPendingNmi(): boolean { return this.nmiPending; }
  isIrqLineAsserted(): boolean { return this.irqLine; }

  /**
   * Park the CPU for `n` cycles. Used by the legacy OAM-DMA stall path
   * (kept for completeness — the per-cycle DMA orchestrator in Nes uses
   * `dmaCopy` instead, which ticks naturally through bus helpers).
   */
  stall(cycles: number): void {
    this.stallCycles += cycles;
  }

  cycles(): number { return this.cyclesTotal; }

  // ----- Internal: shared interrupt entry ------------------------------------

  /**
   * NMI / IRQ entry sequence. 7 cycles:
   *   C1-2: two dummy fetches (the chip is "deciding" something)
   *   C3:   push PC high
   *   C4:   push PC low
   *   C5:   push P (B forced to 0 for hardware interrupts)
   *   C6:   read low byte of vector
   *   C7:   read high byte of vector
   */
  private serviceInterrupt(vector: number, brk: boolean): void {
    this.dummyRead(this.pc);
    this.dummyRead(this.pc);
    this.push8((this.pc >>> 8) & 0xff);
    this.push8(this.pc & 0xff);
    let pushedP = (this.p | Flag.U) & ~Flag.B;
    if (brk) pushedP |= Flag.B;
    this.push8(pushedP);
    this.setFlag(Flag.I, true);
    const lo = this.read8(vector);
    const hi = this.read8((vector + 1) & 0xffff);
    this.pc = (hi << 8) | lo;
  }
}
