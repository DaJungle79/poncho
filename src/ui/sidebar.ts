import type { PanelStack } from './panel-stack';

/**
 * Thin left-side icon nav. The first item lives at the top of the
 * sidebar, the last item at the bottom (separated by a flexible spacer).
 *
 * Each item is a button with:
 *   - A custom icon factory (returns an Element)
 *   - A `panelId` it toggles in the L2 stack
 *   - A tooltip (rendered via `title`)
 */

export interface SidebarItem {
  panelId: string;
  label: string;
  position: 'top' | 'bottom';
  /** Returns a fresh icon element each call. */
  icon: () => Element;
}

export class Sidebar {
  readonly root: HTMLElement;
  private readonly topRow: HTMLDivElement;
  private readonly bottomRow: HTMLDivElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor(private readonly stack: PanelStack) {
    this.root = document.createElement('nav');
    this.root.className = 'sidebar';
    this.root.setAttribute('aria-label', 'Main navigation');

    this.topRow = document.createElement('div');
    this.topRow.className = 'sidebar-row sidebar-top';

    this.bottomRow = document.createElement('div');
    this.bottomRow.className = 'sidebar-row sidebar-bottom';

    const spacer = document.createElement('div');
    spacer.className = 'sidebar-spacer';

    this.root.append(this.topRow, spacer, this.bottomRow);
  }

  add(item: SidebarItem): void {
    const button = document.createElement('button');
    button.className = 'sidebar-btn';
    button.type = 'button';
    button.title = item.label;
    button.setAttribute('aria-label', item.label);
    button.dataset.panel = item.panelId;
    button.appendChild(item.icon());
    button.addEventListener('click', () => this.activate(item.panelId));
    (item.position === 'top' ? this.topRow : this.bottomRow).appendChild(button);
    this.buttons.set(item.panelId, button);
  }

  /** Reflect the stack's current selection in the visible "active" state. */
  syncActive(): void {
    const active = this.stack.activeL2();
    for (const [id, btn] of this.buttons) {
      btn.classList.toggle('active', id === active);
    }
  }

  private activate(panelId: string): void {
    this.stack.toggleL2(panelId);
    this.syncActive();
  }
}
