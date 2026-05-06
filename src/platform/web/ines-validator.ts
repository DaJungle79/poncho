import { isInes } from '../../core/cart/ines';

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
