/**
 * Three-level sliding panel layout.
 *
 *   L1 — the sidebar (always visible, ~56px). Holds icon-only nav buttons.
 *   L2 — first slide-out (~280px). Holds menu content for the active L1 item.
 *   L3 — second slide-out (~320px). Holds form / detail content drilled
 *        into from an L2 item.
 *
 * Layout model: L2 and L3 hosts are *absolutely positioned* over the main
 * content area so opening/closing them slides their respective host
 * elements via CSS transforms instead of resizing the main column. Each
 * panel's DOM is mounted into its host once at registration; we toggle
 * visibility by setting `display` on each panel root, while the slide
 * animation lives on the host element keyed off `data-l2`/`data-l3`
 * attributes on the layout root.
 *
 * Click rules:
 *   - Click the same L1 icon twice → closes the entire stack.
 *   - Click a different L1 icon → switches L2 content; closes any open L3.
 *   - Click an L2 link that has an L3 detail → opens L3 alongside.
 *   - Click another L2 link with a different L3 → switches L3 content.
 */

export type PanelId = string;

export interface Panel {
  /** Stable id, matching whatever the L1 button uses. */
  readonly id: PanelId;
  /** Lazily-created DOM root. The stack mounts it once at registration. */
  readonly root: HTMLElement;
  /** Optional callback fired when the panel becomes visible. */
  onShow?(): void;
  /** Optional callback fired right before the panel is hidden. */
  onHide?(): void;
}

export class PanelStack {
  private readonly l2Host: HTMLElement;
  private readonly l3Host: HTMLElement;
  /** The wrapping element we toggle data attributes on (controls CSS). */
  private readonly layoutRoot: HTMLElement;

  private readonly l2Panels = new Map<PanelId, Panel>();
  private readonly l3Panels = new Map<PanelId, Panel>();

  private currentL2: PanelId | null = null;
  private currentL3: PanelId | null = null;

  constructor(layoutRoot: HTMLElement, l2Host: HTMLElement, l3Host: HTMLElement) {
    this.layoutRoot = layoutRoot;
    this.l2Host = l2Host;
    this.l3Host = l3Host;
  }

  /**
   * Mount a panel into its host once at registration; hide via `display`.
   * Pre-mounting (rather than appending on open) means the close
   * animation has content to slide out — not just an empty panel.
   */
  registerL2(panel: Panel): void {
    this.l2Panels.set(panel.id, panel);
    panel.root.dataset.panelId = panel.id;
    panel.root.style.display = 'none';
    this.l2Host.appendChild(panel.root);
  }

  registerL3(panel: Panel): void {
    this.l3Panels.set(panel.id, panel);
    panel.root.dataset.panelId = panel.id;
    panel.root.style.display = 'none';
    this.l3Host.appendChild(panel.root);
  }

  /** Toggle an L2 panel: open it, switch to it, or close everything. */
  toggleL2(id: PanelId): void {
    if (this.currentL2 === id) {
      this.closeAll();
      return;
    }
    this.openL2(id);
  }

  openL2(id: PanelId): void {
    if (this.currentL3) this.closeL3();
    if (this.currentL2 && this.currentL2 !== id) {
      const prev = this.l2Panels.get(this.currentL2);
      if (prev) {
        prev.onHide?.();
        prev.root.style.display = 'none';
      }
    }
    const panel = this.l2Panels.get(id);
    if (!panel) return;
    panel.root.style.display = '';
    panel.onShow?.();
    this.currentL2 = id;
    this.layoutRoot.dataset.l2 = id;
  }

  toggleL3(id: PanelId): void {
    if (this.currentL3 === id) {
      this.closeL3();
      return;
    }
    this.openL3(id);
  }

  openL3(id: PanelId): void {
    if (this.currentL3 && this.currentL3 !== id) {
      const prev = this.l3Panels.get(this.currentL3);
      if (prev) {
        prev.onHide?.();
        prev.root.style.display = 'none';
      }
    }
    const panel = this.l3Panels.get(id);
    if (!panel) return;
    panel.root.style.display = '';
    panel.onShow?.();
    this.currentL3 = id;
    this.layoutRoot.dataset.l3 = id;
  }

  closeL3(): void {
    if (!this.currentL3) return;
    const panel = this.l3Panels.get(this.currentL3);
    if (panel) {
      panel.onHide?.();
      panel.root.style.display = 'none';
    }
    this.currentL3 = null;
    delete this.layoutRoot.dataset.l3;
  }

  closeAll(): void {
    this.closeL3();
    if (this.currentL2) {
      const panel = this.l2Panels.get(this.currentL2);
      if (panel) {
        panel.onHide?.();
        panel.root.style.display = 'none';
      }
      this.currentL2 = null;
      delete this.layoutRoot.dataset.l2;
    }
  }

  activeL2(): PanelId | null { return this.currentL2; }
  activeL3(): PanelId | null { return this.currentL3; }
}
