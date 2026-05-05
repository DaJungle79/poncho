/**
 * Shared envelope generator. Used by pulse and noise channels.
 *
 * The envelope is a 4-bit volume source that either:
 *   - Outputs a fixed `volumeReload` value (constant-volume mode), or
 *   - Decays from 15 down to 0 (or loops back to 15 if `loop` is set).
 *
 * Per quarter-frame (frame counter steps 0/1/2/3 in 4-step mode, or
 * 0/1/2/4 in 5-step mode), `tick()` is called. A `start` flag (set by
 * the channel on a high-register write) triggers a reload of both the
 * decay counter and divider on the next tick.
 *
 * Reference: nesdev wiki "APU Envelope".
 */

export class Envelope {
  /** When true, output `volumeReload` directly; ignore the decay counter. */
  constant = false;
  /** When true, decay counter loops 15 → ... → 0 → 15 instead of stopping. */
  loop = false;
  /** Reload value for the divider (also acts as constant volume when constant=true). */
  volumeReload = 0;

  /** "Start" latch: set by a register write that starts the envelope. */
  private start = false;
  /** Internal decay level (15 → 0) used in non-constant mode. */
  private decay = 0;
  /** Divider that paces decay updates (counts down each tick to 0). */
  private divider = 0;

  reset(): void {
    this.constant = false;
    this.loop = false;
    this.volumeReload = 0;
    this.start = false;
    this.decay = 0;
    this.divider = 0;
  }

  /** Channels call this on register writes that "start" the envelope. */
  trigger(): void {
    this.start = true;
  }

  /**
   * Frame-counter quarter-frame tick.
   *   start latch set:   decay := 15, divider := volumeReload, clear start.
   *   else divider == 0: divider := volumeReload, decay-- (loop wraps to 15).
   *   else:              divider--.
   */
  tick(): void {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volumeReload;
      return;
    }
    if (this.divider === 0) {
      this.divider = this.volumeReload;
      if (this.decay > 0) {
        this.decay--;
      } else if (this.loop) {
        this.decay = 15;
      }
    } else {
      this.divider--;
    }
  }

  /** Current 4-bit volume the channel should multiply its output by. */
  output(): number {
    return this.constant ? this.volumeReload : this.decay;
  }
}
