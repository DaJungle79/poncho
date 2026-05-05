import { NesButton, type ControllerSource } from './source';

/** KeyboardEvent.code -> NesButton. */
export type KeyBindings = Record<string, NesButton>;

export const DEFAULT_BINDINGS: KeyBindings = {
  ArrowUp: NesButton.Up,
  ArrowDown: NesButton.Down,
  ArrowLeft: NesButton.Left,
  ArrowRight: NesButton.Right,
  KeyZ: NesButton.B,
  KeyX: NesButton.A,
  KeyC: NesButton.Select,
  KeyV: NesButton.Start,
};

export class KeyboardSource implements ControllerSource {
  readonly name = 'keyboard';

  private state = 0;
  private bindings: KeyBindings;
  private readonly target: EventTarget;

  private readonly onDown = (e: Event) => {
    const ev = e as KeyboardEvent;
    const btn = this.bindings[ev.code];
    if (btn === undefined) return;
    this.state |= 1 << btn;
    ev.preventDefault();
  };

  private readonly onUp = (e: Event) => {
    const ev = e as KeyboardEvent;
    const btn = this.bindings[ev.code];
    if (btn === undefined) return;
    this.state &= ~(1 << btn);
    ev.preventDefault();
  };

  constructor(bindings: KeyBindings = DEFAULT_BINDINGS, target: EventTarget = window) {
    this.bindings = { ...bindings };
    this.target = target;
  }

  setBindings(bindings: KeyBindings): void {
    this.bindings = { ...bindings };
    this.state = 0;
  }

  pressed(button: NesButton): boolean {
    return (this.state & (1 << button)) !== 0;
  }

  attach(): void {
    this.target.addEventListener('keydown', this.onDown);
    this.target.addEventListener('keyup', this.onUp);
  }

  detach(): void {
    this.target.removeEventListener('keydown', this.onDown);
    this.target.removeEventListener('keyup', this.onUp);
    this.state = 0;
  }
}
