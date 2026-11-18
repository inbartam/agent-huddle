/**
 * Security review of 639ecb4: the database files are user-only (0o600) and their folder 0o700, like the JSONL store,
 * and a chmod that fails never stops the store from opening (fail open). In a file of its own because `node:fs` is
 * mocked here.
 */
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuddleEvent } from '@huddle/shared';
import { SqliteEventStore } from './sqlite-store.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

let dir: string;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'huddle-sqlite-perm-'));
});

afterEach(async () => {
  vi.mocked(fs.chmodSync).mockRestore();
  for (const close of closers.splice(0).reverse()) await close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

function event(id: string): HuddleEvent {
  return {
    id,
    type: 'notification.raised',
    ts: 1,
    sessionId: 'sess-a',
    agentKey: 'sess-a',
    source: 'hook',
    notificationType: null,
    message: 'hello',
  };
}

function open(file: string): SqliteEventStore {
  const store = new SqliteEventStore({ file, flushDelayMs: 5 });
  closers.push(() => store.close());
  return store;
}

describe('SqliteEventStore file permissions', () => {
  it.skipIf(process.platform === 'win32')(
    'makes the database, -wal and -shm files 0o600 and the folder 0o700',
    async () => {
      const folder = path.join(dir, 'data');
      fs.mkdirSync(folder, { mode: 0o755 });
      fs.chmodSync(folder, 0o755);
      const file = path.join(folder, 'huddle.sqlite');
      const store = open(file);
      await store.append([event('p-1')]);
      for (const name of [file, `${file}-wal`, `${file}-shm`]) {
        expect(fs.statSync(name).mode & 0o777).toBe(0o600);
      }
      expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')('tightens a database file that was made world-readable', async () => {
    const file = path.join(dir, 'huddle.sqlite');
    await open(file).close();
    fs.chmodSync(file, 0o644);
    open(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('still opens, reads and writes when every chmod throws', async () => {
    vi.mocked(fs.chmodSync).mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const file = path.join(dir, 'huddle.sqlite');
    const store = open(file);
    await store.append([event('p-2')]);
    expect(await store.countSessionEvents('sess-a')).toBe(1);
    expect(vi.mocked(fs.chmodSync)).toHaveBeenCalled();
  });
});
