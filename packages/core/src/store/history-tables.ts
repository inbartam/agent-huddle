/**
 * The history side of the SQLite store (M5 WP4b, F22-F24): paged reads of `sessions` for the history list and search,
 * raw row reads of one session's events by `seq` (for the replay index), and the derived tables of schema v3
 * (`run_derivations`, `agent_runs`; see sqlite-schema.ts).
 *
 * It shares the store's one connection (`SqliteEventStore.history`), so every statement here is synchronous like the
 * store's own, and a write transaction can never interleave with the store's append transaction (one JS thread, no
 * await inside a transaction). Callers flush the store's pending appends first when they need them
 * (`SqliteEventStore.flush`).
 *
 * Nothing here knows Claude Code's payloads: rows are HuddleEvents (as stored, masked) and the derived values the
 * report code made from them.
 */
import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { AgentOrigin, AgentRunRow, HuddleEvent, RunOutcome } from '@huddle/shared';
import { parseStoredEvent } from './codec.js';
import type { StoredSession } from './sqlite-store.js';

/** One stored row of a session's log. `event` is null when its JSON is not an event (it is skipped, never thrown). */
export interface StoredRow {
  seq: number;
  event: HuddleEvent | null;
}

/** A `run_derivations` row (schema v3). */
export interface Derivation {
  sessionId: string;
  /** history.ts `DERIVATION_VERSION` when it was made. */
  version: number;
  /** Rows of the session it was built from (stale when `sessions.event_count` differs). */
  eventCount: number;
  derivedAt: number;
  /** The log held a main agent for the session (otherwise there is no report and no history row). */
  hasRoot: boolean;
  outcome: RunOutcome | null;
  origin: AgentOrigin | null;
  model: string | null;
  otherModels: number;
  /** Input plus output tokens over the agents; null when no agent had a usage record. */
  workTokens: number | null;
  tokensPartial: boolean;
  agentCount: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  /** The `RunReport` as JSON; null without a root. */
  reportJson: string | null;
  /** When the Markdown file was last written, and from how many rows; null when never. */
  reportWrittenAt: number | null;
  reportEventCount: number | null;
}

/** What `writeDerivation` sets (the report-file columns are set by `markReportWritten`). */
export type DerivationInput = Omit<Derivation, 'reportWrittenAt' | 'reportEventCount'>;

export interface SessionWithDerivation {
  session: StoredSession;
  derivation: Derivation | null;
}

/** Keyset position: rows strictly after this one in (first_ts DESC, session_id ASC) order. */
export interface SessionCursor {
  startTs: number;
  sessionId: string;
}

export interface SessionPageOptions {
  limit: number;
  before?: SessionCursor;
  /** Only sessions whose root `cwd` is exactly this. */
  folder?: string;
  /** Session ids never listed (the overall budgets' pseudo session). */
  exclude: readonly string[];
}

/** A session that needs (re)deriving: no derivation, an older version, or more rows than it was built from. */
export interface PendingDerivation {
  sessionId: string;
  eventCount: number;
  lastTs: number;
}

function toNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function toNumberOrNull(value: SQLOutputValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function toText(value: SQLOutputValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

const RUN_OUTCOMES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'unknown']);
const ORIGINS: ReadonlySet<string> = new Set(['attached', 'managed']);
const KINDS: ReadonlySet<string> = new Set(['main', 'subagent', 'teammate']);

function outcomeOf(value: SQLOutputValue | undefined): RunOutcome | null {
  const text = toText(value);
  return text !== null && RUN_OUTCOMES.has(text) ? (text as RunOutcome) : null;
}

const SESSION_COLUMNS = [
  'session_id',
  'first_ts',
  'last_ts',
  'event_count',
  'ended',
  'cwd',
  'title',
  'model',
  'first_prompt',
  'last_prompt',
] as const;

