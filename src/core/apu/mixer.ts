/**
 * NES audio mixer — combines the five APU channel outputs into one
 * normalized sample in roughly the [-1, 1] range expected by Web Audio.
 *
 * The 2A03 hardware uses a non-linear mixer that compresses loud signals
 * (when many channels are active simultaneously). The standard
 * approximation from the nesdev wiki:
 *
 *   pulse_out = 95.88 / ((8128 / (p1 + p2)) + 100)               , 0 if p1+p2=0
 *   tnd_out   = 159.79 / ((1 / (t/8227 + n/12241 + d/22638)) + 100)
 *   sample    = pulse_out + tnd_out
 *
 * The result lands in roughly [0, 1]. We center it around 0 with a small
 * DC subtraction to be friendly to AudioBufferSourceNode (which expects
 * signed audio centered at 0). The output filter chain in `filters.ts`
 * removes residual DC drift.
 *
 * Both formulas are implemented as lookup tables for speed (the inputs
 * are small bounded integers — pulse 0..30, TND 0..3*15+127). Building
 * the LUT once at startup is cheap and removes the per-sample divides.
 */

const PULSE_LUT = new Float32Array(31);
const TND_LUT = new Float32Array(203);

(() => {
  PULSE_LUT[0] = 0;
  for (let i = 1; i < 31; i++) {
    PULSE_LUT[i] = 95.88 / (8128 / i + 100);
  }
  TND_LUT[0] = 0;
  for (let i = 1; i < 203; i++) {
    TND_LUT[i] = 163.67 / (24329 / i + 100);
  }
})();

export interface ChannelLevels {
  pulse1: number;
  pulse2: number;
  triangle: number;
  noise: number;
  dmc: number;
}

/**
 * Produce a single normalized sample (~[-0.5, 0.5]) given the four 4-bit
 * channels and the 7-bit DMC level.
 */
export function mixSample(level: ChannelLevels): number {
  const pulseSum = (level.pulse1 + level.pulse2) | 0;
  const tndIndex = (3 * level.triangle + 2 * level.noise + level.dmc) | 0;
  const pulse = PULSE_LUT[pulseSum] ?? 0;
  const tnd = TND_LUT[tndIndex] ?? 0;
  return pulse + tnd;
}
