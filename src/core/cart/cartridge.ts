import type { InesRom } from './ines';
import type { Mapper } from './mapper';
import { createMapper } from '../mappers';

export class Cartridge {
  readonly rom: InesRom;
  readonly mapper: Mapper;

  constructor(rom: InesRom) {
    this.rom = rom;
    this.mapper = createMapper(rom);
  }
}