const DERIVATION_COLUMNS = [
  'version',
  'event_count',
  'derived_at',
  'has_root',
  'outcome',
  'origin',
  'model',
  'other_models',
  'work_tokens',
  'tokens_partial',
  'agent_count',
  'started_at',
  'ended_at',
  'duration_ms',
  'report_json',
  'report_written_at',
  'report_event_count',
] as const;

/** `s.<col>` for the session, `d.<col> AS d_<col>` for the derivation (the names overlap). */
const JOINED_SELECT = [
  ...SESSION_COLUMNS.map((c) => `s.${c}`),
  'd.session_id AS d_session_id',
  ...DERIVATION_COLUMNS.map((c) => `d.${c} AS d_${c}`),
].join(', ');

const AGENT_RUN_COLUMNS = [
  'session_id',
  'agent_key',
  'parent_key',
  'kind',
  'role',
  'model',
  'started_at',
  'ended_at',
  'duration_ms',
  'outcome',
  'tasks_created',
  'tasks_completed',
  'tool_calls',
  'tool_failures',
  'approvals_requested',
  'approvals_by_user',
  'approvals_by_policy',
  'approvals_other',
  'approvals_unresolved',
  'stuck_incidents',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_cache_created',
  'tokens_requests',
  'estimated_cost_usd',
  'cost_partial',
] as const;

function sessionOf(row: Record<string, SQLOutputValue>): StoredSession {
  return {
    sessionId: toText(row.session_id) ?? '',
    firstTs: toNumber(row.first_ts),
    lastTs: toNumber(row.last_ts),
    eventCount: toNumber(row.event_count),
    ended: toNumber(row.ended) !== 0,
    cwd: toText(row.cwd),
    title: toText(row.title),
    model: toText(row.model),
    firstPrompt: toText(row.first_prompt),
    lastPrompt: toText(row.last_prompt),
  };
}

/** The derivation columns of a row, read with `prefix` (`d_` in a join, '' from the table itself). */
function derivationOf(row: Record<string, SQLOutputValue>, prefix: string): Derivation | null {
  const sessionId = toText(row[`${prefix}session_id`]);
  if (sessionId === null) return null;
  const col = (name: (typeof DERIVATION_COLUMNS)[number]): SQLOutputValue | undefined => row[`${prefix}${name}`];
  const origin = toText(col('origin'));
  return {
    sessionId,
    version: toNumber(col('version')),
    eventCount: toNumber(col('event_count')),
    derivedAt: toNumber(col('derived_at')),
    hasRoot: toNumber(col('has_root')) !== 0,
    outcome: outcomeOf(col('outcome')),
    origin: origin !== null && ORIGINS.has(origin) ? (origin as AgentOrigin) : null,
    model: toText(col('model')),
    otherModels: toNumber(col('other_models')),
    workTokens: toNumberOrNull(col('work_tokens')),
    tokensPartial: toNumber(col('tokens_partial')) !== 0,
    agentCount: toNumber(col('agent_count')),
    startedAt: toNumberOrNull(col('started_at')),
    endedAt: toNumberOrNull(col('ended_at')),
    durationMs: toNumberOrNull(col('duration_ms')),
    reportJson: toText(col('report_json')),
    reportWrittenAt: toNumberOrNull(col('report_written_at')),
    reportEventCount: toNumberOrNull(col('report_event_count')),
  };
}

