/**
 * Shared length-counter unit, used by pulse / triangle / noise channels.
 *
 * Behavior:
 *   - Writing the channel's high register loads `value` from a 5-bit
 *     index into LENGTH_TABLE (call `loadFromIndex`).
 *   - The frame counter calls `tick()` on each "half-frame" boundary
 *     (4-step mode steps 1 and 3, or 5-step mode steps 1 and 4).
 *   - When `halt` is true (a per-channel control bit), `tick()` is a no-op.
 *   - When `value` reaches 0, the channel goes silent until reloaded.
 *   - `setEnabled(false)` (from $4015 writes) clears the counter and
 *     prevents subsequent loads. `setEnabled(true)` allows loads again.
 *
 * Reference: nesdev wiki "APU Length Counter".
 */
import { LENGTH_TABLE } from './timing';

export class LengthCounter {
  /** Current length value. 0 means the channel is silent. */
  value = 0;
  /** Halt flag: when true, `tick()` does not decrement. Per-channel control. */
  halt = false;
  /** Channel enable from $4015. Disable forces value to 0 and blocks loads. */
  private enabled = false;

  reset(): void {
    this.value = 0;
    this.halt = false;
    this.enabled = false;
  }

  /** Load `value` from the 5-bit index. No-op if the channel is disabled. */
  loadFromIndex(index: number): void {
    if (!this.enabled) return;
    this.value = LENGTH_TABLE[index & 0x1f];
  }

  /** Frame-counter half-frame tick: decrement unless halt or already zero. */
  tick(): void {
    if (this.halt) return;
    if (this.value > 0) this.value--;
  }

  /** True when the channel is gated on by length counter (audible). */
  active(): boolean {
    return this.value > 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.value = 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
