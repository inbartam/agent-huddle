/**
 * One-time import of the M1-M4 JSONL event log (`<dataDir>/events/*.jsonl`) into the SQLite store (M5, F22).
 *
 * Flow:
 *  1. Nothing to do when the folder does not exist, or when `meta` says the import ran and left this very folder in
 *     place (its rename failed). A folder that is there again after a finished import renamed it away holds new lines
 *     (a Huddle that could not open the database fell back to JSONL) and is imported too (see `nothingNewToImport`).
 *  2. Every `<sessionId>.jsonl` is read through `JsonlEventStore.readSession` (the same reader the M1-M4 replay used:
 *     a truncated last line or a line that is not an event is skipped and counted). A file whose name is not a valid
 *     session id is skipped and counted; it stays in the folder.
 *  3. Events are appended in batches (default 500). Each batch is one SQLite transaction, and the store's insert is
 *     `ON CONFLICT(id) DO NOTHING`, so a rerun after a crash mid-import stores each event exactly once and ends with
 *     the same rows. Ids repeated inside the JSONL are counted and not sent twice.
 *  4. Every event goes through `serializeEvent` again on write: that is the M5 redaction pass for old data. Events whose
 *     stored text differs from their JSONL text (a secret the M1-M4 masking missed, a stray `tool_response`) are
 *     counted in `changedByRedaction`.
 *  5. Check, per session: every distinct id of the file is stored, and the session has at least as many rows as the
 *     file has distinct events of that session. Any shortfall: the folder is left as it is, `meta` gets the counts
 *     but no `jsonl_migrated_at`, and the import runs again at the next start.
 *  6. Counts match: `events/` is renamed to `events.migrated-<YYYY-MM-DD>` (local date; `-2`, `-3`, ... when taken),
 *     then `meta` records `jsonl_migrated_at`, `jsonl_migrated_from`, `jsonl_migrated_to` and the counts. A rename
 *     that fails (EBUSY/EPERM: another process holds a file, antivirus) is not an error: the folder stays, the import
 *     is still marked done so it is not repeated at every start, and a warning is logged.
 *
 * Nothing is ever deleted. Rollback (back to the JSONL build): close the Huddle, rename `events.migrated-<date>` back
 * to `events`, delete `huddle.sqlite` (and its `-wal`/`-shm` files) or keep it aside, and start the older build. Events
 * written after the switch exist only in the database.
 *
 * Pure-ish edge: the clock, the store and the rename are passed in; the only other I/O is reading the folder.
 */
import { access, readdir, rename as fsRename } from 'node:fs/promises';
import path from 'node:path';
import type { HuddleEvent } from '@huddle/shared';
import { serializeEvent } from './codec.js';
import { isValidSessionId, JsonlEventStore } from './jsonl-store.js';

export const META_MIGRATED_AT = 'jsonl_migrated_at';
export const META_MIGRATED_FROM = 'jsonl_migrated_from';
export const META_MIGRATED_TO = 'jsonl_migrated_to';
/** JSON of the last `JsonlMigrationReport` (written for complete and incomplete imports alike). */
export const META_MIGRATION = 'jsonl_migration';

const DEFAULT_BATCH = 500;
const MAX_NAME_SUFFIX = 1000;

/** What the import needs from the SQLite store (`SqliteEventStore` has all of it; tests wrap it). */
export interface MigrationTarget {
  append(events: readonly HuddleEvent[]): Promise<void>;
  flush(): Promise<void>;
  countStoredIds(ids: Iterable<string>): Promise<number>;
  countSessionEvents(sessionId: string): Promise<number>;
  readMeta(key: string): string | null;
  writeMeta(entries: Readonly<Record<string, string>>): void;
  stats(): { written: number; duplicates: number };
}

