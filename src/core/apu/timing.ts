/**
 * 2A03 APU timing constants and lookup tables.
 *
 * Reference: nesdev wiki "APU" section.
 */

/** NTSC CPU clock in Hz; the APU runs at half this rate for pulse/dmc. */
export const NTSC_CPU_HZ = 1_789_773;

/** Default audio output sample rate. The Web Audio side may resample. */
export const DEFAULT_SAMPLE_RATE = 44_100;

/**
 * 5-bit length-counter index → length value table. Used by all four
 * channels (pulse, triangle, noise — DMC has its own). Writing a 5-bit
 * value to the length register loads the channel's length counter from
 * here. The counter then decrements every "half frame" (in 4-step mode:
 * frame counter steps 1 and 3) until it reaches zero.
 */
export const LENGTH_TABLE: readonly number[] = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
];

/**
 * 4-bit period index → noise-channel timer reload value (NTSC).
 * The noise timer counts CPU cycles; smaller values give higher pitches.
 */
export const NOISE_PERIOD_TABLE: readonly number[] = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
];

/**
 * 4-bit DMC rate index → timer reload (CPU cycles per output level
 * change). NTSC values from nesdev wiki.
 */
export const DMC_RATE_TABLE: readonly number[] = [
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
];

/**
 * Pulse-channel duty-cycle waveforms. Indexed by the 2-bit duty field.
 * Each row is 8 samples long; the channel cycles through them in order.
 *
 *   00: 12.5%
 *   01: 25%
 *   10: 50%
 *   11: 25% negated  ("75%" — visually it's a 75%-low waveform)
 */
export const PULSE_DUTY_TABLE: readonly (readonly number[])[] = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
];

/**
 * Triangle output sequence. The triangle channel walks through these 32
 * 4-bit samples in order, producing the classic NES triangle wave when
 * its timer reaches zero. The values fall from 15 to 0 then rise from 0
 * back to 15 — one full cycle.
 */
export const TRIANGLE_SEQUENCE: readonly number[] = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

/**
 * Frame-counter step counts. The frame sequencer fires events at fixed
 * CPU-cycle offsets within a 14914-cycle (4-step) or 18640-cycle
 * (5-step) frame. Steps fire in order at these cycle counts.
 *
 * Reference: nesdev wiki "APU Frame Counter" — NTSC values.
 */
export const FRAME_4STEP_CYCLES: readonly number[] = [7457, 14913, 22371, 29829];
export const FRAME_5STEP_CYCLES: readonly number[] = [7457, 14913, 22371, 29829, 37281];

/** Rounded up cycles for 4-step / 5-step total frame length. */
export const FRAME_4STEP_LENGTH = 29830;
export const FRAME_5STEP_LENGTH = 37282;
