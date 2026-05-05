import type { AudioSink } from './audio-sink';

/**
 * Web Audio sink using an AudioWorklet for low-latency playback.
 *
 * Architecture:
 *   - main thread runs the emulator and `push()`es batches of mono float
 *     samples into the worklet via `port.postMessage`.
 *   - The worklet keeps its own ring buffer; on each `process()` call the
 *     audio thread drains a frame's worth of samples from it, returning
 *     the last value (or 0) on underrun.
 *   - A `GainNode` between the worklet and `destination` provides volume
 *     and mute without renegotiating the worklet.
 *
 * The worklet code is inlined as a string and loaded via a Blob URL —
 * that way the bundler doesn't need to know about a separate worklet
 * file, and there's no extra HTTP request for a tiny script.
 *
 * Browser support: AudioWorklet is available in every evergreen browser
 * (Chrome 66+, Firefox 76+, Safari 14.1+). Older browsers fall through
 * to a silent stub — the rest of the emulator still works fine.
 */
export class WebAudioSink implements AudioSink {
  /** AudioContext sample rate. Read after `start()` resolves. */
  sampleRate: number;
  private muted = false;
  private volume = 0.5;

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private starting: Promise<void> | null = null;

  constructor(preferredSampleRate = 44100) {
    this.sampleRate = preferredSampleRate;
  }

  /**
   * Lazy-construct the AudioContext + worklet. Must be called inside a
   * user gesture (button click) so the browser allows playback. Safe to
   * call multiple times; subsequent calls are no-ops.
   */
  async start(): Promise<void> {
    if (this.ctx) return;
    if (this.starting) return this.starting;

    const startPromise = (async () => {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return; // No AudioContext at all — silent stub.

      const ctx = new Ctor({ sampleRate: this.sampleRate });
      // The actual sample rate may differ from what we asked for.
      this.sampleRate = ctx.sampleRate;

      const url = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
      );
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const node = new AudioWorkletNode(ctx, 'poncho-apu', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      const gain = ctx.createGain();
      gain.gain.value = this.muted ? 0 : this.volume;
      node.connect(gain);
      gain.connect(ctx.destination);

      if (ctx.state === 'suspended') await ctx.resume();

      this.ctx = ctx;
      this.node = node;
      this.gain = gain;
    })();

    this.starting = startPromise;
    try {
      await startPromise;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    if (this.node) this.node.disconnect();
    if (this.gain) this.gain.disconnect();
    await this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.gain = null;
  }

  /**
   * Push `count` samples to the audio thread. Caller may pass a buffer
   * larger than `count`; only the prefix is forwarded. We use the
   * transferable form (`Float32Array.slice()` is needed because
   * postMessage with transfer requires the *exact* underlying buffer
   * boundary, and the caller's buffer may be reused).
   */
  push(samples: Float32Array, count: number): void {
    if (!this.node) return;
    if (count <= 0) return;
    // .slice() copies; the worklet receives a fresh ArrayBuffer it owns.
    const chunk = samples.slice(0, count);
    this.node.port.postMessage(chunk, [chunk.buffer]);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain && !this.muted) this.gain.gain.value = this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume;
  }
}

/**
 * The worklet code, run on the audio thread. Keeps a circular sample
 * buffer fed by main-thread `postMessage`; drains one frame per
 * `process()` call (the host calls this every 128 samples on most
 * implementations). On underrun emits the last sample to avoid clicks.
 */
const WORKLET_SOURCE = `
class PonchoApuProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 16384;
    this.buffer = new Float32Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
    this.last = 0;
    this.port.onmessage = (e) => {
      const samples = e.data;
      const n = samples.length;
      for (let i = 0; i < n; i++) {
        if (this.size < this.capacity) {
          this.buffer[this.tail] = samples[i];
          this.tail = (this.tail + 1) % this.capacity;
          this.size++;
        } else {
          // Drop oldest on overflow.
          this.buffer[this.tail] = samples[i];
          this.tail = (this.tail + 1) % this.capacity;
          this.head = (this.head + 1) % this.capacity;
        }
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      if (this.size > 0) {
        const v = this.buffer[this.head];
        this.head = (this.head + 1) % this.capacity;
        this.size--;
        this.last = v;
        out[i] = v;
      } else {
        out[i] = this.last;
      }
    }
    return true;
  }
}
registerProcessor('poncho-apu', PonchoApuProcessor);
`;
