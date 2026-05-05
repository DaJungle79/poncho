import type { Config, KeyBindings } from '../../config/schema';
import type { ConfigStore } from '../../config/store';
import { DEFAULT_PLAYER1_KEYS } from '../../config/defaults';
import { NesButton } from '../../core/input/source';
import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';

export interface ControlsPanelDeps {
  config: ConfigStore;
  /** Called after a binding change so the host can rebuild the keyboard source. */
  onBindingsChanged: (bindings: KeyBindings) => void;
}

const BUTTONS: { key: NesButton; label: string }[] = [
  { key: NesButton.Up,     label: 'Up' },
  { key: NesButton.Down,   label: 'Down' },
  { key: NesButton.Left,   label: 'Left' },
  { key: NesButton.Right,  label: 'Right' },
  { key: NesButton.A,      label: 'A' },
  { key: NesButton.B,      label: 'B' },
  { key: NesButton.Select, label: 'Select' },
  { key: NesButton.Start,  label: 'Start' },
];

/**
 * Slide-out (L3) controls form. Each row shows one NES button with its
 * currently-bound key code; click a row to enter "press a key" mode and
 * the next keydown captures the new binding. Reset button restores the
 * defaults from `DEFAULT_PLAYER1_KEYS`.
 */
export class ControlsPanel implements Panel {
  readonly id = 'controls';
  readonly root: HTMLElement;

  private readonly rowsContainer: HTMLDivElement;
  /** Currently capturing-binding state. null when idle. */
  private capturing: NesButton | null = null;

  constructor(private readonly deps: ControlsPanelDeps) {
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l3';
    this.root.innerHTML = `
      <header class="panel-head">
        <h2>Controls</h2>
      </header>
      <div class="panel-body">
        <div class="controls-rows" data-rows></div>
        <button class="reset-controls" data-reset>Reset to defaults</button>
        <p class="controls-hint">Click a button to rebind. Press the key you want.</p>
      </div>
    `;

    // Match the Settings header pattern: icon as a sibling of h2.
    const head = this.root.querySelector<HTMLElement>('.panel-head')!;
    const ctrlIcon = gameIcon('retro-controller');
    ctrlIcon.classList.add('panel-head-icon');
    head.prepend(ctrlIcon);

    this.rowsContainer = this.root.querySelector<HTMLDivElement>('[data-rows]')!;

    this.bindEvents();
  }

  onShow(): void {
    mountLucideIcons();
    this.render();
  }

  onHide(): void {
    this.cancelCapture();
  }

  // ----- Rendering ----------------------------------------------------------

  private render(): void {
    const bindings = this.currentBindings();
    this.rowsContainer.innerHTML = '';
    for (const { key, label } of BUTTONS) {
      const code = this.findBoundKey(bindings, key);
      const row = document.createElement('button');
      row.className = 'control-row';
      row.dataset.button = String(key);
      row.innerHTML = `
        <span class="control-label">${label}</span>
        <span class="control-key">${this.prettyKeyName(code)}</span>
      `;
      row.addEventListener('click', () => this.beginCapture(key));
      this.rowsContainer.appendChild(row);
    }
  }

  private bindEvents(): void {
    this.root
      .querySelector<HTMLButtonElement>('[data-reset]')!
      .addEventListener('click', () => this.resetToDefaults());

    // Global keydown listener — only consumes when capturing.
    document.addEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (this.capturing === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      this.cancelCapture();
      return;
    }
    this.commitCapture(e.code);
  };

  // ----- Capture flow -------------------------------------------------------

  private beginCapture(button: NesButton): void {
    this.cancelCapture();
    this.capturing = button;
    const row = this.rowsContainer.querySelector<HTMLButtonElement>(
      `[data-button="${button}"]`,
    );
    if (row) {
      row.classList.add('capturing');
      row.querySelector<HTMLSpanElement>('.control-key')!.textContent = 'Press a key…';
    }
  }

  private commitCapture(code: string): void {
    if (this.capturing === null) return;
    const button = this.capturing;
    this.capturing = null;
    const newBindings: KeyBindings = { ...this.currentBindings() };
    // Remove any previous mapping for the same code (single-key-per-action).
    for (const k of Object.keys(newBindings)) {
      if (newBindings[k] === button || k === code) delete newBindings[k];
    }
    newBindings[code] = button;
    this.persist(newBindings);
    this.render();
  }

  private cancelCapture(): void {
    if (this.capturing === null) return;
    this.capturing = null;
    this.render();
  }

  private resetToDefaults(): void {
    this.persist({ ...DEFAULT_PLAYER1_KEYS });
    this.render();
  }

  // ----- Helpers ------------------------------------------------------------

  private currentBindings(): KeyBindings {
    return this.deps.config.get().input.player1Keys;
  }

  private persist(bindings: KeyBindings): void {
    const cfg: Config = this.deps.config.update((c) => ({
      ...c,
      input: { ...c.input, player1Keys: bindings },
    }));
    this.deps.onBindingsChanged(cfg.input.player1Keys);
  }

  private findBoundKey(bindings: KeyBindings, button: NesButton): string | null {
    for (const code of Object.keys(bindings)) {
      if (bindings[code] === button) return code;
    }
    return null;
  }

  /** Map KeyboardEvent.code to a short, readable label. */
  private prettyKeyName(code: string | null): string {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);     // KeyZ → Z
    if (code.startsWith('Digit')) return code.slice(5);   // Digit1 → 1
    if (code.startsWith('Arrow')) return code.slice(5);   // ArrowUp → Up
    return code;
  }
}
