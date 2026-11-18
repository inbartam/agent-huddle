/**
 * History questions on `huddle:query` (M5, F22): a page of runs, the folder list, a run's head. Like query.ts, the
 * answer is checked here too: a result of the wrong type or shape reads as `failed`, and a missing bridge as
 * "unavailable in this build". The real core answers `not_available` until WP4b; that comes through as is.
 */
import type {
  HistoryCursor,
  HistoryMatch,
  HistoryRow,
  HistorySearchHit,
  HuddleQuery,
  QueryResult,
  RunHead,
} from '@huddle/shared';
import { QUERY_FAILED, QUERY_UNAVAILABLE, type QueryFn } from './query.js';
import { runsQuery, type HistoryFilters, type RunsPage } from './view/history.js';

type Failed = Extract<QueryResult, { ok: false }>;

const unavailable: Failed = { ok: false, code: 'unsupported', message: QUERY_UNAVAILABLE };
const failed: Failed = { ok: false, code: 'failed', message: QUERY_FAILED };

type Rec = Record<string, unknown>;

function isObject(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null;
}

/** The answer to `q`, as an untyped record of the right type, or a failure. */
export async function ask(query: QueryFn | null, q: HuddleQuery): Promise<{ ok: true; r: Rec } | Failed> {
  if (query === null) return unavailable;
  try {
    const r: unknown = await query(q);
    if (!isObject(r)) return failed;
    if (r['ok'] === false) {
      return typeof r['message'] === 'string' && typeof r['code'] === 'string' ? (r as unknown as Failed) : failed;
    }
    return r['ok'] === true && r['type'] === q.type ? { ok: true, r } : failed;
  } catch {
    return failed;
  }
}

function isRow(v: unknown): v is HistoryRow {
  return (
    isObject(v) &&
    typeof v['sessionId'] === 'string' &&
    typeof v['startTs'] === 'number' &&
    typeof v['outcome'] === 'string' &&
    typeof v['agentCount'] === 'number' &&
    typeof v['otherModels'] === 'number'
  );
}

function isMatch(v: unknown): v is HistoryMatch {
  return isObject(v) && typeof v['text'] === 'string' && typeof v['field'] === 'string' && Array.isArray(v['ranges']);
}

function cursorOf(v: unknown): HistoryCursor | null | false {
  if (v === null || v === undefined) return null;
  return isObject(v) && typeof v['startTs'] === 'number' && typeof v['sessionId'] === 'string'
    ? { startTs: v['startTs'], sessionId: v['sessionId'] }
    : false;
}

export type RunsAnswer = ({ ok: true } & RunsPage) | Failed;

/** One page of runs for these filters, from `before` on. List rows come back as hits with no match. */
export async function loadRuns(
  query: QueryFn | null,
  filters: HistoryFilters,
  before?: HistoryCursor,
): Promise<RunsAnswer> {
  const a = await ask(query, runsQuery(filters, before));
  if (!a.ok) return a;
  const page = a.r['page'];
  if (!isObject(page)) return failed;
  const next = cursorOf(page['next']);
  if (next === false) return failed;
  const migrating = page['migrating'] === true;
  const rows = page['rows'];
  if (a.r['type'] === 'history.list') {
    if (!Array.isArray(rows) || !rows.every(isRow)) return failed;
    return { ok: true, hits: rows.map((row) => ({ row, match: null })), total: null, next, migrating };
  }
  const raw = page['hits'];
  if (!Array.isArray(raw)) return failed;
  const hits: HistorySearchHit[] = [];
  for (const h of raw) {
    if (!isObject(h) || !isRow(h['row'])) return failed;
    hits.push({ row: h['row'], match: isMatch(h['match']) ? h['match'] : null });
  }
  const total = page['total'];
  return { ok: true, hits, total: typeof total === 'number' ? total : null, next, migrating };
}

export type FoldersAnswer = { ok: true; folders: string[] } | Failed;

/** Every folder with a stored run, most recent first (the Folder filter). */
export async function loadFolders(query: QueryFn | null): Promise<FoldersAnswer> {
  const a = await ask(query, { type: 'history.folders' });
  if (!a.ok) return a;
  const folders = a.r['folders'];
  if (!Array.isArray(folders)) return failed;
  return { ok: true, folders: folders.filter((f): f is string => typeof f === 'string' && f !== '') };
}

export type HeadAnswer = { ok: true; head: RunHead } | Failed;

/** A run's head: its row, event count, report flag, markers and gaps. */
export async function openRun(query: QueryFn | null, sessionId: string): Promise<HeadAnswer> {
  const a = await ask(query, { type: 'history.open', sessionId });
  if (!a.ok) return a;
  const head = a.r['head'];
  if (!isObject(head) || !isRow(head['row']) || typeof head['eventCount'] !== 'number') return failed;
  return { ok: true, head: head as unknown as RunHead };
}
