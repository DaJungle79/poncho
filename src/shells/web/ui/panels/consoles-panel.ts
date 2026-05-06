import type { ConsoleSpec } from '../../../../console/console';
import { mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';

export interface ConsolesPanelDeps {
  /** All consoles to choose from (`ALL_SPECS` from `src/console/specs.ts`). */
  specs: ReadonlyArray<ConsoleSpec>;
  /** Initially-selected console id. */
  initialSelectedId: string;
  /** Called when the user picks a different console. */
  onSelect: (spec: ConsoleSpec) => void;
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
  private readonly entries = new Map<string, HTMLButtonElement>();

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
          Poncho-NES is the 4× successor — runs <code>.nes</code> at 4× scale and native <code>.poncho</code> ROMs.
        </p>
        <ul class="console-list" data-list></ul>
      </div>
    `;

    const list = this.root.querySelector<HTMLUListElement>('[data-list]')!;
    for (const spec of deps.specs) {
      const li = document.createElement('li');
      li.className = 'console-item';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'console-btn';
      button.dataset.consoleId = spec.id;
      button.innerHTML = `
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
      button.addEventListener('click', () => this.handleClick(spec));

      this.entries.set(spec.id, button);
      li.appendChild(button);
      list.appendChild(li);
    }

    this.applySelection();
    mountLucideIcons();
  }

  /** Update the panel's visible-selection without firing onSelect. */
  setSelected(id: string): void {
    this.selectedId = id;
    this.applySelection();
  }

  private handleClick(spec: ConsoleSpec): void {
    if (spec.id === this.selectedId) return;
    this.selectedId = spec.id;
    this.applySelection();
    this.deps.onSelect(spec);
  }

  private applySelection(): void {
    for (const [id, btn] of this.entries) {
      btn.classList.toggle('selected', id === this.selectedId);
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
