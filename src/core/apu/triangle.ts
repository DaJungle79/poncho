/**
 * Triangle channel — $4008-$400B.
 *
 * The triangle is the only channel without an envelope; its volume is
 * fixed (4-bit output from the TRIANGLE_SEQUENCE table). It has TWO
 * gates that must both be open for it to advance:
 *   - Length counter (half-frame)
 *   - Linear counter (quarter-frame, with reload-latch behavior)
 *
 * Register layout:
 *   $4008:  CRRR RRRR
 *           C = control: doubles as length-counter halt AND linear-counter
 *               "halt reload" — when set, the linear counter is reloaded
 *               every quarter-frame from R; when clear, it counts down
 *               and stops.
 *           R = linear-counter reload value (7 bits)
 *   $4009:  unused
 *   $400A:  TTTT TTTT  — timer low byte
 *   $400B:  LLLL LTTT  — length-counter index + timer high (3 bits)
 *
 * Cycle behavior:
 *   - Timer counts down at the *full* CPU rate (twice as fast as pulse).
 *     On reaching 0 it reloads and advances the 32-step sequence index.
 *   - Sequence stalls when either counter is 0; the timer keeps ticking
 *     to maintain frequency, but the sequence index doesn't advance.
 *
 * Reference: nesdev wiki "APU Triangle".
 */
import { LengthCounter } from './length-counter';
import { TRIANGLE_SEQUENCE } from './timing';

export class Triangle {
  // ----- Register-derived state ---------------------------------------------
  private timerPeriod = 0;     // 11-bit
  private timer = 0;
  private linearReload = 0;    // 7-bit
  private control = false;     // halt for length AND reload-latch for linear

  // ----- Wave-generation state ----------------------------------------------
  private sequenceIndex = 0;   // 0..31

  // ----- Linear counter (private state machine) -----------------------------
  private linearCounter = 0;
  private linearReloadFlag = false;

  readonly length = new LengthCounter();

  reset(): void {
    this.timerPeriod = 0;
    this.timer = 0;
    this.linearReload = 0;
    this.control = false;
    this.sequenceIndex = 0;
    this.linearCounter = 0;
    this.linearReloadFlag = false;
    this.length.reset();
  }

  // ----- Register writes ----------------------------------------------------

  write(offset: 0 | 1 | 2 | 3, value: number): void {
    value &= 0xff;
    switch (offset) {
      case 0:
        this.control = (value & 0x80) !== 0;
        this.length.halt = this.control;
        this.linearReload = value & 0x7f;
        break;
      case 1:
        // Unused.
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x0700) | value;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x00ff) | ((value & 0x07) << 8);
        this.length.loadFromIndex(value >> 3);
        this.linearReloadFlag = true;
        break;
    }
  }

  // ----- Per-CPU-cycle tick (triangle runs at full CPU rate) ---------------

  /**
   * Advance the timer; on underflow, advance the wave sequence index —
   * but ONLY if both gates are open. The timer itself keeps counting
   * regardless so the channel's "frequency" is preserved even while
   * silenced.
   */
  tickTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      if (this.length.active() && this.linearCounter > 0) {
        this.sequenceIndex = (this.sequenceIndex + 1) & 0x1f;
      }
    } else {
      this.timer--;
    }
  }

  // ----- Frame-counter triggers ---------------------------------------------

  /**
   * Quarter-frame: clock the linear counter.
   *   reload flag set: counter := linearReload
   *   else if counter > 0: counter--
   *   if control flag clear: clear the reload flag (one-shot mode)
   */
  clockLinear(): void {
    if (this.linearReloadFlag) {
      this.linearCounter = this.linearReload;
    } else if (this.linearCounter > 0) {
      this.linearCounter--;
    }
    if (!this.control) this.linearReloadFlag = false;
  }

  /** Half-frame: tick length counter. */
  clockHalfFrame(): void {
    this.length.tick();
  }

  // ----- $4015 enable/disable ----------------------------------------------

  setEnabled(on: boolean): void { this.length.setEnabled(on); }
  isActive(): boolean { return this.length.active(); }

  // ----- Output -------------------------------------------------------------

  /**
   * 4-bit output sample. Returns 0 (silent) when the timer period is too
   * short to be audible (< 2) — the chip would emit a high-frequency hiss
   * otherwise that game audio engines never want.
   */
  output(): number {
    if (this.timerPeriod < 2) return 0;
    return TRIANGLE_SEQUENCE[this.sequenceIndex];
  }
}
