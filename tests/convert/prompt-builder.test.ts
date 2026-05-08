import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildGameUpscalePrompt,
  buildMetaPrompt,
  clearPromptCache,
  PROMPT_CACHE,
} from '../../src/convert/prompt-builder';

beforeEach(() => clearPromptCache());
afterEach(() => clearPromptCache());

function respondWithText(text: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
    }), { status })) as typeof fetch;
}

describe('buildMetaPrompt', () => {
  it('includes optional fields when present', () => {
    const out = buildMetaPrompt({
      title: 'Castlevania',
      year: 1986,
      publisher: 'Konami',
      developer: 'Konami',
      genre: 'Platformer / Horror',
      subtitle: 'USA · Rev A',
    });
    expect(out).toContain('Castlevania');
    expect(out).toContain('Year: 1986');
    expect(out).toContain('Publisher: Konami');
    expect(out).toContain('Genre: Platformer / Horror');
    expect(out).toContain('Variant: USA · Rev A');
  });

  it('omits optional fields when missing', () => {
    const out = buildMetaPrompt({ title: 'Mystery Game' });
    expect(out).toContain('Mystery Game');
    expect(out).not.toContain('Year:');
    expect(out).not.toContain('Publisher:');
    expect(out).not.toContain('Genre:');
  });

  it('always asks the model to upscale 4× and keep the 4-colour palette', () => {
    const out = buildMetaPrompt({ title: 'X' });
    expect(out).toMatch(/4×|4x/);
    expect(out).toContain('4 colours');
  });
});

describe('buildGameUpscalePrompt', () => {
  it('returns the model output verbatim (after sanitization)', async () => {
    const out = await buildGameUpscalePrompt({
      apiKey: 'test',
      game: { title: 'Castlevania' },
      fetch: respondWithText('A custom directive about Castlevania.'),
    });
    expect(out).toBe('A custom directive about Castlevania.');
  });

  it('strips wrapping fences and quotes', async () => {
    const out = await buildGameUpscalePrompt({
      apiKey: 'test',
      game: { title: 'X' },
      fetch: respondWithText('```\n"A directive."\n```'),
    });
    expect(out).toBe('A directive.');
  });

  it('caches by title (case-insensitive)', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'cached prompt' }] } }],
      }), { status: 200 });
    }) as typeof fetch;

    const a = await buildGameUpscalePrompt({ apiKey: 'k', game: { title: 'Mega Man 2' }, fetch: f });
    const b = await buildGameUpscalePrompt({ apiKey: 'k', game: { title: 'mega man 2' }, fetch: f });
    expect(a).toBe('cached prompt');
    expect(b).toBe('cached prompt');
    expect(calls).toBe(1);
    expect(PROMPT_CACHE.size).toBe(1);
  });

  it('returns null on HTTP error (caller falls back to default)', async () => {
    const f = (async () => new Response('quota', { status: 429 })) as typeof fetch;
    const out = await buildGameUpscalePrompt({
      apiKey: 'test',
      game: { title: 'X' },
      fetch: f,
    });
    expect(out).toBeNull();
  });

  it('returns null when no API key is supplied', async () => {
    const out = await buildGameUpscalePrompt({
      apiKey: '',
      game: { title: 'X' },
      fetch: respondWithText('shouldnt be called'),
    });
    expect(out).toBeNull();
  });

  it('returns null when network throws', async () => {
    const f = (async () => { throw new Error('network'); }) as typeof fetch;
    const out = await buildGameUpscalePrompt({
      apiKey: 'k',
      game: { title: 'X' },
      fetch: f,
    });
    expect(out).toBeNull();
  });
});
