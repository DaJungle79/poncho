import type { PanelStack } from './panel-stack';

/**
 * Thin left-side icon nav. Items can live in the top or bottom group,
 * separated by a flexible spacer.
 *
 * Two kinds of items:
 *   - Panel items (`panelId`): clicking toggles an L2 panel.
 *   - Action items (`onClick`): clicking fires a callback (Pause / Reset /
 *     Off / etc.). No panel is opened.
 *
 * An optional `hotkey` (single character, typically "1"-"9") binds a
 * top-level keyboard shortcut: pressing the key triggers the same action
 * as a click. Skipped while the user is typing in an input.
 */

interface SidebarItemBase {
  id: string;
  label: string;
  position: 'top' | 'bottom';
  /** Returns a fresh icon element each call. */
  icon: () => Element;
  /** Optional keyboard shortcut (e.g. "1", "p"). Shown in tooltip. */
  hotkey?: string;
  /** Adds one button-height gap before this item. */
  separated?: boolean;
}

export type SidebarItem =
  | (SidebarItemBase & { panelId: string; onClick?: never })
  | (SidebarItemBase & { panelId?: never; onClick: () => void });

export class Sidebar {
  readonly root: HTMLElement;
  private readonly topRow: HTMLDivElement;
  private readonly bottomRow: HTMLDivElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly hotkeys = new Map<string, HTMLButtonElement>();
  private readonly tooltip: HTMLDivElement;

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

    // Tooltip element lives on <body> so it isn't clipped by the layout's
    // overflow:hidden chain. Single element reused across all buttons.
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'sidebar-tooltip';
    document.body.appendChild(this.tooltip);

    this.attachHotkeyListener();
  }

  add(item: SidebarItem): void {
    const button = document.createElement('button');
    button.className = 'sidebar-btn';
    if (item.separated) button.classList.add('sidebar-btn-separated');
    button.type = 'button';
    const tooltip = item.hotkey ? `${item.label} (${item.hotkey})` : item.label;
    // dataset.tooltip drives the CSS tooltip; aria-label keeps it accessible.
    // No `title` attribute — that gives a slow native tooltip we don't want.
    button.dataset.tooltip = tooltip;
    button.setAttribute('aria-label', tooltip);
    button.dataset.id = item.id;
    if (item.hotkey) button.dataset.hotkey = item.hotkey;
    if (item.panelId) button.dataset.panel = item.panelId;
    button.appendChild(item.icon());
    if (item.panelId) {
      const panelId = item.panelId;
      button.addEventListener('click', () => this.activatePanel(panelId));
    } else {
      button.addEventListener('click', () => item.onClick!());
    }
    // Read tooltip from dataset on each event so dynamic updates via
    // `setTooltip()` are picked up without rebinding handlers.
    button.addEventListener('mouseenter', () => this.showTooltip(button, button.dataset.tooltip ?? ''));
    button.addEventListener('mouseleave', () => this.hideTooltip());
    button.addEventListener('focus', () => this.showTooltip(button, button.dataset.tooltip ?? ''));
    button.addEventListener('blur', () => this.hideTooltip());
    (item.position === 'top' ? this.topRow : this.bottomRow).appendChild(button);
    this.buttons.set(item.id, button);
    if (item.hotkey) this.hotkeys.set(item.hotkey.toLowerCase(), button);
  }

  /**
   * Update the tooltip + aria-label for an existing item. Used by the
   * console-selector whose hover hint reflects the live selection.
   */
  setTooltip(id: string, label: string): void {
    const button = this.buttons.get(id);
    if (!button) return;
    const hotkey = button.dataset.hotkey;
    const text = hotkey ? `${label} (${hotkey})` : label;
    button.dataset.tooltip = text;
    button.setAttribute('aria-label', text);
    if (this.tooltip.classList.contains('visible')) {
      this.tooltip.textContent = text;
    }
  }

  /** Reflect the stack's current selection in the visible "active" state. */
  syncActive(): void {
    const active = this.stack.activeL2();
    for (const btn of this.buttons.values()) {
      const panelId = btn.dataset.panel;
      btn.classList.toggle('active', panelId !== undefined && panelId === active);
    }
  }

  private activatePanel(panelId: string): void {
    this.stack.toggleL2(panelId);
    this.syncActive();
  }

  private showTooltip(button: HTMLButtonElement, text: string): void {
    const rect = button.getBoundingClientRect();
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${rect.right + 8}px`;
    this.tooltip.style.top = `${rect.top + rect.height / 2}px`;
    this.tooltip.classList.add('visible');
  }

  private hideTooltip(): void {
    this.tooltip.classList.remove('visible');
  }

  /**
   * Document-level keydown listener. Triggers the registered button when
   * the user presses its hotkey. Ignored while the user is typing in an
   * input/textarea/contenteditable, or while a modifier key is held (so
   * we don't intercept Cmd+1 / Ctrl+1 browser tab shortcuts).
   */
  private attachHotkeyListener(): void {
    document.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && isEditable(target)) return;
      const key = event.key.toLowerCase();
      const button = this.hotkeys.get(key);
      if (!button) return;
      event.preventDefault();
      button.click();
    });
  }
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}
