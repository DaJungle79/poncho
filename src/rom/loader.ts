/**
 * Loader interface for the various sources of ROM bytes.
 * `LoadedRom` lives in `src/domain/rom.ts` so non-web shells can
 * import it without dragging the loaders in too.
 */
export type { LoadedRom } from '../domain/rom';

export interface RomLoader {
  readonly id: string;
  load(input: unknown): Promise<import('../domain/rom').LoadedRom>;
}
