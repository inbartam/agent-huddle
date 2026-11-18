import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { serializeEvent } from './codec.js';
import { JsonlEventStore } from './jsonl-store.js';
import {
  isJsonlMigrationDone,
  META_MIGRATED_AT,
  META_MIGRATED_FROM,
  META_MIGRATED_TO,
  META_MIGRATION,
  migratedFolderName,
  migrateJsonlToSqlite,
  type MigrationTarget,
} from './migrate-jsonl.js';
import { SqliteEventStore } from './sqlite-store.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const now = (): number => NOW;

let root: string;
let eventsDir: string;
const closers: (() => unknown)[] = [];

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-migrate-'));
  eventsDir = path.join(root, 'events');
});

afterEach(async () => {
  // Close every database before removing the folder: Windows keeps open files locked.
  for (const close of closers.splice(0).reverse()) await close();
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function openDb(name = 'huddle.sqlite'): SqliteEventStore {
  const store = new SqliteEventStore({ file: path.join(root, name), flushDelayMs: 5 });
  closers.push(() => store.close());
  return store;
}

/** Three recorded fixtures, ids made unique across fixtures (each fixture's counter starts at evt-0001). */
function seedEvents(): HuddleEvent[] {
  return listFixtureFiles()
    .slice(0, 3)
    .flatMap((name) => fixtureEvents(name).map((event) => ({ ...event, id: `${name}:${event.id}` })));
}

async function writeJsonl(events: readonly HuddleEvent[]): Promise<void> {
  const store = new JsonlEventStore({ baseDir: eventsDir, flushDelayMs: 1 });
  await store.append(events);
  await store.close();
}

async function collect(iterable: AsyncIterable<HuddleEvent>): Promise<HuddleEvent[]> {
  const out: HuddleEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

/** What a store returns for an event: the same serializer, read back. */
function stored(event: HuddleEvent): unknown {
  return JSON.parse(serializeEvent(event, () => undefined));
}

function bySession(events: readonly HuddleEvent[]): Map<string, HuddleEvent[]> {
  const map = new Map<string, HuddleEvent[]>();
  for (const event of events) map.set(event.sessionId, [...(map.get(event.sessionId) ?? []), event]);
  return map;
}

async function dump(store: SqliteEventStore): Promise<Record<string, HuddleEvent[]>> {
  const out: Record<string, HuddleEvent[]> = {};
  for (const { sessionId } of await store.listSessions()) out[sessionId] = await collect(store.readSession(sessionId));
  return out;
}

function line(event: HuddleEvent): string {
  return JSON.stringify(event);
}

function note(id: string, sessionId: string, ts: number, message = 'hello'): HuddleEvent {
  return {
    id,
    type: 'notification.raised',
    ts,
    sessionId,
    agentKey: sessionId,
    source: 'hook',
    notificationType: null,
    message,
  };
}

describe('migrateJsonlToSqlite', () => {
  it('imports every session in order, renames the folder and records the run in meta', async () => {
    const events = seedEvents();
    await writeJsonl(events);
    const store = openDb();
    const logger = { info: vi.fn(), warn: vi.fn() };

    const report = await migrateJsonlToSqlite({ eventsDir, store, now, batchSize: 50, logger });

    const sessions = bySession(events);
    expect(report).toMatchObject({
      status: 'migrated',
      sessions: sessions.size,
      eventsRead: events.length,
      distinctEvents: events.length,
      written: events.length,
      alreadyStored: 0,
      skippedLines: 0,
      missing: 0,
      mismatchedSessions: 0,
      renameError: null,
    });
    for (const [sessionId, expected] of sessions) {
      expect(await collect(store.readSession(sessionId))).toEqual(expected.map(stored));
    }
    const target = path.join(root, migratedFolderName(NOW));
    expect(report.renamedTo).toBe(target);
    expect(await fsp.readdir(root)).not.toContain('events');
    // Nothing deleted: every file (index.json too) moved with the folder.
    expect(await fsp.readdir(target)).toEqual(expect.arrayContaining(['index.json']));
    expect(isJsonlMigrationDone(store)).toBe(true);
    expect(store.readMeta(META_MIGRATED_AT)).toBe(new Date(NOW).toISOString());
    expect(store.readMeta(META_MIGRATED_FROM)).toBe(eventsDir);
    expect(store.readMeta(META_MIGRATED_TO)).toBe(target);
    expect(JSON.parse(store.readMeta(META_MIGRATION) ?? '{}')).toMatchObject({
      status: 'migrated',
      written: events.length,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is a no-op on a second run, and reports a missing folder without writing meta', async () => {
    const events = seedEvents();
    await writeJsonl(events);
    const store = openDb();
    await migrateJsonlToSqlite({ eventsDir, store, now });
    const rows = (await store.listSessionRecords()).reduce((n, s) => n + s.eventCount, 0);
    expect(rows).toBe(events.length);

    // Next start: the folder is gone, nothing to do.
    expect((await migrateJsonlToSqlite({ eventsDir, store, now })).status).toBe('already_done');

    // The folder is back (moved back by hand): read again, nothing stored twice, moved aside again.
    const target = path.join(root, migratedFolderName(NOW));
    await fsp.rename(target, eventsDir);
    const again = await migrateJsonlToSqlite({ eventsDir, store, now });
    expect(again).toMatchObject({ status: 'migrated', written: 0, alreadyStored: events.length, renamedTo: target });
    expect((await store.listSessionRecords()).reduce((n, s) => n + s.eventCount, 0)).toBe(rows);

    // New lines in a new events folder (a Huddle that fell back to JSONL) are picked up; the name is taken now.
    await writeJsonl([note('late-1', 'sess-late', NOW)]);
    expect(await migrateJsonlToSqlite({ eventsDir, store, now })).toMatchObject({
      status: 'migrated',
      written: 1,
      renamedTo: `${target}-2`,
    });

    const fresh = openDb('other.sqlite');
    const missing = await migrateJsonlToSqlite({ eventsDir: path.join(root, 'nope'), store: fresh, now });
    expect(missing.status).toBe('no_source');
    expect(fresh.readMeta(META_MIGRATION)).toBeNull();
  });

  it('ends with the same rows when an import that crashed after some batches is run again', async () => {
    const events = seedEvents();
    await writeJsonl(events);
    const clean = openDb('clean.sqlite');
    // The clean run renames the folder; put it back for the crash run.
    await migrateJsonlToSqlite({ eventsDir, store: clean, now, batchSize: 40 });
    await fsp.rename(path.join(root, migratedFolderName(NOW)), eventsDir);

    const store = openDb();
    let appends = 0;
    const crashing: MigrationTarget = {
      append: (batch) => {
        appends += 1;
        return appends === 4 ? Promise.reject(new Error('disk gone')) : store.append(batch);
      },
      flush: () => store.flush(),
      countStoredIds: (ids) => store.countStoredIds(ids),
      countSessionEvents: (id) => store.countSessionEvents(id),
      readMeta: (key) => store.readMeta(key),
      writeMeta: (entries) => {
        store.writeMeta(entries);
      },
      stats: () => store.stats(),
    };
    await expect(migrateJsonlToSqlite({ eventsDir, store: crashing, now, batchSize: 40 })).rejects.toThrow('disk gone');
    expect(isJsonlMigrationDone(store)).toBe(false);
    expect(await fsp.readdir(root)).toContain('events');
    // Three batches were committed before the fourth failed.
    const partial = store.stats().written;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(events.length);

    const rerun = await migrateJsonlToSqlite({ eventsDir, store, now, batchSize: 40 });
    expect(rerun).toMatchObject({ status: 'migrated', alreadyStored: partial, written: events.length - partial });
    expect(await dump(store)).toEqual(await dump(clean));
  });

  it('skips a truncated last line and a foreign line, counts them, and imports the rest', async () => {
    await fsp.mkdir(eventsDir, { recursive: true });
    const a = note('a-1', 'sess-a', 1);
    const b = note('a-2', 'sess-a', 2);
    const text = [line(a), '{"not":"an event"}', 'garbage', line(b), '{"id":"a-3","type":"notif'].join('\n');
    await fsp.writeFile(path.join(eventsDir, 'sess-a.jsonl'), text);
    // A name that is not a session id is left alone (and moved with the folder).
    await fsp.writeFile(path.join(eventsDir, 'not valid.jsonl'), line(note('x-1', 'x', 1)));

    const store = openDb();
    const report = await migrateJsonlToSqlite({ eventsDir, store, now });

    expect(report).toMatchObject({ status: 'migrated', sessions: 1, skippedFiles: 1, skippedLines: 3, written: 2 });
    expect(await collect(store.readSession('sess-a'))).toEqual([a, b]);
    expect(await fsp.readdir(path.join(root, migratedFolderName(NOW)))).toContain('not valid.jsonl');
  });

  it('counts ids repeated in the JSONL once', async () => {
    await fsp.mkdir(eventsDir, { recursive: true });
    const a = note('d-1', 'sess-d', 1);
    await fsp.writeFile(
      path.join(eventsDir, 'sess-d.jsonl'),
      [line(a), line(a), line(note('d-2', 'sess-d', 2))].join('\n'),
    );
    const store = openDb();
    const report = await migrateJsonlToSqlite({ eventsDir, store, now });
    expect(report).toMatchObject({
      status: 'migrated',
      eventsRead: 3,
      distinctEvents: 2,
      duplicateLines: 1,
      written: 2,
    });
    expect(await store.countSessionEvents('sess-d')).toBe(2);
  });

  it('leaves the folder, still marks the import done and does not throw when the rename fails', async () => {
    await writeJsonl([note('r-1', 'sess-r', 1)]);
    const store = openDb();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const busy = (): Promise<void> => Promise.reject(Object.assign(new Error('resource busy'), { code: 'EBUSY' }));

    const report = await migrateJsonlToSqlite({ eventsDir, store, now, logger, rename: busy });

    expect(report).toMatchObject({ status: 'migrated', renamedTo: null, renameError: 'EBUSY', written: 1 });
    expect(await fsp.readdir(eventsDir)).toContain('sess-r.jsonl');
    expect(isJsonlMigrationDone(store)).toBe(true);
    expect(store.readMeta(META_MIGRATED_TO)).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not be renamed'), { code: 'EBUSY' });
    // Not repeated at the next start.
    expect((await migrateJsonlToSqlite({ eventsDir, store, now, rename: busy })).status).toBe('already_done');
  });

  it('picks the next free folder name when events.migrated-<date> exists', async () => {
    await writeJsonl([note('n-1', 'sess-n', 1)]);
    const taken = path.join(root, migratedFolderName(NOW));
    await fsp.mkdir(taken);
    await fsp.mkdir(`${taken}-2`);
    const store = openDb();
    const report = await migrateJsonlToSqlite({ eventsDir, store, now });
    expect(report.renamedTo).toBe(`${taken}-3`);
    expect(await fsp.readdir(`${taken}-3`)).toContain('sess-n.jsonl');
  });

  it('masks secrets in old lines the M1-M4 masking missed (the redaction pass)', async () => {
    await fsp.mkdir(eventsDir, { recursive: true });
    const leaky = note('s-1', 'sess-s', 1, 'export API_KEY=abc123 and sk-ant-api03-AbCdEfGhIjKlMnOpQrSt');
    const clean = note('s-2', 'sess-s', 2);
    await fsp.writeFile(path.join(eventsDir, 'sess-s.jsonl'), `${line(leaky)}\n${line(clean)}\n`);
    const store = openDb();

    const report = await migrateJsonlToSqlite({ eventsDir, store, now });

    expect(report.changedByRedaction).toBe(1);
    const [first] = await collect(store.readSession('sess-s'));
    const text = JSON.stringify(first);
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('AbCdEfGhIjKlMnOpQrSt');
    expect(text).toContain('API_KEY=<redacted>');
  });

  it('keeps the folder and does not mark the import done when events are missing afterwards', async () => {
    await writeJsonl([note('m-1', 'sess-m', 1), note('m-2', 'sess-m', 2)]);
    const store = openDb();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const lossy: MigrationTarget = {
      append: (batch) => store.append(batch.slice(1)),
      flush: () => store.flush(),
      countStoredIds: (ids) => store.countStoredIds(ids),
      countSessionEvents: (id) => store.countSessionEvents(id),
      readMeta: (key) => store.readMeta(key),
      writeMeta: (entries) => {
        store.writeMeta(entries);
      },
      stats: () => store.stats(),
    };

    const report = await migrateJsonlToSqlite({ eventsDir, store: lossy, now, logger });

    expect(report).toMatchObject({ status: 'incomplete', missing: 1, mismatchedSessions: 1, renamedTo: null });
    expect(await fsp.readdir(eventsDir)).toContain('sess-m.jsonl');
    expect(isJsonlMigrationDone(store)).toBe(false);
    expect(JSON.parse(store.readMeta(META_MIGRATION) ?? '{}')).toMatchObject({ status: 'incomplete' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The next start completes it.
    expect((await migrateJsonlToSqlite({ eventsDir, store, now })).status).toBe('migrated');
  });
});
