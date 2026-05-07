/**
 * Phase 10 diagnostic: boots Contra through both Classic NES and
 * Poncho-NES, runs N frames, dumps state + framebuffers.
 *
 * Helps narrow down what's working / broken in the Poncho-NES upscaled
 * runtime when faced with a real game.
 *
 * Usage:
 *   tsx scripts/diagnose-contra.ts [frames]
 *
 * Output:
 *   /tmp/contra-nes.png        — reference frame from classic Nes
 *   /tmp/contra-poncho.png     — frame from PonchoNes (upscaled mode)
 *   /tmp/contra-diagnostic.txt — state diff
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { Nes } from '../src/console/nes';
import { PonchoNes } from '../src/console/poncho-nes';
import { convertInesToPoncho } from '../src/convert/ines-to-poncho';
import { NesButton, type ControllerSource } from '../src/core/input/source';

/** Scripted controller that reports a fixed set of buttons as held. */
class ScriptedSource implements ControllerSource {
  readonly name = 'scripted';
  private held = new Set<NesButton>();
  press(...buttons: NesButton[]): void { for (const b of buttons) this.held.add(b); }
  release(...buttons: NesButton[]): void { for (const b of buttons) this.held.delete(b); }
  pressed(button: NesButton): boolean { return this.held.has(button); }
}

const ROM = path.resolve('roms/Contra (USA).nes');
const OUT_DIR = '/tmp';

