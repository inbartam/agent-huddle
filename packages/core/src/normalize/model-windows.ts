/**
 * Context window size per model id (SPIKES S9: telemetry does not report it, so it is derived from the model id).
 *
 * Pure lookup. An unknown model gives `null`: the UI then shows "window unknown", never a guessed size.
 *
 * To correct or extend: edit `MODEL_WINDOWS` only. Keys are base model ids, lower case, without a date suffix
 * (`claude-sonnet-4-5`, not `claude-sonnet-4-5-20250929`); `modelWindowTokens` strips the date and provider
 * prefixes before looking up. A `[1m]` suffix (Claude Code's 1M-context variant, e.g. `claude-sonnet-4-5[1m]`)
 * always means 1,000,000 tokens.
 *
 * Status: docs-checked 2026-11-14 (docs/INTEGRATION.md, "Context window per model"): 1M by default for Fable,
 * Sonnet 5 and later, Haiku 5.5 and Opus 4.7 and later; 200K for Opus/Sonnet 4.6 without `[1m]` and for older models.
 * A user who sets CLAUDE_CODE_DISABLE_1M_CONTEXT=1 gets 200K on the 1M models; telemetry does not say so, which is
 * why the status line's own `context_window_size` is preferred whenever it is available.
 */

export const ONE_MILLION_TOKENS = 1_000_000;

/** Standard context window, in tokens, by base model id. */
export const MODEL_WINDOWS: Readonly<Record<string, number>> = {
  'claude-3-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-7-sonnet': 200_000,
  'claude-opus-4': 200_000,
  'claude-opus-4-0': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-0': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-7': ONE_MILLION_TOKENS,
  'claude-opus-5': ONE_MILLION_TOKENS,
  'claude-opus-5-5': ONE_MILLION_TOKENS,
  'claude-sonnet-5': ONE_MILLION_TOKENS,
  'claude-sonnet-5-5': ONE_MILLION_TOKENS,
  'claude-haiku-5-5': ONE_MILLION_TOKENS,
  'claude-fable-5': ONE_MILLION_TOKENS,
  'claude-fable-5-2': ONE_MILLION_TOKENS,
};

const ONE_M_SUFFIX = /\[1m\]$/;
/** Bedrock (`us.anthropic.`, `anthropic.`) and similar provider prefixes. */
const PROVIDER_PREFIX = /^(?:[a-z]{2,4}\.)?anthropic\./;
/** Bedrock version suffix (`-v1:0`), Vertex date suffix (`@20250929`), API date suffix (`-20250929`), `-latest`. */
const VERSION_SUFFIXES = [/-v\d+(?::\d+)?$/, /@\d{8}$/, /-\d{8}$/, /-latest$/];

/** The base id `MODEL_WINDOWS` is keyed by. */
export function baseModelId(model: string): string {
  let id = model.trim().toLowerCase().replace(ONE_M_SUFFIX, '').replace(PROVIDER_PREFIX, '');
  for (const suffix of VERSION_SUFFIXES) id = id.replace(suffix, '');
  return id;
}

/** Context window in tokens for a model id, or null when the model is unknown (never a guess). */
export function modelWindowTokens(model: string | null | undefined): number | null {
  if (typeof model !== 'string' || model.trim() === '') return null;
  if (ONE_M_SUFFIX.test(model.trim().toLowerCase())) return ONE_MILLION_TOKENS;
  const base = baseModelId(model);
  return Object.hasOwn(MODEL_WINDOWS, base) ? (MODEL_WINDOWS[base] ?? null) : null;
}
