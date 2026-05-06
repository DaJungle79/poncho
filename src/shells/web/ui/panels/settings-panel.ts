import type { Config, ThemeId } from '../../../../config/schema';
import type { ConfigStore } from '../../../../config/store';
import { mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';

export interface SettingsPanelDeps {
  config: ConfigStore;
  /** Triggered when the user clicks "Controls" — opens the L3 form. */
  onOpenControls: () => void;
  /** Called whenever any setting changes. */
  onConfigChanged: (cfg: Config) => void;
}

/**
 * Slide-out settings menu. Holds:
 *   - Appearance: light / dark theme
 *   - Video: scale selector (1x / 2x / 4x)
 *   - Audio: volume slider + mute toggle
 *   - Controls: link that opens the L3 form (Player 1 keybinds)
 */
export class SettingsPanel implements Panel {
  readonly id = 'settings';
  readonly root: HTMLElement;

  private readonly themeSelect: HTMLSelectElement;
  private readonly scaleSelect: HTMLSelectElement;
  private readonly volumeRange: HTMLInputElement;
  private readonly muteCheckbox: HTMLInputElement;
  private readonly statusBarCheckbox: HTMLInputElement;

  constructor(private readonly deps: SettingsPanelDeps) {
    this.root = document.createElement('section');
    this.root.className = 'panel panel-l2';
    this.root.innerHTML = `
      <header class="panel-head">
        <i data-lucide="settings" class="panel-head-icon"></i>
        <h2>Settings</h2>
      </header>
      <div class="panel-body">
        <section class="settings-group">
          <h3><i data-lucide="sun"></i><span>Appearance</span></h3>
          <label class="settings-row">
            <span>Theme</span>
            <select data-theme>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label class="settings-row">
            <span>Status bar</span>
            <input type="checkbox" data-status-bar />
          </label>
        </section>

        <section class="settings-group">
          <h3><i data-lucide="monitor"></i><span>Video</span></h3>
          <label class="settings-row">
            <span>Scale</span>
            <select data-scale>
              <option value="nearest-1x">1×</option>
              <option value="nearest-2x">2×</option>
              <option value="nearest-4x">4×</option>
            </select>
          </label>
        </section>

        <section class="settings-group">
          <h3><i data-lucide="volume-2"></i><span>Audio</span></h3>
          <label class="settings-row">
            <span>Volume</span>
            <input type="range" min="0" max="100" data-volume />
          </label>
          <label class="settings-row">
            <span>Mute</span>
            <input type="checkbox" data-mute />
          </label>
        </section>

        <section class="settings-group">
          <button class="settings-link" data-controls>
            <i data-lucide="keyboard"></i>
            <span>Controls</span>
            <i data-lucide="chevron-right" class="chev"></i>
          </button>
        </section>
      </div>
    `;

    this.themeSelect = this.root.querySelector<HTMLSelectElement>('[data-theme]')!;
    this.scaleSelect = this.root.querySelector<HTMLSelectElement>('[data-scale]')!;
    this.volumeRange = this.root.querySelector<HTMLInputElement>('[data-volume]')!;
    this.muteCheckbox = this.root.querySelector<HTMLInputElement>('[data-mute]')!;
    this.statusBarCheckbox = this.root.querySelector<HTMLInputElement>('[data-status-bar]')!;

    this.bindEvents();
  }

  onShow(): void {
    mountLucideIcons();
    const cfg = this.deps.config.get();
    this.themeSelect.value = cfg.general.theme;
    this.scaleSelect.value = cfg.video.scaler;
    this.volumeRange.value = String(Math.round(cfg.audio.volume * 100));
    this.muteCheckbox.checked = cfg.audio.muted;
    this.statusBarCheckbox.checked = cfg.general.showStatusBar;
  }

  private bindEvents(): void {
    this.themeSelect.addEventListener('change', () => {
      const cfg = this.deps.config.update((c) => ({
        ...c,
        general: { ...c.general, theme: this.themeSelect.value as ThemeId },
      }));
      this.deps.onConfigChanged(cfg);
    });

    this.scaleSelect.addEventListener('change', () => {
      const cfg = this.deps.config.update((c) => ({
        ...c,
        video: { ...c.video, scaler: this.scaleSelect.value as Config['video']['scaler'] },
      }));
      this.deps.onConfigChanged(cfg);
    });

    this.volumeRange.addEventListener('input', () => {
      const cfg = this.deps.config.update((c) => ({
        ...c,
        audio: { ...c.audio, volume: Number(this.volumeRange.value) / 100 },
      }));
      this.deps.onConfigChanged(cfg);
    });

    this.muteCheckbox.addEventListener('change', () => {
      const cfg = this.deps.config.update((c) => ({
        ...c,
        audio: { ...c.audio, muted: this.muteCheckbox.checked },
      }));
      this.deps.onConfigChanged(cfg);
    });

    this.statusBarCheckbox.addEventListener('change', () => {
      const cfg = this.deps.config.update((c) => ({
        ...c,
        general: { ...c.general, showStatusBar: this.statusBarCheckbox.checked },
      }));
      this.deps.onConfigChanged(cfg);
    });

    this.root
      .querySelector<HTMLButtonElement>('[data-controls]')!
      .addEventListener('click', () => this.deps.onOpenControls());
  }
}
