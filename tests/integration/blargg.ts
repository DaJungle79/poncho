/**
 * Headless runner for blargg-style test ROMs.
 *
 * The shared protocol used by every blargg test ROM:
 *   $6000      Result code. While the test is running this is $80; when
 *              the test finishes it becomes 0 (pass) or any other value
 *              (failure code).
 *   $6001-3    Signature bytes "DE B0 61" — written *while the test is
 *              running properly*. We only treat $6000 as authoritative once
 *              the signature is in place.
 *   $6004…     ASCII status message terminated by $00 (e.g. "Passed",
 *              "Failed: <test name>").
 *
 * We poll those bytes on a coarse interval to keep the inner loop tight,
 * then return a structured result. The runner is deliberately mapper-/PPU-
 * agnostic: it just steps the CPU and inspects RAM through the bus, so it
 * works for any ROM that uses the blargg protocol.
 */
import { readFileSync } from 'node:fs';
import { Nes } from '../../src/console/nes';

const SIG = [0xde, 0xb0, 0x61] as const;
const STATE_RUNNING = 0x80;
const MESSAGE_BASE = 0x6004;
const MESSAGE_END = 0x8000;

export interface BlarggResult {
  passed: boolean;
  /** Final value at $6000. 0 = pass; non-zero = failure code. */
  code: number;
  /** ASCII status message read from $6004 onward. */
  message: string;
  /** True if the runner observed the sig at $6001-$6003 before timing out. */
  signatureValid: boolean;
  /** Total CPU cycles executed by the runner. */
  totalCycles: number;
  /** Total CPU step() calls (instructions + interrupt services). */
  totalSteps: number;
  /** True if the runner hit its step budget before the test settled. */
  timedOut: boolean;
  /** Final CPU PC, A, X, Y, P, SP. */
  cpu: { pc: number; a: number; x: number; y: number; p: number; sp: number };
  /** Last unique PC values observed at the end of the run (debug aid). */
  recentPcs: number[];
}

export interface BlarggOptions {
  /**
   * Maximum CPU step() calls. Default 30 million ≈ ~50 seconds of simulated
   * NES time, which is enough headroom for every blargg suite.
   */
  maxSteps?: number;
  /**
   * Polling interval in steps. Smaller = earlier termination, slightly
   * more overhead. The default keeps overhead negligible.
   */
  pollEvery?: number;
}

export function runBlarggRom(romPath: string, options: BlarggOptions = {}): BlarggResult {
  const data = new Uint8Array(readFileSync(romPath));
  const nes = new Nes();
  nes.loadRom(data);

  const maxSteps = options.maxSteps ?? 30_000_000;
  const pollEvery = options.pollEvery ?? 1024;

  let totalCycles = 0;
  let totalSteps = 0;
  let signatureValid = false;
  let code = STATE_RUNNING;
  let timedOut = true;

  // Tail buffer of recent PCs — useful for diagnosing hangs.
  const TAIL = 16;
  const tail: number[] = new Array(TAIL).fill(0);
  let tailIdx = 0;

  while (totalSteps < maxSteps) {
    tail[tailIdx] = nes.cpu.pc;
    tailIdx = (tailIdx + 1) % TAIL;
    totalCycles += nes.step();
    totalSteps++;

    if (totalSteps % pollEvery !== 0) continue;

    const sig0 = nes.cpuBus.read(0x6001);
    const sig1 = nes.cpuBus.read(0x6002);
    const sig2 = nes.cpuBus.read(0x6003);
    signatureValid = sig0 === SIG[0] && sig1 === SIG[1] && sig2 === SIG[2];
    code = nes.cpuBus.read(0x6000);

    if (signatureValid && code !== STATE_RUNNING) {
      timedOut = false;
      break;
    }
  }

  // Re-read once at the very end (in case we exited just before a poll).
  if (timedOut) {
    const sig0 = nes.cpuBus.read(0x6001);
    const sig1 = nes.cpuBus.read(0x6002);
    const sig2 = nes.cpuBus.read(0x6003);
    signatureValid = sig0 === SIG[0] && sig1 === SIG[1] && sig2 === SIG[2];
    code = nes.cpuBus.read(0x6000);
    if (signatureValid && code !== STATE_RUNNING) timedOut = false;
  }

  // Pull the ASCII message from $6004 up to the first NUL.
  const bytes: number[] = [];
  for (let addr = MESSAGE_BASE; addr < MESSAGE_END; addr++) {
    const b = nes.cpuBus.read(addr);
    if (b === 0) break;
    if (b >= 0x20 && b < 0x7f) bytes.push(b);
    else if (b === 0x0a) bytes.push(b); // newline
  }
  const message = String.fromCharCode(...bytes).trim();

  // Order tail starting at the oldest entry, dedup adjacent.
  const ordered: number[] = [];
  for (let i = 0; i < TAIL; i++) {
    const pc = tail[(tailIdx + i) % TAIL];
    if (ordered.length === 0 || ordered[ordered.length - 1] !== pc) ordered.push(pc);
  }

  return {
    passed: signatureValid && code === 0,
    code,
    message,
    signatureValid,
    totalCycles,
    totalSteps,
    timedOut,
    cpu: {
      pc: nes.cpu.pc,
      a: nes.cpu.a,
      x: nes.cpu.x,
      y: nes.cpu.y,
      p: nes.cpu.p,
      sp: nes.cpu.sp,
    },
    recentPcs: ordered,
  };
}
