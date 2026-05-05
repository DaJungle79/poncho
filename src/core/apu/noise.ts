/**
 * Noise channel — $400C-$400F.
 *
 * Generates pseudo-random output via a 15-bit linear-feedback shift
 * register (LFSR). Two LFSR modes:
 *   mode 0: feedback = bit 0 XOR bit 1   (long sequence ~32k samples)
 *   mode 1: feedback = bit 0 XOR bit 6   (short sequence ~93 samples,
 *                                          metallic / pitched percussion)
 *
 * Register layout:
 *   $400C:  --LC VVVV   length halt | constant volume | volume/envelope
 *   $400D:  unused
 *   $400E:  M--- PPPP   mode | period index → NOISE_PERIOD_TABLE
 *   $400F:  LLLL L---   length-counter index (top 5 bits)
 *
 * Output: 0 when length is 0, when LFSR bit 0 is 1 (silent half of the
 * pulse), or when the channel is disabled. Otherwise envelope volume.
 *
 * Reference: nesdev wiki "APU Noise".
 */
import { Envelope } from './envelope';
import { LengthCounter } from './length-counter';
import { NOISE_PERIOD_TABLE } from './timing';

export class Noise {
  // ----- LFSR ---------------------------------------------------------------
  /** 15-bit LFSR. Resets to 1 (a non-zero value is required). */
  private lfsr = 1;
  private mode = false;        // false = bit-1 feedback, true = bit-6 feedback

  // ----- Timer --------------------------------------------------------------
  private timerPeriod = 0;
  private timer = 0;

  // ----- Sub-units ---------------------------------------------------------
  readonly envelope = new Envelope();
  readonly length = new LengthCounter();

  reset(): void {
    this.lfsr = 1;
    this.mode = false;
    this.timerPeriod = 0;
    this.timer = 0;
    this.envelope.reset();
    this.length.reset();
  }

  // ----- Register writes ---------------------------------------------------

  write(offset: 0 | 1 | 2 | 3, value: number): void {
    value &= 0xff;
    switch (offset) {
      case 0:
        this.length.halt = (value & 0x20) !== 0;
        this.envelope.loop = (value & 0x20) !== 0;
        this.envelope.constant = (value & 0x10) !== 0;
        this.envelope.volumeReload = value & 0x0f;
        break;
      case 1:
        // Unused.
        break;
      case 2:
        this.mode = (value & 0x80) !== 0;
        this.timerPeriod = NOISE_PERIOD_TABLE[value & 0x0f];
        break;
      case 3:
        this.length.loadFromIndex(value >> 3);
        this.envelope.trigger();
        break;
    }
  }

  // ----- Per-APU-cycle tick (CPU/2 rate) -----------------------------------

  /** On timer underflow: shift the LFSR. */
  tickTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      // Feedback bit: bit 0 XOR (bit 1 or bit 6 depending on mode).
      const tap = this.mode ? (this.lfsr >> 6) & 1 : (this.lfsr >> 1) & 1;
      const feedback = (this.lfsr & 1) ^ tap;
      this.lfsr = (this.lfsr >> 1) | (feedback << 14);
    } else {
      this.timer--;
    }
  }

  // ----- Frame-counter triggers --------------------------------------------

  clockEnvelope(): void { this.envelope.tick(); }
  clockHalfFrame(): void { this.length.tick(); }

  // ----- $4015 enable/disable ----------------------------------------------

  setEnabled(on: boolean): void { this.length.setEnabled(on); }
  isActive(): boolean { return this.length.active(); }

  // ----- Output -------------------------------------------------------------

  /** 4-bit output: 0 when bit 0 of LFSR is 1 (silent half) or muted. */
  output(): number {
    if (!this.length.active()) return 0;
    if ((this.lfsr & 1) !== 0) return 0;
    return this.envelope.output();
  }
}
