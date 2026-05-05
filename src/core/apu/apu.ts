/**
 * 2A03 APU — top-level orchestrator.
 *
 * Hosts the four sound channels (pulse 1, pulse 2, triangle, noise) plus
 * DMC, the frame counter, and the mixer. Exposes the CPU-side register
 * interface ($4000-$4017) and produces a stream of mono float samples
 * for the AudioSink to consume.
 *
 * Cycle scheduling:
 *   - `tick()` is called once per CPU cycle from the CPU's tick callback.
 *   - Triangle and DMC tick on every CPU cycle.
 *   - Pulse and noise tick at half rate (every other CPU cycle).
 *   - The frame counter ticks every CPU cycle.
 *   - A sample-rate accumulator emits one mixed sample roughly every
 *     `cpuRate / sampleRate` cycles into a circular sample buffer.
 *
 * IRQ surface: the union of frame-counter IRQ and DMC IRQ.
 *
 * Reference: nesdev wiki "APU".
 */
import { Filters } from './filters';
import { FrameCounter } from './frame-counter';
import { mixSample } from './mixer';
import { Noise } from './noise';
import { Pulse } from './pulse';
import { Triangle } from './triangle';
import { Dmc, type DmcReader } from './dmc';
import { DEFAULT_SAMPLE_RATE, NTSC_CPU_HZ } from './timing';

/** Maximum samples held in the ring buffer before we start dropping. */
const SAMPLE_QUEUE_CAPACITY = 8192;

export class Apu {
  readonly pulse1 = new Pulse(0);
  readonly pulse2 = new Pulse(1);
  readonly triangle = new Triangle();
  readonly noise = new Noise();
  readonly dmc = new Dmc();

  private readonly frame: FrameCounter;
  private filters: Filters;

  // ----- Sample emission state ---------------------------------------------
  private cpuRate = NTSC_CPU_HZ;
  private sampleRate = DEFAULT_SAMPLE_RATE;
  /** Cycles-per-sample as float; we accumulate fractional residue. */
  private cyclesPerSample = NTSC_CPU_HZ / DEFAULT_SAMPLE_RATE;
  private cycleAccumulator = 0;

  /** Ring buffer of recent samples, drained by `pullSamples`. */
  private readonly queue = new Float32Array(SAMPLE_QUEUE_CAPACITY);
  private queueHead = 0;
  private queueTail = 0;
  private queueSize = 0;

  /** True after $4017 bit 6 (IRQ inhibit) is *cleared*; tracked here to
   *  surface the union IRQ pin to the CPU. */
  private cycleEvenOdd = false;

  constructor() {
    this.frame = new FrameCounter({
      onQuarterFrame: () => this.onQuarterFrame(),
      onHalfFrame: () => this.onHalfFrame(),
    });
    this.filters = new Filters(this.sampleRate);
  }

  // ----- Lifecycle ---------------------------------------------------------

  reset(): void {
    this.pulse1.reset();
    this.pulse2.reset();
    this.triangle.reset();
    this.noise.reset();
    this.dmc.reset();
    this.frame.reset();
    this.cycleAccumulator = 0;
    this.queueHead = 0;
    this.queueTail = 0;
    this.queueSize = 0;
    this.cycleEvenOdd = false;
    this.filters.reset();
  }

  /** Configure output sample rate. Recomputes the cycles-per-sample ratio. */
  setSampleRate(rate: number): void {
    this.sampleRate = Math.max(1, rate);
    this.cyclesPerSample = this.cpuRate / this.sampleRate;
    this.filters = new Filters(this.sampleRate);
  }

  /** Set the CPU memory reader the DMC uses to fetch sample bytes. */
  setDmcReader(fn: DmcReader): void {
    this.dmc.setReader(fn);
  }

  // ----- Per-CPU-cycle tick ------------------------------------------------

  /**
   * Advance the APU by one CPU cycle. Triangle and DMC are full-rate;
   * pulse/noise tick on every other cycle (the APU runs at CPU/2).
   */
  tick(): void {
    this.frame.tick();
    this.triangle.tickTimer();
    this.dmc.tickTimer();
    if (this.cycleEvenOdd) {
      this.pulse1.tickTimer();
      this.pulse2.tickTimer();
      this.noise.tickTimer();
    }
    this.cycleEvenOdd = !this.cycleEvenOdd;

    // Sample emission: accumulate cycles, emit when we cross the threshold.
    this.cycleAccumulator++;
    if (this.cycleAccumulator >= this.cyclesPerSample) {
      this.cycleAccumulator -= this.cyclesPerSample;
      this.emitSample();
    }
  }

  // ----- CPU register interface --------------------------------------------

