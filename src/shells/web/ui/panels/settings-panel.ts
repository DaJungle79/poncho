import type { Config, ThemeId } from '../../../../config/schema';
import type { ConfigStore } from '../../../../config/store';
import { mountLucideIcons } from '../icons';
import type { Panel } from '../panel-stack';

export interface SettingsPanelDeps {
  config: ConfigStore;
  /** Called whenever any setting changes. */
  onConfigChanged: (cfg: Config) => void;
}

/**
 * Slide-out settings menu. Holds:
 *   - Appearance: light / dark theme, status bar, FPS overlay
 *   - Video: scale selector (1x / 2x / 4x)
 *   - Audio: volume slider + mute toggle
 */
export class SettingsPanel implements Panel {
  readonly id = 'settings';
  readonly root: HTMLElement;

  private readonly themeSelect: HTMLSelectElement;
  private readonly scaleSelect: HTMLSelectElement;
  private readonly videoContent: HTMLElement;
  private readonly videoUnavailableHint: HTMLElement;
  private readonly overscanCheckbox: HTMLInputElement;
  private readonly overscanInputs: HTMLElement;
  private readonly overscanTop: HTMLInputElement;
  private readonly overscanBottom: HTMLInputElement;
  private readonly overscanLeft: HTMLInputElement;
  private readonly overscanRight: HTMLInputElement;
  private readonly volumeRange: HTMLInputElement;
  private readonly muteCheckbox: HTMLInputElement;
  private readonly statusBarCheckbox: HTMLInputElement;
  private readonly fpsCheckbox: HTMLInputElement;

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
          <label class="settings-row">
            <span>Show FPS</span>
            <input type="checkbox" data-fps />
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

