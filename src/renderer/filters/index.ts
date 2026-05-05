import type { Filter } from './filter';

export type FilterId = string;

/**
 * Filter registry. Empty for now — filters land in a future phase
 * (CRT scanlines, NTSC composite, color tweaks, etc.). New filters should
 * register here so the config UI can list them by id.
 */
const FACTORIES: Record<FilterId, () => Filter> = {};

export function createFilter(id: FilterId): Filter {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`Unknown filter: ${id}`);
  return factory();
}

export function registerFilter(id: FilterId, factory: () => Filter): void {
  FACTORIES[id] = factory;
}

export function availableFilters(): readonly FilterId[] {
  return Object.keys(FACTORIES);
}

export type { Filter };
