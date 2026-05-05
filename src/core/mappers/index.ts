import type { InesRom } from '../cart/ines';
import type { Mapper } from '../cart/mapper';
import { Axrom } from './axrom';
import { Cnrom } from './cnrom';
import { Mmc1 } from './mmc1';
import { Mmc3 } from './mmc3';
import { Nrom } from './nrom';
import { Uxrom } from './uxrom';

type MapperCtor = new (rom: InesRom) => Mapper;

const REGISTRY: Record<number, MapperCtor> = {
  0: Nrom,
  1: Mmc1,
  2: Uxrom,
  3: Cnrom,
  4: Mmc3,
  7: Axrom,
};

export function createMapper(rom: InesRom): Mapper {
  const id = rom.header.mapper;
  const Ctor = REGISTRY[id];
  if (!Ctor) throw new Error(`Unsupported mapper: ${id}`);
  return new Ctor(rom);
}

export function isMapperSupported(id: number): boolean {
  return id in REGISTRY;
}