        <section class="settings-group settings-console-group" data-overscan-section>
          <h3><i data-lucide="monitor"></i><span>Video</span></h3>
          <div data-video-content>
          <label class="settings-row">
            <span>Scale</span>
            <select data-scale>
              <optgroup label="Nearest-neighbour">
                <option value="nearest-1x">1×</option>
                <option value="nearest-2x">2×</option>
                <option value="nearest-4x">4×</option>
              </optgroup>
              <optgroup label="xBRZ (smooth, curve-fitted)">
                <option value="xbrz-2x">xBRZ 2×</option>
                <option value="xbrz-3x">xBRZ 3×</option>
                <option value="xbrz-4x">xBRZ 4×</option>
                <option value="xbrz-5x">xBRZ 5×</option>
                <option value="xbrz-6x">xBRZ 6×</option>
              </optgroup>
              <optgroup label="MMPX (clean, pixel-art)">
                <option value="mmpx-2x">MMPX 2×</option>
              </optgroup>
            </select>
          </label>
          <p class="settings-hint">
            xBRZ smooths edges with curves; MMPX preserves the pixel-art look.
            Higher numbers = larger output.
          </p>
          <label class="settings-row">
            <span>Overscan crop</span>
            <input type="checkbox" data-overscan />
          </label>
          <div class="overscan-inputs" data-overscan-inputs hidden>
            <label class="overscan-field">
              <span>Top</span>
              <input type="number" min="0" max="64" data-overscan-top />
            </label>
            <label class="overscan-field">
              <span>Bottom</span>
              <input type="number" min="0" max="64" data-overscan-bottom />
            </label>
            <label class="overscan-field">
              <span>Left</span>
              <input type="number" min="0" max="64" data-overscan-left />
            </label>
            <label class="overscan-field">
              <span>Right</span>
              <input type="number" min="0" max="64" data-overscan-right />
            </label>
          </div>
          </div>
          <p class="settings-hint" data-video-unavailable hidden>
            Video settings are not available for selected console.
          </p>
        </section>
      </div>
    `;

    this.themeSelect = this.root.querySelector<HTMLSelectElement>('[data-theme]')!;
    this.scaleSelect = this.root.querySelector<HTMLSelectElement>('[data-scale]')!;
    this.videoContent = this.root.querySelector<HTMLElement>('[data-video-content]')!;
    this.videoUnavailableHint = this.root.querySelector<HTMLElement>('[data-video-unavailable]')!;
    this.overscanCheckbox = this.root.querySelector<HTMLInputElement>('[data-overscan]')!;
    this.overscanInputs = this.root.querySelector<HTMLElement>('[data-overscan-inputs]')!;
    this.overscanTop = this.root.querySelector<HTMLInputElement>('[data-overscan-top]')!;
    this.overscanBottom = this.root.querySelector<HTMLInputElement>('[data-overscan-bottom]')!;
    this.overscanLeft = this.root.querySelector<HTMLInputElement>('[data-overscan-left]')!;
    this.overscanRight = this.root.querySelector<HTMLInputElement>('[data-overscan-right]')!;
    this.volumeRange = this.root.querySelector<HTMLInputElement>('[data-volume]')!;
    this.muteCheckbox = this.root.querySelector<HTMLInputElement>('[data-mute]')!;
    this.statusBarCheckbox = this.root.querySelector<HTMLInputElement>('[data-status-bar]')!;
    this.fpsCheckbox = this.root.querySelector<HTMLInputElement>('[data-fps]')!;

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
    this.fpsCheckbox.checked = cfg.general.showFps;
    this.syncOverscanUI(cfg);
    this.applyScalerAvailability(cfg.general.selectedConsoleId);
  }

  /**
   * Poncho-NES already renders to a 1024×960 framebuffer. Any pipeline
   * scaler other than nearest-1x would balloon the output (nearest-2x →
   * 2048×1920, xbrz-4x → 4096×3840) with no benefit — CSS handles
   * display scaling — and a severe cost: frame rate drops from 60 fps
   * to ~12 fps or worse on typical hardware.
   *
   * The xBRZ/MMPX tile-level upscaling for Poncho-NES is handled by the
   * UpscaleWorker inside the PPU, not by this pipeline scaler. Applying
   * a pipeline scaler on top of the already-1024×960 framebuffer just
   * re-scales an already-upscaled image at high cost.
   *
   * All non-nearest-1x options are disabled for Poncho-NES and any
   * stored non-nearest-1x value is downgraded at console-select time.
   * Reads from config (not scaleSelect.value) so the downgrade fires
   * correctly at boot before onShow has synced the <select>.
   */
  setConsoleId(consoleId: string): void {
    this.applyScalerAvailability(consoleId);
  }

  private syncOverscanUI(cfg: Config): void {
    const ov = cfg.video.overscan;
    this.overscanCheckbox.checked = ov.enabled;
    this.overscanTop.value = String(ov.top);
    this.overscanBottom.value = String(ov.bottom);
    this.overscanLeft.value = String(ov.left);
    this.overscanRight.value = String(ov.right);
    this.overscanInputs.hidden = !ov.enabled;
  }

  private applyScalerAvailability(consoleId: string): void {
    const isPoncho = consoleId === 'poncho-nes';
    for (const option of this.scaleSelect.options) {
      option.disabled = isPoncho && option.value !== 'nearest-1x';
    }

    if (isPoncho) {
      const cur = this.deps.config.get().video.scaler;
      if (cur !== 'nearest-1x') {
        this.scaleSelect.value = 'nearest-1x';
        const cfg = this.deps.config.update((c) => ({
          ...c,
          video: { ...c.video, scaler: 'nearest-1x' },
        }));
        this.deps.onConfigChanged(cfg);
      }
    } else if (consoleId === 'nes') {
      // If arriving from Poncho-NES, the scaler was forced to nearest-1x.
      // nearest-1x looks terrible on the 256×240 NES framebuffer — bump
      // it to xbrz-4x so the user gets a decent picture without having
      // to reconfigure.
      const cur = this.deps.config.get().video.scaler;
      if (cur === 'nearest-1x') {
        this.scaleSelect.value = 'xbrz-4x';
        const cfg = this.deps.config.update((c) => ({
          ...c,
          video: { ...c.video, scaler: 'xbrz-4x' },
        }));
        this.deps.onConfigChanged(cfg);
      }
    }

    // Video settings only apply to Classic NES. Keep the section visible for
    // other consoles so the Settings panel does not appear to lose a category.
    const videoAvailable = consoleId === 'nes';
    this.videoContent.hidden = !videoAvailable;
    this.videoUnavailableHint.hidden = videoAvailable;
  }

  private updateOverscan(): void {
    const cfg = this.deps.config.update((c) => ({
      ...c,
      video: {
        ...c.video,
        overscan: {
          enabled: this.overscanCheckbox.checked,
          top: clampOverscan(this.overscanTop.value),
          bottom: clampOverscan(this.overscanBottom.value),
          left: clampOverscan(this.overscanLeft.value),
          right: clampOverscan(this.overscanRight.value),
        },
      },
    }));
    this.overscanInputs.hidden = !this.overscanCheckbox.checked;
    this.deps.onConfigChanged(cfg);
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

    this.fpsCheckbox.addEventListener('change', () => {
      const cfg = this.deps.config.update((c) => ({
        ...c,
        general: { ...c.general, showFps: this.fpsCheckbox.checked },
      }));
      this.deps.onConfigChanged(cfg);
    });

    this.overscanCheckbox.addEventListener('change', () => this.updateOverscan());
    this.overscanTop.addEventListener('change', () => this.updateOverscan());
    this.overscanBottom.addEventListener('change', () => this.updateOverscan());
    this.overscanLeft.addEventListener('change', () => this.updateOverscan());
    this.overscanRight.addEventListener('change', () => this.updateOverscan());
  }
}

function clampOverscan(raw: string): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(64, n)) : 0;
}
