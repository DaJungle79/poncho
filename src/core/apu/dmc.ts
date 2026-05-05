/**
 * DMC (delta-modulation) channel — $4010-$4013.
 *
 * Streams 1-bit delta-PCM samples from CPU memory. Each bit either nudges
 * a 7-bit "output level" up by 2 or down by 2 (clamped to 0..127). At
 * playback rate, the output level IS the audio sample.
 *
 * Register layout:
 *   $4010:  IL-- RRRR   IRQ enable | loop | rate index (NOISE-style table)
 *   $4011:  -DDD DDDD   direct load of output level (7 bits)
 *   $4012:  AAAA AAAA   sample address = $C000 + (A << 6)
 *   $4013:  LLLL LLLL   sample length  =  L << 4 + 1   (in bytes)
 *
 * Cycle behavior:
 *   - Timer counts down at the rate from DMC_RATE_TABLE; on reaching 0,
 *     consume one bit from the shift register.
 *   - When the shift register empties (8 bits consumed), refill it from
 *     the sample buffer; if the sample buffer is empty, fetch the next
 *     byte from CPU memory at sampleAddr (advances sampleAddr, decrements
 *     bytesRemaining).
 *   - When bytesRemaining reaches 0: if loop, reload from registers;
 *     else, optionally fire IRQ and stop.
 *
 * Simplification: real DMC fetches stall the CPU for a few cycles (the
 * CPU "pauses" during the DMA byte fetch). We do an immediate read here
 * for simplicity — the difference is rarely audible on its own. Tracked
 * in DEFERRED.md.
 *
 * Reference: nesdev wiki "APU DMC".
 */
import { DMC_RATE_TABLE } from './timing';

/** A function the DMC uses to read a byte from CPU memory ($8000-$FFFF). */
export type DmcReader = (addr: number) => number;

export class Dmc {
  // ----- Registers ----------------------------------------------------------
  private irqEnable = false;
  private loop = false;
  private timerPeriod = DMC_RATE_TABLE[0];
  private timer = 0;
  private sampleAddrBase = 0xc000;
  private sampleLengthBase = 1;

  // ----- Output level (the actual heard signal) ----------------------------
  private outputLevel = 0;

  // ----- Sample-fetch state ------------------------------------------------
  private sampleAddr = 0xc000;
  private bytesRemaining = 0;
  private sampleBuffer = 0;
  private sampleBufferEmpty = true;

  // ----- Shift register state ----------------------------------------------
  private shift = 0;
  private bitsRemaining = 0;
  private silenceFlag = true;

  // ----- IRQ ----------------------------------------------------------------
  private irqLine = false;

  /** Set by the APU at construction; reads CPU memory for DMC samples. */
  private reader: DmcReader = () => 0;

  reset(): void {
    this.irqEnable = false;
    this.loop = false;
    this.timerPeriod = DMC_RATE_TABLE[0];
    this.timer = 0;
    this.sampleAddrBase = 0xc000;
    this.sampleLengthBase = 1;
    this.outputLevel = 0;
    this.sampleAddr = 0xc000;
    this.bytesRemaining = 0;
    this.sampleBuffer = 0;
    this.sampleBufferEmpty = true;
    this.shift = 0;
    this.bitsRemaining = 0;
    this.silenceFlag = true;
    this.irqLine = false;
  }

  setReader(fn: DmcReader): void {
    this.reader = fn;
  }

  // ----- Register writes ---------------------------------------------------

  write(offset: 0 | 1 | 2 | 3, value: number): void {
    value &= 0xff;
    switch (offset) {
      case 0:
        this.irqEnable = (value & 0x80) !== 0;
        this.loop = (value & 0x40) !== 0;
        this.timerPeriod = DMC_RATE_TABLE[value & 0x0f];
        if (!this.irqEnable) this.irqLine = false;
        break;
      case 1:
        this.outputLevel = value & 0x7f;
        break;
      case 2:
        // Sample base address: $C000 + (A << 6)
        this.sampleAddrBase = 0xc000 | (value << 6);
        break;
      case 3:
        // Sample base length in bytes: (L << 4) + 1
        this.sampleLengthBase = (value << 4) + 1;
        break;
    }
  }

  // ----- $4015 enable/disable ----------------------------------------------

  /** Enables: kick off playback if bytes remaining is 0. Disables: halt. */
  setEnabled(on: boolean): void {
    if (!on) {
      this.bytesRemaining = 0;
    } else if (this.bytesRemaining === 0) {
      this.sampleAddr = this.sampleAddrBase;
      this.bytesRemaining = this.sampleLengthBase;
    }
  }

  /** True when there are sample bytes still to play. Surfaces in $4015. */
  isActive(): boolean { return this.bytesRemaining > 0; }

  irqPending(): boolean { return this.irqLine; }
  irqClear(): void { this.irqLine = false; }

  // ----- Per-CPU-cycle tick ------------------------------------------------

  /**
   * On timer underflow, consume one bit from the shift register and
   * adjust the output level (or maintain it when silenceFlag is on).
   * If the shift register is empty afterwards, refill from sample buffer.
   * If the sample buffer is empty, fetch a new byte from CPU memory.
   */
  tickTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      this.shiftClock();
    } else {
      this.timer--;
    }
  }

  // ----- Output -------------------------------------------------------------

  /** 7-bit output level — fed directly to the mixer's TND input. */
  output(): number { return this.outputLevel; }

  // -------------------------------------------------------------------------
  // Internal: shift-register clocking and sample fetch
  // -------------------------------------------------------------------------

  private shiftClock(): void {
    if (!this.silenceFlag) {
      // Bit 0 of shift register: 1 → +2, 0 → -2 (clamped to 0..127).
      if ((this.shift & 1) !== 0) {
        if (this.outputLevel <= 125) this.outputLevel += 2;
      } else {
        if (this.outputLevel >= 2) this.outputLevel -= 2;
      }
    }
    this.shift >>= 1;
    if (this.bitsRemaining > 0) this.bitsRemaining--;

    if (this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      if (this.sampleBufferEmpty) {
        this.silenceFlag = true;
      } else {
        this.silenceFlag = false;
        this.shift = this.sampleBuffer;
        this.sampleBufferEmpty = true;
      }
    }

    // Try to refill the sample buffer if it just emptied.
    if (this.sampleBufferEmpty && this.bytesRemaining > 0) {
      this.sampleBuffer = this.reader(this.sampleAddr) & 0xff;
      this.sampleBufferEmpty = false;
      this.sampleAddr = this.sampleAddr === 0xffff ? 0x8000 : this.sampleAddr + 1;
      this.bytesRemaining--;
      if (this.bytesRemaining === 0) {
        if (this.loop) {
          this.sampleAddr = this.sampleAddrBase;
          this.bytesRemaining = this.sampleLengthBase;
        } else if (this.irqEnable) {
          this.irqLine = true;
        }
      }
    }
  }
}
