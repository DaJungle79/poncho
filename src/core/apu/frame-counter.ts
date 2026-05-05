/**
 * APU Frame Counter / Sequencer.
 *
 * The frame counter divides the CPU clock and fires "envelope" and
 * "length / sweep" events at fixed cycle offsets within a 4-step or
 * 5-step frame. It also generates a maskable IRQ at the end of each
 * 4-step frame (unless inhibited).
 *
 *   4-step (mode 0, $4017 bit 7 = 0):
 *     step 0 @ 7457:    quarter-frame (envelope + linear)
 *     step 1 @ 14913:   quarter + half  (length + sweep)
 *     step 2 @ 22371:   quarter
 *     step 3 @ 29829:   quarter + half  + IRQ (if not inhibited)
 *     wraps at 29830 cycles
 *
 *   5-step (mode 1, $4017 bit 7 = 1):
 *     step 0 @ 7457:    quarter
 *     step 1 @ 14913:   quarter + half
 *     step 2 @ 22371:   quarter
 *     step 3 @ 29829:   (idle)
 *     step 4 @ 37281:   quarter + half
 *     wraps at 37282 cycles. *No IRQ.*
 *
 * Writing $4017 with bit 7 set immediately clocks both quarter- and
 * half-frame events (the "soft reset" behavior used by some games to
 * sync envelopes precisely).
 *
 * Reference: nesdev wiki "APU Frame Counter".
 */
import {
  FRAME_4STEP_CYCLES,
  FRAME_4STEP_LENGTH,
  FRAME_5STEP_CYCLES,
  FRAME_5STEP_LENGTH,
} from './timing';

export interface FrameCounterCallbacks {
  onQuarterFrame: () => void;
  onHalfFrame: () => void;
}

export class FrameCounter {
  private mode5Step = false;
  private irqInhibit = false;
  private irqLine = false;

  /** Cycle counter modulo the current frame length. */
  private cycle = 0;
  /** Index into the cycle table — which step we're scheduled to fire next. */
  private nextStepIndex = 0;

  private readonly callbacks: FrameCounterCallbacks;

  constructor(callbacks: FrameCounterCallbacks) {
    this.callbacks = callbacks;
  }

  reset(): void {
    this.mode5Step = false;
    this.irqInhibit = false;
    this.irqLine = false;
    this.cycle = 0;
    this.nextStepIndex = 0;
  }

  // ----- $4017 write --------------------------------------------------------

  /** Process a CPU write to $4017. */
  write(value: number): void {
    this.mode5Step = (value & 0x80) !== 0;
    this.irqInhibit = (value & 0x40) !== 0;
    if (this.irqInhibit) this.irqLine = false;
    this.cycle = 0;
    this.nextStepIndex = 0;
    // 5-step mode immediately clocks all events (per chip behavior).
    if (this.mode5Step) {
      this.callbacks.onQuarterFrame();
      this.callbacks.onHalfFrame();
    }
  }

  // ----- Per-CPU-cycle tick -----------------------------------------------

  tick(): void {
    this.cycle++;
    const table = this.mode5Step ? FRAME_5STEP_CYCLES : FRAME_4STEP_CYCLES;
    if (this.nextStepIndex < table.length && this.cycle === table[this.nextStepIndex]) {
      this.fireStep(this.nextStepIndex);
      this.nextStepIndex++;
    }
    const length = this.mode5Step ? FRAME_5STEP_LENGTH : FRAME_4STEP_LENGTH;
    if (this.cycle >= length) {
      this.cycle = 0;
      this.nextStepIndex = 0;
    }
  }

  // ----- IRQ pin -----------------------------------------------------------

  irqPending(): boolean { return this.irqLine; }
  irqAcknowledge(): void { this.irqLine = false; }

  // -------------------------------------------------------------------------
  // Step dispatch (private)
  // -------------------------------------------------------------------------

  private fireStep(index: number): void {
    if (this.mode5Step) {
      // 5-step: steps 0, 1, 2, 4 are quarter; steps 1, 4 are also half;
      // step 3 is idle.
      switch (index) {
        case 0: this.callbacks.onQuarterFrame(); break;
        case 1: this.callbacks.onQuarterFrame(); this.callbacks.onHalfFrame(); break;
        case 2: this.callbacks.onQuarterFrame(); break;
        case 3: break;
        case 4: this.callbacks.onQuarterFrame(); this.callbacks.onHalfFrame(); break;
      }
    } else {
      // 4-step: steps 0, 1, 2, 3 all quarter; 1, 3 also half; 3 fires IRQ.
      switch (index) {
        case 0: this.callbacks.onQuarterFrame(); break;
        case 1: this.callbacks.onQuarterFrame(); this.callbacks.onHalfFrame(); break;
        case 2: this.callbacks.onQuarterFrame(); break;
        case 3:
          this.callbacks.onQuarterFrame();
          this.callbacks.onHalfFrame();
          if (!this.irqInhibit) this.irqLine = true;
          break;
      }
    }
  }
}