  /**
   * $4015 read returns the channel-active flags + frame counter IRQ flag.
   * Reading also acknowledges (clears) the frame counter IRQ.
   */
  cpuRead(addr: number): number {
    if ((addr & 0x1f) === 0x15) {
      let v = 0;
      if (this.pulse1.isActive())   v |= 0x01;
      if (this.pulse2.isActive())   v |= 0x02;
      if (this.triangle.isActive()) v |= 0x04;
      if (this.noise.isActive())    v |= 0x08;
      if (this.dmc.isActive())      v |= 0x10;
      if (this.frame.irqPending())  v |= 0x40;
      if (this.dmc.irqPending())    v |= 0x80;
      this.frame.irqAcknowledge();
      return v;
    }
    return 0;
  }

  /** Route writes for $4000-$4017 to the right channel / unit. */
  cpuWrite(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr >= 0x4000 && addr <= 0x4003) {
      this.pulse1.write((addr - 0x4000) as 0 | 1 | 2 | 3, value);
    } else if (addr >= 0x4004 && addr <= 0x4007) {
      this.pulse2.write((addr - 0x4004) as 0 | 1 | 2 | 3, value);
    } else if (addr >= 0x4008 && addr <= 0x400b) {
      this.triangle.write((addr - 0x4008) as 0 | 1 | 2 | 3, value);
    } else if (addr >= 0x400c && addr <= 0x400f) {
      this.noise.write((addr - 0x400c) as 0 | 1 | 2 | 3, value);
    } else if (addr >= 0x4010 && addr <= 0x4013) {
      this.dmc.write((addr - 0x4010) as 0 | 1 | 2 | 3, value);
    } else if (addr === 0x4015) {
      this.pulse1.setEnabled  ((value & 0x01) !== 0);
      this.pulse2.setEnabled  ((value & 0x02) !== 0);
      this.triangle.setEnabled((value & 0x04) !== 0);
      this.noise.setEnabled   ((value & 0x08) !== 0);
      this.dmc.setEnabled     ((value & 0x10) !== 0);
      // Writing $4015 acknowledges DMC IRQ but NOT frame IRQ.
      this.dmc.irqClear();
    } else if (addr === 0x4017) {
      this.frame.write(value);
    }
  }

  // ----- IRQ surface -------------------------------------------------------

  irqPending(): boolean {
    return this.frame.irqPending() || this.dmc.irqPending();
  }

  // ----- Sample queue (drained by AudioSink) -------------------------------

  /**
   * Drain up to `out.length` queued samples into `out`. Pads with the
   * last-emitted sample (or 0 if none) when the queue underruns, so the
   * audio thread never hears a gap of true silence — just a held value.
   * Returns the number of *fresh* samples written.
   */
  pullSamples(out: Float32Array): number {
    let written = 0;
    let lastValue = 0;
    while (written < out.length && this.queueSize > 0) {
      lastValue = this.queue[this.queueHead];
      out[written++] = lastValue;
      this.queueHead = (this.queueHead + 1) % SAMPLE_QUEUE_CAPACITY;
      this.queueSize--;
    }
    while (written < out.length) {
      out[written++] = lastValue;
    }
    return written;
  }

  /** Diagnostic: how many samples are queued for playback. */
  queuedSamples(): number { return this.queueSize; }

  // -------------------------------------------------------------------------
  // Internal: callbacks routed from the frame counter and per-cycle path
  // -------------------------------------------------------------------------

  private onQuarterFrame(): void {
    this.pulse1.clockEnvelope();
    this.pulse2.clockEnvelope();
    this.triangle.clockLinear();
    this.noise.clockEnvelope();
  }

  private onHalfFrame(): void {
    this.pulse1.clockHalfFrame();
    this.pulse2.clockHalfFrame();
    this.triangle.clockHalfFrame();
    this.noise.clockHalfFrame();
  }

  private emitSample(): void {
    const raw = mixSample({
      pulse1: this.pulse1.output(),
      pulse2: this.pulse2.output(),
      triangle: this.triangle.output(),
      noise: this.noise.output(),
      dmc: this.dmc.output(),
    });
    const filtered = this.filters.process(raw);
    if (this.queueSize < SAMPLE_QUEUE_CAPACITY) {
      this.queue[this.queueTail] = filtered;
      this.queueTail = (this.queueTail + 1) % SAMPLE_QUEUE_CAPACITY;
      this.queueSize++;
    } else {
      // Overflow: drop the oldest sample.
      this.queue[this.queueTail] = filtered;
      this.queueTail = (this.queueTail + 1) % SAMPLE_QUEUE_CAPACITY;
      this.queueHead = (this.queueHead + 1) % SAMPLE_QUEUE_CAPACITY;
    }
  }
}
