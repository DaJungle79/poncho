/**
 * Per-game upscale-prompt builder. Asks the *text* Gemini model
 * (`gemini-2.5-flash`) once per game to draft a directive that the
 * image model receives on every per-tile call.
 *
 * Why two stages:
 *   - The image model gets a much sharper aesthetic when it knows the
 *     game's genre, vibe, and visual conventions. NES games are a
 *     diverse set — a horror tile from Castlevania needs a different
 *     touch than a cheerful Mario tile.
 *   - The text model is cheap + has a generous free-tier quota,
 *     separate from the image model's tight one. One call per game.
 *
 * Failure mode: if the text call fails (quota / network / parsing),
 * we return `null` and let the caller fall back to the default prompt.
 * The conversion still works, just less aesthetically tailored.
 *
 * Caching: in-memory `Map<title, prompt>` keyed by lowercased title.
 * Re-fetched on page reload. Persisting (e.g. into the `.poncho` AI
 * cache section) is a phase 4+ polish item.
 */

import { log } from '../debug/logger';
import { UpscaleError } from './upscale-client';

const TEXT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Subset of `RomMeta` we feed to the text model for context. */
export interface PromptGameContext {
  title: string;
  genre?: string;
  publisher?: string;
  developer?: string;
  year?: number;
  /** Region / rev qualifier — e.g. "USA · Rev A". */
  subtitle?: string | null;
}

export interface BuildPromptOptions {
  apiKey: string;
  game: PromptGameContext;
  /** Override the text model. Default: gemini-2.5-flash. */
  modelName?: string;
  /** Override fetch for testing / proxy. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Build a per-game upscale directive. Returns `null` on any failure —
 * the caller is expected to fall back to a default prompt rather than
 * propagate. (Conversion shouldn't break because of an optional bit
 * of polish.)
 */
export async function buildGameUpscalePrompt(
  opts: BuildPromptOptions,
): Promise<string | null> {
  const cacheKey = (opts.game.title || '').toLowerCase().trim();
  if (cacheKey && PROMPT_CACHE.has(cacheKey)) {
    const cached = PROMPT_CACHE.get(cacheKey)!;
    log.info('rom', `prompt-builder: cache hit for "${opts.game.title}"`, { prompt: cached });
    return cached;
  }

  const fetchImpl = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!fetchImpl) {
    log.info('rom', 'prompt-builder: no fetch available, skipping');
    return null;
  }
  if (!opts.apiKey) {
    log.info('rom', 'prompt-builder: no API key, skipping');
    return null;
  }

  const meta = buildMetaPrompt(opts.game);
  log.info('rom', `prompt-builder: generating prompt for "${opts.game.title}"`, {
    game: opts.game,
    metaPrompt: meta,
  });

  const url = `${API_BASE}/${opts.modelName ?? TEXT_MODEL}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: meta }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 512,
      // Gemini 2.5 has "thinking" enabled by default — those tokens
      // count against `maxOutputTokens` and silently truncate the
      // visible answer. Disable for this short-answer use case.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    log.warn('rom', 'prompt-builder: network error', err);
    return null;
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    log.warn('rom', `prompt-builder: HTTP ${resp.status}`, errText.slice(0, 200));
    return null;
  }

  let json: TextResponse;
  try {
    json = await resp.json();
  } catch (err) {
    log.warn('rom', 'prompt-builder: response not JSON', err);
    return null;
  }

  const text = extractFirstText(json);
  const finishReason = json.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    // MAX_TOKENS / SAFETY / RECITATION — the visible answer is likely
    // partial. Log so the dev sees the truncation; we still return
    // whatever we got, since a partial directive is usually better than
    // falling back to the generic default.
    log.warn('rom', `prompt-builder: response finishReason=${finishReason} (likely truncated)`, json);
  }
  if (!text) {
    log.warn('rom', 'prompt-builder: response had no text part', json);
    return null;
  }
  const cleaned = sanitizePrompt(text);
  if (!cleaned) {
    log.warn('rom', 'prompt-builder: response empty after sanitization', { raw: text });
    return null;
  }

  if (cacheKey) PROMPT_CACHE.set(cacheKey, cleaned);
  log.info('rom', `prompt-builder: built prompt for "${opts.game.title}"`, { prompt: cleaned });
  return cleaned;
}

/** Process-local cache. Public for tests + hot-swap UI. */
export const PROMPT_CACHE = new Map<string, string>();

/** Reset the cache — call this when the model or meta-prompt changes. */
export function clearPromptCache(): void {
  PROMPT_CACHE.clear();
}

/**
 * Turn the game context into the meta-prompt that the text model sees.
 * Kept as a separate function so tests can snapshot it and the prompt
 * can evolve without touching transport code.
 */
export function buildMetaPrompt(game: PromptGameContext): string {
  const lines: string[] = [
    'You are configuring an AI image-upscaling system for an NES game.',
    'The image model will receive every 8×8 NES tile (rendered as a 32×32 PNG primer in 4 NES colours) and should output a 32×32 upscaled tile.',
    '',
    'Game context:',
    `- Title: ${game.title || '(unknown)'}`,
  ];
  if (game.subtitle) lines.push(`- Variant: ${game.subtitle}`);
  if (game.year) lines.push(`- Year: ${game.year}`);
  if (game.publisher) lines.push(`- Publisher: ${game.publisher}`);
  if (game.developer) lines.push(`- Developer: ${game.developer}`);
  if (game.genre) lines.push(`- Genre: ${game.genre}`);
  lines.push('');
  lines.push(
    'Write a SINGLE concise directive (3–5 sentences) that the image model will receive on every per-tile upscale call. Requirements:',
    '- Identify the genre and visual vibe so the model can match the game\'s aesthetic.',
    '- Tell the model to upscale 4× (8×8 → 32×32) with smooth edges and subtle anti-aliasing.',
    '- Encourage tasteful HD-detail additions (light shading, texture, sprite finish) appropriate for the genre — without altering the silhouette.',
    '- Require the output to use only the same 4 colours as the input (the runtime snaps each pixel back to the palette regardless, but the model should aim for it).',
    '- No background changes, no extra elements, no text.',
    '',
    'Output ONLY the directive itself. No preamble, no quotes, no markdown, no headings. Plain prose.',
  );
  return lines.join('\n');
}

interface TextResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    /** "STOP" on success; "MAX_TOKENS" when the budget was exhausted. */
    finishReason?: string;
  }>;
}

function extractFirstText(json: TextResponse): string | null {
  for (const cand of json.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (part.text) return part.text;
    }
  }
  return null;
}

/**
 * Strip surrounding whitespace, leading/trailing quotes, and code-fence
 * artefacts in case the model wraps its answer despite the directive.
 */
function sanitizePrompt(raw: string): string {
  let s = raw.trim();
  // Drop fenced blocks: ```...``` or ```text\n...\n```.
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  // Drop wrapping quotes if the whole answer is quoted.
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith('“') && s.endsWith('”'))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// `UpscaleError` re-exported in case a caller wants to type-check the
// upstream surface without a separate import.
export { UpscaleError };
