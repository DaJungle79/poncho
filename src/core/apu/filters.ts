/**
 * NES audio output post-processing.
 *
 * The 2A03 mixer's raw output isn't quite what came out of the cartridge
 * connector — there's an analog stage on the console that imposes a
 * specific filter response:
 *
 *   90 Hz   first-order high-pass
 *   440 Hz  first-order high-pass
 *   14 kHz first-order low-pass
 *
 * Approximating these as RC filters (one-pole IIR) gives audibly
 * correct output without much CPU cost. The high-passes remove the DC
 * bias the mixer produces; the low-pass tames the digital harshness.
 *
 * Reference: nesdev wiki "APU Mixer".
 */

/** First-order high-pass: y = a * (y_prev + x - x_prev). */
export class HighPass {
  private prevIn = 0;
  private prevOut = 0;
  constructor(private readonly alpha: number) {}
  reset(): void { this.prevIn = 0; this.prevOut = 0; }
  process(sample: number): number {
    const out = this.alpha * (this.prevOut + sample - this.prevIn);
    this.prevIn = sample;
    this.prevOut = out;
    return out;
  }
}

/** First-order low-pass: y = y_prev + a * (x - y_prev). */
export class LowPass {
  private prev = 0;
  constructor(private readonly alpha: number) {}
  reset(): void { this.prev = 0; }
  process(sample: number): number {
    const out = this.prev + this.alpha * (sample - this.prev);
    this.prev = out;
    return out;
  }
}

/**
 * Bundles the three NES output filters in series. Coefficients are
 * computed for a given output sample rate (the alpha for an RC filter
 * depends on the cutoff frequency relative to the sampling rate).
 */
export class Filters {
  private readonly hp90: HighPass;
  private readonly hp440: HighPass;
  private readonly lp14k: LowPass;

  constructor(sampleRate: number) {
    // Coefficients via the one-pole RC approximation:
    //   alpha = exp(-2*pi*f/Fs)  for high-pass (towards 1 = pass)
    //   alpha = 1 - exp(-2*pi*f/Fs) for low-pass
    // The classic NES-emulator constants below come from blargg's nes_snd_emu.
    const hpAlpha = (cutoff: number) =>
      1 / (1 + (sampleRate / (2 * Math.PI * cutoff)));
    const hp90Coef = 1 - hpAlpha(90);
    const hp440Coef = 1 - hpAlpha(440);
    const lp14kCoef = hpAlpha(14000);

    this.hp90 = new HighPass(hp90Coef);
    this.hp440 = new HighPass(hp440Coef);
    this.lp14k = new LowPass(lp14kCoef);
  }

  reset(): void {
    this.hp90.reset();
    this.hp440.reset();
    this.lp14k.reset();
  }

  process(sample: number): number {
    return this.lp14k.process(this.hp440.process(this.hp90.process(sample)));
  }
}
