/**
 * Generic audio output. Implementations queue mono float samples
 * (peak ~1.0) and play them at their own sample rate.
 */
export interface AudioSink {
  readonly sampleRate: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  push(samples: Float32Array, count: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}
