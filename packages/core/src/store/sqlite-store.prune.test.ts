/**
 * The SQLite store's M5 WP5 parts: a root `run.exited` ends a session in `sessions.ended` (and a resume clears it), the
 * v4 data fix for rows written before, and chunked deletion that never touches another session and keeps events that
 * came in after the deletion was decided.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventOfType, HuddleEvent } from '@huddle/shared';
import { appendAll, fixtureSession, tempStore, type TempStore } from '../test/history-sessions.js';
import { readUserVersion, SCHEMA_VERSION } from './sqlite-schema.js';
import { SqliteEventStore } from './sqlite-store.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(): Promise<TempStore> {
  const tmp = await tempStore('huddle-prune-');
  cleanups.push(tmp.cleanup);
  return tmp;
}

function runExited(runId: string, ts: number, id = `${runId}:exited`): HuddleEvent {
  const event: EventOfType<'run.exited'> = {
    id,
    type: 'run.exited',
    ts,
    sessionId: runId,
    agentKey: runId,
    source: 'huddle',
    runId,
    exitCode: null,
    how: 'stopped',
    error: null,
  };
  return event;
}

function sessionStarted(sessionId: string, ts: number, id: string): HuddleEvent {
  const event: EventOfType<'session.started'> = {
    id,
    type: 'session.started',
    ts,
    sessionId,
    agentKey: sessionId,
    source: 'hook',
    origin: 'attached',
    cwd: 'C:/work',
    title: null,
    model: null,
    startKind: 'resume',
  };
  return event;
}

async function record(store: SqliteEventStore, sessionId: string) {
  return (await store.listSessionRecords()).find((r) => r.sessionId === sessionId);
}

describe('a root run.exited ends the session (fix b)', () => {
  it('marks a run killed hard (no session.ended) ended, and a later resume clears it', async () => {
    const { store } = await setup();
    const killed = fixtureSession('single-agent.jsonl', 'run-killed', { lastTs: NOW - 3 * HOUR, dropEnd: true });
    await appendAll(store, killed);
    expect((await record(store, 'run-killed'))?.ended).toBe(false);
    await appendAll(store, [runExited('run-killed', NOW - 3 * HOUR + 1)]);
    expect((await record(store, 'run-killed'))?.ended).toBe(true);
    await appendAll(store, [sessionStarted('run-killed', NOW - HOUR, 'resume-1')]);
    expect((await record(store, 'run-killed'))?.ended).toBe(false);
  });

  it('a subagent-keyed run.exited does not end the session', async () => {
    const { store } = await setup();
    await appendAll(store, fixtureSession('single-agent.jsonl', 's1', { lastTs: NOW - HOUR, dropEnd: true }));
    const sub: HuddleEvent = { ...runExited('s1', NOW), agentKey: 's1::a1' };
    await appendAll(store, [sub]);
    expect((await record(store, 's1'))?.ended).toBe(false);
  });

  it('rebuildSessions applies the same rule', async () => {
    const { store } = await setup();
    await appendAll(store, fixtureSession('single-agent.jsonl', 'r1', { lastTs: NOW - HOUR, dropEnd: true }));
    await appendAll(store, [runExited('r1', NOW)]);
    await store.rebuildSessions();
    expect((await record(store, 'r1'))?.ended).toBe(true);
  });

  it('the v4 data fix marks rows written before this build, and leaves a resumed run open', async () => {
    const { dir, store } = await setup();
    await appendAll(store, fixtureSession('single-agent.jsonl', 'old-kill', { lastTs: NOW - 5 * HOUR, dropEnd: true }));
    await appendAll(store, [runExited('old-kill', NOW - 5 * HOUR + 1)]);
    await appendAll(store, fixtureSession('single-agent.jsonl', 'resumed', { lastTs: NOW - 4 * HOUR, dropEnd: true }));
    await appendAll(store, [runExited('resumed', NOW - 4 * HOUR + 1), sessionStarted('resumed', NOW - HOUR, 'res-2')]);
    await store.close();
    // Back to what a v3 build left: `ended` never set by run.exited.
    const file = `${dir}/huddle.sqlite`;
    const db = new DatabaseSync(file);
    db.exec('UPDATE sessions SET ended = 0');
    db.exec('PRAGMA user_version = 3');
    db.close();
    const reopened = new SqliteEventStore({ file, flushDelayMs: 1 });
    cleanups.push(() => reopened.close());
    const raw = new DatabaseSync(file);
    expect(readUserVersion(raw)).toBe(SCHEMA_VERSION);
    raw.close();
    expect((await record(reopened, 'old-kill'))?.ended).toBe(true);
    expect((await record(reopened, 'resumed'))?.ended).toBe(false);
  });
});

describe('deleteSessionStep', () => {
  it('deletes a session in chunks, then its sessions, search and derived rows, and nothing of another session', async () => {
    const { store } = await setup();
    const a = fixtureSession('parallel-subagents.jsonl', 'gone', { lastTs: NOW - 2 * HOUR });
    const b = fixtureSession('single-agent.jsonl', 'stays', { lastTs: NOW - HOUR });
    await appendAll(store, [...a, ...b]);
    store.history.writeDerivation(
      {
        sessionId: 'gone',
        version: 1,
        eventCount: a.length,
        derivedAt: NOW,
        hasRoot: true,
        outcome: 'completed',
        origin: 'attached',
        model: null,
        otherModels: 0,
        workTokens: null,
        tokensPartial: false,
        agentCount: 1,
        startedAt: NOW,
        endedAt: NOW,
        durationMs: 0,
        reportJson: '{"secret":"x"}',
      },
      [],
    );
    const upToSeq = store.maxSeq('gone');
    const chunk = Math.ceil(a.length / 3);
    const states: string[] = [];
    let removed = 0;
    for (let guard = 0; guard < 10; guard++) {
      const step = store.deleteSessionStep('gone', { upToSeq }, chunk);
      removed += step.removed;
      states.push(step.state);
      if (step.state !== 'more') break;
    }
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.at(-1)).toBe('deleted');
    expect(removed).toBe(a.length);
    expect(await store.countSessionEvents('gone')).toBe(0);
    expect(store.history.session('gone')).toBeNull();
    expect(await store.searchSessions('project')).toEqual([expect.objectContaining({ sessionId: 'stays' })]);
    expect(await store.countSessionEvents('stays')).toBe(b.length);
    expect(store.history.session('stays')).not.toBeNull();
  });

  it('keeps events that came after the deletion was decided and rebuilds the row from them', async () => {
    const { store } = await setup();
    await appendAll(store, fixtureSession('single-agent.jsonl', 'back', { lastTs: NOW - 2 * HOUR }));
    const upToSeq = store.maxSeq('back');
    await appendAll(store, [sessionStarted('back', NOW, 'back-again')]);
    const step = store.deleteSessionStep('back', { upToSeq }, 10_000);
    expect(step.state).toBe('kept');
    const row = await record(store, 'back');
    expect(row).toMatchObject({ eventCount: 1, firstTs: NOW, lastTs: NOW, ended: false, cwd: 'C:/work' });
  });

  it('trims by event time', async () => {
    const { store } = await setup();
    await appendAll(store, [
      sessionStarted('own', NOW - 40 * 24 * HOUR, 'own-1'),
      sessionStarted('own', NOW - HOUR, 'own-2'),
    ]);
    const step = store.deleteSessionStep('own', { beforeTs: NOW - 30 * 24 * HOUR }, 100);
    expect(step).toEqual({ removed: 1, state: 'kept' });
    expect(await store.countSessionEvents('own')).toBe(1);
  });

  it('a derivation for a session that is gone stores nothing', async () => {
    const { store } = await setup();
    store.history.writeDerivation(
      {
        sessionId: 'never',
        version: 1,
        eventCount: 0,
        derivedAt: NOW,
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
      },
      [],
    );
    expect(store.history.agentRuns([])).toEqual([]);
    expect(store.history.pendingDerivations(1, [], 10)).toEqual([]);
  });

  it('VACUUM gives the freed pages back', async () => {
    const { store } = await setup();
    const big = fixtureSession('parallel-subagents.jsonl', 'big', { lastTs: NOW - HOUR });
    for (let n = 0; n < 20; n++) {
      await appendAll(
        store,
        big.map((e) => ({ ...e, id: `${e.id}:${String(n)}` })),
      );
    }
    const upToSeq = store.maxSeq('big');
    store.setSecureDelete(true);
    while (store.deleteSessionStep('big', { upToSeq }, 500).state === 'more');
    store.setSecureDelete(false);
    const before = store.pageStats();
    expect(before.freePages).toBeGreaterThan(0);
    store.vacuum();
    const after = store.pageStats();
    expect(after.freePages).toBe(0);
    expect(after.pageCount).toBeLessThan(before.pageCount);
  });
});