function agentRunOf(row: Record<string, SQLOutputValue>): AgentRunRow {
  const kind = toText(row.kind) ?? 'main';
  const input = toNumberOrNull(row.tokens_input);
  return {
    sessionId: toText(row.session_id) ?? '',
    agentKey: toText(row.agent_key) ?? '',
    parentKey: toText(row.parent_key),
    kind: (KINDS.has(kind) ? kind : 'main') as AgentRunRow['kind'],
    role: toText(row.role) ?? '',
    model: toText(row.model),
    startedAt: toNumber(row.started_at),
    endedAt: toNumberOrNull(row.ended_at),
    durationMs: toNumberOrNull(row.duration_ms),
    outcome: outcomeOf(row.outcome) ?? 'unknown',
    tasksCreated: toNumber(row.tasks_created),
    tasksCompleted: toNumber(row.tasks_completed),
    toolCalls: toNumber(row.tool_calls),
    toolFailures: toNumber(row.tool_failures),
    approvals: {
      requested: toNumber(row.approvals_requested),
      byUser: toNumber(row.approvals_by_user),
      byPolicy: toNumber(row.approvals_by_policy),
      other: toNumber(row.approvals_other),
      unresolved: toNumber(row.approvals_unresolved),
    },
    stuckIncidents: toNumber(row.stuck_incidents),
    tokens:
      input === null
        ? null
        : {
            input,
            output: toNumber(row.tokens_output),
            cacheRead: toNumber(row.tokens_cache_read),
            cacheCreation: toNumber(row.tokens_cache_created),
            requests: toNumber(row.tokens_requests),
          },
    estimatedCostUsd: toNumberOrNull(row.estimated_cost_usd),
    costPartial: toNumber(row.cost_partial) !== 0,
  };
}

function agentRunValues(row: AgentRunRow): (string | number | null)[] {
  const t = row.tokens;
  return [
    row.sessionId,
    row.agentKey,
    row.parentKey,
    row.kind,
    row.role,
    row.model,
    row.startedAt,
    row.endedAt,
    row.durationMs,
    row.outcome,
    row.tasksCreated,
    row.tasksCompleted,
    row.toolCalls,
    row.toolFailures,
    row.approvals.requested,
    row.approvals.byUser,
    row.approvals.byPolicy,
    row.approvals.other,
    row.approvals.unresolved,
    row.stuckIncidents,
    t?.input ?? null,
    t?.output ?? null,
    t?.cacheRead ?? null,
    t?.cacheCreation ?? null,
    t?.requests ?? null,
    row.estimatedCostUsd,
    row.costPartial ? 1 : 0,
  ];
}

/** Read live: SQLite can end a transaction on its own (disk full, I/O error), which the type checker cannot see. */
function inTransaction(db: DatabaseSync): boolean {
  return db.isTransaction;
}

const EXCLUDE = 's.session_id NOT IN (SELECT value FROM json_each(?))';
/** The retention rule (M5): no event at or after the cutoff (first parameter), `exclude` (second) left out. */
const INACTIVE_BEFORE = `s.last_ts < ? AND ${EXCLUDE}`;

