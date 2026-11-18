/**
 * HistoryService (M5 WP4b, F22 F23 F24): the history, replay, report and scorecard questions on `huddle:query`, the
 * report commands, and the run reports written when a run ends. Owned by HuddleCore; needs the SQLite store.
 *
 * Everything here works on stored HuddleEvents (rule 2: no payload field is read). Nothing here changes state or
 * writes an event (rule 1); what it writes is derived and rebuildable: the v3 tables (`run_derivations`,
 * `agent_runs`) and the Markdown files in `<dataDir>/reports`.
 *
 * Derivation. A session's report is `buildRunReport` over its stored events; its agent rows (`AgentRunRow`, for the
 * scorecards) and the history row's summary come from that report and are stored with it. A derivation is current
 * while its `version` is DERIVATION_VERSION and it was built from as many rows as the session has; otherwise it is
 * built again when needed. The fold behind it runs in chunks with a yield between them (`buildRunReport` gets the
 * state), so a long log never holds the hook server for long.
 *
 * Reports are written:
 *  - when a run ends: the root's `session.ended`, a managed run's `run.exited` (taskkill sends no SessionEnd, S16), and
 *    its worktree summary or close after that. Only after the batch is in the database, debounced per session
 *    (REPORT_DELAY_MS), off the hook path, fail-soft (a failure is logged; the next open writes it);
 *  - lazily, when an ended run with no current file is opened (`report.get`);
 *  - on demand (`report.make`).
 * Migrated and other old sessions get their derivation (no file) from a start-up backfill: a background job, one
 * session at a time with yields, at most `backfillMaxSessions` per pass, progress in `meta` (META_BACKFILL), and
 * idempotent (it picks only sessions whose derivation is missing or stale). `scorecards.get` waits for a pass.
 *
 * Live sessions (in this Huddle's state, not ended, with an event since this start) are never derived: their row is
 * read from the live state and their report is `not_ready`.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  CLIP_LIMITS,
  sessionTopic,
  etaPriorsFrom,
  workTokens,
  type AgentKey,
  type AgentNode,
  type CommandResult,
  type EtaPriors,
  type HistoryOutcome,
  type HistoryRow,
  type HistorySearchHit,
  type HistoryTokens,
  type HuddleEvent,
  type M5Query,
  type QueryResult,
  type ReplayEventEntry,
  type RunReport,
  type UserSettings,
} from '@huddle/shared';
import { m5QueryNotAvailable } from '../contracts/m5-schemas.js';
import { clip } from '../text.js';
import { reportNodes, scorecardRows, tokenCounts } from '../report/agent-runs.js';
import { renderReportMarkdown } from '../report/markdown.js';
import { buildRunReport, sessionEvents } from '../report/run-report.js';
import { computeScorecards } from '../report/scorecards.js';
import { initialState, reduce, toHuddleState, type ReducerState } from '../state/reduce.js';
import type { Derivation, DerivationInput, SessionWithDerivation } from '../store/history-tables.js';
import { sessionOfAgentKey } from '../store/codec.js';
import { isJsonlMigrationDone, META_MIGRATED_TO } from '../store/migrate-jsonl.js';
import { searchTerms, toFtsQuery, type SqliteEventStore, type StoredSession } from '../store/sqlite-store.js';
import { matchFor } from './history-match.js';
import {
  READ_CHUNK,
  ReplayCache,
  SessionTooLargeError,
  yieldToEventLoop,
  type IndexLimits,
  type YieldNow,
} from './replay-index.js';
import {
  ReportFileWriter,
  reportFileExists,
  reportPathFor,
  reportsDirBytes,
  reportsDirOf,
  type ReportFileOps,
} from './report-files.js';
import { activeOverallBudgetSince } from './replay-window.js';
import { newestFileMtimeNoFollow, removeTreeNoFollow } from './safe-remove.js';

/** Bump when what a derivation holds changes (the report builder, the row summary): every session is derived again. */
// 2 (M5 WP7): report failures and approvals carry their log `index`.
// 3 (M5 runbook): `agent_runs` holds only the rows the scorecards count (`scorecardRows`: no agent that did nothing).
export const DERIVATION_VERSION = 3;
/** How long after a run's last ending event its report is written (later endings in that window wait with it). */
export const REPORT_DELAY_MS = 1500;
/** Most sessions one backfill pass derives. */
export const BACKFILL_MAX_SESSIONS = 5000;
/** How long the ETA priors wait after the last derivation before they are computed again (debounced). */
export const PRIORS_DELAY_MS = 2000;
/** `meta` key: the last backfill pass, as JSON. */
export const META_BACKFILL = 'history_backfill';
/**
 * Events one deletion transaction removes (M5 WP5). About 1-3 ms of work on this machine's SQLite, so a hook that
 * arrives during a large delete waits at most that long; the deletion yields to the event loop between transactions.
 */
export const PRUNE_CHUNK_ROWS = 1000;
/**
 * A VACUUM runs after deleting history only when the data left is at most this size (M5 WP5). VACUUM rewrites the whole
 * file synchronously on the thread that answers hooks, in time proportional to what is left: at 4 MB that is tens of
 * milliseconds once (after "delete all history", where little is left), while a large database would stall hooks for
 * seconds and need its size again in free disk. Otherwise the freed pages stay in the file and new events reuse them.
 */
export const VACUUM_MAX_LIVE_BYTES = 4 * 1024 * 1024;
/** And only when at least this much would be given back. */
export const VACUUM_MIN_FREE_BYTES = 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The M1-M4 JSONL history folder in the data folder (and, once imported, `events.migrated-<date>`). */
const LEGACY_EVENTS_DIRNAME = 'events';
/** Sessions read per page while filling one history page (more than one page when a filter drops rows). */
const SCAN_PAGE = 100;
/** Events that may end a run: its report is written after them. */
const ENDING_TYPES: ReadonlySet<string> = new Set(['run.exited', 'worktree.summarized', 'worktree.closed']);

interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface HistoryServiceDeps {
  store: SqliteEventStore;
  dataDir: string;
  now: () => number;
  logger: Logger;
  /** The core's live reducer state. */
  liveState: () => ReducerState;
  /** When this Huddle started (`start()`), or null before. A session is live only with an event since then. */
  startedAt: () => number | null;
  settings: () => UserSettings;
  /** The JSONL import is running. */
  migrating: () => boolean;
  /** Background work the core waits for before it closes the store. */
  track: <T>(work: Promise<T>) => Promise<T>;
  /**
   * Session ids that are never runs (the Huddle's own sessions): never listed, counted or derived, and never deleted
   * by the retention (`keep` aside, the retention trims them by event time, see `trimSession`).
   */
  exclude: readonly string[];
  /** Session ids never deleted at all, not even by "delete all history" (the overall budgets' session). Default []. */
  keep?: readonly string[];
  /**
   * The overall budgets' session (BUDGET_SESSION_ID). While an overall budget is in force, the retention spares every
   * session it counts (`retentionCandidates`). Absent: no overall budget is considered.
   */
  budgetSessionId?: string;
  /**
   * Is this managed run's process alive? A run's session id is its runId (S16 h). Such a session is never deleted
   * (M5 WP5). Default: none is.
   */
  isRunLive?: (runId: string) => boolean;
  /** Most events one deletion transaction removes (default PRUNE_CHUNK_ROWS). */
  pruneChunkRows?: number;
  /** Default REPORT_DELAY_MS. */
  reportDelayMs?: number;
  /** Default BACKFILL_MAX_SESSIONS. */
  backfillMaxSessions?: number;
  /**
   * The ETA priors (`priors()`) changed: the core hands listeners an empty batch ("read the state again"). Called from
   * a timer, never on the hook path.
   */
  onPriorsChanged?: () => void;
  /** Default PRIORS_DELAY_MS. */
  priorsDelayMs?: number;
  /** Sessions whose replay index is kept in memory (default 3). */
  cacheSessions?: number;
  /** Tests only: lower replay limits (replay-index.ts `IndexLimits`). */
  replayLimits?: IndexLimits;
  /** Tests only: the report writer's rename and wait (report-files.ts `ReportFileOps`). */
  reportFileOps?: ReportFileOps;
  yieldNow?: YieldNow;
}

interface Derived {
  derivation: Derivation;
  report: RunReport | null;
}

