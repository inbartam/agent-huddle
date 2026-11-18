/**
 * Settings, History (M5, F22): the stats line and the retention preview on `huddle:query`. Like history-query.ts, the
 * answer is checked here: a result of the wrong type or shape reads as `failed`, a missing bridge as "unavailable in
 * this build", and the core's own refusals (`not_available`, …) come through with their message.
 */
import type { HistoryStats, QueryResult } from '@huddle/shared';
import { ask } from './history-query.js';
import { QUERY_FAILED, type QueryFn } from './query.js';

type Failed = Extract<QueryResult, { ok: false }>;

const failed: Failed = { ok: false, code: 'failed', message: QUERY_FAILED };

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isCountOrNull = (v: unknown): v is number | null => v === null || isCount(v);

export type StatsAnswer = { ok: true; stats: HistoryStats } | Failed;

/** history.stats: runs, size and oldest run for the stats line, the retention in force and the older JSONL folder. */
export async function loadStats(query: QueryFn | null): Promise<StatsAnswer> {
  const r = await ask(query, { type: 'history.stats' });
  if (!r.ok) return r;
  const s: unknown = r.r['stats'];
  if (typeof s !== 'object' || s === null) return failed;
  const v = s as Record<string, unknown>;
  const legacy = v['legacyFolder'];
  if (
    !isCount(v['runs']) ||
    !isCountOrNull(v['bytes']) ||
    !isCountOrNull(v['oldestTs']) ||
    !isCount(v['retentionDays']) ||
    typeof v['migrating'] !== 'boolean' ||
    (legacy !== null && typeof legacy !== 'string')
  ) {
    return failed;
  }
  return {
    ok: true,
    stats: {
      runs: v['runs'],
      bytes: v['bytes'],
      oldestTs: v['oldestTs'],
      retentionDays: v['retentionDays'],
      migrating: v['migrating'],
      legacyFolder: legacy,
    },
  };
}

/** history.retentionPreview: how many runs a retention of `days` would delete (null: the core cannot tell). */
export async function loadRetentionPreview(
  query: QueryFn | null,
  days: number,
): Promise<{ ok: true; runs: number | null } | Failed> {
  const r = await ask(query, { type: 'history.retentionPreview', days });
  if (!r.ok) return r;
  const p: unknown = r.r['preview'];
  if (typeof p !== 'object' || p === null) return failed;
  const runs = (p as Record<string, unknown>)['runs'];
  return isCountOrNull(runs) ? { ok: true, runs } : failed;
}
