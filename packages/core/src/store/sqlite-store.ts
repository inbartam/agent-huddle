/**
 * SqliteEventStore: the M5 event log in one SQLite file (ADR-003), on the built-in `node:sqlite` (no native module,
 * no npm dependency). Same contract as `JsonlEventStore` (`HuddleEventStore`); schema in `sqlite-schema.ts`.
 *
 * Rules it keeps:
 *  - Append-only. `append` queues and returns at once; one flush (25 ms later by default) writes every queued append
 *    in one transaction, each append inside its own savepoint, so a failing append rolls back only its own rows and
 *    rejects only its own promise. The hook server never waits for it.
 *  - Idempotent on the event id: re-appending an id that is stored already is a no-op (counted in `duplicates`).
 *  - Crash tolerant: WAL journal, a committed batch is whole, an interrupted one leaves nothing behind.
 *  - The same serializer as the JSONL store (`codec.ts`): `tool_response` dropped at any depth, secrets masked again.
 *    Every derived column (`sessions` title, cwd, prompts) is read back from that masked JSON, never from the raw event.
 *  - Session ids are checked with `isValidSessionId` on every public method that takes one, exactly like the JSONL
 *    store (they stay usable as file names for exports, and the two stores accept the same ids).
 *  - Reads never hold the main thread for long: `readSession` reads 500 rows per query and yields to the event loop
 *    between chunks (hook answers have a 20 ms budget).
 *
 * One connection, opened in the constructor (synchronous file I/O: create the store at startup, not on a hot path).
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { CLIP_LIMITS, type AgentKey, type HuddleEvent } from '@huddle/shared';
import { plain } from '../text.js';
import { isRecord, parseStoredEvent, serializeEvent, sessionOfAgentKey } from './codec.js';
import {
  defaultEventsDir,
  InvalidSessionIdError,
  isValidSessionId,
  MAX_AGENT_EVENTS,
  type HuddleEventStore,
  type SessionSummary,
} from './jsonl-store.js';
import { HistoryTables } from './history-tables.js';
import { assertSupportedSchema, migrate } from './sqlite-schema.js';

const DATABASE_FILE = 'huddle.sqlite';
const READ_CHUNK = 500;
const MAX_SEARCH_TERMS = 16;
const MAX_SEARCH_TERM_LENGTH = 64;

/**
 * `%APPDATA%/agent-huddle/huddle.sqlite`: next to the JSONL `events` folder, not inside it (same fallbacks as
 * `defaultEventsDir`). The desktop app may pass a path under Electron's userData instead.
 */
export function defaultDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  return path.join(path.dirname(defaultEventsDir(env, platform, home)), DATABASE_FILE);
}

export interface SqliteEventStoreOptions {
  /** The database file. Defaults to `defaultDatabasePath()`. Its folder is created (user-only) if missing. */
  file?: string;
  /** How long appends are gathered before one transaction. Defaults to 25 ms, like the JSONL store. */
  flushDelayMs?: number;
  /** How long a write waits for a lock held by another connection (a backup, a migration). Defaults to 5000 ms. */
  busyTimeoutMs?: number;
}

export interface SqliteEventStoreStats {
  written: number;
  /** Events not written because an event with the same id is stored already. */
  duplicates: number;
  /** Events not written because their session id is not valid (`isValidSessionId`). */
  rejectedInvalidSession: number;
  /** `tool_response` keys removed by the serializer (should stay 0). */
  strippedToolResponses: number;
  /** Stored rows skipped while reading because their JSON is not an event. */
  skippedRows: number;
  /** Appends whose transaction failed (their promise rejected, none of their rows stored). */
  failedAppends: number;
}

