import path from 'node:path';

/**
 * Test ROMs live in `tests/roms/` (vs. `/roms/` at the project root,
 * which is reserved for actual games served via the Vite dev middleware).
 *
 * All integration tests resolve their ROM filenames through this helper
 * so the path can be moved in one place if the layout ever changes.
 */
export function testRomPath(filename: string): string {
  return path.join(process.cwd(), 'tests', 'roms', filename);
}
