import { isInes } from '../../core/cart/ines';
import { isPonchoRom } from '../../core/cart-poncho/header';

export class InvalidRomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRomError';
  }
}

export function validateInes(data: Uint8Array): void {
  if (!isInes(data)) {
    throw new InvalidRomError('File is not a valid iNES ROM (missing NES\\x1a magic).');
  }
}

/**
 * Accept either an iNES file (`NES\x1a` magic) or a PonchoROM (`PNCH`
 * magic). The runtime later decides which console loads it.
 */
export function validateRom(data: Uint8Array): void {
  if (isInes(data) || isPonchoRom(data)) return;
  throw new InvalidRomError(
    'File is neither a valid iNES nor a PonchoROM (missing NES\\x1a / PNCH magic).',
  );
}