/** Structured log sink; `data` carries counts and codes only. */
export interface MigrationLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface MigrateJsonlOptions {
  /** The JSONL folder, normally `<dataDir>/events`. */
  eventsDir: string;
  store: MigrationTarget;
  /** Epoch ms: the date in the new folder name and `jsonl_migrated_at`. */
  now: () => number;
  /** Events per transaction. Default 500. */
  batchSize?: number;
  logger?: MigrationLogger;
  /** Defaults to `fs.promises.rename`. Tests pass one that fails. */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface JsonlMigrationReport {
  /**
   * migrated: imported and checked (the folder renamed, or left when `renameError` is set). already_done: `meta` says
   * the import ran. no_source: no events folder. incomplete: some events are not in the database; retried next start.
   */
  status: 'migrated' | 'already_done' | 'no_source' | 'incomplete';
  /** Session files read (valid names). */
  sessions: number;
  /** `.jsonl` files skipped because their name is not a valid session id (left in the folder). */
  skippedFiles: number;
  /** Events read from the files. */
  eventsRead: number;
  /** Distinct event ids read. */
  distinctEvents: number;
  /** Events whose id was already read earlier in this import (not sent again). */
  duplicateLines: number;
  /** Events read whose session id is not valid (cannot be stored by either store). */
  foreignEvents: number;
  /** Lines the JSONL reader skipped: a truncated last line, a line that is not JSON or not an event. */
  skippedLines: number;
  /** Rows this import inserted. */
  written: number;
  /** Events that were in the database already (an earlier, interrupted import). */
  alreadyStored: number;
  /** Events whose stored form differs from their JSONL line after the masking pass. */
  changedByRedaction: number;
  /** Distinct ids read but not found in the database afterwards (0 for a complete import). */
  missing: number;
  /** Sessions that failed the count check. */
  mismatchedSessions: number;
  renamedTo: string | null;
  /** The error code of a failed rename (the folder stays where it was). */
  renameError: string | null;
}

function emptyReport(status: JsonlMigrationReport['status']): JsonlMigrationReport {
  return {
    status,
    sessions: 0,
    skippedFiles: 0,
    eventsRead: 0,
    distinctEvents: 0,
    duplicateLines: 0,
    foreignEvents: 0,
    skippedLines: 0,
    written: 0,
    alreadyStored: 0,
    changedByRedaction: 0,
    missing: 0,
    mismatchedSessions: 0,
    renamedTo: null,
    renameError: null,
  };
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `events.migrated-<YYYY-MM-DD>` for the local date of `now`. */
export function migratedFolderName(now: number): string {
  const d = new Date(now);
  return `events.migrated-${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** True when `meta` records a finished import. */
export function isJsonlMigrationDone(store: Pick<MigrationTarget, 'readMeta'>): boolean {
  return store.readMeta(META_MIGRATED_AT) !== null;
}

/**
 * True when an `events` folder need not be read: the import finished and left that folder in place (its rename
 * failed), so it holds nothing new. After a finished import that renamed the folder, an `events` folder that is there
 * again holds new lines (written by a Huddle that could not open the database and fell back to JSONL, or put back by
 * hand) and is imported again; already stored events are skipped by id, so this is safe.
 */
function nothingNewToImport(store: Pick<MigrationTarget, 'readMeta'>): boolean {
  return isJsonlMigrationDone(store) && (store.readMeta(META_MIGRATED_TO) ?? '') === '';
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The first free `events.migrated-<date>`, `-2`, `-3`, ... next to the events folder. */
async function freeTarget(eventsDir: string, now: number): Promise<string> {
  const base = path.join(path.dirname(eventsDir), migratedFolderName(now));
  if (!(await exists(base))) return base;
  for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw Object.assign(new Error('no free name for the migrated events folder'), { code: 'EEXIST' });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Session files in name order: `<name>.jsonl` regular files. */
async function listSessionFiles(eventsDir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(eventsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Imports `eventsDir` into `store` once (see the module comment). Rejects only when reading the folder or writing to
 * the database fails; nothing is marked done then, and a rerun continues where it stopped.
 */
export async function migrateJsonlToSqlite(options: MigrateJsonlOptions): Promise<JsonlMigrationReport> {
  const { store, eventsDir } = options;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH));
  const doRename = options.rename ?? fsRename;
  if (nothingNewToImport(store)) return emptyReport('already_done');
  const files = await listSessionFiles(eventsDir);
  if (files === null) return emptyReport(isJsonlMigrationDone(store) ? 'already_done' : 'no_source');

  const report = emptyReport('migrated');
  const reader = new JsonlEventStore({ baseDir: eventsDir });
  const seen = new Set<string>();
  const before = store.stats();
  let batch: HuddleEvent[] = [];
  const writeBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const written = store.append(batch);
    batch = [];
    await store.flush();
    await written;
    await yieldToEventLoop();
  };

  for (const name of files) {
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (!isValidSessionId(sessionId)) {
      report.skippedFiles += 1;
      continue;
    }
    report.sessions += 1;
    const ids = new Set<string>();
    let ofThisSession = 0;
    for await (const event of reader.readSession(sessionId)) {
      report.eventsRead += 1;
      if (!isValidSessionId(event.sessionId)) {
        report.foreignEvents += 1;
        continue;
      }
      if (seen.has(event.id)) {
        report.duplicateLines += 1;
        continue;
      }
      seen.add(event.id);
      ids.add(event.id);
      if (event.sessionId === sessionId) ofThisSession += 1;
      if (serializeEvent(event, () => undefined) !== JSON.stringify(event)) report.changedByRedaction += 1;
      batch.push(event);
      if (batch.length >= batchSize) await writeBatch();
    }
    await writeBatch();
    const stored = await store.countStoredIds(ids);
    const rows = await store.countSessionEvents(sessionId);
    if (stored < ids.size || rows < ofThisSession) {
      report.mismatchedSessions += 1;
      report.missing += ids.size - stored;
    }
  }
  await reader.close();

  const after = store.stats();
  report.distinctEvents = seen.size;
  report.skippedLines = reader.stats().skippedLines;
  report.written = after.written - before.written;
  report.alreadyStored = after.duplicates - before.duplicates;
  const logger = options.logger;

  if (report.mismatchedSessions > 0) {
    report.status = 'incomplete';
    store.writeMeta({ [META_MIGRATION]: JSON.stringify(report) });
    logger?.warn('JSONL history import incomplete; the events folder is kept and the import runs again next start', {
      missing: report.missing,
      sessions: report.mismatchedSessions,
    });
    return report;
  }

  try {
    const target = await freeTarget(eventsDir, options.now());
    await doRename(eventsDir, target);
    report.renamedTo = target;
  } catch (error) {
    report.renameError = codeOf(error);
    logger?.warn('JSONL history imported, but the events folder could not be renamed; it is left as it is', {
      code: report.renameError,
    });
  }
  store.writeMeta({
    [META_MIGRATED_AT]: new Date(options.now()).toISOString(),
    [META_MIGRATED_FROM]: eventsDir,
    [META_MIGRATED_TO]: report.renamedTo ?? '',
    [META_MIGRATION]: JSON.stringify(report),
  });
  logger?.info('imported JSONL history into SQLite', {
    sessions: report.sessions,
    events: report.distinctEvents,
    written: report.written,
    skippedLines: report.skippedLines,
    changedByRedaction: report.changedByRedaction,
    renamed: report.renamedTo !== null,
  });
  return report;
}
