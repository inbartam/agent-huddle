import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { describeEventStoreContract } from './event-store.contract.js';
import { InvalidSessionIdError, JsonlEventStore } from './jsonl-store.js';
import { readUserVersion, SCHEMA_VERSION, UnsupportedSchemaError } from './sqlite-schema.js';
import { defaultDatabasePath, SqliteEventStore, toFtsQuery } from './sqlite-store.js';

describeEventStoreContract('SqliteEventStore', {
  open: (dir) => new SqliteEventStore({ file: path.join(dir, 'huddle.sqlite'), flushDelayMs: 5 }),
  dedupesOnId: true,
});

let dir: string;
let file: string;
const closers: (() => unknown)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'huddle-sqlite-'));
  file = path.join(dir, 'huddle.sqlite');
});

afterEach(async () => {
  // Close every store and raw connection before removing the folder: Windows keeps open files locked.
  for (const close of closers.splice(0).reverse()) await close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

function openStore(): SqliteEventStore {
  const store = new SqliteEventStore({ file, flushDelayMs: 5 });
  closers.push(() => store.close());
  return store;
}

/** A second, raw connection to the same file, for looking at what was stored. */
function rawDb(): DatabaseSync {
  const db = new DatabaseSync(file);
  closers.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

async function collect(iterable: AsyncIterable<HuddleEvent>): Promise<HuddleEvent[]> {
  const out: HuddleEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `s-${String(counter).padStart(6, '0')}`;
}

function notification(sessionId: string, ts: number, id = nextId()): HuddleEvent {
  return {
    id,
    type: 'notification.raised',
    ts,
    sessionId,
    agentKey: agentKey(sessionId),
    source: 'hook',
    notificationType: null,
    message: 'hello',
  };
}

function started(
  sessionId: string,
  ts: number,
  fields: { cwd?: string; title?: string; model?: string } = {},
): HuddleEvent {
  return {
    id: nextId(),
    type: 'session.started',
    ts,
    sessionId,
    agentKey: agentKey(sessionId),
    source: 'hook',
    origin: 'attached',
    cwd: fields.cwd ?? null,
    title: fields.title ?? null,
    model: fields.model ?? null,
    startKind: 'startup',
  };
}

function prompt(
  sessionId: string,
  ts: number,
  text: string,
  options: { agentId?: string; kind?: 'user' | 'task_notification' | 'agent_message'; cwd?: string } = {},
): HuddleEvent {
  return {
    id: nextId(),
    type: 'prompt.submitted',
    ts,
    sessionId,
    agentKey: agentKey(sessionId, options.agentId ?? null),
    source: 'hook',
    text,
    promptId: null,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };
}

function ended(sessionId: string, ts: number): HuddleEvent {
  return {
    id: nextId(),
    type: 'session.ended',
    ts,
    sessionId,
    agentKey: agentKey(sessionId),
    source: 'hook',
    reason: 'exit',
  };
}

describe('SqliteEventStore', () => {
  it('creates the schema on an empty database and moves user_version from 0 to the current version', async () => {
    const empty = rawDb();
    expect(readUserVersion(empty)).toBe(0);
    empty.close();

    const store = openStore();
    await store.append([notification('sess-a', 1)]);
    await store.flush();

    const db = rawDb();
    expect(readUserVersion(db)).toBe(SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'events',
        'events_agent_seq',
        'events_session_seq',
        'events_type_ts',
        'sessions',
        'sessions_fts',
        'sessions_fts_insert',
        'sessions_fts_update',
        'sessions_fts_delete',
        'meta',
        'run_derivations',
        'agent_runs',
        'agent_runs_role_model',
        'sessions_first_ts',
      ]),
    );
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');

    // Reopening an up-to-date database runs no migration and keeps the data.
    await store.close();
    const again = openStore();
    expect(await again.listSessions()).toEqual([{ sessionId: 'sess-a', firstTs: 1, lastTs: 1 }]);
  });

  it('refuses a database from a newer schema and leaves it untouched', () => {
    const db = rawDb();
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => new SqliteEventStore({ file })).toThrow(UnsupportedSchemaError);
    const after = rawDb();
    expect(readUserVersion(after)).toBe(99);
    expect(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'events'").get()?.n).toBe(0);
  });

  it('masks secrets in the stored JSON and in the derived session text, and leaves identifiers alone', async () => {
    const store = openStore();
    const secretEvent: HuddleEvent = {
      id: 'evt-token=1',
      type: 'control.applied',
      ts: 1,
      sessionId: 'sess-1',
      agentKey: 'sess-1',
      source: 'user',
      action: 'rename',
      detail: 'my API_KEY=abc123 and sk-ant-api03-AbCdEfGhIjKlMnOpQrSt',
    };
    await store.append([
      secretEvent,
      started('sess-1', 2, { title: 'deploy with token=hunter22', cwd: 'C:\\work\\app' }),
      prompt('sess-1', 3, 'use Authorization: Bearer abcdefghijklmnop to call it'),
    ]);
    await store.close();

    const db = rawDb();
    const text = db
      .prepare('SELECT json FROM events ORDER BY seq')
      .all()
      .map((row) => String(row.json))
      .join('\n');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('AbCdEfGhIjKlMnOpQrSt');
    expect(text).not.toContain('hunter22');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).toContain('API_KEY=<redacted>');
    expect(text).toContain('"id":"evt-token=1"');
    expect(db.prepare('SELECT id FROM events WHERE seq = 1').get()?.id).toBe('evt-token=1');

    const session = db.prepare('SELECT title, cwd, first_prompt, last_prompt FROM sessions').get();
    const sessionText = JSON.stringify(session);
    expect(sessionText).not.toContain('hunter22');
    expect(sessionText).not.toContain('abcdefghijklmnop');
    expect(session?.title).toBe('deploy with token=<redacted>');
    expect(session?.cwd).toBe('C:\\work\\app');
  });

  it('a batch that fails mid-transaction leaves no rows, rejects only its own append, and the store keeps working', async () => {
    const store = openStore();
    await store.append([notification('sess-a', 1)]);
    // A second connection makes the third insert of the next batch fail, the way a full disk or a constraint would.
    const db = rawDb();
    db.exec(`CREATE TRIGGER fail_boom BEFORE INSERT ON events WHEN new.id = 'boom'
             BEGIN SELECT RAISE(ABORT, 'boom refused'); END`);

    const good = notification('sess-b', 5);
    const bad = store.append([
      notification('sess-a', 2),
      started('sess-a', 3, { title: 't' }),
      notification('sess-a', 4, 'boom'),
    ]);
    const alongside = store.append([good]); // same flush, own savepoint
    await expect(bad).rejects.toThrow(/boom refused/);
    await alongside;

    expect((await collect(store.readSession('sess-a'))).map((e) => e.ts)).toEqual([1]);
    expect(await collect(store.readSession('sess-b'))).toEqual([good]);
    const records = await store.listSessionRecords();
    expect(records.find((r) => r.sessionId === 'sess-a')).toMatchObject({ eventCount: 1, lastTs: 1, title: null });
    expect(store.stats()).toMatchObject({ written: 2, failedAppends: 1 });

    db.exec('DROP TRIGGER fail_boom');
    await store.append([notification('sess-a', 6, 'boom')]);
    expect((await collect(store.readSession('sess-a'))).map((e) => e.ts)).toEqual([1, 6]);
  });

  it('rejects an append it cannot serialize and queues none of it', async () => {
    const store = openStore();
    const broken = { ...notification('sess-a', 1), message: 10n } as unknown as HuddleEvent;
    await expect(store.append([notification('sess-a', 0), broken])).rejects.toThrow();
    expect(await collect(store.readSession('sess-a'))).toEqual([]);
  });

  it('counts duplicate ids and does not count them into the session', async () => {
    const store = openStore();
    const a = notification('sess-a', 1);
    await store.append([a, a]);
    await store.append([a]);
    expect(store.stats()).toMatchObject({ written: 1, duplicates: 2 });
    expect((await store.listSessionRecords())[0]?.eventCount).toBe(1);
  });

  it('yields to the event loop between read chunks', async () => {
    const store = openStore();
    const events: HuddleEvent[] = [];
    for (let i = 0; i < 1500; i++) events.push(notification('sess-a', i));
    await store.append(events);
    await store.flush();

    const loop = { ticked: false };
    setImmediate(() => {
      loop.ticked = true;
    });
    let index = 0;
    let tickedAt = -1;
    for await (const _event of store.readSession('sess-a')) {
      if (loop.ticked && tickedAt === -1) tickedAt = index;
      index += 1;
    }
    expect(index).toBe(1500);
    // The first chunk (500 rows) is read without a break; the event loop runs before the second.
    expect(tickedAt).toBe(500);
  });

  it('derives the session row: span, count, ended, cwd/title/model and the root user prompts', async () => {
    const store = openStore();
    await store.append([
      started('sess-a', 10, { cwd: 'C:\\projects\\alpha', model: 'sonnet' }),
      prompt('sess-a', 11, '  Fix the\nflaky   test  '),
      prompt('sess-a', 12, 'subagent brief', { agentId: 'sub1' }),
      prompt('sess-a', 13, '<agent-message from=x>hi', { kind: 'agent_message' }),
      prompt('sess-a', 14, 'then update the docs', { kind: 'user' }),
      ended('sess-a', 20),
      started('sess-b', 5, { cwd: 'C:\\projects\\beta' }),
      prompt('sess-b', 6, 'x'.repeat(1000)),
    ]);
    const [b, a] = [...(await store.listSessionRecords())].sort((x, y) => x.firstTs - y.firstTs);
    expect(a).toEqual({
      sessionId: 'sess-a',
      firstTs: 10,
      lastTs: 20,
      eventCount: 6,
      ended: true,
      cwd: 'C:\\projects\\alpha',
      title: null,
      model: 'sonnet',
      firstPrompt: 'Fix the flaky test',
      lastPrompt: 'then update the docs',
    });
    expect(b).toMatchObject({ sessionId: 'sess-b', ended: false, cwd: 'C:\\projects\\beta', model: null });
    expect(b?.firstPrompt).toHaveLength(300);

    // A resume clears `ended`; a start without a cwd keeps the known one.
    await store.append([started('sess-a', 30, { title: 'Alpha work' })]);
    const resumed = (await store.listSessionRecords({ limit: 1 }))[0];
    expect(resumed).toMatchObject({
      sessionId: 'sess-a',
      ended: false,
      cwd: 'C:\\projects\\alpha',
      title: 'Alpha work',
    });
  });

  it('a session first seen mid-run takes its folder from a prompt; a known folder is never replaced (2026-11-18)', async () => {
    const store = openStore();
    await store.append([
      prompt('sess-mid', 10, 'carry on', { cwd: 'C:/projects/gamma' }),
      prompt('sess-mid', 11, 'and more', { cwd: 'C:/elsewhere' }),
      started('sess-known', 5, { cwd: 'C:/projects/beta' }),
      prompt('sess-known', 6, 'go', { cwd: 'C:/elsewhere' }),
    ]);
    const rows = await store.listSessionRecords();
    expect(rows.find((r) => r.sessionId === 'sess-mid')?.cwd).toBe('C:/projects/gamma');
    expect(rows.find((r) => r.sessionId === 'sess-known')?.cwd).toBe('C:/projects/beta');
  });

  it('searches sessions by title, cwd and prompts with prefix terms, safely', async () => {
    const store = openStore();
    await store.append([
      started('sess-a', 1, { cwd: 'C:\\projects\\agent-huddle', title: 'Huddle history' }),
      prompt('sess-a', 2, 'Add the SQLite store'),
      started('sess-b', 3, { cwd: 'C:\\projects\\other' }),
      prompt('sess-b', 4, 'Write the café menu'),
    ]);
    const ids = async (text: string): Promise<string[]> => (await store.searchSessions(text)).map((s) => s.sessionId);
    expect(await ids('sqlite')).toEqual(['sess-a']);
    expect(await ids('HUDD')).toEqual(['sess-a']);
    expect(await ids('projects')).toEqual(['sess-b', 'sess-a']);
    expect(await ids('projects other')).toEqual(['sess-b']);
    expect(await ids('cafe')).toEqual(['sess-b']);
    expect(await ids('"unbalanced OR (* NEAR')).toEqual([]);
    expect(await ids('   ')).toEqual([]);
    expect(await store.searchSessions('projects', { limit: 1 })).toHaveLength(1);

    // The index follows later changes to the text columns.
    await store.append([prompt('sess-b', 5, 'now the sqlite part')]);
    expect(await ids('sqlite')).toEqual(['sess-b', 'sess-a']);
  });

  it('rebuildSessions recreates the derived table and the search index from the events', async () => {
    const store = openStore();
    await store.append([
      started('sess-a', 1, { cwd: 'C:\\alpha', title: 'Alpha' }),
      prompt('sess-a', 2, 'first ask'),
      prompt('sess-a', 3, 'second ask'),
      ended('sess-a', 4),
      notification('sess-b', 9),
    ]);
    const before = await store.listSessionRecords();
    const db = rawDb();
    db.exec("UPDATE sessions SET title = 'wrong', event_count = 0");
    expect(await store.rebuildSessions()).toBe(2);
    expect(await store.listSessionRecords()).toEqual(before);
    expect((await store.searchSessions('alpha')).map((s) => s.sessionId)).toEqual(['sess-a']);
    expect(await store.searchSessions('wrong')).toEqual([]);
  });

  it('stores every recorded fixture exactly as the JSONL store does', async () => {
    const sqlite = openStore();
    const jsonl = new JsonlEventStore({ baseDir: path.join(dir, 'jsonl'), flushDelayMs: 5 });
    closers.push(() => jsonl.close());
    const fixtures = listFixtureFiles();
    expect(fixtures.length).toBeGreaterThan(0);
    for (const name of fixtures) {
      // Ids restart per fixture; prefix them so fixtures do not collide in one database.
      const events = fixtureEvents(name).map((e) => ({ ...e, id: `${name}:${e.id}` }));
      await Promise.all([sqlite.append(events), jsonl.append(events)]);
    }
    const sessions = await jsonl.listSessions();
    expect(await sqlite.listSessions()).toEqual(sessions);
    for (const { sessionId } of sessions) {
      expect(await collect(sqlite.readSession(sessionId)), sessionId).toEqual(
        await collect(jsonl.readSession(sessionId)),
      );
    }
    expect(sqlite.stats().strippedToolResponses).toBe(0);
  });

  it('rejects reads after close', async () => {
    const store = openStore();
    await store.close();
    await expect(store.listSessions()).rejects.toThrow(/closed/);
    await expect(collect(store.readSession('sess-a'))).rejects.toThrow(/closed/);
  });

  it('upgrades a version 1 database to the current version (meta, then the v3 tables) and keeps its events', async () => {
    const first = openStore();
    await first.append([notification('sess-a', 1)]);
    await first.close();
    // Back to what a WP1 build left: no meta table (nor the v3 derived tables), user_version 1.
    const db = rawDb();
    db.exec('DROP TABLE meta');
    db.exec('DROP TABLE run_derivations');
    db.exec('DROP TABLE agent_runs');
    db.exec('DROP INDEX sessions_first_ts');
    db.exec('PRAGMA user_version = 1');
    db.close();

    const store = openStore();
    expect(await store.countSessionEvents('sess-a')).toBe(1);
    expect(store.readMeta('k')).toBeNull();
    store.writeMeta({ k: 'v', other: '2' });
    store.writeMeta({ k: 'w' });
    expect(store.readMeta('k')).toBe('w');
    expect(store.readMeta('other')).toBe('2');
    expect(readUserVersion(rawDb())).toBe(SCHEMA_VERSION);
  });

  it('counts stored ids across sessions', async () => {
    const store = openStore();
    await store.append([notification('sess-a', 1, 'id-1'), notification('sess-b', 2, 'id-2')]);
    expect(await store.countStoredIds(['id-1', 'id-2', 'id-3'])).toBe(2);
    await expect(store.countSessionEvents('../x')).rejects.toThrow(InvalidSessionIdError);
  });
});