export class HistoryTables {
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly ensureOpen: () => void,
  ) {}

  private statement(sql: string): StatementSync {
    this.ensureOpen();
    let stmt = this.statements.get(sql);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * WHERE clauses and their parameters for a page: exclusion, folder, cursor, and no session already known to have no
   * main agent (a derivation with `has_root = 0`: not a run). Needs `d` joined.
   */
  private pageFilter(options: SessionPageOptions): { where: string[]; params: (string | number)[] } {
    const where = [EXCLUDE, '(d.has_root IS NULL OR d.has_root != 0)'];
    const params: (string | number)[] = [JSON.stringify([...options.exclude])];
    if (options.folder !== undefined) {
      where.push('s.cwd = ?');
      params.push(options.folder);
    }
    if (options.before !== undefined) {
      where.push('(s.first_ts < ? OR (s.first_ts = ? AND s.session_id > ?))');
      params.push(options.before.startTs, options.before.startTs, options.before.sessionId);
    }
    return { where, params };
  }

  /** Sessions newest start first (then session id), with their derivation, after `before`. */
  sessionPage(options: SessionPageOptions): SessionWithDerivation[] {
    const { where, params } = this.pageFilter(options);
    const sql =
      `SELECT ${JOINED_SELECT} FROM sessions AS s LEFT JOIN run_derivations AS d ON d.session_id = s.session_id ` +
      `WHERE ${where.join(' AND ')} ORDER BY s.first_ts DESC, s.session_id LIMIT ?`;
    return this.statement(sql)
      .all(...params, Math.max(0, Math.floor(options.limit)))
      .map((row) => ({ session: sessionOf(row), derivation: derivationOf(row, 'd_') }));
  }

  /** Like `sessionPage`, over the sessions whose indexed text matches the FTS5 query `fts` (see `toFtsQuery`). */
  searchPage(fts: string, options: SessionPageOptions): SessionWithDerivation[] {
    const { where, params } = this.pageFilter(options);
    const sql =
      `SELECT ${JOINED_SELECT} FROM sessions_fts JOIN sessions AS s ON s.sid = sessions_fts.rowid ` +
      `LEFT JOIN run_derivations AS d ON d.session_id = s.session_id ` +
      `WHERE sessions_fts MATCH ? AND ${where.join(' AND ')} ORDER BY s.first_ts DESC, s.session_id LIMIT ?`;
    return this.statement(sql)
      .all(fts, ...params, Math.max(0, Math.floor(options.limit)))
      .map((row) => ({ session: sessionOf(row), derivation: derivationOf(row, 'd_') }));
  }

  /** How many sessions match `fts` (folder and exclusion applied, no cursor). */
  countSearch(fts: string, options: Pick<SessionPageOptions, 'folder' | 'exclude'>): number {
    const { where, params } = this.pageFilter({ ...options, limit: 0 });
    const sql =
      `SELECT count(*) AS n FROM sessions_fts JOIN sessions AS s ON s.sid = sessions_fts.rowid ` +
      `LEFT JOIN run_derivations AS d ON d.session_id = s.session_id ` +
      `WHERE sessions_fts MATCH ? AND ${where.join(' AND ')}`;
    return toNumber(this.statement(sql).get(fts, ...params)?.n);
  }

  /** One session and its derivation; null when it is not stored. */
  session(sessionId: string): SessionWithDerivation | null {
    const sql =
      `SELECT ${JOINED_SELECT} FROM sessions AS s LEFT JOIN run_derivations AS d ON d.session_id = s.session_id ` +
      'WHERE s.session_id = ?';
    const row = this.statement(sql).get(sessionId);
    return row === undefined ? null : { session: sessionOf(row), derivation: derivationOf(row, 'd_') };
  }

  /** Every root folder with a stored session, the one with the most recent start first. */
  folders(exclude: readonly string[], limit = 1000): string[] {
    const sql =
      `SELECT s.cwd AS cwd, max(s.first_ts) AS t FROM sessions AS s WHERE s.cwd IS NOT NULL AND ${EXCLUDE} ` +
      'GROUP BY s.cwd ORDER BY t DESC, s.cwd LIMIT ?';
    return this.statement(sql)
      .all(JSON.stringify([...exclude]), limit)
      .map((row) => toText(row.cwd))
      .filter((cwd): cwd is string => cwd !== null);
  }

  /** Sessions with no event at or after `cutoffTs` (what a retention would delete), `exclude` left out. */
  countInactiveBefore(cutoffTs: number, exclude: readonly string[]): number {
    const sql = `SELECT count(*) AS n FROM sessions AS s WHERE ${INACTIVE_BEFORE}`;
    return toNumber(this.statement(sql).get(cutoffTs, JSON.stringify([...exclude]))?.n);
  }

  /**
   * The ids `countInactiveBefore` counts, oldest last event first (M5 WP5): the retention deletes exactly these (less
   * any session the caller finds live), and its preview counts the same list.
   */
  inactiveBefore(cutoffTs: number, exclude: readonly string[]): string[] {
    const sql = `SELECT s.session_id AS session_id FROM sessions AS s WHERE ${INACTIVE_BEFORE} ORDER BY s.last_ts, s.session_id`;
    return this.statement(sql)
      .all(cutoffTs, JSON.stringify([...exclude]))
      .map((row) => toText(row.session_id))
      .filter((id): id is string => id !== null);
  }

  /** Every stored session id, `exclude` left out, oldest last event first ("delete all history", M5 WP5). */
  sessionIds(exclude: readonly string[]): string[] {
    const sql = `SELECT s.session_id AS session_id FROM sessions AS s WHERE ${EXCLUDE} ORDER BY s.last_ts, s.session_id`;
    return this.statement(sql)
      .all(JSON.stringify([...exclude]))
      .map((row) => toText(row.session_id))
      .filter((id): id is string => id !== null);
  }

  /**
   * Up to `limit` stored `control.applied` events with `seq > afterSeq`, in log order (the nicknames copied into the
   * settings before history is deleted, M5 WP5). Rows whose JSON is not an event are skipped.
   */
  controlEventsAfter(afterSeq: number, limit: number): StoredRow[] {
    const sql = "SELECT seq, json FROM events WHERE type = 'control.applied' AND seq > ? ORDER BY seq LIMIT ?";
    return this.statement(sql)
      .all(afterSeq, Math.max(0, Math.floor(limit)))
      .map((row) => ({ seq: toNumber(row.seq), event: parseStoredEvent(toText(row.json) ?? '') }));
  }

  /**
   * One run's stored lifecycle events (`run.*`, `worktree.*`), in log order: enough for the reducer to rebuild the run
   * as its root shows it (M5 WP5, worktree commands on runs that are no longer in the live state). The run's events are
   * filed under its session, which is the runId for every run this Huddle launches (S16 h).
   */
  runEvents(runId: string): HuddleEvent[] {
    const sql =
      'SELECT json FROM events WHERE session_id = ? AND type IN ' +
      "('run.launched', 'run.exited', 'run.result', 'worktree.created', 'worktree.summarized', 'worktree.closed') " +
      'ORDER BY seq';
    const out: HuddleEvent[] = [];
    for (const row of this.statement(sql).all(runId)) {
      const event = parseStoredEvent(toText(row.json) ?? '');
      if (event !== null) out.push(event);
    }
    return out;
  }

  /** The current `sessions.event_count` of one session (0 when not stored). */
  eventCount(sessionId: string): number {
    return toNumber(
      this.statement('SELECT event_count FROM sessions WHERE session_id = ?').get(sessionId)?.event_count,
    );
  }

  /** Up to `limit` rows of one session with `seq > afterSeq`, in log order. */
  rowsAfter(sessionId: string, afterSeq: number, limit: number): StoredRow[] {
    const sql = 'SELECT seq, json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?';
    return this.statement(sql)
      .all(sessionId, afterSeq, Math.max(0, Math.floor(limit)))
      .map((row) => ({ seq: toNumber(row.seq), event: parseStoredEvent(toText(row.json) ?? '') }));
  }

  /** One session's rows with `fromSeq <= seq <= toSeq` (one agent's only when `agentKey` is given), in log order. */
  rowsBetween(sessionId: string, fromSeq: number, toSeq: number, agentKey?: string): StoredRow[] {
    const rows =
      agentKey === undefined
        ? this.statement('SELECT seq, json FROM events WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq').all(
            sessionId,
            fromSeq,
            toSeq,
          )
        : this.statement(
            'SELECT seq, json FROM events WHERE agent_key = ? AND session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq',
          ).all(agentKey, sessionId, fromSeq, toSeq);
    return rows.map((row) => ({ seq: toNumber(row.seq), event: parseStoredEvent(toText(row.json) ?? '') }));
  }

  /**
   * Sessions whose derivation is missing, of another `version`, or built from fewer rows than they have now; the most
   * recently active first. `exclude` left out.
   */
  pendingDerivations(version: number, exclude: readonly string[], limit: number): PendingDerivation[] {
    const sql =
      'SELECT s.session_id AS session_id, s.event_count AS event_count, s.last_ts AS last_ts FROM sessions AS s ' +
      'LEFT JOIN run_derivations AS d ON d.session_id = s.session_id ' +
      `WHERE (d.session_id IS NULL OR d.version != ? OR d.event_count != s.event_count) AND ${EXCLUDE} ` +
      'ORDER BY s.last_ts DESC, s.session_id LIMIT ?';
    return this.statement(sql)
      .all(version, JSON.stringify([...exclude]), Math.max(0, Math.floor(limit)))
      .map((row) => ({
        sessionId: toText(row.session_id) ?? '',
        eventCount: toNumber(row.event_count),
        lastTs: toNumber(row.last_ts),
      }));
  }

  /**
   * Stores one session's derivation and replaces its agent runs, in one transaction (all of it, or none). The
   * report-file columns of an existing row are kept (`markReportWritten` sets them). Nothing is stored for a session
   * that is not (or no longer) in `sessions`.
   */
  writeDerivation(d: DerivationInput, rows: readonly AgentRunRow[]): void {
    this.ensureOpen();
    const db = this.db;
    const insertDerivation = this.statement(
      `INSERT INTO run_derivations (session_id, ${DERIVATION_COLUMNS.slice(0, 15).join(', ')})
       VALUES (${new Array(16).fill('?').join(', ')})
       ON CONFLICT (session_id) DO UPDATE SET ${DERIVATION_COLUMNS.slice(0, 15)
         .map((c) => `${c} = excluded.${c}`)
         .join(', ')}`,
    );
    const deleteRuns = this.statement('DELETE FROM agent_runs WHERE session_id = ?');
    const insertRun = this.statement(
      `INSERT INTO agent_runs (${AGENT_RUN_COLUMNS.join(', ')}) VALUES (${AGENT_RUN_COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT (session_id, agent_key) DO NOTHING`,
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      // M5 WP5: a derivation that finishes after its session was deleted (retention, delete all) stores nothing, so no
      // report text outlives the events it came from.
      if (this.statement('SELECT 1 AS found FROM sessions WHERE session_id = ?').get(d.sessionId) === undefined) {
        db.exec('ROLLBACK');
        return;
      }
      insertDerivation.run(
        d.sessionId,
        d.version,
        d.eventCount,
        d.derivedAt,
        d.hasRoot ? 1 : 0,
        d.outcome,
        d.origin,
        d.model,
        d.otherModels,
        d.workTokens,
        d.tokensPartial ? 1 : 0,
        d.agentCount,
        d.startedAt,
        d.endedAt,
        d.durationMs,
        d.reportJson,
      );
      deleteRuns.run(d.sessionId);
      for (const row of rows) insertRun.run(...agentRunValues({ ...row, sessionId: d.sessionId }));
      db.exec('COMMIT');
    } catch (error) {
      if (inTransaction(db)) db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Records that the session's Markdown file was written at `writtenAt` from `eventCount` rows. */
  markReportWritten(sessionId: string, writtenAt: number, eventCount: number): void {
    this.statement('UPDATE run_derivations SET report_written_at = ?, report_event_count = ? WHERE session_id = ?').run(
      writtenAt,
      eventCount,
      sessionId,
    );
  }

  /**
   * Every stored agent run, `exclude`d sessions left out, in session then start order. These are the runs the
   * scorecards count (`scorecardRows`, from derivation version 3): no row of a session without a main agent, none of an
   * agent that did nothing.
   */
  agentRuns(exclude: readonly string[]): AgentRunRow[] {
    const sql =
      `SELECT ${AGENT_RUN_COLUMNS.map((c) => `r.${c}`).join(', ')} FROM agent_runs AS r ` +
      'WHERE r.session_id NOT IN (SELECT value FROM json_each(?)) ORDER BY r.session_id, r.started_at, r.agent_key';
    return this.statement(sql)
      .all(JSON.stringify([...exclude]))
      .map(agentRunOf);
  }
}
