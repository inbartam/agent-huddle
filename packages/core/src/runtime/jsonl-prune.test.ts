import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from '../store/jsonl-store.js';
import { migratedJsonlFolders, pickJsonlSessions } from './jsonl-prune.js';
import { removeTreeNoFollow } from './safe-remove.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('pickJsonlSessions (M1)', () => {
  const files = [
    { sessionId: 'a', mtimeMs: 100 },
    { sessionId: 'b', mtimeMs: 200 },
    { sessionId: 'budget', mtimeMs: 50 },
    { sessionId: 'live', mtimeMs: 10 },
  ];
  const keep = new Set(['budget', 'live']);

  it('retention picks files older than the cutoff; delete all picks every file; neither picks a kept one', () => {
    expect(pickJsonlSessions(files, { kind: 'retention', cutoff: 150 }, keep)).toEqual(['a']);
    expect(pickJsonlSessions(files, { kind: 'retention', cutoff: 200 }, keep)).toEqual(['a']);
    expect(pickJsonlSessions(files, { kind: 'retention', cutoff: 201 }, keep)).toEqual(['a', 'b']);
    expect(pickJsonlSessions(files, { kind: 'delete_all' }, keep)).toEqual(['a', 'b']);
  });
});

describe('JsonlEventStore session files (M1)', () => {
  it('lists session files with their own times, deletes them on the write chain, and forgets them', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-jsonl-prune-'));
    roots.push(root);
    const baseDir = path.join(root, 'events');
    const store = new JsonlEventStore({ baseDir, flushDelayMs: 1 });
    const event = (sessionId: string, id: string) =>
      ({
        id,
        type: 'notification.raised',
        ts: 1,
        sessionId,
        agentKey: sessionId,
        source: 'hook',
        kind: 'other',
        message: 'm',
      }) as unknown as Parameters<JsonlEventStore['append']>[0][number];
    await store.append([event('s1', 'e1'), event('s2', 'e2')]);
    await fsp.writeFile(path.join(baseDir, 'not a session!.jsonl'), '');
    await fsp.mkdir(path.join(baseDir, 'dir.jsonl'));
    const listed = await store.sessionFiles();
    expect(listed.map((f) => f.sessionId)).toEqual(['s1', 's2']);
    expect(listed.every((f) => Number.isFinite(f.mtimeMs))).toBe(true);

    // An append queued right before the deletion is written first, then the file goes.
    void store.append([event('s1', 'e3')]);
    const out = await store.deleteSessionFiles(['s1', 'missing', '../evil'], removeTreeNoFollow);
    expect(out).toEqual({ deleted: ['s1', 'missing'], problems: [] });
    expect((await store.sessionFiles()).map((f) => f.sessionId)).toEqual(['s2']);
    expect((await store.listSessions()).map((s) => s.sessionId)).toEqual(['s2']);
    await store.close();
  });

  it('migratedJsonlFolders lists only events.migrated-* in the data folder', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-jsonl-prune-'));
    roots.push(root);
    for (const name of ['events', 'events.migrated-2026-10-01', 'events.migrated-2026-10-01-2', 'reports']) {
      await fsp.mkdir(path.join(root, name));
    }
    expect((await migratedJsonlFolders(root)).map((p) => path.basename(p))).toEqual([
      'events.migrated-2026-10-01',
      'events.migrated-2026-10-01-2',
    ]);
    expect(await migratedJsonlFolders(path.join(root, 'nope'))).toEqual([]);
  });
});
