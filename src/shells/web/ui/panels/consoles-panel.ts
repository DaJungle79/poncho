import type { ConsoleSpec } from '../../../../console/console';
import { gameIcon, mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';

export interface ConsolesPanelDeps {
  /** All consoles to choose from (`ALL_SPECS` from `src/console/specs.ts`). */
  specs: ReadonlyArray<ConsoleSpec>;
  /** Initially-selected console id. */
  initialSelectedId: string;
  /** Called when the user picks a different console. */
  onSelect: (spec: ConsoleSpec) => void;
  /** Called when the user opens/closes the ROM bay for a console. */
  onToggleRoms: (spec: ConsoleSpec) => void;
  /** Called when the Consoles panel becomes visible again. */
  onShow?: () => void;
}

/**
 * L2 panel listing the available virtual consoles. The user clicks one
 * to switch the active runtime — the App reacts by re-instantiating
 * the appropriate console class. The currently-selected entry has a
 * distinct visual state.
 *
 * Spec data comes from `src/console/specs.ts`. Status (`'working'` /
 * `'beta'`) is shown next to each entry.
 */
export class ConsolesPanel implements Panel {
  readonly id = 'consoles';
  readonly root: HTMLElement;

  private selectedId: string;
  private romsOpenId: string | null = null;
  private readonly entries = new Map<string, { card: HTMLElement; romsButton: HTMLButtonElement }>();

  constructor(private readonly deps: ConsolesPanelDeps) {
    this.selectedId = deps.initialSelectedId;
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l2';
    this.root.innerHTML = `
      <header class="panel-head">
        <i data-lucide="cpu" class="panel-head-icon"></i>
        <h2>Consoles</h2>
      </header>
      <div class="panel-body">
        <p class="panel-hint">
          Pick which virtual console boots ROMs.
          Classic NES is the original hardware, faithful to spec.
          Poncho-NES is the 4× upscale successor — runs native <code>.poncho</code> ROMs.
        </p>
        <ul class="console-list" data-list></ul>
      </div>
    `;

    const list = this.root.querySelector<HTMLUListElement>('[data-list]')!;
    for (const spec of deps.specs) {
      const li = document.createElement('li');
      li.className = 'console-item';

      const card = document.createElement('div');
      card.className = 'console-card';
      card.dataset.consoleId = spec.id;

      const mainButton = document.createElement('button');
      mainButton.type = 'button';
      mainButton.className = 'console-main-btn';
      mainButton.innerHTML = `
        <div class="console-row-top">
          <span class="console-name">${escapeHtml(spec.fullName)}</span>
          <span class="console-status console-status-${spec.status}">${spec.status}</span>
        </div>
        <div class="console-desc">${escapeHtml(spec.shortDesc)}</div>
        <div class="console-meta">
          <span>${escapeHtml(spec.ppu.name)} · ${spec.ppu.resolution.width}×${spec.ppu.resolution.height}</span>
          <span>${escapeHtml(spec.cart.format)} (<code>${escapeHtml(spec.cart.magic)}</code>)</span>
        </div>
      `;
      mainButton.addEventListener('click', () => this.handleClick(spec));

      const romsButton = document.createElement('button');
      romsButton.type = 'button';
      romsButton.className = 'console-roms-btn';
      romsButton.title = 'ROMs';
      romsButton.setAttribute('aria-label', `${spec.name} ROMs`);
      const cartIcon = gameIcon('cartridge');
      cartIcon.setAttribute('width', '16');
      cartIcon.setAttribute('height', '16');
      romsButton.append(cartIcon, document.createTextNode('ROMs'));
      romsButton.addEventListener('click', () => this.handleRomsClick(spec));

      this.entries.set(spec.id, { card, romsButton });
      card.append(mainButton, romsButton);
      li.appendChild(card);
      list.appendChild(li);
    }

    this.applySelection();
    mountLucideIcons();
  }

  onHide(): void {
    this.setRomsOpen(null);
  }

  onShow(): void {
    this.deps.onShow?.();
  }

  /** Update the panel's visible-selection without firing onSelect. */
  setSelected(id: string): void {
    this.selectedId = id;
    this.applySelection();
  }

  /** Update which console's ROM bay is visibly open. */
  setRomsOpen(id: string | null): void {
    this.romsOpenId = id;
    this.applySelection();
  }

  private handleClick(spec: ConsoleSpec): void {
    if (spec.id === this.selectedId) return;
    this.selectedId = spec.id;
    this.applySelection();
    this.deps.onSelect(spec);
  }

  private handleRomsClick(spec: ConsoleSpec): void {
    this.deps.onToggleRoms(spec);
  }

  private applySelection(): void {
    for (const [id, entry] of this.entries) {
      entry.card.classList.toggle('selected', id === this.selectedId);
      entry.romsButton.classList.toggle('selected', id === this.romsOpenId);
      entry.romsButton.setAttribute('aria-pressed', id === this.romsOpenId ? 'true' : 'false');
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