function main(): void {
  const frames = Number.parseInt(process.argv[2] ?? '120', 10);
  // Optional: simulate pressing Start at frame N to advance past the title.
  const startAt = process.argv[3] ? Number.parseInt(process.argv[3], 10) : -1;

  const inesBytes = new Uint8Array(fs.readFileSync(ROM));

  /**
   * Per-frame log of mid-frame PPU register writes ($2000/$2001/$2005/$2006).
   * Lets us see where scroll/PPUMASK changes happen during a frame and
   * whether the two consoles emit identical writes.
   */
  type RegWrite = [number /* scanline */, number /* dot */, number /* reg */, number /* value */];

  // -------- Classic NES reference --------
  const nes = new Nes();
  nes.loadRom(inesBytes);
  const nesScripted = new ScriptedSource();
  nes.setController(1, nesScripted);
  const nesWriteLog: RegWrite[] = [];
  const origNesWrite = nes.cpuBus.write.bind(nes.cpuBus);
  nes.cpuBus.write = (addr: number, value: number) => {
    if (addr >= 0x2000 && addr < 0x4000) {
      const reg = 0x2000 | (addr & 0x07);
      if (reg === 0x2000 || reg === 0x2001 || reg === 0x2005 || reg === 0x2006) {
        nesWriteLog.push([nes.ppu.scanline, nes.ppu.dot, reg, value]);
      }
    }
    origNesWrite(addr, value);
  };
  let nesFb;
  for (let i = 0; i < frames; i++) {
    if (i === startAt) nesScripted.press(NesButton.Start);
    if (i === startAt + 4) nesScripted.release(NesButton.Start);
    if (i === frames - 1) nesWriteLog.length = 0; // capture only the last frame
    nesFb = nes.runFrame();
  }
  if (!nesFb) throw new Error('classic nes produced no frame');

  fs.writeFileSync(path.join(OUT_DIR, 'contra-nes.png'), encodePng(nesFb.data, nesFb.width, nesFb.height, 1));

  // -------- Poncho-NES (upscaled mode) --------
  const { poncho, notes } = convertInesToPoncho(inesBytes, { title: 'Contra' });
  const pnes = new PonchoNes();
  pnes.loadRom(poncho);
  const pncScripted = new ScriptedSource();
  pnes.setController(1, pncScripted);

  // Track per-frame whether sprite-0 hit fired in PpuUltra. We poll
  // sprite0Hit at every CPU tick (3× faster than 1× per frame) and
  // record the maximum-true value across the frame.
  const hitFiredInFrame: boolean[] = [];
  const hitScanlineSeen: number[] = [];
  let hitFiredFlag = false;
  let lastHitScanline = -1;
  // Wrap the existing tick callback so we can observe.
  const origTickCb = (pnes.cpu as any).tickCallback;
  (pnes.cpu as any).tickCallback = () => {
    origTickCb();
    // After tick: pnes.ppu.sprite0Hit reflects whatever the tick set.
    if (pnes.ppu.sprite0Hit) {
      hitFiredFlag = true;
      lastHitScanline = (pnes.ppu as any).scanline ?? -1;
    }
  };

  const pncWriteLog: RegWrite[] = [];
  const origPncWrite = pnes.cpuBus.write.bind(pnes.cpuBus);
  pnes.cpuBus.write = (addr: number, value: number) => {
    if (addr >= 0x2000 && addr < 0x4000) {
      const reg = 0x2000 | (addr & 0x07);
      if (reg === 0x2000 || reg === 0x2001 || reg === 0x2005 || reg === 0x2006) {
        pncWriteLog.push([(pnes.ppu as any).scanline, (pnes.ppu as any).dot, reg, value]);
      }
    }
    origPncWrite(addr, value);
  };

  let pncFb;
  for (let i = 0; i < frames; i++) {
    if (i === startAt) pncScripted.press(NesButton.Start);
    if (i === startAt + 4) pncScripted.release(NesButton.Start);
    hitFiredFlag = false;
    if (i === frames - 1) pncWriteLog.length = 0;
    pncFb = pnes.runFrame();
    hitFiredInFrame.push(hitFiredFlag);
    hitScanlineSeen.push(lastHitScanline);
  }
  if (!pncFb) throw new Error('poncho-nes produced no frame');

  fs.writeFileSync(path.join(OUT_DIR, 'contra-poncho.png'), encodePng(pncFb.data, pncFb.width, pncFb.height, 1));

  // -------- Diagnostic dump --------
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  log('CONTRA — POST-FRAME DIAGNOSTIC');
  log(`frames run: ${frames} (Start pressed at frame ${startAt}, released at ${startAt + 4})`);
  log('');
  log('CROSS-CONSOLE COMPARISON');
  log(`  CPU pc match:    NES=$${nes.cpu.pc.toString(16)} Poncho=$${pnes.cpu.pc.toString(16)} ` +
      `${nes.cpu.pc === pnes.cpu.pc ? '✓' : '✗ DIVERGED'}`);
  // Compare a few RAM bytes typically used as game state (zero-page).
  const nesRam = (nes as any).cpuBus?.ram as Uint8Array | undefined;
  const pncRam = (pnes as any).cpuBus?.ram as Uint8Array | undefined;
  if (nesRam && pncRam) {
    let same = 0, diff = 0;
    for (let i = 0; i < 0x800; i++) (nesRam[i] === pncRam[i] ? same++ : diff++);
    log(`  CPU RAM bytes (2 KB):    same=${same} diff=${diff}` +
        (diff > 0 ? ' ✗ DIVERGED' : ' ✓'));
  }
  // Compare OAM
  let oamSame = 0, oamDiff = 0;
  const nesOam = (nes.ppu as any).oam as Uint8Array | undefined;
  if (nesOam) {
    for (let i = 0; i < 256; i++) (nesOam[i] === pnes.ppu.oamRam[i] ? oamSame++ : oamDiff++);
    log(`  OAM bytes (first 256):   same=${oamSame} diff=${oamDiff}` +
        (oamDiff > 0 ? ' ✗ DIVERGED' : ' ✓'));
  }
  // Compare palette (iNES PPU stores it on the PPU bus)
  let palSame = 0, palDiff = 0;
  const nesPalRam = (nes as any).ppuBus?.palette as Uint8Array | undefined;
  if (nesPalRam) {
    const palDiffOffsets: number[] = [];
    for (let i = 0; i < 32; i++) {
      if (nesPalRam[i] === pnes.ppu.paletteRam[i]) {
        palSame++;
      } else {
        palDiff++;
        palDiffOffsets.push(i);
      }
    }
    log(`  palette bytes (32):      same=${palSame} diff=${palDiff}` +
        (palDiff > 0 ? ` ✗ at offsets ${palDiffOffsets.map(o => '$3F' + o.toString(16).padStart(2,'0').toUpperCase()).join(' ')}` : ' ✓'));
  }
  // Show which RAM regions differ.
  if (nesRam && pncRam) {
    const ramDiffRegions: Array<[number, number]> = [];
    let regionStart = -1;
    for (let i = 0; i <= 0x800; i++) {
      const same = i < 0x800 && nesRam[i] === pncRam[i];
      if (!same && regionStart === -1) regionStart = i;
      if (same && regionStart !== -1) {
        ramDiffRegions.push([regionStart, i - 1]);
        regionStart = -1;
      }
    }
    if (ramDiffRegions.length > 0) {
      log(`  RAM diff regions (first 8): ${ramDiffRegions.slice(0, 8)
        .map(([a, b]) => `\$${a.toString(16).padStart(3,'0')}-\$${b.toString(16).padStart(3,'0')}`).join(' ')}`);
    }
  }
  log('');

  log('');
  log('CONVERSION');
  log(`  source mapper:  ${notes.sourceMapper} (${['NROM','MMC1','UxROM','CNROM','MMC3','?','?','AxROM'][notes.bankingVariant]})`);
  log(`  source mirror:  ${notes.sourceMirroring}`);
  log(`  PRG:            ${notes.prgKb} KB`);
  log(`  CHR:            ${notes.chrKb || notes.chrRamKb} KB ${notes.chrRamKb > 0 ? '(RAM)' : '(ROM)'}`);
  log('');

  log('CLASSIC NES STATE');
  const nesPpu = nes.ppu as any;
  log(`  CPU pc:         $${nes.cpu.pc.toString(16).padStart(4, '0').toUpperCase()}`);
  log(`  PPU scanline:   ${nes.ppu.scanline}, dot ${nes.ppu.dot}`);
  // PpuStatus.SpriteZeroHit = 0x40
  log(`  PPU status:               $${(nesPpu.regs?.status ?? 0).toString(16).padStart(2,'0')} ` +
      `(sprite0Hit=${((nesPpu.regs?.status ?? 0) & 0x40) ? 'YES' : 'no'})`);
  log(`  PPU regs.ctrl:            $${(nesPpu.regs?.ctrl ?? 0).toString(16).padStart(2,'0')}`);
  log(`  PPU regs.mask:            $${(nesPpu.regs?.mask ?? 0).toString(16).padStart(2,'0')}`);
  log(`  framebuffer:    ${nesFb.width}×${nesFb.height} non-bg pixels: ${countNonBg(nesFb.data)}`);
  log(`  distinct colors: ${distinctColors(nesFb.data)}`);
  log('');

  log('PONCHO-NES STATE');
  // Hit-fire history — useful to know IF and WHERE sprite-0 hit fired this frame.
  const recentFireCount = hitFiredInFrame.slice(-30).filter(Boolean).length;
  log(`  sprite-0 hit fired: this frame=${hitFiredInFrame[hitFiredInFrame.length - 1]}, ` +
      `last 30 frames: ${recentFireCount}/30 (last hit scanline = ${lastHitScanline})`);
  log(`  CPU pc:         $${pnes.cpu.pc.toString(16).padStart(4, '0').toUpperCase()}`);
  // PpuUltra fields (some are public, some private — we read what we can)
  log(`  framebuffer:    ${pncFb.width}×${pncFb.height} non-bg pixels: ${countNonBg(pncFb.data)}`);
  log(`  distinct colors: ${distinctColors(pncFb.data)}`);
  log(`  PpuUltra.sprite0Hit:    ${pnes.ppu.sprite0Hit}`);
  log(`  PpuUltra.showBackground: ${pnes.ppu.showBackground}`);
  log(`  PpuUltra.showSprites:    ${pnes.ppu.showSprites}`);
  log(`  PpuUltra.maskByte: $${pnes.ppu.maskByte.toString(16).padStart(2, '0')}`);
  log(`  PpuUltra.nmiEnabled:    ${pnes.ppu.nmiEnabled}`);
  log(`  PpuUltra.spriteSize16:   ${pnes.ppu.spriteSize16}`);
  log(`  PpuUltra.bgPatternBase:  $${pnes.ppu.bgPatternBase.toString(16)}`);
  log(`  PpuUltra.spritePatternBase: $${pnes.ppu.spritePatternBase.toString(16)}`);
  log(`  PpuUltra.baseNametable:  ${pnes.ppu.baseNametable}`);
  log(`  PpuUltra.scrollX/Y:       ${(pnes.ppu as any).scrollX}/${(pnes.ppu as any).scrollY}`);
  log(`  iNES PPU regs.t:          $${((nes.ppu as any).regs?.t ?? 0).toString(16).padStart(4, '0')} ` +
      `(coarse-X=${((nes.ppu as any).regs?.t ?? 0) & 0x1f}, ` +
      `coarse-Y=${(((nes.ppu as any).regs?.t ?? 0) >> 5) & 0x1f}, ` +
      `nt=${(((nes.ppu as any).regs?.t ?? 0) >> 10) & 0x3}, ` +
      `fineY=${(((nes.ppu as any).regs?.t ?? 0) >> 12) & 0x7})`);
  log(`  iNES PPU regs.x (fine X): ${(nes.ppu as any).regs?.x ?? '?'}`);
  log('');

  // Sample a small chunk of the palette RAM
  log(`  paletteRam[0..7]:  ${Array.from(pnes.ppu.paletteRam.slice(0, 8))
    .map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`);
  log(`  paletteRam[8..15]: ${Array.from(pnes.ppu.paletteRam.slice(8, 16))
    .map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`);
  log(`  paletteRam[16..23]: ${Array.from(pnes.ppu.paletteRam.slice(16, 24))
    .map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`);
  log(`  paletteRam[24..31]: ${Array.from(pnes.ppu.paletteRam.slice(24, 32))
    .map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`);
  log('');

  // OAM activity — first 16 bytes
  log(`  OAM[0..15]: ${Array.from(pnes.ppu.oamRam.slice(0, 16))
    .map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`);
  // Shadow OAM in CPU RAM (Contra uses $0200 by convention).
  if (pncRam) {
    log(`  CPU RAM $0200-$020F (shadow OAM): ${Array.from(pncRam.slice(0x200, 0x210))
      .map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  if (nesRam) {
    log(`  NES CPU RAM $0200-$020F (ref):    ${Array.from(nesRam.slice(0x200, 0x210))
      .map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  // Count non-FF bytes in OAM (FF = uninit / off-screen)
  let oamUsed = 0;
  for (let i = 0; i < 256; i++) if (pnes.ppu.oamRam[i] !== 0xff) oamUsed++;
  log(`  OAM bytes != 0xFF (in first 256): ${oamUsed}`);
  // Count sprites with priority bit set (attr bit 5 = "behind BG")
  let spritesWithPriority = 0;
  let visibleSprites = 0;
  const visibleSpriteList: Array<[number, number, number, number, number]> = [];
  for (let s = 0; s < 64; s++) {
    const y = pnes.ppu.oamRam[s * 4]!;
    const tile = pnes.ppu.oamRam[s * 4 + 1]!;
    const attr = pnes.ppu.oamRam[s * 4 + 2]!;
    const x = pnes.ppu.oamRam[s * 4 + 3]!;
    if (y >= 0xef) continue;
    visibleSprites++;
    if (attr & 0x20) spritesWithPriority++;
    visibleSpriteList.push([s, x, y, tile, attr]);
  }
  log(`  Visible sprites: ${visibleSprites}, with priority-bit-5 (behind BG): ${spritesWithPriority}`);
  // Sort by y to show what's at the top.
  visibleSpriteList.sort((a, b) => a[2] - b[2]);
  log(`  First 10 visible sprites by y:`);
  for (const [s, x, y, tile, attr] of visibleSpriteList.slice(0, 10)) {
    log(`    sprite ${s}: x=${x} y=${y} tile=$${tile.toString(16).padStart(2,'0')} attr=$${attr.toString(16).padStart(2,'0')}`);
  }
  log('');

  // CHR-RAM activity
  if (pnes.cartridge && pnes.cartridge.chrIsRam) {
    let chrWritten = 0;
    for (let i = 0; i < 8192; i++) {
      if (pnes.cartridge.chr[i] !== 0) chrWritten++;
    }
    log(`  CHR-RAM non-zero bytes: ${chrWritten} / 8192`);
    log(`  CHR-RAM[0..15] (tile 0): ${Array.from(pnes.cartridge.chr.slice(0, 16))
      .map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  log('');

  // Nametable activity + cross-console comparison
  let nt0Used = 0;
  for (let i = 0; i < 1024; i++) if (pnes.ppu.nametableRam[i] !== 0) nt0Used++;
  let nt1Used = 0;
  for (let i = 1024; i < 2048; i++) if (pnes.ppu.nametableRam[i] !== 0) nt1Used++;
  log(`  nametable page 0 non-zero: ${nt0Used} / 1024`);
  log(`  nametable page 1 non-zero: ${nt1Used} / 1024`);

  // Compare with iNES PPU vram
  const nesVram = (nes as any).ppuBus?.vram as Uint8Array | undefined;
  if (nesVram) {
    let ntDiff = 0;
    for (let i = 0; i < 2048; i++) {
      if (nesVram[i] !== pnes.ppu.nametableRam[i]) ntDiff++;
    }
    log(`  nametable diff vs classic NES: ${ntDiff} bytes`);
  }
  // Compare CHR-RAM
  const nesChr = (nes as any).cartridge?.mapper?.chr as Uint8Array | undefined;
  if (nesChr && pnes.cartridge) {
    let chrDiff = 0;
    for (let i = 0; i < pnes.cartridge.chr.length && i < nesChr.length; i++) {
      if (nesChr[i] !== pnes.cartridge.chr[i]) chrDiff++;
    }
    log(`  CHR diff vs classic NES: ${chrDiff} bytes (length: ${pnes.cartridge.chr.length})`);
    // Tile $02 bytes (top tile of sprite 46) and $03 (bottom tile).
    if (pnes.cartridge.chr.length >= 64) {
      log(`  CHR tile $02 (16 bytes): ${Array.from(pnes.cartridge.chr.slice(0x20, 0x30))
        .map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      log(`  CHR tile $03 (16 bytes): ${Array.from(pnes.cartridge.chr.slice(0x30, 0x40))
        .map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  }

  log('');
  log('LAST FRAME PPU REGISTER WRITES (NES vs Poncho)');
  const regName = (r: number) => ({ 0x2000: 'PPUCTRL', 0x2001: 'PPUMASK', 0x2005: 'PPUSCROLL', 0x2006: 'PPUADDR' } as Record<number, string>)[r] ?? '$' + r.toString(16);
  log(`  classic NES writes (${nesWriteLog.length}):`);
  for (let i = 0; i < Math.min(nesWriteLog.length, 30); i++) {
    const [s, d, r, v] = nesWriteLog[i]!;
    log(`    line=${s} dot=${d}  ${regName(r)} <- $${v.toString(16).padStart(2,'0')}`);
  }
  log(`  Poncho writes (${pncWriteLog.length}):`);
  for (let i = 0; i < Math.min(pncWriteLog.length, 30); i++) {
    const [s, d, r, v] = pncWriteLog[i]!;
    log(`    line=${s} dot=${d}  ${regName(r)} <- $${v.toString(16).padStart(2,'0')}`);
  }

  log('');
  log('PIXEL COMPARISON — every NES pixel vs Poncho 4×4 block top-left');
  // Walk every NES pixel; count how many match the corresponding Poncho px.
  let total = 0, matches = 0, mismatches = 0;
  let firstMismatchAt: [number, number] | null = null;
  const mismatchByRow = new Map<number, number>();
  for (let ny = 0; ny < 240; ny++) {
    for (let nx = 0; nx < 256; nx++) {
      total++;
      const n = nesFb.data[ny * 256 + nx]!;
      const p = pncFb.data[(ny * 4) * 1024 + (nx * 4)]!;
      if (n === p) {
        matches++;
      } else {
        mismatches++;
        if (firstMismatchAt === null) firstMismatchAt = [nx, ny];
        mismatchByRow.set(ny, (mismatchByRow.get(ny) ?? 0) + 1);
      }
    }
  }
  log(`  total: ${total}, matches: ${matches} (${((matches/total)*100).toFixed(1)}%), mismatches: ${mismatches}`);
  // Classify mismatches
  let bgOnlyNes = 0, bgOnlyPnc = 0, bothColored = 0;
  // Sample bgColor — pure black is the typical NES universal-BG
  const blackish = 0xff000000;
  for (let ny = 0; ny < 240; ny++) {
    for (let nx = 0; nx < 256; nx++) {
      const n = nesFb.data[ny * 256 + nx]!;
      const p = pncFb.data[(ny * 4) * 1024 + (nx * 4)]!;
      if (n === p) continue;
      if (n === blackish && p !== blackish) bgOnlyPnc++; // Poncho shows extra
      else if (p === blackish && n !== blackish) bgOnlyNes++; // Poncho missing
      else bothColored++; // wrong
    }
  }
  log(`    Poncho shows extra (NES=black, Poncho=color): ${bgOnlyPnc}`);
  log(`    Poncho missing (NES=color, Poncho=black): ${bgOnlyNes}`);
  log(`    Wrong content (both colored, different): ${bothColored}`);
  if (firstMismatchAt) {
    const [mx, my] = firstMismatchAt;
    log(`  first mismatch at NES (${mx},${my}): NES=${pixHex(nesFb.data[my * 256 + mx]!)} ` +
        `Poncho=${pixHex(pncFb.data[(my * 4) * 1024 + (mx * 4)]!)}`);
  }
  if (mismatchByRow.size > 0) {
    const worst = [...mismatchByRow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    log(`  worst rows (NES y, mismatches): ${worst.map(([y, c]) => `${y}:${c}`).join(', ')}`);
    // Find the columns where the worst row mismatches.
    const [worstY] = worst[0]!;
    const cols: number[] = [];
    for (let nx = 0; nx < 256; nx++) {
      const n = nesFb.data[worstY * 256 + nx]!;
      const p = pncFb.data[(worstY * 4) * 1024 + (nx * 4)]!;
      if (n !== p) cols.push(nx);
    }
    log(`  row ${worstY} mismatch cols: ${cols.slice(0, 20).join(',')}${cols.length > 20 ? `... (${cols.length} total)` : ''}`);
    log(`  row ${worstY} mismatch examples:`);
    for (const nx of cols.slice(0, 5)) {
      const n = nesFb.data[worstY * 256 + nx]!;
      const p = pncFb.data[(worstY * 4) * 1024 + (nx * 4)]!;
      log(`    NES (${nx},${worstY})=${pixHex(n)}  Poncho=${pixHex(p)}`);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'contra-diagnostic.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  console.log(`\nWrote /tmp/contra-nes.png /tmp/contra-poncho.png /tmp/contra-diagnostic.txt`);
}

function countNonBg(data: Uint32Array): number {
  // bg = palette[0]; we don't know its value here, so just count distinct from data[0].
  const ref = data[0];
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] !== ref) n++;
  return n;
}

function distinctColors(data: Uint32Array): number {
  const set = new Set<number>();
  for (let i = 0; i < data.length; i++) {
    set.add(data[i]!);
    if (set.size > 64) break; // good enough
  }
  return set.size;
}

function pixHex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

// ---------- Minimal PNG encoder (lifted from render-screenshot.ts) ----------

function encodePng(pixels: Uint32Array, w: number, h: number, s: number): Buffer {
  const W = w * s;
  const H = h * s;
  const rowSize = W * 3 + 1;
  const raw = Buffer.alloc(rowSize * H);
  for (let y = 0; y < H; y++) {
    const srcY = (y / s) | 0;
    let off = y * rowSize;
    raw[off++] = 0;
    for (let x = 0; x < W; x++) {
      const srcX = (x / s) | 0;
      const p = pixels[srcY * w + srcX]!;
      raw[off++] = p & 0xff;
      raw[off++] = (p >>> 8) & 0xff;
      raw[off++] = (p >>> 16) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

main();