interface MadeReport extends Derived {
  /** The file, when it is written and current. */
  file: string | null;
  /** Writing it failed (the report itself is fine). */
  writeFailed: boolean;
  /** Not written: the session's history is being or was deleted (`ReportFileWriter.refuse`). */
  deleted: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clipOrNull(text: string | null, limit: number): string | null {
  return text === null ? null : clip(text, limit);
}

const NOT_FOUND: QueryResult = { ok: false, code: 'not_found', message: 'There is no stored run with that id.' };

export class HistoryService {
  private readonly cache: ReplayCache;
  private readonly yieldNow: YieldNow;
  private readonly inFlight = new Map<string, Promise<Derived>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly reportWork = new Set<Promise<void>>();
  /** Every report file write goes through it: one per session at a time (the end-of-run write and `report.make`). */
  private readonly reportFiles: ReportFileWriter;
  /** Sessions a `deleteSessions` call is deleting right now. */
  private readonly deleting = new Set<string>();
  private backfillRun: Promise<void> | null = null;
  private disposed = false;
  private priorsValue: EtaPriors | null = null;
  private priorsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HistoryServiceDeps) {
    this.yieldNow = deps.yieldNow ?? yieldToEventLoop;
    this.reportFiles = new ReportFileWriter(deps.dataDir, deps.reportFileOps);
    this.cache = new ReplayCache(deps.store.history, {
      maxSessions: deps.cacheSessions ?? 3,
      yieldNow: this.yieldNow,
      expectedEvents: (sessionId) => deps.store.history.eventCount(sessionId),
      ...(deps.replayLimits !== undefined ? { limits: deps.replayLimits } : {}),
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------------------------------

  /** One already-validated M5 question. Never rejects. */
  async query(q: M5Query): Promise<QueryResult> {
    try {
      return await this.answer(q);
    } catch (error) {
      // L2: a session too large to replay says so, in words, instead of a generic failure.
      if (error instanceof SessionTooLargeError) {
        this.deps.logger.warn('session too large to replay', {
          type: q.type,
          events: error.events,
          limit: error.limit,
        });
        return { ok: false, code: 'failed', message: error.message };
      }
      this.deps.logger.error('history query failed', { type: q.type, error: messageOf(error) });
      return { ok: false, code: 'failed', message: 'The history could not be read.' };
    }
  }

  private async answer(q: M5Query): Promise<QueryResult> {
    switch (q.type) {
      case 'history.list': {
        const { rows, next } = await this.scan(
          (options) => this.deps.store.history.sessionPage(options),
          q.limit,
          q.before,
          q.folder,
          q.outcome,
        );
        return { ok: true, type: 'history.list', page: { rows, next, migrating: this.deps.migrating() } };
      }
      case 'history.search':
        return { ok: true, type: 'history.search', page: await this.search(q) };
      case 'history.folders':
        await this.deps.store.flush();
        return { ok: true, type: 'history.folders', folders: this.deps.store.history.folders(this.deps.exclude) };
      case 'history.open':
        return this.open(q.sessionId);
      case 'history.stateAt':
        return this.stateAt(q.sessionId, q.index);
      case 'history.events':
        return this.events(q);
      case 'history.stats':
        return { ok: true, type: 'history.stats', stats: await this.stats() };
      case 'history.retentionPreview': {
        const runs = await this.retentionRunCount(q.days);
        return { ok: true, type: 'history.retentionPreview', preview: { days: q.days, runs } };
      }
      case 'report.get':
        return this.reportGet(q.sessionId);
      case 'scorecards.get': {
        await this.backfill();
        const rows = this.deps.store.history.agentRuns([...this.deps.exclude, ...this.liveIds()]);
        return {
          ok: true,
          type: 'scorecards.get',
          answer: { scorecards: computeScorecards(rows), retentionDays: this.deps.settings().history.retentionDays },
        };
      }
      case 'ask.preview':
        // WP6.
        return m5QueryNotAvailable(q.type);
    }
  }

  /** Is this stored session running in this Huddle now? */
  private isLive(session: StoredSession): boolean {
    if (session.ended) return false;
    const started = this.deps.startedAt();
    if (started === null || session.lastTs < started) return false;
    const state = this.deps.liveState();
    const root = Object.hasOwn(state.agents, session.sessionId) ? state.agents[session.sessionId] : undefined;
    if (root?.kind !== 'main') return false;
    return (root.run?.exited ?? null) === null;
  }

  /** Session ids live now (see `isLive`). */
  private liveIds(): string[] {
    const state = this.deps.liveState();
    const out: string[] = [];
    for (const key of state.rootKeys) {
      const node = Object.hasOwn(state.agents, key) ? state.agents[key] : undefined;
      if (node?.kind !== 'main') continue;
      const stored = this.deps.store.history.session(node.sessionId);
      if (stored !== null && this.isLive(stored.session)) out.push(node.sessionId);
    }
    return out;
  }

  private isCurrent(sw: SessionWithDerivation): sw is SessionWithDerivation & { derivation: Derivation } {
    const d = sw.derivation;
    return d !== null && d.version === DERIVATION_VERSION && d.eventCount === sw.session.eventCount;
  }

  /** The current derivation of a stored session, derived now when missing or stale. */
  private async current(sw: SessionWithDerivation): Promise<Derivation> {
    if (this.isCurrent(sw)) return sw.derivation;
    return (await this.derive(sw.session.sessionId)).derivation;
  }

  /**
   * Is this stored session a run, one `history.list` shows? The one predicate behind the list, `history.stats.runs`
   * and the retention preview, so their counts agree:
   *  - 'live': running in this Huddle (shown from the live state);
   *  - its current derivation, when that holds a main agent;
   *  - null otherwise: not a run. A session with no main agent (a telemetry-only fragment: `model.observed`,
   *    `usage.recorded`, `context.measured` and no session start) is stored and searchable by id, never listed. A stored
   *    derivation that already says "no main agent" is not a run even when stale or live, as the list's SQL filter
   *    (`HistoryTables.pageFilter`) says; the backfill re-derives it.
   */
  private async listedAs(sw: SessionWithDerivation): Promise<'live' | Derivation | null> {
    if (sw.derivation !== null && !sw.derivation.hasRoot) return null;
    if (this.isLive(sw.session)) return 'live';
    const d = await this.current(sw);
    return d.hasRoot ? d : null;
  }

  /** The row a stored session shows as; null for a session that is not a run (`listedAs`). */
  private async rowOf(sw: SessionWithDerivation): Promise<HistoryRow | null> {
    const s = sw.session;
    const base = {
      sessionId: s.sessionId,
      title: clipOrNull(s.title, CLIP_LIMITS.summary),
      topic: clipOrNull(sessionTopic(s.lastPrompt, s.firstPrompt), CLIP_LIMITS.summary),
      folder: clipOrNull(s.cwd, CLIP_LIMITS.path),
      startTs: s.firstTs,
    };
    const d = await this.listedAs(sw);
    if (d === null) return null;
    if (d === 'live') return { ...base, ...this.liveSummary(s.sessionId) };
    return {
      ...base,
      durationMs: d.durationMs,
      outcome: d.outcome === null || d.outcome === 'unknown' ? 'no_end' : d.outcome,
      origin: d.origin ?? 'attached',
      model: d.model,
      otherModels: d.otherModels,
      tokens: d.workTokens === null ? null : { value: d.workTokens, partial: d.tokensPartial },
      agentCount: d.agentCount,
    };
  }

  /** The row fields of a live session, from the live state. */
  private liveSummary(sessionId: string): Omit<HistoryRow, 'sessionId' | 'title' | 'topic' | 'folder' | 'startTs'> {
    const state = this.deps.liveState();
    const nodes = reportNodes(state, sessionId);
    const root: AgentNode | undefined = nodes.find((n) => n.kind === 'main') ?? state.agents[sessionId];
    const rootModel = root?.model ?? null;
    const others = new Set(
      nodes.filter((n) => n !== root && n.model !== null && n.model !== rootModel).map((n) => n.model),
    );
    let sum = 0;
    let known = 0;
    for (const node of nodes) {
      const counts = tokenCounts(node.usage);
      if (counts === null) continue;
      sum += workTokens(counts);
      known += 1;
    }
    const tokens: HistoryTokens | null = known === 0 ? null : { value: sum, partial: known < nodes.length };
    return {
      durationMs: null,
      outcome: 'running',
      origin: root?.origin ?? 'attached',
      model: rootModel === null ? null : clip(rootModel, CLIP_LIMITS.id),
      otherModels: others.size,
      tokens,
      agentCount: nodes.length,
    };
  }

  /**
   * Fills one page from `read` (sessions in history order), deriving rows that need it and applying the outcome
   * filter, which the database cannot (live and derived outcomes). `next` is the last row returned.
   */
  private async scan<T extends { row: HistoryRow }>(
    read: (options: {
      limit: number;
      before?: { startTs: number; sessionId: string };
      folder?: string;
      exclude: readonly string[];
    }) => SessionWithDerivation[],
    limit: number,
    before: { startTs: number; sessionId: string } | undefined,
    folder: string | undefined,
    outcome: HistoryOutcome | undefined,
    wrap?: (sw: SessionWithDerivation, row: HistoryRow) => T,
  ): Promise<{ rows: HistoryRow[]; items: T[]; next: { startTs: number; sessionId: string } | null }> {
    await this.deps.store.flush();
    const rows: HistoryRow[] = [];
    const items: T[] = [];
    let cursor = before;
    let more = false;
    for (;;) {
      const batch = read({
        limit: SCAN_PAGE,
        exclude: this.deps.exclude,
        ...(cursor !== undefined ? { before: cursor } : {}),
        ...(folder !== undefined ? { folder } : {}),
      });
      for (const sw of batch) {
        cursor = { startTs: sw.session.firstTs, sessionId: sw.session.sessionId };
        const row = await this.rowOf(sw);
        if (row === null || (outcome !== undefined && row.outcome !== outcome)) continue;
        if (rows.length === limit) {
          more = true;
          break;
        }
        rows.push(row);
        if (wrap !== undefined) items.push(wrap(sw, row));
      }
      if (more || batch.length < SCAN_PAGE) break;
      await this.yieldNow();
    }
    const last = rows.at(-1);
    return {
      rows,
      items,
      next: more && last !== undefined ? { startTs: last.startTs, sessionId: last.sessionId } : null,
    };
  }

  private async search(q: Extract<M5Query, { type: 'history.search' }>) {
    const migrating = this.deps.migrating();
    const fts = toFtsQuery(q.text);
    if (fts === null) return { hits: [], total: 0, next: null, migrating };
    const terms = searchTerms(q.text);
    const { items, next } = await this.scan<HistorySearchHit>(
      (options) => this.deps.store.history.searchPage(fts, options),
      q.limit,
      q.before,
      q.folder,
      q.outcome,
      (sw, row) => ({
        row,
        match: matchFor(
          { title: row.title, topic: row.topic, folder: row.folder, prompt: sw.session.firstPrompt },
          terms,
        ),
      }),
    );
    const total =
      q.outcome === undefined
        ? this.deps.store.history.countSearch(fts, {
            exclude: this.deps.exclude,
            ...(q.folder !== undefined ? { folder: q.folder } : {}),
          })
        : null;
    return { hits: items, total, next, migrating };
  }

  private async open(sessionId: string): Promise<QueryResult> {
    await this.deps.store.flush();
    const sw = this.deps.store.history.session(sessionId);
    if (sw === null) return NOT_FOUND;
    const threshold = Math.max(1, this.deps.settings().detectors.stuckMinutes) * 60_000;
    const head = await this.cache.use(sessionId, (index) => ({
      eventCount: index.count,
      startsWithSession: index.startsWithSession(),
      markers: [...index.markers],
      markersTruncated: index.markersTruncated,
      quietGaps: index.quietGaps(threshold),
      lastTs: index.ts[index.count - 1] ?? sw.session.lastTs,
    }));
    if (head.eventCount === 0) return NOT_FOUND;
    const row = await this.rowOf(sw);
    if (row === null) return NOT_FOUND;
    const hasReport = row.outcome !== 'running';
    return { ok: true, type: 'history.open', head: { row, hasReport, ...head } };
  }

  private async stateAt(sessionId: string, index: number): Promise<QueryResult> {
    await this.deps.store.flush();
    if (this.deps.store.history.session(sessionId) === null) return NOT_FOUND;
    const source = this.deps.store.history;
    const moment = await this.cache.use(sessionId, async (ix) => {
      if (ix.count === 0) return null;
      const i = Math.min(Math.max(0, index), ix.count - 1);
      const state = await ix.stateAt(i, source, this.yieldNow);
      return {
        sessionId,
        index: i,
        eventCount: ix.count,
        event: ix.ref(i),
        gapBeforeMs: i === 0 ? null : (ix.ts[i] ?? 0) - (ix.ts[i - 1] ?? 0),
        state: toHuddleState(state),
        why: ix.whyAt(state, i),
      };
    });
    if (moment === null) return NOT_FOUND;
    return { ok: true, type: 'history.stateAt', moment };
  }

  private async events(q: Extract<M5Query, { type: 'history.events' }>): Promise<QueryResult> {
    await this.deps.store.flush();
    if (this.deps.store.history.session(q.sessionId) === null) return NOT_FOUND;
    const source = this.deps.store.history;
    const page = await this.cache.use(q.sessionId, (ix) => {
      if (ix.count === 0) return null;
      const options = {
        ...(q.backward === true ? { backward: true } : {}),
        ...(q.agentKey !== undefined ? { agentKey: q.agentKey } : {}),
      };
      const { indexes, more } = ix.page(q.fromIndex, q.limit, options);
      const entries: ReplayEventEntry[] = indexes.map((i) => ix.ref(i));
      if (q.full === true && indexes.length > 0) {
        const seqs = indexes.map((i) => ix.seq[i] ?? 0);
        const bySeq = new Map<number, HuddleEvent>();
        for (const row of source.rowsBetween(q.sessionId, Math.min(...seqs), Math.max(...seqs), q.agentKey)) {
          if (row.event !== null) bySeq.set(row.seq, row.event);
        }
        indexes.forEach((i, n) => {
          const event = bySeq.get(ix.seq[i] ?? -1);
          const entry = entries[n];
          if (event !== undefined && entry !== undefined) entry.event = event;
        });
      }
      return { entries, eventCount: ix.count, more };
    });
    if (page === null) return NOT_FOUND;
    return { ok: true, type: 'history.events', page };
  }

  /**
   * The runs `history.list` shows with no filter, and the oldest start among them: the same pages (`sessionPage`) and
   * the same predicate (`listedAs`), so "N runs" in Settings is the length of the unfiltered list.
   */
  private async listedRunStats(): Promise<{ runs: number; oldestTs: number | null }> {
    await this.deps.store.flush();
    let runs = 0;
    let oldestTs: number | null = null;
    let cursor: { startTs: number; sessionId: string } | undefined;
    for (;;) {
      const batch = this.deps.store.history.sessionPage({
        limit: SCAN_PAGE,
        exclude: this.deps.exclude,
        ...(cursor !== undefined ? { before: cursor } : {}),
      });
      for (const sw of batch) {
        cursor = { startTs: sw.session.firstTs, sessionId: sw.session.sessionId };
        if ((await this.listedAs(sw)) === null) continue;
        runs += 1;
        oldestTs = oldestTs === null ? sw.session.firstTs : Math.min(oldestTs, sw.session.firstTs);
      }
      if (batch.length < SCAN_PAGE) break;
      await this.yieldNow();
    }
    return { runs, oldestTs };
  }

  private async stats() {
    const { runs, oldestTs } = await this.listedRunStats();
    let bytes: number | null = 0;
    for (const suffix of ['', '-wal']) {
      try {
        bytes += (await fsp.stat(this.deps.store.file + suffix)).size;
      } catch {
        if (suffix === '') bytes = null;
      }
      if (bytes === null) break;
    }
    if (bytes !== null) bytes += await reportsDirBytes(this.deps.dataDir);
    return {
      runs,
      bytes,
      oldestTs,
      retentionDays: this.deps.settings().history.retentionDays,
      migrating: this.deps.migrating(),
      legacyFolder: await this.legacyFolder(),
    };
  }

  /** The older JSONL folder delete-all also removes: the renamed one the import left, else `events` if still there. */
  private async legacyFolder(): Promise<string | null> {
    const isDir = (p: string): Promise<boolean> =>
      fsp.stat(p).then(
        (s) => s.isDirectory(),
        () => false,
      );
    const moved = this.deps.store.readMeta(META_MIGRATED_TO);
    if (moved !== null && moved !== '' && (await isDir(moved))) return moved;
    const events = path.join(path.resolve(this.deps.dataDir), 'events');
    return (await isDir(events)) ? events : null;
  }

  private async reportGet(sessionId: string): Promise<QueryResult> {
    await this.deps.store.flush();
    const sw = this.deps.store.history.session(sessionId);
    if (sw === null) return NOT_FOUND;
    if (this.isLive(sw.session)) return { ok: true, type: 'report.get', answer: { status: 'not_ready' } };
    let made: MadeReport;
    try {
      made = await this.makeReport(sessionId, { force: false });
    } catch (error) {
      this.deps.logger.warn('could not build a run report', { error: messageOf(error) });
      return { ok: true, type: 'report.get', answer: { status: 'none' } };
    }
    if (made.report === null) return { ok: true, type: 'report.get', answer: { status: 'none' } };
    const file = reportPathFor(this.deps.dataDir, sessionId);
    const writtenAt = made.derivation.reportWrittenAt;
    return {
      ok: true,
      type: 'report.get',
      answer: {
        status: 'ready',
        report: made.report,
        file:
          file === null || writtenAt === null ? null : { path: file, exists: await reportFileExists(file), writtenAt },
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Derivation and reports
  // -------------------------------------------------------------------------------------------------------------------

  /** Builds (and stores) one session's derivation from its stored events. One build per session at a time. */
  derive(sessionId: string): Promise<Derived> {
    const running = this.inFlight.get(sessionId);
    if (running !== undefined) return running;
    const work = this.runDerive(sessionId).finally(() => {
      this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, work);
    return work;
  }

  private async runDerive(sessionId: string): Promise<Derived> {
    const { store } = this.deps;
    await store.flush();
    const events: HuddleEvent[] = [];
    let rowsRead = 0;
    let after = 0;
    for (;;) {
      const rows = store.history.rowsAfter(sessionId, after, READ_CHUNK);
      for (const row of rows) {
        after = row.seq;
        rowsRead += 1;
        if (row.event !== null) events.push(row.event);
      }
      if (rows.length < READ_CHUNK) break;
      await this.yieldNow();
    }
    // The fold buildRunReport would do in one go, in chunks with a yield between them.
    const own = sessionEvents(events, sessionId);
    let state = initialState();
    for (let i = 0; i < own.length; i++) {
      state = reduce(state, own[i] as HuddleEvent);
      if ((i + 1) % READ_CHUNK === 0) await this.yieldNow();
    }
    const report = buildRunReport(own, sessionId, { state });
    const input = this.derivationOf(sessionId, rowsRead, report);
    // The report keeps every agent; `agent_runs` (the scorecards' input) only the runs a scorecard counts.
    store.history.writeDerivation(
      input,
      report === null
        ? []
        : scorecardRows(
            report.agents.map((a) => a.row),
            own,
          ),
    );
    // New agent rows: the scorecards, and so the ETA priors, may have moved (debounced). A backfill pass computes them
    // once at its end instead.
    if (this.backfillRun === null) this.schedulePriors();
    const stored = store.history.session(sessionId)?.derivation ?? null;
    return { derivation: stored ?? { ...input, reportWrittenAt: null, reportEventCount: null }, report };
  }

  private derivationOf(sessionId: string, eventCount: number, report: RunReport | null): DerivationInput {
    const base = { sessionId, version: DERIVATION_VERSION, eventCount, derivedAt: this.deps.now() };
    if (report === null) {
      return {
        ...base,
        hasRoot: false,
        outcome: null,
        origin: null,
        model: null,
        otherModels: 0,
        workTokens: null,
        tokensPartial: false,
        agentCount: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        reportJson: null,
      };
    }
    const s = report.summary;
    const others = new Set(report.agents.map((a) => a.row.model).filter((m) => m !== null && m !== s.model));
    return {
      ...base,
      hasRoot: true,
      outcome: s.outcome,
      origin: s.origin,
      model: s.model,
      otherModels: others.size,
      workTokens: s.tokens === null ? null : workTokens(s.tokens),
      tokensPartial: s.tokensPartial,
      agentCount: s.agents,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      reportJson: JSON.stringify(report),
    };
  }

  /** The stored report of a current derivation; null when it has none or the JSON is not one (then derive again). */
  private storedReport(d: Derivation): RunReport | null {
    if (d.reportJson === null) return null;
    try {
      const value: unknown = JSON.parse(d.reportJson);
      if (isRecord(value) && value.version === 1 && value.sessionId === d.sessionId)
        return value as unknown as RunReport;
    } catch {
      // Fall through.
    }
    return null;
  }

  /**
   * The session's report, built when its derivation is missing or stale, and its Markdown file written when it is
   * missing, older than the derivation, or `force`. A failed write is logged and reported, never thrown.
   */
  private async makeReport(sessionId: string, options: { force: boolean }): Promise<MadeReport> {
    await this.deps.store.flush();
    const sw = this.deps.store.history.session(sessionId);
    if (sw === null) throw new Error('no stored session');
    let derived: Derived;
    if (this.isCurrent(sw)) {
      const report = this.storedReport(sw.derivation);
      derived =
        report === null && sw.derivation.hasRoot ? await this.derive(sessionId) : { derivation: sw.derivation, report };
    } else {
      derived = await this.derive(sessionId);
    }
    const { derivation, report } = derived;
    const file = reportPathFor(this.deps.dataDir, sessionId);
    if (report === null || file === null) return { ...derived, file: null, writeFailed: false, deleted: false };
    const upToDate =
      derivation.reportWrittenAt !== null &&
      derivation.reportEventCount === derivation.eventCount &&
      (await reportFileExists(file));
    if (upToDate && !options.force) return { ...derived, file, writeFailed: false, deleted: false };
    try {
      const written = await this.reportFiles.write(sessionId, renderReportMarkdown(report));
      if (written === null) {
        // Its history is being deleted (or was, and nothing new came since): no file may outlive that.
        this.deps.logger.info('run report not written: the run was deleted from history');
        return { ...derived, file: null, writeFailed: false, deleted: true };
      }
      const writtenAt = this.deps.now();
      this.deps.store.history.markReportWritten(sessionId, writtenAt, derivation.eventCount);
      return {
        derivation: { ...derivation, reportWrittenAt: writtenAt, reportEventCount: derivation.eventCount },
        report,
        file,
        writeFailed: false,
        deleted: false,
      };
    } catch (error) {
      this.deps.logger.warn('could not write a run report file; it is written again when the run is opened', {
        error: messageOf(error),
      });
      return { ...derived, file: null, writeFailed: true, deleted: false };
    }
  }

  /** Events were stored: a run that ended in them gets its report after REPORT_DELAY_MS (debounced per session). */
  noteStored(events: readonly HuddleEvent[]): void {
    if (this.disposed) return;
    for (const e of events) {
      // A deleted run that comes back (resumed, or a new run with the same id) can have a report again. Not while its
      // deletion runs: an append that was in flight when it began lands here too, and its events are deleted with the
      // rest. deleteSessions clears the marks of the sessions it kept (they had a new event) when it ends.
      if (!this.deleting.has(e.sessionId)) this.reportFiles.allow(e.sessionId);
      const ending = (e.type === 'session.ended' && e.agentKey === e.sessionId) || ENDING_TYPES.has(e.type);
      if (ending) this.schedule(e.sessionId);
    }
  }

  private schedule(sessionId: string): void {
    const old = this.timers.get(sessionId);
    if (old !== undefined) clearTimeout(old);
    const timer = setTimeout(
      () => {
        this.timers.delete(sessionId);
        this.runReportOnEnd(sessionId);
      },
      Math.max(0, this.deps.reportDelayMs ?? REPORT_DELAY_MS),
    );
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  private runReportOnEnd(sessionId: string): void {
    if (this.disposed) return;
    const work = this.deps.track(this.reportOnEnd(sessionId)).finally(() => {
      this.reportWork.delete(work);
    });
    this.reportWork.add(work);
  }

  private async reportOnEnd(sessionId: string): Promise<void> {
    try {
      await this.deps.store.flush();
      const sw = this.deps.store.history.session(sessionId);
      // A run that went on (resumed) gets its report when it ends again.
      if (sw === null || this.isLive(sw.session)) return;
      const made = await this.makeReport(sessionId, { force: false });
      if (made.report !== null && !made.writeFailed && !made.deleted) this.deps.logger.info('run report written');
    } catch (error) {
      this.deps.logger.warn('could not make a run report; it is made when the run is opened', {
        error: messageOf(error),
      });
    }
  }

  /** Tests and quit: write the reports waiting for their delay now, and wait for every report in progress. */
  async flushReports(): Promise<void> {
    const waiting = [...this.timers.keys()];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const sessionId of waiting) this.runReportOnEnd(sessionId);
    await Promise.allSettled([...this.reportWork]);
    await this.reportFiles.idle();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------------------------------

  /** `report.make`: build the report of an ended run from its stored events and write its file. */
  async makeReportCommand(sessionId: string): Promise<CommandResult> {
    await this.deps.store.flush();
    const sw = this.deps.store.history.session(sessionId);
    if (sw === null) return { ok: false, code: 'not_found', message: 'There is no stored run with that id.' };
    if (this.isLive(sw.session)) {
      return { ok: false, code: 'unsupported', message: 'This run is still going. Its report is made when it ends.' };
    }
    const made = await this.makeReport(sessionId, { force: true });
    if (made.deleted) {
      return {
        ok: false,
        code: 'not_found',
        message: 'This run was deleted from history, so there is no report to make.',
      };
    }
    if (made.report === null) {
      return { ok: false, code: 'failed', message: 'This log has no main agent, so there is no report to make.' };
    }
    if (made.writeFailed || made.file === null) {
      return {
        ok: false,
        code: 'failed',
        message: 'The report is built, but its file could not be written. Check that the app data folder is writable.',
      };
    }
    return { ok: true, detail: made.file };
  }

  /**
   * `report.openFile` / `report.copyPath`: the run's report file path in `detail`, only a file inside
   * `<dataDir>/reports` that exists. Desktop main opens it or copies it.
   */
  async reportFileCommand(sessionId: string): Promise<CommandResult> {
    const file = reportPathFor(this.deps.dataDir, sessionId);
    if (file === null) return { ok: false, code: 'invalid', message: 'That run id is not valid.' };
    await this.deps.store.flush();
    if (this.deps.store.history.session(sessionId) === null) {
      return { ok: false, code: 'not_found', message: 'There is no stored run with that id.' };
    }
    if (!(await reportFileExists(file))) {
      return { ok: false, code: 'not_found', message: 'The report file is missing. Write it again first.' };
    }
    return { ok: true, detail: file };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Deleting history (M5 WP5, F22): retention and "delete all history"
  // -------------------------------------------------------------------------------------------------------------------

  /** A stored session the Huddle must not delete now: running in this Huddle, or a managed run whose process lives. */
  private liveSet(): Set<string> {
    const isRunLive = this.deps.isRunLive ?? (() => false);
    const live = new Set(this.liveIds());
    for (const id of this.deps.store.history.sessionIds([])) if (isRunLive(id)) live.add(id);
    return live;
  }

  /**
   * The sessions a retention of `days` deletes now: no event in the last `days` days (`HistoryTables.inactiveBefore`,
   * the rule `countInactiveBefore` counts), the Huddle's own sessions and live sessions left out. The retention deletes
   * this whole list, run-less fragments included; the preview (`retentionRunCount`) counts the runs on it.
   *
   * While an overall budget is in force, no session it counts is chosen either: the cutoff moves back to the budget's
   * `setAt` (`activeOverallBudgetSince`, the rule the start-up replay uses). A retention is a cleanup; it must never
   * lower a safety cap's usage and so let paused or stopped runs go on.
   */
  async retentionCandidates(days: number): Promise<string[]> {
    await this.deps.store.flush();
    const since = await this.overallBudgetSince();
    const cutoff = Math.min(this.retentionCutoff(days), since ?? Number.POSITIVE_INFINITY);
    const live = this.liveSet();
    return this.deps.store.history.inactiveBefore(cutoff, [...this.deps.exclude, ...live]);
  }

  /**
   * What `history.retentionPreview` answers for `days`, and what the lowering command's `confirm` must equal (L4): how
   * many of `retentionCandidates(days)` are runs `history.list` shows (`listedAs`), so "(N runs)" in the confirmation
   * matches the list. The deletion itself takes every candidate, so it also removes the run-less fragments older than
   * the cutoff (sessions with no main agent, which are inactive and never listed); they are not counted here.
   */
  async retentionRunCount(days: number): Promise<number> {
    let runs = 0;
    for (const id of await this.retentionCandidates(days)) {
      const sw = this.deps.store.history.session(id);
      if (sw !== null && (await this.listedAs(sw)) !== null) runs += 1;
    }
    return runs;
  }

  /** `setAt` of the overall budget in force (from the stored budget session), or null when none is. */
  async overallBudgetSince(): Promise<number | null> {
    const sessionId = this.deps.budgetSessionId;
    if (sessionId === undefined) return null;
    const events: HuddleEvent[] = [];
    for await (const event of this.deps.store.readSession(sessionId)) events.push(event);
    return activeOverallBudgetSince(events);
  }

  /** How many of these stored sessions an overall budget in force counts (last event at or after its `setAt`). */
  async countedByOverallBudget(ids: readonly string[]): Promise<number> {
    const since = await this.overallBudgetSince();
    if (since === null) return 0;
    return ids.filter((id) => (this.deps.store.history.session(id)?.session.lastTs ?? -Infinity) >= since).length;
  }

  /** Epoch ms before which a retention of `days` deletes. */
  retentionCutoff(days: number): number {
    return this.deps.now() - days * DAY_MS;
  }

  /** Every session "delete all history" deletes: all but `keep` (the overall budgets) and live sessions. */
  async deleteAllCandidates(): Promise<string[]> {
    await this.deps.store.flush();
    const live = this.liveSet();
    return this.deps.store.history.sessionIds([...(this.deps.keep ?? []), ...live]);
  }

  /**
   * Deletes these sessions' events, `sessions`, search, `run_derivations` and `agent_runs` rows and report files, in
   * transactions of at most `pruneChunkRows` events with a yield between them. Each session is deleted as it was when
   * this call began (up to its newest `seq` then): a session that gets an event meanwhile keeps that event and comes
   * back as `kept` (its row is rebuilt from what is left). No file is written for a deleted run: a report waiting for its
   * delay is called off, the report writer refuses these sessions from the start (also a `report.make` made while this
   * runs), and a write in flight finishes before the file is removed. A deleted session stays refused until it has a new
   * event (`noteStored`); the others are allowed again when this ends. Rejects on a database error; what was deleted
   * before it stays deleted (each session's step is its own transaction).
   */
  async deleteSessions(
    ids: readonly string[],
    shouldStop: () => boolean = () => false,
  ): Promise<{ deleted: string[]; kept: string[]; events: number; reports: number }> {
    const { store } = this.deps;
    const chunk = Math.max(1, Math.floor(this.deps.pruneChunkRows ?? PRUNE_CHUNK_ROWS));
    for (const id of ids) {
      const timer = this.timers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(id);
    }
    // No report file may outlive the deletion. From here on the writer refuses these sessions: a `report.make` or an
    // end-of-run report that starts now, and one waiting in the writer's queue, write nothing. The write already in
    // flight is waited for below, before the file is removed. The marks stay on the deleted sessions after this call.
    for (const id of ids) this.deleting.add(id);
    this.reportFiles.refuse(ids);
    const deleted: string[] = [];
    const kept: string[] = [];
    let events = 0;
    let reports = 0;
    try {
      const deriving = ids.map((id) => this.inFlight.get(id)).filter((p): p is Promise<Derived> => p !== undefined);
      await Promise.allSettled([...this.reportWork, ...deriving]);
      await this.reportFiles.idle();
      await store.flush();
      const upTo = new Map(ids.map((id) => [id, store.maxSeq(id)]));
      store.setSecureDelete(true);
      try {
        for (const id of ids) {
          // Quit: stop between sessions; what is deleted stays deleted, the rest waits for the next pass.
          if (shouldStop()) break;
          for (;;) {
            const step = store.deleteSessionStep(id, { upToSeq: upTo.get(id) ?? 0 }, chunk);
            events += step.removed;
            await this.yieldNow();
            if (step.state === 'more') continue;
            (step.state === 'deleted' ? deleted : kept).push(id);
            break;
          }
          // The report described the events just deleted, whether or not the session goes on.
          if (await this.removeReportFile(id)) reports += 1;
        }
      } finally {
        store.setSecureDelete(false);
        this.cache.clear();
        // Their agent rows went with them.
        this.schedulePriors();
      }
    } finally {
      const gone = new Set(deleted);
      for (const id of ids) {
        this.deleting.delete(id);
        // Kept (a new event came meanwhile), not reached (quit) or left by an error: its reports are written again.
        if (!gone.has(id)) this.reportFiles.allow(id);
      }
    }
    return { deleted, kept, events, reports };
  }

  /** Deletes one session's events older than `beforeTs` (the Huddle's own history session), in chunks. */
  async trimSession(sessionId: string, beforeTs: number): Promise<number> {
    const chunk = Math.max(1, Math.floor(this.deps.pruneChunkRows ?? PRUNE_CHUNK_ROWS));
    await this.deps.store.flush();
    if (this.deps.store.history.session(sessionId) === null) return 0;
    let removed = 0;
    for (;;) {
      const step = this.deps.store.deleteSessionStep(sessionId, { beforeTs }, chunk);
      removed += step.removed;
      await this.yieldNow();
      if (step.state !== 'more') return removed;
    }
  }

  private async removeReportFile(sessionId: string): Promise<boolean> {
    const file = reportPathFor(this.deps.dataDir, sessionId);
    if (file === null) return false;
    try {
      await fsp.unlink(file);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * "Delete all history": every file directly in the reports folder that belongs to a session not in `keepIds` (a
   * report `<sessionId>.md`, or a temp file `.<sessionId>.<hex>.tmp` a crash left), including reports of sessions the
   * database no longer knows. Folders are left alone; a link is removed as a link. Returns how many were removed.
   */
  async removeReportFiles(keepIds: ReadonlySet<string>): Promise<number> {
    const dir = reportsDirOf(this.deps.dataDir);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const sessionId = /^(.+)\.md$/.exec(name)?.[1] ?? /^\.(.+)\.[0-9a-f]{12}\.tmp$/.exec(name)?.[1] ?? null;
      if (sessionId === null || keepIds.has(sessionId)) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fsp.lstat(file);
        if (stat.isDirectory()) continue;
        await fsp.unlink(file);
        removed += 1;
      } catch (error) {
        this.deps.logger.warn('could not remove a report file', { error: messageOf(error) });
      }
    }
    return removed;
  }

  /**
   * The older JSONL history folders in the data folder: `events` (not imported, or its rename failed) and every
   * `events.migrated-*` the import left. Links count too (they are removed as links).
   */
  async legacyFolders(): Promise<string[]> {
    const dataDir = path.resolve(this.deps.dataDir);
    let entries: string[];
    try {
      entries = await fsp.readdir(dataDir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name === LEGACY_EVENTS_DIRNAME || name.startsWith(`${LEGACY_EVENTS_DIRNAME}.migrated-`))
      .map((name) => path.join(dataDir, name))
      .sort();
  }

  /** Removes `legacyFolders()` without following links. Returns how many went and the problems, in words. */
  async removeLegacyFolders(): Promise<{ removed: number; problems: string[] }> {
    let removed = 0;
    const problems: string[] = [];
    for (const folder of await this.legacyFolders()) {
      try {
        const result = await removeTreeNoFollow(folder);
        if (result.existed) removed += 1;
      } catch (error) {
        problems.push(`${path.basename(folder)}: ${messageOf(error)}`);
      }
    }
    return { removed, problems };
  }

  /**
   * The retention's part of the older JSONL history (M5 security review M1). Only once the import is recorded as done
   * (`jsonl_migrated_at`): each `events.migrated-*` folder, and an `events` folder only when the import left that very
   * folder in place (its rename failed, `jsonl_migrated_to` empty; an `events` folder after a renaming import holds new
   * lines the next start imports, so it is never touched here). A folder goes, without following links, only when its
   * newest file is older than `cutoff`; one that holds a newer file (or cannot be read) is kept, and logged.
   */
  async removeExpiredLegacyFolders(cutoff: number): Promise<{ removed: number; kept: number; problems: string[] }> {
    const out = { removed: 0, kept: 0, problems: [] as string[] };
    if (!isJsonlMigrationDone(this.deps.store)) return out;
    const leftInPlace = (this.deps.store.readMeta(META_MIGRATED_TO) ?? '') === '';
    for (const folder of await this.legacyFolders()) {
      const name = path.basename(folder);
      if (name === LEGACY_EVENTS_DIRNAME && !leftInPlace) continue;
      let newest: number;
      try {
        newest = await newestFileMtimeNoFollow(folder);
      } catch (error) {
        out.kept += 1;
        this.deps.logger.warn('kept an older history folder: it could not be read', {
          folder: name,
          error: messageOf(error),
        });
        continue;
      }
      if (newest >= cutoff) {
        out.kept += 1;
        this.deps.logger.info('kept an older history folder: it holds a file newer than the retention', {
          folder: name,
        });
        continue;
      }
      try {
        const result = await removeTreeNoFollow(folder);
        if (result.existed) out.removed += 1;
      } catch (error) {
        out.problems.push(`${name}: ${messageOf(error)}`);
      }
    }
    return out;
  }

  /** The search index rebuilt from the sessions left ("delete all history": no deleted text left in it). */
  rebuildSearchIndex(): void {
    this.deps.store.rebuildSearchIndex();
  }

  /**
   * After a deletion: `VACUUM` only when it is cheap (at most VACUUM_MAX_LIVE_BYTES left and at least
   * VACUUM_MIN_FREE_BYTES to give back); otherwise the free pages are reused by new events. Never throws.
   */
  compactIfCheap(): 'vacuumed' | 'skipped' | 'failed' {
    try {
      const { pageCount, freePages, pageSize } = this.deps.store.pageStats();
      const live = (pageCount - freePages) * pageSize;
      const free = freePages * pageSize;
      if (live > VACUUM_MAX_LIVE_BYTES || free < VACUUM_MIN_FREE_BYTES) return 'skipped';
      this.deps.store.vacuum();
      return 'vacuumed';
    } catch (error) {
      this.deps.logger.warn('could not compact the event database after deleting history', {
        error: messageOf(error),
      });
      return 'failed';
    }
  }

  /**
   * The latest nickname per agent in the stored log (`control.applied` rename, ADR-015), for the agents whose session
   * `include` accepts: a name, or null when the latest rename cleared it. Read in chunks with a yield between them.
   */
  async storedNicknames(include: (sessionId: string) => boolean): Promise<Map<AgentKey, string | null>> {
    await this.deps.store.flush();
    const out = new Map<AgentKey, string | null>();
    let after = 0;
    for (;;) {
      const rows = this.deps.store.history.controlEventsAfter(after, READ_CHUNK);
      for (const row of rows) {
        after = row.seq;
        const e = row.event;
        if (e?.type !== 'control.applied' || e.action !== 'rename' || !include(sessionOfAgentKey(e.agentKey))) continue;
        const name = e.detail === null ? '' : e.detail.trim();
        out.set(e.agentKey, name === '' ? null : name);
      }
      if (rows.length < READ_CHUNK) return out;
      await this.yieldNow();
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Backfill
  // -------------------------------------------------------------------------------------------------------------------

  /** One backfill pass (or the one running): derives sessions whose derivation is missing or stale. Never rejects. */
  backfill(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.backfillRun ??= this.deps.track(this.runBackfill()).finally(() => {
      this.backfillRun = null;
    });
    return this.backfillRun;
  }

  private async runBackfill(): Promise<void> {
    const max = Math.max(0, this.deps.backfillMaxSessions ?? BACKFILL_MAX_SESSIONS);
    const startedAt = this.deps.now();
    const failed = new Set<string>();
    let derived = 0;
    const progress = (done: boolean, remaining: number | null): void => {
      try {
        this.deps.store.writeMeta({
          [META_BACKFILL]: JSON.stringify({
            version: DERIVATION_VERSION,
            startedAt,
            finishedAt: done ? this.deps.now() : null,
            derived,
            failed: failed.size,
            remaining,
          }),
        });
      } catch (error) {
        this.deps.logger.warn('could not record the history backfill progress', { error: messageOf(error) });
      }
    };
    try {
      await this.deps.store.flush();
      let remaining: number | null = null;
      while (!this.isDisposed() && derived + failed.size < max) {
        const skip = [...this.deps.exclude, ...this.liveIds(), ...failed];
        const pending = this.deps.store.history.pendingDerivations(DERIVATION_VERSION, skip, 50);
        if (pending.length === 0) {
          remaining = 0;
          break;
        }
        for (const p of pending) {
          if (this.isDisposed() || derived + failed.size >= max) break;
          try {
            await this.derive(p.sessionId);
            derived += 1;
          } catch (error) {
            failed.add(p.sessionId);
            this.deps.logger.warn('could not derive a stored run', { error: messageOf(error) });
          }
          await this.yieldNow();
        }
        progress(false, null);
      }
      if (this.isDisposed()) return;
      // The first priors of this start come from here, also when there was nothing to derive.
      this.schedulePriors();
      progress(remaining === 0, remaining);
      if (derived > 0 || failed.size > 0) {
        this.deps.logger.info('history backfill', { derived, failed: failed.size, done: remaining === 0 });
      }
    } catch (error) {
      if (!this.isDisposed()) this.deps.logger.warn('history backfill stopped', { error: messageOf(error) });
    }
  }

  /** A call, not a field read, so TypeScript does not narrow it across the awaits where it can change. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // ETA priors (M5 WP7, F24 -> F4)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The ETA priors from the stored scorecards, as last computed; null before the first computation. A cached value:
   * `getState()` reads it on every call, so it is never computed here.
   */
  priors(): EtaPriors | null {
    return this.priorsValue;
  }

  /** Computes the priors again PRIORS_DELAY_MS after the last call (debounced). */
  private schedulePriors(): void {
    if (this.disposed) return;
    if (this.priorsTimer !== null) clearTimeout(this.priorsTimer);
    this.priorsTimer = setTimeout(
      () => {
        this.priorsTimer = null;
        this.recomputePriors();
      },
      Math.max(0, this.deps.priorsDelayMs ?? PRIORS_DELAY_MS),
    );
    this.priorsTimer.unref();
  }

  /**
   * Scorecards over the stored agent rows (the same rows `scorecards.get` uses: not the Huddle's own sessions, not live
   * ones), then `etaPriorsFrom`. Tells the core only when a prior changed. Never throws.
   */
  recomputePriors(): void {
    if (this.disposed) return;
    try {
      const rows = this.deps.store.history.agentRuns([...this.deps.exclude, ...this.liveIds()]);
      const next = etaPriorsFrom(computeScorecards(rows), this.deps.now());
      const before = this.priorsValue;
      this.priorsValue = next;
      if (before === null || JSON.stringify(before.byRoleModel) !== JSON.stringify(next.byRoleModel)) {
        this.deps.onPriorsChanged?.();
      }
    } catch (error) {
      this.deps.logger.warn('could not compute the ETA priors', { error: messageOf(error) });
    }
  }

  /** Quit: no new report or backfill step starts. Work already running finishes (the core waits for it). */
  dispose(): void {
    this.disposed = true;
    if (this.priorsTimer !== null) clearTimeout(this.priorsTimer);
    this.priorsTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.cache.clear();
  }
}