/** One row of the derived `sessions` table. Text fields come from masked events; null when unknown. */
export interface StoredSession extends SessionSummary {
  eventCount: number;
  /**
   * True after the root agent's `session.ended` or (M5 WP5) the root's `run.exited`; a later `session.started` (resume)
   * clears it.
   */
  ended: boolean;
  /** From the root `session.started` (newest non-null value wins). */
  cwd: string | null;
  title: string | null;
  model: string | null;
  /** First and newest prompt the user typed into the root agent, one line, clipped to `CLIP_LIMITS.summary`. */
  firstPrompt: string | null;
  lastPrompt: string | null;
}

/** What one event changes in its `sessions` row besides time span and count. */
interface SessionFacts {
  started: { cwd: string | null; title: string | null; model: string | null } | null;
  ended: boolean;
  prompt: string | null;
  /** A prompt's folder, for a row that has none yet (a session first seen mid-run). */
  cwd?: string | null;
}

interface Row {
  id: string;
  sessionId: string;
  agentKey: string;
  type: string;
  ts: number;
  json: string;
  facts: SessionFacts | null;
}

interface PendingAppend {
  rows: Row[];
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Statements {
  insertEvent: StatementSync;
  upsertSession: StatementSync;
  sessionStarted: StatementSync;
  sessionEnded: StatementSync;
  sessionPrompt: StatementSync;
  readChunk: StatementSync;
  readAgent: StatementSync;
  listSessions: StatementSync;
  listRecords: StatementSync;
  search: StatementSync;
  hasId: StatementSync;
  countSession: StatementSync;
  getMeta: StatementSync;
  setMeta: StatementSync;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function toText(value: SQLOutputValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The session facts in one event, read from its masked, stored form. Only the root agent counts (`agentKey` is the
 * session id): a subagent's prompt or start does not describe the session.
 */
function sessionFacts(stored: Record<string, unknown>): SessionFacts | null {
  if (stored.agentKey !== stored.sessionId) return null;
  switch (stored.type) {
    case 'session.started':
      return {
        started: { cwd: textOrNull(stored.cwd), title: textOrNull(stored.title), model: textOrNull(stored.model) },
        ended: false,
        prompt: null,
      };
    // M5 WP5: a managed run ended by a hard kill sends no SessionEnd (S16 c); its root's run.exited is the end. A later
    // session.started (resume) clears it again, as after a session.ended.
    case 'session.ended':
    case 'run.exited':
      return { started: null, ended: true, prompt: null };
    case 'prompt.submitted': {
      // Absent `kind` is an older log: read it as 'user' (events.ts).
      if (stored.kind !== undefined && stored.kind !== 'user') return null;
      const text = textOrNull(stored.text);
      if (text === null) return null;
      const line = plain(text, CLIP_LIMITS.summary);
      if (line === '') return null;
      return { started: null, ended: false, prompt: line, cwd: textOrNull(stored.cwd) };
    }
    default:
      return null;
  }
}

/** Only these event types carry session facts; every other event skips the JSON round trip. */
const FACT_TYPES: ReadonlySet<string> = new Set(['session.started', 'session.ended', 'run.exited', 'prompt.submitted']);

/** The facts of one stored (masked) event's JSON; null for any other type or JSON that is not an object. */
function factsFromStoredJson(type: string, json: string): SessionFacts | null {
  if (!FACT_TYPES.has(type)) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(json);
  } catch {
    return null;
  }
  return isRecord(stored) ? sessionFacts(stored) : null;
}

/**
 * A user's search text as an FTS5 query that cannot be a syntax error: letters and digits only, each term quoted
 * and prefix-matched, all terms required. Null when nothing searchable is left.
 */
export function toFtsQuery(text: string): string | null {
  const terms = searchTerms(text);
  return terms.length === 0 ? null : terms.map((term) => `"${term}"*`).join(' ');
}

/** The words of a search text exactly as `toFtsQuery` uses them: letters and digits, at most 16, each clipped. */
export function searchTerms(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, MAX_SEARCH_TERMS)
    .map((term) => term.slice(0, MAX_SEARCH_TERM_LENGTH));
}

function clampLimit(limit: number | undefined): number {
  // SQLite reads LIMIT -1 as "no limit".
  return limit !== undefined && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : -1;
}

/** Read live: SQLite can end a transaction on its own (disk full, I/O error), which the type checker cannot see. */
function inTransaction(db: DatabaseSync): boolean {
  return db.isTransaction;
}

/**
 * User-only permissions on a database file or its folder (SECURITY.md), when it exists. Fail open: a chmod that fails
 * (another owner, a file system without modes) never stops the store from opening. On Windows the mode bits are mostly
 * ignored and %APPDATA% is user-only already; `posixOnly` skips the call there.
 */
function restrictMode(target: string, mode: number, options: { posixOnly: boolean }): void {
  if (options.posixOnly && process.platform === 'win32') return;
  try {
    if (existsSync(target)) chmodSync(target, mode);
  } catch {
    // Best effort; see above.
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class SqliteEventStore implements HuddleEventStore {
  readonly file: string;
  private readonly flushDelayMs: number;
  private readonly db: DatabaseSync;
  private readonly statements: Statements;
  /** History reads and the derived tables of schema v3 (history-tables.ts), on this same connection. */
  readonly history: HistoryTables;
  private pending: PendingAppend[] = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly counters: SqliteEventStoreStats = {
    written: 0,
    duplicates: 0,
    rejectedInvalidSession: 0,
    strippedToolResponses: 0,
    skippedRows: 0,
    failedAppends: 0,
  };

  constructor(options: SqliteEventStoreOptions = {}) {
    this.file = path.resolve(options.file ?? defaultDatabasePath());
    this.flushDelayMs = options.flushDelayMs ?? 25;
    const busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000));
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    restrictMode(dir, 0o700, { posixOnly: true });
    // Created user-only before SQLite opens it, so the file never exists with the umask's mode (like the JSONL store).
    // 'a' leaves an existing file's bytes alone: a database from a newer Huddle is still refused untouched below.
    closeSync(openSync(this.file, 'a', 0o600));
    this.db = new DatabaseSync(this.file, { timeout: busyTimeoutMs });
    try {
      this.db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
      // A schema someone else wrote (a tampered file) must not run functions with side effects from triggers or views.
      this.db.exec('PRAGMA trusted_schema = OFF');
      // Before anything writes to the file: a database from a newer Huddle is refused untouched.
      assertSupportedSchema(this.db);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      migrate(this.db);
      this.statements = this.prepare();
      this.history = new HistoryTables(this.db, () => {
        this.ensureOpen();
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    // An older file (or one made before this rule) is tightened too. SQLite gives `-wal` and `-shm` the main file's
    // mode when it creates them; the ones already there are set here.
    for (const suffix of ['', '-wal', '-shm']) restrictMode(this.file + suffix, 0o600, { posixOnly: false });
  }

  stats(): SqliteEventStoreStats {
    return { ...this.counters };
  }

  /**
   * Queues events for writing and returns at once. The promise resolves when they are committed and rejects if that
   * transaction failed (then none of them is stored). Events with an invalid session id are skipped and counted.
   */
  append(events: readonly HuddleEvent[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('SqliteEventStore is closed'));
    const rows: Row[] = [];
    try {
      for (const event of events) {
        if (!isValidSessionId(event.sessionId)) {
          this.counters.rejectedInvalidSession += 1;
          continue;
        }
        const json = serializeEvent(event, () => {
          this.counters.strippedToolResponses += 1;
        });
        const facts = factsFromStoredJson(event.type, json);
        rows.push({
          id: event.id,
          sessionId: event.sessionId,
          agentKey: event.agentKey,
          type: event.type,
          ts: event.ts,
          json,
          facts,
        });
      }
    } catch (error) {
      // An event JSON cannot represent (a BigInt, a cycle): nothing of this append is queued.
      this.counters.failedAppends += 1;
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (rows.length === 0) return Promise.resolve();
    const done = new Promise<void>((resolve, reject) => {
      this.pending.push({ rows, resolve, reject });
    });
    this.schedule();
    return done;
  }

  /** Writes everything queued so far; resolves when it is committed. Never rejects (failures reach `append`). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writePending();
    return Promise.resolve();
  }

  /** Flushes, stops accepting appends and closes the database. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    this.db.close();
  }

  /** Events of one session in append order. Pending appends are flushed first. */
  async *readSession(sessionId: string): AsyncIterable<HuddleEvent> {
    if (!isValidSessionId(sessionId)) throw new InvalidSessionIdError();
    await this.flush();
    let after = 0;
    for (;;) {
      // Keyset paging instead of one long cursor: a fresh query per chunk keeps no read snapshot open across awaits
      // (that would hold back WAL checkpoints) and is safe when two readers run at once.
      this.ensureOpen();
      const rows = this.statements.readChunk.all(sessionId, after, READ_CHUNK);
      for (const row of rows) {
        after = toNumber(row.seq);
        const event = parseStoredEvent(toText(row.json) ?? '');
        if (event) yield event;
        else this.counters.skippedRows += 1;
      }
      if (rows.length < READ_CHUNK) return;
      await yieldToEventLoop();
    }
  }

  /**
   * The newest `limit` events of one agent (oldest first), for `huddle:get-events`.
   * `limit` is clamped to 1..500; anything not a finite number means 500.
   */
  async readAgentEvents(agentKey: AgentKey, limit: number = MAX_AGENT_EVENTS): Promise<HuddleEvent[]> {
    if (!isValidSessionId(sessionOfAgentKey(agentKey))) throw new InvalidSessionIdError();
    const cap = Number.isFinite(limit) ? Math.min(MAX_AGENT_EVENTS, Math.max(1, Math.floor(limit))) : MAX_AGENT_EVENTS;
    await this.flush();
    this.ensureOpen();
    const out: HuddleEvent[] = [];
    for (const row of this.statements.readAgent.all(agentKey, cap)) {
      const event = parseStoredEvent(toText(row.json) ?? '');
      if (event) out.push(event);
      else this.counters.skippedRows += 1;
    }
    return out.reverse();
  }

  /** Sessions, most recently active first (ties by session id, binary order). */
  async listSessions(options: { limit?: number } = {}): Promise<SessionSummary[]> {
    await this.flush();
    this.ensureOpen();
    return this.statements.listSessions.all(clampLimit(options.limit)).map((row) => ({
      sessionId: toText(row.session_id) ?? '',
      firstTs: toNumber(row.first_ts),
      lastTs: toNumber(row.last_ts),
    }));
  }

  /** Like `listSessions`, with every derived column of the `sessions` table (for the history view, WP4). */
  async listSessionRecords(options: { limit?: number } = {}): Promise<StoredSession[]> {
    await this.flush();
    this.ensureOpen();
    return this.statements.listRecords.all(clampLimit(options.limit)).map(toStoredSession);
  }

  /**
   * Sessions whose title, cwd, first or last prompt contain every term of `text` (prefix match, case and accent
   * insensitive), most recently active first. Text that holds no letter or digit matches nothing.
   */
  async searchSessions(text: string, options: { limit?: number } = {}): Promise<StoredSession[]> {
    const query = toFtsQuery(text);
    await this.flush();
    this.ensureOpen();
    if (query === null) return [];
    return this.statements.search.all(query, clampLimit(options.limit)).map(toStoredSession);
  }

  /**
   * Rebuilds the derived `sessions` table and its search index from `events`. One transaction over the whole log,
   * so it blocks for as long as that takes: for migration and repair, not for a hot path. Returns the session count.
   */
  async rebuildSessions(): Promise<number> {
    await this.flush();
    this.ensureOpen();
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM sessions');
      const all = db.prepare('SELECT session_id, ts, type, json FROM events ORDER BY seq');
      for (const row of all.iterate()) {
        const facts = factsFromStoredJson(toText(row.type) ?? '', toText(row.json) ?? '');
        this.writeSession(toText(row.session_id) ?? '', toNumber(row.ts), facts);
      }
      db.exec("INSERT INTO sessions_fts (sessions_fts) VALUES ('rebuild')");
      db.exec('COMMIT');
    } catch (error) {
      if (inTransaction(db)) db.exec('ROLLBACK');
      throw error;
    }
    return toNumber(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n);
  }

  /** How many of these event ids are stored (in any session). Pending appends are flushed first. */
  async countStoredIds(ids: Iterable<string>): Promise<number> {
    await this.flush();
    this.ensureOpen();
    let found = 0;
    for (const id of ids) if (this.statements.hasId.get(id) !== undefined) found += 1;
    return found;
  }

  /** Rows stored for one session. Pending appends are flushed first. */
  async countSessionEvents(sessionId: string): Promise<number> {
    if (!isValidSessionId(sessionId)) throw new InvalidSessionIdError();
    await this.flush();
    this.ensureOpen();
    return toNumber(this.statements.countSession.get(sessionId)?.n);
  }

  /** One value of the `meta` table (schema v2), or null when the key is not set. */
  readMeta(key: string): string | null {
    this.ensureOpen();
    return toText(this.statements.getMeta.get(key)?.value);
  }

  /** Sets several `meta` values in one transaction: all of them are stored, or none. */
  writeMeta(entries: Readonly<Record<string, string>>): void {
    this.ensureOpen();
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(entries)) this.statements.setMeta.run(key, value);
      db.exec('COMMIT');
    } catch (error) {
      if (inTransaction(db)) db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Deleting history (M5 WP5, F22): retention and "delete all history"
  // ---------------------------------------------------------------------------

  /** The newest `seq` stored for a session (0 when none). Pending appends are written first. */
  maxSeq(sessionId: string): number {
    this.ensureOpen();
    this.writePending();
    return toNumber(this.db.prepare('SELECT max(seq) AS m FROM events WHERE session_id = ?').get(sessionId)?.m);
  }

  /**
   * One step of deleting a session's events, in one short transaction so the main thread (which answers hooks) is held
   * only briefly; the caller yields between steps. Deletes at most `maxRows` of the session's events chosen by `scope`:
   * those with `seq <= upToSeq` (the session as it was when the deletion was decided), or those with `ts < beforeTs`.
   *
   * When none of those is left, the same transaction finishes the session: with no event left at all, its `sessions` row
   * (and so its search row, by trigger), its `run_derivations` and `agent_runs` rows go (`deleted`); with events left
   * (it got new ones meanwhile, or only part was chosen), its `sessions` row is rebuilt from them and its derived rows
   * go, to be derived again (`kept`). `more`: call again. Never touches any other session.
   */
  deleteSessionStep(
    sessionId: string,
    scope: { upToSeq: number } | { beforeTs: number },
    maxRows: number,
  ): { removed: number; state: 'more' | 'deleted' | 'kept' } {
    if (!isValidSessionId(sessionId)) throw new InvalidSessionIdError();
    this.ensureOpen();
    this.writePending();
    const limit = Math.max(1, Math.floor(maxRows));
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const removed = Number(
        ('upToSeq' in scope
          ? db
              .prepare(
                'DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE session_id = ? AND seq <= ? ORDER BY seq LIMIT ?)',
              )
              .run(sessionId, scope.upToSeq, limit)
          : db
              .prepare(
                'DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE session_id = ? AND ts < ? ORDER BY seq LIMIT ?)',
              )
              .run(sessionId, scope.beforeTs, limit)
        ).changes,
      );
      let state: 'more' | 'deleted' | 'kept' = 'more';
      if (removed < limit) {
        const left = toNumber(db.prepare('SELECT count(*) AS n FROM events WHERE session_id = ?').get(sessionId)?.n);
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM run_derivations WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM agent_runs WHERE session_id = ?').run(sessionId);
        if (left > 0) {
          const rows = db
            .prepare('SELECT ts, type, json FROM events WHERE session_id = ? ORDER BY seq')
            .iterate(sessionId);
          for (const row of rows) {
            const facts = factsFromStoredJson(toText(row.type) ?? '', toText(row.json) ?? '');
            this.writeSession(sessionId, toNumber(row.ts), facts);
          }
        }
        state = left > 0 ? 'kept' : 'deleted';
      }
      db.exec('COMMIT');
      return { removed, state };
    } catch (error) {
      if (inTransaction(db)) db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Rebuilds the search index from the `sessions` rows left (after "delete all history"): the FTS5 index then holds no
   * trace of a deleted session's text, not even in segments a `delete` only marks.
   */
  rebuildSearchIndex(): void {
    this.ensureOpen();
    this.writePending();
    this.db.exec("INSERT INTO sessions_fts (sessions_fts) VALUES ('rebuild')");
  }

  /**
   * `PRAGMA secure_delete` on this connection: on while history is deleted, so freed pages are overwritten with zeros
   * instead of keeping the deleted text until they are reused. Off again afterwards (the default; appends never free).
   */
  setSecureDelete(on: boolean): void {
    this.ensureOpen();
    this.db.exec(`PRAGMA secure_delete = ${on ? 'ON' : 'OFF'}`);
  }

  /** Pages in the file, pages on the free list and the page size (bytes). */
  pageStats(): { pageCount: number; freePages: number; pageSize: number } {
    this.ensureOpen();
    return {
      pageCount: toNumber(this.db.prepare('PRAGMA page_count').get()?.page_count),
      freePages: toNumber(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count),
      pageSize: toNumber(this.db.prepare('PRAGMA page_size').get()?.page_size),
    };
  }

  /**
   * Rewrites the file without its free pages (`VACUUM`), then truncates the WAL. Synchronous and proportional to the
   * data left, so callers run it only when little is left (see HistoryService). Pending appends are written first.
   */
  vacuum(): void {
    this.ensureOpen();
    this.writePending();
    this.db.exec('VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  // ---------------------------------------------------------------------------

  private prepare(): Statements {
    const db = this.db;
    const columns = ['session_id', 'first_ts', 'last_ts', 'event_count', 'ended', 'cwd', 'title', 'model'];
    columns.push('first_prompt', 'last_prompt');
    const sessionColumns = columns.join(', ');
    const joinedColumns = columns.map((column) => `s.${column}`).join(', ');
    return {
      insertEvent: db.prepare(
        // ON CONFLICT(id) rather than INSERT OR IGNORE: only a duplicate id is skipped, any other failure still fails.
        'INSERT INTO events (id, session_id, agent_key, type, ts, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
      ),
      upsertSession: db.prepare(
        `INSERT INTO sessions (session_id, first_ts, last_ts, event_count) VALUES (?, ?, ?, 1)
         ON CONFLICT (session_id) DO UPDATE SET
           first_ts = min(first_ts, excluded.first_ts),
           last_ts = max(last_ts, excluded.last_ts),
           event_count = event_count + 1`,
      ),
      sessionStarted: db.prepare(
        `UPDATE sessions SET ended = 0, cwd = coalesce(?, cwd), title = coalesce(?, title), model = coalesce(?, model)
         WHERE session_id = ?`,
      ),
      sessionEnded: db.prepare('UPDATE sessions SET ended = 1 WHERE session_id = ?'),
      sessionPrompt: db.prepare(
        'UPDATE sessions SET first_prompt = coalesce(first_prompt, ?), last_prompt = ?, cwd = coalesce(cwd, ?) WHERE session_id = ?',
      ),
      readChunk: db.prepare('SELECT seq, json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
      readAgent: db.prepare('SELECT json FROM events WHERE agent_key = ? ORDER BY seq DESC LIMIT ?'),
      listSessions: db.prepare(
        'SELECT session_id, first_ts, last_ts FROM sessions ORDER BY last_ts DESC, session_id LIMIT ?',
      ),
      listRecords: db.prepare(`SELECT ${sessionColumns} FROM sessions ORDER BY last_ts DESC, session_id LIMIT ?`),
      search: db.prepare(
        `SELECT ${joinedColumns} FROM sessions_fts JOIN sessions AS s ON s.sid = sessions_fts.rowid
         WHERE sessions_fts MATCH ? ORDER BY s.last_ts DESC, s.session_id LIMIT ?`,
      ),
      hasId: db.prepare('SELECT 1 AS found FROM events WHERE id = ?'),
      countSession: db.prepare('SELECT count(*) AS n FROM events WHERE session_id = ?'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ),
    };
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('SqliteEventStore is closed');
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  private writeSession(sessionId: string, ts: number, facts: SessionFacts | null): void {
    const s = this.statements;
    s.upsertSession.run(sessionId, ts, ts);
    if (!facts) return;
    if (facts.started) s.sessionStarted.run(facts.started.cwd, facts.started.title, facts.started.model, sessionId);
    if (facts.ended) s.sessionEnded.run(sessionId);
    if (facts.prompt !== null) s.sessionPrompt.run(facts.prompt, facts.prompt, facts.cwd ?? null, sessionId);
  }

  /** Writes one append's rows; returns how many were new and how many were duplicates. Throws on any SQL error. */
  private writeRows(rows: readonly Row[]): { written: number; duplicates: number } {
    let written = 0;
    let duplicates = 0;
    for (const row of rows) {
      const result = this.statements.insertEvent.run(row.id, row.sessionId, row.agentKey, row.type, row.ts, row.json);
      if (Number(result.changes) === 0) {
        duplicates += 1;
        continue;
      }
      written += 1;
      this.writeSession(row.sessionId, row.ts, row.facts);
    }
    return { written, duplicates };
  }

  /** One flush: every queued append in one transaction, each in its own savepoint. Never throws. */
  private writePending(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const db = this.db;
    const fail = (items: readonly PendingAppend[], error: unknown): void => {
      this.counters.failedAppends += items.length;
      for (const item of items) item.reject(error);
    };
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      fail(batch, error);
      return;
    }
    const committed: { item: PendingAppend; written: number; duplicates: number }[] = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (item === undefined) continue;
      db.exec('SAVEPOINT huddle_append');
      try {
        const counts = this.writeRows(item.rows);
        db.exec('RELEASE huddle_append');
        committed.push({ item, ...counts });
      } catch (error) {
        if (!inTransaction(db)) {
          // SQLite rolled the whole transaction back (disk full, I/O error): nothing of this flush is stored.
          fail([...committed.map((entry) => entry.item), ...batch.slice(i)], error);
          return;
        }
        try {
          db.exec('ROLLBACK TO huddle_append');
          db.exec('RELEASE huddle_append');
        } catch (rollbackError) {
          if (inTransaction(db)) db.exec('ROLLBACK');
          fail([...committed.map((entry) => entry.item), ...batch.slice(i)], rollbackError);
          return;
        }
        fail([item], error);
      }
    }
    try {
      db.exec('COMMIT');
    } catch (error) {
      try {
        if (inTransaction(db)) db.exec('ROLLBACK');
      } catch {
        // The connection is in a bad state; the append promises below report the original error.
      }
      fail(
        committed.map((entry) => entry.item),
        error,
      );
      return;
    }
    for (const entry of committed) {
      this.counters.written += entry.written;
      this.counters.duplicates += entry.duplicates;
      entry.item.resolve();
    }
  }
}

function toStoredSession(row: Record<string, SQLOutputValue>): StoredSession {
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
