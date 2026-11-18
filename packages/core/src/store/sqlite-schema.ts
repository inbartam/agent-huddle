/**
 * Schema of the SQLite event store (ADR-003, M5) and its migrations, tracked in `PRAGMA user_version`.
 *
 *   events        the log: one row per HuddleEvent, append-only, `json` is the masked event (codec.ts)
 *   sessions      derived from `events`, rebuildable at any time (`SqliteEventStore.rebuildSessions`)
 *   sessions_fts  FTS5 index over the short masked text of `sessions` (title, cwd, first and last prompt),
 *                 an external-content table kept in step by triggers
 *   meta          (v2) key/value facts about the database itself: the JSONL import (`jsonl_migrated_at`, ...)
 *   run_derivations, agent_runs
 *                 (v3) derived per session for history, reports and scorecards; rebuildable (see V3)
 *   (v4)          no new table: a data fix of `sessions.ended` for runs ended only by `run.exited` (see V4)
 *
 * A migration moves the database from version `i` to `i + 1` and runs inside one transaction together with the
 * `user_version` bump, so a crash leaves the database at the old version, never half migrated. A database from a
 * newer Huddle (a version this build does not know) is refused, not touched.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Version 1: the first SQLite schema (M5). */
const V1 = `
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY,
  id         TEXT    NOT NULL UNIQUE,
  session_id TEXT    NOT NULL,
  agent_key  TEXT,
  type       TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  json       TEXT    NOT NULL
);
CREATE INDEX events_session_seq ON events (session_id, seq);
CREATE INDEX events_agent_seq   ON events (agent_key, seq);
CREATE INDEX events_type_ts     ON events (type, ts);

-- Derived from events. An explicit INTEGER PRIMARY KEY so the FTS rowid survives VACUUM.
CREATE TABLE sessions (
  sid          INTEGER PRIMARY KEY,
  session_id   TEXT    NOT NULL UNIQUE,
  first_ts     INTEGER NOT NULL,
  last_ts      INTEGER NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  ended        INTEGER NOT NULL DEFAULT 0,
  cwd          TEXT,
  title        TEXT,
  model        TEXT,
  first_prompt TEXT,
  last_prompt  TEXT
);
CREATE INDEX sessions_last_ts ON sessions (last_ts DESC, session_id);

CREATE VIRTUAL TABLE sessions_fts USING fts5 (
  title, cwd, first_prompt, last_prompt,
  content = 'sessions', content_rowid = 'sid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER sessions_fts_insert AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts (rowid, title, cwd, first_prompt, last_prompt)
  VALUES (new.sid, new.title, new.cwd, new.first_prompt, new.last_prompt);
END;
CREATE TRIGGER sessions_fts_delete AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts (sessions_fts, rowid, title, cwd, first_prompt, last_prompt)
  VALUES ('delete', old.sid, old.title, old.cwd, old.first_prompt, old.last_prompt);
END;
-- Only the text columns: the per-event count and time updates never touch the index.
CREATE TRIGGER sessions_fts_update AFTER UPDATE OF title, cwd, first_prompt, last_prompt ON sessions
WHEN old.title IS NOT new.title OR old.cwd IS NOT new.cwd
  OR old.first_prompt IS NOT new.first_prompt OR old.last_prompt IS NOT new.last_prompt
BEGIN
  INSERT INTO sessions_fts (sessions_fts, rowid, title, cwd, first_prompt, last_prompt)
  VALUES ('delete', old.sid, old.title, old.cwd, old.first_prompt, old.last_prompt);
  INSERT INTO sessions_fts (rowid, title, cwd, first_prompt, last_prompt)
  VALUES (new.sid, new.title, new.cwd, new.first_prompt, new.last_prompt);
END;
`;

/**
 * Version 2: a key/value `meta` table for facts about the database itself, such as the one-time import of the M1-M4
 * JSONL history and its counts (migrate-jsonl.ts). Values are text; structured values are JSON.
 */
const V2 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * Version 3 (M5 WP4b, F22-F24): tables derived from `events`, for the history list, the report and the scorecards.
 * Like `sessions`, both are rebuildable at any time from the log (delete their rows and the next start's backfill, or
 * the next open, derives them again); nothing in them is a fact the log does not hold.
 *
 *   run_derivations  one row per derived session: the report (`report_json`, the `RunReport` built from the stored,
 *                    masked events) and the history-row summary read from it. `version` is the derivation version
 *                    (history.ts `DERIVATION_VERSION`) and `event_count` the rows it was built from: when either differs
 *                    from now (a newer build, or the session got more events), the row is stale and derived again.
 *                    `report_written_at` / `report_event_count`: the Markdown file in `<dataDir>/reports`, when one
 *                    was written, and from how many rows.
 *   agent_runs       one `AgentRunRow` per agent the scorecards count, per derived session (report/agent-runs.ts
 *                    `scorecardRows`: agents that did nothing are left out; the report keeps them).
 *
 * The index on `sessions (first_ts DESC, session_id)` is the history list's order (newest start first).
 */
