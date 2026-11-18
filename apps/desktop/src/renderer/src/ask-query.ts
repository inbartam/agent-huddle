/**
 * Ask the Huddle (M5, F25): the `ask.preview` question on `huddle:query`. Like history-query.ts, the answer is checked
 * here: a result of the wrong type or shape reads as `failed`, a missing bridge as "unavailable in this build", and the
 * core's own refusals (`not_available` from an older core, …) come through with their message.
 */
import type { AskPreview, AskPreviewPart, AskTurn, QueryResult } from '@huddle/shared';
import { ask } from './history-query.js';
import { QUERY_FAILED, type QueryFn } from './query.js';

type Failed = Extract<QueryResult, { ok: false }>;

const failed: Failed = { ok: false, code: 'failed', message: QUERY_FAILED };

export type AskPreviewAnswer = { ok: true; preview: AskPreview } | Failed;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function partsOf(v: unknown): AskPreview['parts'] | null {
  if (!Array.isArray(v)) return null;
  const out: AskPreview['parts'] = [];
  for (const p of v as unknown[]) {
    if (typeof p !== 'object' || p === null) return null;
    const r = p as Record<string, unknown>;
    const part = r['part'];
    const start = r['start'];
    const end = r['end'];
    if (typeof part !== 'string' || !isNum(start) || !isNum(end)) return null;
    out.push({ part: part as AskPreviewPart, start, end });
  }
  return out;
}

/** ask.preview: the exact text `huddle.ask` would send for this question now. */
/** `history`: the conversation's earlier turns (view/ask.ts `historyFor`), the same ones `huddle.ask` carries. */
export async function loadAskPreview(
  query: QueryFn | null,
  question: string,
  history: readonly AskTurn[] = [],
): Promise<AskPreviewAnswer> {
  const a = await ask(
    query,
    history.length > 0 ? { type: 'ask.preview', question, history: [...history] } : { type: 'ask.preview', question },
  );
  if (!a.ok) return a;
  const p: unknown = a.r['preview'];
  if (typeof p !== 'object' || p === null) return failed;
  const v = p as Record<string, unknown>;
  const parts = partsOf(v['parts']);
  const systemPrompt = v['systemPrompt'];
  if (
    typeof v['text'] !== 'string' ||
    !isNum(v['bytes']) ||
    !isNum(v['estTokens']) ||
    !isNum(v['asOf']) ||
    typeof v['truncated'] !== 'boolean' ||
    parts === null ||
    // Absent from an older core. Present but not text: the view could not show everything that is sent, so refuse it.
    (systemPrompt !== undefined && typeof systemPrompt !== 'string')
  ) {
    return failed;
  }
  return {
    ok: true,
    preview: {
      text: v['text'],
      bytes: v['bytes'],
      estTokens: v['estTokens'],
      asOf: v['asOf'],
      truncated: v['truncated'],
      parts,
      ...(typeof systemPrompt === 'string' ? { systemPrompt } : {}),
    },
  };
}