describe('two connections to one file (single-instance safety)', () => {
  it('lets two stores append to the same database without losing or corrupting rows', async () => {
    const a = openStore();
    const b = openStore();
    const fromA = Array.from({ length: 30 }, (_, i) => notification('sess-a', i, `two-a-${String(i)}`));
    const fromB = Array.from({ length: 30 }, (_, i) => notification('sess-b', i, `two-b-${String(i)}`));
    await Promise.all([...fromA.map((e) => a.append([e])), ...fromB.map((e) => b.append([e]))]);
    // The same event from both: stored once.
    await Promise.all([a.append([notification('sess-a', 99, 'both')]), b.append([notification('sess-a', 99, 'both')])]);
    expect(await a.countSessionEvents('sess-a')).toBe(31);
    expect(await b.countSessionEvents('sess-b')).toBe(30);
    expect((await collect(b.readSession('sess-a'))).map((e) => e.id)).toEqual([...fromA.map((e) => e.id), 'both']);
    expect(rawDb().prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });

  it('fails a write soft (the append rejects, nothing is corrupted) while another connection holds the lock', async () => {
    const store = new SqliteEventStore({ file, flushDelayMs: 5, busyTimeoutMs: 50 });
    closers.push(() => store.close());
    await store.append([notification('sess-a', 1, 'before')]);
    const other = rawDb();
    other.exec('BEGIN IMMEDIATE');
    await expect(store.append([notification('sess-a', 2, 'blocked')])).rejects.toThrow(/locked|busy/i);
    expect(store.stats().failedAppends).toBe(1);
    other.exec('COMMIT');
    await store.append([notification('sess-a', 3, 'after')]);
    expect((await collect(store.readSession('sess-a'))).map((e) => e.id)).toEqual(['before', 'after']);
    expect(other.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });
});

describe('toFtsQuery', () => {
  it('keeps letters and digits, quotes and prefix-matches each term', () => {
    expect(toFtsQuery('fix "the" bug*')).toBe('"fix"* "the"* "bug"*');
    expect(toFtsQuery('C:\\projects\\agent-huddle')).toBe('"C"* "projects"* "agent"* "huddle"*');
    expect(toFtsQuery('NEAR(a b) OR c')).toBe('"NEAR"* "a"* "b"* "OR"* "c"*');
    expect(toFtsQuery(' -- ;; ')).toBeNull();
    expect(toFtsQuery('a '.repeat(40))?.split(' ')).toHaveLength(16);
  });
});

describe('defaultDatabasePath', () => {
  it('sits next to the events folder', () => {
    expect(defaultDatabasePath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', 'agent-huddle', 'huddle.sqlite'),
    );
    expect(defaultDatabasePath({}, 'linux', '/home/u')).toBe(
      path.join('/home/u', '.config', 'agent-huddle', 'huddle.sqlite'),
    );
  });
});
