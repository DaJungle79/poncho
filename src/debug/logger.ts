export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type Subsystem = 'cpu' | 'ppu' | 'apu' | 'bus' | 'mapper' | 'input' | 'rom' | 'render';

const LEVEL_ORDER: Record<LogLevel, number> = {
  off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};

const levels: Record<Subsystem, LogLevel> = {
  cpu: 'warn', ppu: 'warn', apu: 'warn', bus: 'warn',
  mapper: 'warn', input: 'warn', rom: 'info', render: 'warn',
};

export function setLevel(sys: Subsystem, level: LogLevel): void {
  levels[sys] = level;
}

export function getLevel(sys: Subsystem): LogLevel {
  return levels[sys];
}

function enabled(sys: Subsystem, level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[levels[sys]];
}

export const log = {
  error(sys: Subsystem, ...args: unknown[]): void {
    if (enabled(sys, 'error')) console.error(`[${sys}]`, ...args);
  },
  warn(sys: Subsystem, ...args: unknown[]): void {
    if (enabled(sys, 'warn')) console.warn(`[${sys}]`, ...args);
  },
  info(sys: Subsystem, ...args: unknown[]): void {
    if (enabled(sys, 'info')) console.info(`[${sys}]`, ...args);
  },
  debug(sys: Subsystem, ...args: unknown[]): void {
    if (enabled(sys, 'debug')) console.debug(`[${sys}]`, ...args);
  },
  trace(sys: Subsystem, ...args: unknown[]): void {
    if (enabled(sys, 'trace')) console.debug(`[${sys}]`, ...args);
  },
};

/**
 * Read URL params at startup to override per-subsystem levels.
 *   ?log=cpu:trace,ppu:debug
 */
export function applyLogLevelsFromQuery(search: string): void {
  try {
    const params = new URLSearchParams(search);
    const spec = params.get('log');
    if (!spec) return;
    for (const part of spec.split(',')) {
      const [sys, lvl] = part.split(':') as [Subsystem, LogLevel];
      if (sys in levels && lvl in LEVEL_ORDER) levels[sys] = lvl;
    }
  } catch {
    // ignore
  }
}
