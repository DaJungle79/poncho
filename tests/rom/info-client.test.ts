import { describe, expect, it } from 'vitest';
import { parseFilename } from '../../src/rom/info-client';

describe('parseFilename', () => {
  it('plain name with no extension', () => {
    expect(parseFilename('nestest.nes')).toEqual({
      title: 'nestest',
      subtitle: null,
      source: 'filename',
    });
  });

  it('expands single region codes', () => {
    expect(parseFilename('Contra (USA).nes')).toEqual({
      title: 'Contra',
      subtitle: 'USA',
      source: 'filename',
    });
    expect(parseFilename('Mighty Bomb Jack (E) [!].nes')).toEqual({
      title: 'Mighty Bomb Jack',
      subtitle: 'Europe',
      source: 'filename',
    });
  });

  it('preserves revision strings', () => {
    expect(parseFilename('The Legend of Zelda (USA) (Rev A).nes')).toEqual({
      title: 'The Legend of Zelda',
      subtitle: 'USA · Rev A',
      source: 'filename',
    });
  });

  it('drops No-Intro verification flags', () => {
    const m = parseFilename('Game (J) [!].nes');
    expect(m.subtitle).toBe('Japan');
  });

  it('handles extra parentheses', () => {
    const m = parseFilename('Super Mario Bros. 3 (USA) (Special Edition).nes');
    expect(m.title).toBe('Super Mario Bros. 3');
    expect(m.subtitle).toBe('USA · Special Edition');
  });

  it('passes through unknown region codes unchanged', () => {
    const m = parseFilename('Game (PR-Demo).nes');
    expect(m.subtitle).toBe('PR-Demo');
  });

  it('handles brackets that lead the filename', () => {
    const m = parseFilename('[Homebrew] Lawn Mower.nes');
    expect(m.title).toBe('Lawn Mower');
    expect(m.subtitle).toBe('Homebrew');
  });

  it('decodes percent-escapes from URL-derived names', () => {
    const m = parseFilename('Mighty%20Bomb%20Jack%20(E).nes');
    expect(m.title).toBe('Mighty Bomb Jack');
    expect(m.subtitle).toBe('Europe');
  });
});