const V3 = `
CREATE TABLE run_derivations (
  session_id         TEXT    PRIMARY KEY,
  version            INTEGER NOT NULL,
  event_count        INTEGER NOT NULL,
  derived_at         INTEGER NOT NULL,
  has_root           INTEGER NOT NULL,
  outcome            TEXT,
  origin             TEXT,
  model              TEXT,
  other_models       INTEGER NOT NULL DEFAULT 0,
  work_tokens        INTEGER,
  tokens_partial     INTEGER NOT NULL DEFAULT 0,
  agent_count        INTEGER NOT NULL DEFAULT 0,
  started_at         INTEGER,
  ended_at           INTEGER,
  duration_ms        INTEGER,
  report_json        TEXT,
  report_written_at  INTEGER,
  report_event_count INTEGER
) WITHOUT ROWID;

CREATE TABLE agent_runs (
  session_id           TEXT    NOT NULL,
  agent_key            TEXT    NOT NULL,
  parent_key           TEXT,
  kind                 TEXT    NOT NULL,
  role                 TEXT    NOT NULL,
  model                TEXT,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  duration_ms          INTEGER,
  outcome              TEXT    NOT NULL,
  tasks_created        INTEGER NOT NULL,
  tasks_completed      INTEGER NOT NULL,
  tool_calls           INTEGER NOT NULL,
  tool_failures        INTEGER NOT NULL,
  approvals_requested  INTEGER NOT NULL,
  approvals_by_user    INTEGER NOT NULL,
  approvals_by_policy  INTEGER NOT NULL,
  approvals_other      INTEGER NOT NULL,
  approvals_unresolved INTEGER NOT NULL,
  stuck_incidents      INTEGER NOT NULL,
  tokens_input         INTEGER,
  tokens_output        INTEGER,
  tokens_cache_read    INTEGER,
  tokens_cache_created INTEGER,
  tokens_requests      INTEGER,
  estimated_cost_usd   REAL,
  cost_partial         INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_key)
) WITHOUT ROWID;
CREATE INDEX agent_runs_role_model ON agent_runs (role, model);

CREATE INDEX sessions_first_ts ON sessions (first_ts DESC, session_id);
`;

/**
 * Version 4 (M5 WP5): a data fix, no schema change. From this build on, the root's `run.exited` ends a session in
 * `sessions.ended` like its `session.ended` (a managed run killed hard sends no SessionEnd, S16 c), so such a run is no
 * longer replayed at every start. Rows written before are fixed here: a session whose root has a `run.exited` after its
 * last root `session.started` (a resume clears the end) is marked ended. Same rule as `sessionFacts` (sqlite-store.ts).
 */
const V4 = `
UPDATE sessions SET ended = 1
WHERE ended = 0 AND EXISTS (
  SELECT 1 FROM events AS x
  WHERE x.session_id = sessions.session_id AND x.type = 'run.exited' AND x.agent_key = x.session_id
    AND x.seq > coalesce((
      SELECT max(s.seq) FROM events AS s
      WHERE s.session_id = sessions.session_id AND s.type = 'session.started' AND s.agent_key = s.session_id
    ), 0)
);
`;

/** `MIGRATIONS[i]` takes the database from version `i` to `i + 1`. Append only; never edit a shipped step. */
const MIGRATIONS: readonly string[] = [V1, V2, V3, V4];

export const SCHEMA_VERSION = MIGRATIONS.length;

export class UnsupportedSchemaError extends Error {
  constructor(readonly found: number) {
    super(`event database has schema version ${String(found)}, this build knows up to ${String(SCHEMA_VERSION)}`);
    this.name = 'UnsupportedSchemaError';
  }
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  const value = row?.user_version;
  return typeof value === 'number' ? value : 0;
}

/** Throws `UnsupportedSchemaError` unless this build can open the database (version 0 up to `SCHEMA_VERSION`). */
export function assertSupportedSchema(db: DatabaseSync): number {
  const version = readUserVersion(db);
  if (version > SCHEMA_VERSION || version < 0) throw new UnsupportedSchemaError(version);
  return version;
}

/**
 * Brings the database up to `SCHEMA_VERSION`. Returns the version it started at (0 for a new file).
 * Throws `UnsupportedSchemaError` for a database newer than this build; nothing is changed then.
 */
export function migrate(db: DatabaseSync): number {
  const start = assertSupportedSchema(db);
  for (let version = start; version < SCHEMA_VERSION; version++) {
    const step = MIGRATIONS[version];
    if (step === undefined) throw new UnsupportedSchemaError(version);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step);
      // PRAGMA takes no bound parameters; the value is our own integer.
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return start;
}
