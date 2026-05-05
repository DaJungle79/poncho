export const enum NesButton {
  A = 0,
  B = 1,
  Select = 2,
  Start = 3,
  Up = 4,
  Down = 5,
  Left = 6,
  Right = 7,
}

export const ALL_BUTTONS: readonly NesButton[] = [
  NesButton.A,
  NesButton.B,
  NesButton.Select,
  NesButton.Start,
  NesButton.Up,
  NesButton.Down,
  NesButton.Left,
  NesButton.Right,
];

/**
 * A pluggable input source — keyboard, gamepad, network, scripted, etc.
 * The console polls `pressed()` once per frame per controller.
 */
export interface ControllerSource {
  readonly name: string;
  pressed(button: NesButton): boolean;
  /** Optional lifecycle hooks for sources that own DOM listeners. */
  attach?(): void;
  detach?(): void;
}
