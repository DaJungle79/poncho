export interface LoadedRom {
  /** Display label (filename, URL basename, etc.). */
  readonly name: string;
  /** Original source descriptor — useful for "last loaded" tracking. */
  readonly source: string;
  readonly data: Uint8Array;
}

export interface RomLoader {
  readonly id: string;
  load(input: unknown): Promise<LoadedRom>;
}
