/**
 * The read-only `huddle:query` questions (M4, ADR-020): "what would this rule have matched?" and the folder picker.
 * The preload exposes `window.huddle.query` (the fifth bridge function); this still checks it is there and otherwise
 * answers "unavailable in this build" (an older preload, or tests), which the UI shows as is. A query changes nothing.
 *
 * The answer comes from main, but it is still checked here: a result of the wrong type or shape reads as `failed`.
 */
import type { HuddleQuery, PolicyPreview, PolicyRule, QueryResult } from '@huddle/shared';

/** The preload's `query`, next to the four functions of ADR-015. */
export type QueryFn = (query: HuddleQuery) => Promise<QueryResult>;

export const QUERY_UNAVAILABLE = 'Unavailable in this build: this Huddle cannot ask the core yet.';
export const QUERY_FAILED = "Huddle couldn't get an answer from its core. Try again.";

type Failed = Extract<QueryResult, { ok: false }>;

const unavailable: Failed = { ok: false, code: 'unsupported', message: QUERY_UNAVAILABLE };
const failed: Failed = { ok: false, code: 'failed', message: QUERY_FAILED };

/** The bridge's `query`, when this build's preload has one. */
export function bridgeQuery(bridge: unknown): QueryFn | null {
  if (typeof bridge !== 'object' || bridge === null || !('query' in bridge)) return null;
  const fn: unknown = bridge.query;
  return typeof fn === 'function' ? (q) => (fn as QueryFn).call(bridge, q) : null;
}

async function ask(query: QueryFn | null, q: HuddleQuery): Promise<QueryResult> {
  if (query === null) return unavailable;
  try {
    const r: unknown = await query(q);
    return isResult(r) ? r : failed;
  } catch {
    return failed;
  }
}

function isResult(r: unknown): r is QueryResult {
  if (typeof r !== 'object' || r === null || !('ok' in r)) return false;
  if (r.ok === false) return 'message' in r && typeof r.message === 'string';
  return r.ok === true && 'type' in r && typeof r.type === 'string';
}

function isPreview(p: unknown): p is PolicyPreview {
  if (typeof p !== 'object' || p === null) return false;
  const v = p as Record<string, unknown>;
  return typeof v['examined'] === 'number' && typeof v['matched'] === 'number' && Array.isArray(v['samples']);
}

export type PreviewAnswer = { ok: true; preview: PolicyPreview } | Failed;
export type FolderAnswer = { ok: true; path: string | null } | Failed;

/** policy.preview: which recent approval requests the rule would have matched. */
export async function previewRule(query: QueryFn | null, rule: PolicyRule): Promise<PreviewAnswer> {
  const r = await ask(query, { type: 'policy.preview', rule });
  if (!r.ok) return r;
  if (r.type !== 'policy.preview' || !isPreview(r.preview)) return failed;
  return { ok: true, preview: r.preview };
}

/** pick.folder: the system folder picker; `path` is null when the user cancelled. */
export async function pickFolder(query: QueryFn | null, defaultPath?: string): Promise<FolderAnswer> {
  const q: HuddleQuery = defaultPath ? { type: 'pick.folder', defaultPath } : { type: 'pick.folder' };
  const r = await ask(query, q);
  if (!r.ok) return r;
  if (r.type !== 'pick.folder' || (r.path !== null && typeof r.path !== 'string')) return failed;
  return { ok: true, path: r.path };
}
