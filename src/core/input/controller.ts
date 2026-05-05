import { ALL_BUTTONS, NesButton, type ControllerSource } from './source';

/**
 * NES standard controller as exposed to the CPU via $4016/$4017.
 * Strobe high -> continually latch button state. Strobe falling edge ->
 * subsequent reads serially shift A,B,Select,Start,Up,Down,Left,Right.
 */
export class Controller {
  private source: ControllerSource | null = null;
  private latch = 0;
  private strobe = 0;
  private shift = 0;

  setSource(source: ControllerSource | null): void {
    this.source?.detach?.();
    this.source = source;
    this.source?.attach?.();
  }

  writeStrobe(value: number): void {
    const next = value & 1;
    if (this.strobe === 1 && next === 0) {
      this.shift = this.latch;
    }
    this.strobe = next;
    if (this.strobe === 1) this.refreshLatch();
  }

  read(): number {
    if (this.strobe === 1) {
      this.refreshLatch();
      return this.latch & 1;
    }
    const bit = this.shift & 1;
    this.shift = (this.shift >>> 1) | 0x80;
    return bit;
  }

  private refreshLatch(): void {
    if (!this.source) {
      this.latch = 0;
      return;
    }
    let bits = 0;
    for (const b of ALL_BUTTONS) {
      if (this.source.pressed(b)) bits |= 1 << (b as NesButton);
    }
    this.latch = bits;
  }
}
