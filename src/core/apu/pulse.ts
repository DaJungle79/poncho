/**
 * Pulse channel — there are two of these, mapped to $4000-$4003 and
 * $4004-$4007. They differ only by the sweep negate behavior at the
 * boundary (channel 1's negate produces ones-complement subtract;
 * channel 2 produces twos-complement) — exposed as `channelIndex`.
 *
 * Register layout (CPU writes):
 *   $4000/$4004:  DDLC VVVV
 *                 D = duty (0-3, indexes PULSE_DUTY_TABLE)
 *                 L = length-counter halt / envelope loop
 *                 C = constant volume (1) vs decay (0)
 *                 V = volume / envelope reload
 *   $4001/$4005:  EPPP NSSS
 *                 E = sweep enable
 *                 P = sweep period (3 bits)
 *                 N = negate (subtract) flag
 *                 S = sweep shift count (3 bits)
 *   $4002/$4006:  TTTT TTTT  — timer low byte (low 8 bits of period)
 *   $4003/$4007:  LLLL LTTT  — length-counter index + timer high (3 bits)
 *
 * Cycle behavior:
 *   - Timer counts down at the APU rate (CPU/2). On reach 0, reload from
 *     period and advance the duty phase.
 *   - Envelope ticks per quarter-frame.
 *   - Sweep ticks per half-frame; can mute the channel when target
 *     period is out of range.
 *   - Length counter ticks per half-frame.
 *
 * Output is gated to 0 when:
 *   - Timer period < 8                (silenced — sweep target out of range)
 *   - Sweep target > 0x7FF            (silenced — sweep target out of range)
 *   - Length counter is 0
 *   - Duty waveform sample is 0
 *
 * Reference: nesdev wiki "APU Pulse".
 */
import { Envelope } from './envelope';
import { LengthCounter } from './length-counter';
import { PULSE_DUTY_TABLE } from './timing';

export class Pulse {
  /** Set at construction; channel 1 (0) and channel 2 (1) differ at the
   *  sweep "negate" boundary by 1. */
  readonly channelIndex: 0 | 1;

  // ----- Register-derived state ---------------------------------------------
  private duty = 0;            // 0..3
  private timerPeriod = 0;     // 11-bit
  private timer = 0;           // counts down

  // ----- Wave-generation state ----------------------------------------------
  private dutyPhase = 0;       // 0..7

  // ----- Sweep --------------------------------------------------------------
  private sweepEnabled = false;
  private sweepPeriod = 0;     // 3 bits
  private sweepNegate = false;
  private sweepShift = 0;      // 3 bits
  private sweepDivider = 0;
  private sweepReload = false;

  // ----- Sub-units ----------------------------------------------------------
  readonly envelope = new Envelope();
  readonly length = new LengthCounter();

  constructor(channelIndex: 0 | 1) {
    this.channelIndex = channelIndex;
  }

  reset(): void {
    this.duty = 0;
    this.timerPeriod = 0;
    this.timer = 0;
    this.dutyPhase = 0;
    this.sweepEnabled = false;
    this.sweepPeriod = 0;
    this.sweepNegate = false;
    this.sweepShift = 0;
    this.sweepDivider = 0;
    this.sweepReload = false;
    this.envelope.reset();
    this.length.reset();
  }

  // ----- Register writes ----------------------------------------------------

  /** Channels route writes through `write(offset, value)` where `offset`
   *  is 0..3 within the channel's register window. */
  write(offset: 0 | 1 | 2 | 3, value: number): void {
    value &= 0xff;
    switch (offset) {
      case 0:
        this.duty = (value >> 6) & 0x03;
        this.length.halt = (value & 0x20) !== 0;
        this.envelope.loop = (value & 0x20) !== 0;
        this.envelope.constant = (value & 0x10) !== 0;
        this.envelope.volumeReload = value & 0x0f;
        break;
      case 1:
        this.sweepEnabled = (value & 0x80) !== 0;
        this.sweepPeriod = (value >> 4) & 0x07;
        this.sweepNegate = (value & 0x08) !== 0;
        this.sweepShift = value & 0x07;
        this.sweepReload = true;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x0700) | value;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x00ff) | ((value & 0x07) << 8);
        this.length.loadFromIndex(value >> 3);
        // Writing $4003/$4007 also restarts the duty phase + envelope.
        this.dutyPhase = 0;
        this.envelope.trigger();
        break;
    }
  }

  // ----- Per-APU-cycle tick (called from APU at half CPU rate) -------------

  /** Decrement timer; on underflow, reload from period and advance duty. */
  tickTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      this.dutyPhase = (this.dutyPhase + 1) & 0x07;
    } else {
      this.timer--;
    }
  }

  // ----- Frame-counter triggers ---------------------------------------------

  /** Quarter-frame: tick envelope. */
  clockEnvelope(): void {
    this.envelope.tick();
  }

  /** Half-frame: tick length counter and sweep. */
  clockHalfFrame(): void {
    this.length.tick();
    this.tickSweep();
  }

  // ----- $4015 enable/disable ----------------------------------------------

  setEnabled(on: boolean): void { this.length.setEnabled(on); }
  isActive(): boolean { return this.length.active(); }

  // ----- Output -------------------------------------------------------------

  /** Current sample value, 0..15. 0 means silent. */
  output(): number {
    if (!this.length.active()) return 0;
    if (this.timerPeriod < 8 || this.sweepTarget() > 0x7ff) return 0;
    if (PULSE_DUTY_TABLE[this.duty][this.dutyPhase] === 0) return 0;
    return this.envelope.output();
  }

  // -------------------------------------------------------------------------
  // Sweep unit (private)
  // -------------------------------------------------------------------------

  /**
   * Compute the sweep "target" period — what the timer would become if we
   * applied the current sweep this half-frame. Used both for muting
   * (target > $7FF mutes) and for the actual update.
   */
  private sweepTarget(): number {
    const change = this.timerPeriod >> this.sweepShift;
    if (this.sweepNegate) {
      // Channel 1 uses ones-complement (-change-1); channel 2 twos.
      return this.timerPeriod - change - (this.channelIndex === 0 ? 1 : 0);
    }
    return this.timerPeriod + change;
  }

  /**
   * Half-frame sweep tick. When the divider hits 0, apply the sweep if
   * enabled, shift count is non-zero, and the target is in range.
   */
  private tickSweep(): void {
    if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0) {
      const target = this.sweepTarget();
      if (this.timerPeriod >= 8 && target <= 0x7ff) {
        this.timerPeriod = Math.max(0, target);
      }
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }
}
