/**
 * Icon helpers for the GUI.
 *
 * Two icon sources are mixed:
 *   - **Lucide** (ISC) — clean line-icons used everywhere except where
 *     a thematic accent is wanted. Lucide ships as ESM, so individual
 *     imports tree-shake cleanly. See https://lucide.dev.
 *   - **Game Icons** (CC BY 3.0) — a small set of game-themed SVGs in
 *     `./icons-game/` (cartridge, cassette, gamepad, controller, joystick, save).
 *     Their canonical format is "negative space": a solid black 512x512
 *     background plus a white foreground. We strip the background and
 *     swap the white fill for `currentColor` at runtime so they tint
 *     to whatever CSS color the parent has.
 *
 * Use `mountLucideIcons(root)` once after rendering HTML that contains
 * `<i data-lucide="...">` placeholders — Lucide replaces them with SVG.
 *
 * Use `gameIcon(name)` to get a ready-to-mount Game Icons SVG element.
 *
 * Both helpers return live DOM nodes; CSS controls size + color.
 */
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FilePlus2,
  Folder,
  HardDrive,
  Keyboard,
  Link,
  Monitor,
  PackageOpen,
  Paperclip,
  Pause,
  Play,
  Plus,
  Power,
  RotateCcw,
  Settings,
  Sliders,
  Sun,
  Upload,
  Volume2,
  VolumeX,
  X,
  createIcons,
} from 'lucide';

import cartridgeSvg from './icons-game/cartridge.svg?raw';
import cassetteSvg from './icons-game/cassette.svg?raw';
import gamepadSvg from './icons-game/gamepad.svg?raw';
import joystickSvg from './icons-game/joystick.svg?raw';
import retroControllerSvg from './icons-game/retro-controller.svg?raw';
import saveSvg from './icons-game/save.svg?raw';

/**
 * Register the Lucide icon set and replace any `<i data-lucide="name">`
 * placeholders found in the document with their matching SVG. Safe to
 * call multiple times — already-rendered nodes are skipped.
 */
export function mountLucideIcons(): void {
  createIcons({
    icons: {
      ChevronDown,
      ChevronLeft,
      ChevronRight,
      Cpu,
      FilePlus2,
      Folder,
      HardDrive,
      Keyboard,
      Link,
      Monitor,
      PackageOpen,
      Paperclip,
      Pause,
      Play,
      Plus,
      Power,
      RotateCcw,
      Settings,
      Sliders,
      Sun,
      Upload,
      Volume2,
      VolumeX,
      X,
    },
    attrs: { 'stroke-width': '1.75', 'aria-hidden': 'true' },
  });
}

export type GameIconName =
  | 'cartridge'
  | 'cassette'
  | 'gamepad'
  | 'joystick'
  | 'retro-controller'
  | 'save';

const GAME_ICON_SOURCES: Record<GameIconName, string> = {
  cartridge: cartridgeSvg,
  cassette: cassetteSvg,
  gamepad: gamepadSvg,
  joystick: joystickSvg,
  'retro-controller': retroControllerSvg,
  save: saveSvg,
};

/**
 * Build an `<svg>` element from one of our Game Icons. Strips the black
 * background rectangle and swaps the white fg fill for `currentColor`,
 * so the icon tints to whatever color the CSS parent specifies.
 */
export function gameIcon(name: GameIconName): SVGElement {
  const raw = GAME_ICON_SOURCES[name];
  // Game Icons format: <svg ...><path d="M0 0h512v512H0z"/><path fill="#fff" d="..."/></svg>
  // Drop the first <path> (background); replace fill="#fff" with currentColor.
  const cleaned = raw
    .replace(/<path d="M0 0h512v512H0z"\/>/, '')
    .replace(/fill="#fff"/g, 'fill="currentColor"');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cleaned;
  const svg = wrapper.firstElementChild as SVGElement;
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}
