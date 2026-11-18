/**
 * Replay index (M5 WP4b, F22): `stateAt(i)` is exactly `replay(events[0..i])` for every recorded fixture, on both
 * sides of each checkpoint (499, 500, 501, 999, 1000, 1001), with rows that are not events skipped like the store skips
 * them; the cache keeps a few sessions and folds new rows in; markers, why-facts and event pages.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type AttentionItem, type HuddleEvent } from '@huddle/shared';
import { replay, toHuddleState } from '../state/reduce.js';
import type { StoredRow } from '../store/history-tables.js';
import { listFixtureFiles } from '../test/fixtures.js';
import { builder } from '../test/report-events.js';
import { longSession } from '../test/history-sessions.js';
import {
  CHECKPOINT_EVERY,
  MAX_CHECKPOINTS,
  MAX_INDEXED_EVENTS,
  ReplayCache,
  SessionIndex,
  SessionTooLargeError,
  STATE_AT_CHUNK,
  checkpointInterval,
  extendIndex,
  type RowSource,
} from './replay-index.js';

/** An in-memory log: `rows` per session, `seq` increasing; a row with `event: null` is not an event. */
class MemorySource implements RowSource {
  readonly rows = new Map<string, StoredRow[]>();
  private seq = 0;
  reads = 0;

  add(sessionId: string, events: readonly (HuddleEvent | null)[]): void {
    const list = this.rows.get(sessionId) ?? [];
    for (const event of events) list.push({ seq: (this.seq += 1), event });
    this.rows.set(sessionId, list);
  }

  rowsAfter(sessionId: string, afterSeq: number, limit: number): StoredRow[] {
    this.reads += 1;
    return (this.rows.get(sessionId) ?? []).filter((r) => r.seq > afterSeq).slice(0, limit);
  }

  rowsBetween(sessionId: string, fromSeq: number, toSeq: number, agent?: string): StoredRow[] {
    return (this.rows.get(sessionId) ?? []).filter(
      (r) => r.seq >= fromSeq && r.seq <= toSeq && (agent === undefined || r.event?.agentKey === agent),
    );
  }
}

const now = (): Promise<void> => Promise.resolve();

async function indexOf(source: MemorySource, sessionId: string): Promise<SessionIndex> {
  const index = new SessionIndex(sessionId);
  await extendIndex(index, source, now);
  return index;
}

const FIXTURES = listFixtureFiles();

describe('stateAt is replay over the prefix', () => {
  it.each(FIXTURES)('%s, padded past two checkpoints', async (fixture) => {
    const sessionId = `s-${fixture.replace(/\W/g, '-')}`;
    const events = longSession(fixture, sessionId, 1100, 1_800_000_000_000);
    const source = new MemorySource();
    // A row that is not an event in the middle: skipped by the index, as `readSession` skips it.
    source.add(sessionId, [...events.slice(0, 300), null, ...events.slice(300)]);
    const index = await indexOf(source, sessionId);
    expect(index.count).toBe(events.length);
    expect(index.rowsRead).toBe(events.length + 1);
    const last = events.length - 1;
    for (const i of [0, 1, 250, 498, 499, 500, 501, 998, 999, 1000, 1001, last - 1, last]) {
      expect(toHuddleState(await index.stateAt(i, source, now)), `index ${String(i)}`).toEqual(
        toHuddleState(replay(events.slice(0, i + 1))),
      );
    }
  });
});

describe('checkpoints', () => {
  it('are every 500 events, wider only when the log would need more than MAX_CHECKPOINTS', () => {
    expect(checkpointInterval(0)).toBe(CHECKPOINT_EVERY);
    expect(checkpointInterval(CHECKPOINT_EVERY * MAX_CHECKPOINTS)).toBe(CHECKPOINT_EVERY);
    expect(checkpointInterval(CHECKPOINT_EVERY * MAX_CHECKPOINTS + 1)).toBe(2 * CHECKPOINT_EVERY);
    expect(checkpointInterval(Number.NaN)).toBe(CHECKPOINT_EVERY);
  });

  it('a wider interval still answers every index exactly', async () => {
    const sessionId = 'wide';
    const events = longSession('single-agent.jsonl', sessionId, 1300, 1_800_000_000_000);
    const source = new MemorySource();
    source.add(sessionId, events);
    const index = new SessionIndex(sessionId, CHECKPOINT_EVERY * MAX_CHECKPOINTS * 2 + 1);
    expect(index.interval).toBe(3 * CHECKPOINT_EVERY);
    await extendIndex(index, source, now);
    for (const i of [1498, 1499, 1500, 1501]) {
      expect(toHuddleState(await index.stateAt(i, source, now))).toEqual(toHuddleState(replay(events.slice(0, i + 1))));
    }
  });
});

describe('bounded synchronous work and size (M5 security review L2)', () => {
  /** Counts the rows each `rowsBetween` read returns, and the yields between them. */
  function counting(source: MemorySource) {
    const reads: number[] = [];
    let yields = 0;
    const counted: RowSource = {
      rowsAfter: (...args) => source.rowsAfter(...args),
      rowsBetween: (...args) => {
        const rows = source.rowsBetween(...args);
        reads.push(rows.length);
        return rows;
      },
    };
    const yieldNow = (): Promise<void> => {
      yields += 1;
      return Promise.resolve();
    };
    return { counted, reads, yieldNow, yields: () => yields };
  }

  it('a session past the widen threshold: stateAt reads and reduces in chunks with yields, and stays exact', async () => {
    // Lowered thresholds: checkpoints every 50, at most 4 of them, so 1300 events widen the interval to 350.
    const sessionId = 'wide-chunked';
    const events = longSession('single-agent.jsonl', sessionId, 1300, 1_800_000_000_000);
    const source = new MemorySource();
    source.add(sessionId, events);
    const limits = { checkpointEvery: 50, maxCheckpoints: 4, stateAtChunk: 40 };
    const index = new SessionIndex(sessionId, events.length, limits);
    expect(index.interval).toBe(50 * Math.ceil(events.length / 200));
    expect(index.interval).toBeGreaterThan(50);
    expect(Math.floor(events.length / index.interval)).toBeLessThanOrEqual(4);
    await extendIndex(index, source, now);
    const c = counting(source);
    // The farthest point from a checkpoint: interval - 1 events to reduce.
    const i = 2 * index.interval - 2;
    const state = await index.stateAt(i, c.counted, c.yieldNow);
    expect(toHuddleState(state)).toEqual(toHuddleState(replay(events.slice(0, i + 1))));
    expect(c.reads.reduce((a, b) => a + b, 0)).toBe(index.interval - 1);
    expect(Math.max(...c.reads)).toBeLessThanOrEqual(40);
    expect(c.yields()).toBe(c.reads.length - 1);
    expect(c.yields()).toBeGreaterThan(0);
    for (const j of [0, index.interval - 1, index.interval, index.interval + 1, events.length - 2]) {
      expect(toHuddleState(await index.stateAt(j, source, now)), `index ${String(j)}`).toEqual(
        toHuddleState(replay(events.slice(0, j + 1))),
      );
    }
  });

  it('the default chunk is 500 events, whatever the interval', async () => {
    expect(STATE_AT_CHUNK).toBe(500);
    const sessionId = 'wide-default';
    // More than 1500 events, so 1498 is the farthest point from the only checkpoint below the second one.
    const events = longSession('single-agent.jsonl', sessionId, 1600, 1_800_000_000_000);
    const source = new MemorySource();
    source.add(sessionId, events);
    const index = new SessionIndex(sessionId, CHECKPOINT_EVERY * MAX_CHECKPOINTS * 2 + 1);
    expect(index.interval).toBe(3 * CHECKPOINT_EVERY);
    await extendIndex(index, source, now);
    const c = counting(source);
    await index.stateAt(1498, c.counted, c.yieldNow);
    expect(c.reads).toEqual([500, 500, 499]);
    expect(c.yields()).toBe(2);
  });

  it('refuses to index a session above the event limit, with words that say why; the cache lets it go', async () => {
    expect(MAX_INDEXED_EVENTS).toBe(2_000_000);
    const source = new MemorySource();
    source.add('big', longSession('single-agent.jsonl', 'big', 60, 1_800_000_000_000));
    // Found while reading (the stored count was lower).
    const growing = new SessionIndex('big', 0, { maxEvents: 25 });
    const err = await extendIndex(growing, source, now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionTooLargeError);
    expect((err as Error).message).toMatch(/more than 25 events, too many to replay/);
    expect(growing.count).toBe(25);
    // Known up front: nothing is read.
    source.reads = 0;
    const known = new SessionIndex('big', 1000, { maxEvents: 25 });
    await expect(extendIndex(known, source, now)).rejects.toBeInstanceOf(SessionTooLargeError);
    expect(source.reads).toBe(0);
    const cache = new ReplayCache(source, { yieldNow: now, limits: { maxEvents: 25 } });
    await expect(cache.use('big', (ix) => ix.count)).rejects.toBeInstanceOf(SessionTooLargeError);
    expect(cache.size()).toBe(0);
  });
});

describe('ReplayCache', () => {
  it('keeps the most recently used sessions and folds rows appended since', async () => {
    const source = new MemorySource();
    const sessions = ['a', 'b', 'c', 'd'];
    for (const s of sessions) source.add(s, longSession('single-agent.jsonl', s, 10, 1_800_000_000_000));
    const cache = new ReplayCache(source, { maxSessions: 3, yieldNow: now });
    for (const s of sessions) await cache.use(s, () => undefined);
    expect(cache.size()).toBe(3);

    const before = await cache.use('d', (ix) => ix.count);
    source.add('d', longSession('single-agent.jsonl', 'd', 4, 1_800_000_100_000));
    const after = await cache.use('d', (ix) => ix.count);
    expect(after).toBeGreaterThan(before);
    const all = (source.rows.get('d') ?? []).flatMap((r) => (r.event === null ? [] : [r.event]));
    expect(await cache.use('d', (ix) => toHuddleState(ix.last))).toEqual(toHuddleState(replay(all)));
  });

  it('drops a session whose read failed, so the next access starts again', async () => {
    const source = new MemorySource();
    source.add('a', longSession('single-agent.jsonl', 'a', 10, 1_800_000_000_000));
    let fail = true;
    const flaky: RowSource = {
      rowsAfter: (s, after, limit) => {
        if (fail) throw new Error('disk gone');
        return source.rowsAfter(s, after, limit);
      },
      rowsBetween: (...args) => source.rowsBetween(...args),
    };
    const cache = new ReplayCache(flaky, { yieldNow: now });
    await expect(cache.use('a', (ix) => ix.count)).rejects.toThrow('disk gone');
    expect(cache.size()).toBe(0);
    fail = false;
    await expect(cache.use('a', (ix) => ix.count)).resolves.toBeGreaterThan(0);
  });
});

describe('markers and why-facts', () => {
  const S = 'sess-why';
  const MAIN = agentKey(S);
  const SUB = agentKey(S, 'a1');
  const stuck: AttentionItem = {
    id: `stuck:${SUB}`,
    kind: 'stuck',
    severity: 'warning',
    agentKey: SUB,
    title: 'Explore #1 looks stuck',
    detail: 'No activity for 12 min. Still inside Bash npm test.',
    createdAt: 0,
    resolvedAt: null,
  };

  function log(): HuddleEvent[] {
    const ev = builder(1_800_000_000_000, 60_000);
    const request = {
      requestId: 'req-1',
      agentKey: SUB,
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      summary: 'npm test',
      receivedAt: 0,
      expiresAt: null,
      channel: 'hook' as const,
    };
    return [
      ev('session.started', MAIN, { origin: 'attached', cwd: 'C:/p', title: 't', model: 'opus', startKind: 'startup' }),
      ev('agent.started', SUB, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('approval.requested', SUB, { request }), // 2
      ev('approval.resolved', SUB, {
        requestId: 'req-1',
        outcome: 'allowed',
        by: 'user',
        policyRuleId: null,
        message: null,
      }), // 3
      ev('tool.started', SUB, {
        toolUseId: 'tu-1',
        toolName: 'Bash',
        summary: 'npm test',
        filePath: null,
        inputDigest: 'd1',
      }), // 4
      ev('attention.raised', SUB, { item: stuck }, { source: 'huddle' }), // 5
      ev('attention.raised', SUB, { item: stuck }, { source: 'huddle' }), // 6: a re-raise while open
      ev('tool.finished', SUB, { toolUseId: 'tu-1', toolName: 'Bash', durationMs: 120_000 }), // 7
      ev('attention.resolved', SUB, { itemId: stuck.id }, { source: 'huddle' }), // 8
      ev('tool.failed', MAIN, {
        toolUseId: 'tu-2',
        toolName: 'Read',
        error: 'no such file',
        interrupted: false,
      }), // 9
      ev('session.ended', MAIN, { reason: 'exit' }), // 10
    ];
  }

  it('marks requests, raised items once per episode, and failures', async () => {
    const source = new MemorySource();
    source.add(S, log());
    const index = await indexOf(source, S);
    expect(index.markers.map((m) => [m.index, m.kind, m.itemId])).toEqual([
      [2, 'approval', 'approval:req-1'],
      [5, 'stuck', stuck.id],
      [9, 'failure', null],
    ]);
    expect(index.startsWithSession()).toBe(true);
    expect(index.quietGaps(30_000).length).toBe(10);
    expect(index.quietGaps(60_000)).toEqual([]);
  });

  it('says what the stuck agent was doing, how long it was quiet, and what happened later', async () => {
    const events = log();
    const source = new MemorySource();
    source.add(S, events);
    const index = await indexOf(source, S);
    const at = 6;
    const why = index.whyAt(await index.stateAt(at, source, now), at);
    expect(why).toHaveLength(1);
    const item = why[0];
    expect(item).toMatchObject({
      itemId: stuck.id,
      kind: 'stuck',
      agentKey: SUB,
      title: stuck.title,
      raisedIndex: 5,
      lastToolCall: { toolName: 'Bash', summary: 'npm test', fate: { state: 'open' } },
      // From the agent's own last event (the tool start, index 4); the huddle's raise at 5 does not count.
      quietMs: (events[6]?.ts ?? 0) - (events[4]?.ts ?? 0),
      request: null,
      later: { kind: 'cleared', index: 8, reason: 'condition_cleared' },
    });
    // At the tool's end the stuck item is still open, and the call has finished.
    const atEnd = index.whyAt(await index.stateAt(7, source, now), 7);
    expect(atEnd[0]?.lastToolCall?.fate).toMatchObject({ state: 'finished', durationMs: 120_000 });
    // Once cleared, nothing is open.
    expect(index.whyAt(await index.stateAt(8, source, now), 8)).toEqual([]);
  });

  it('gives an open approval its summary, wait and ending', async () => {
    const events = log();
    const source = new MemorySource();
    source.add(S, events);
    const index = await indexOf(source, S);
    const why = index.whyAt(await index.stateAt(2, source, now), 2);
    expect(why).toEqual([
      expect.objectContaining({
        kind: 'approval',
        raisedIndex: 2,
        request: { summary: 'npm test', waitedMs: 0 },
        later: { kind: 'approval', index: 3, ts: events[3]?.ts, outcome: 'allowed', by: 'user' },
      }),
    ]);
  });

  it('pages events forward, backward and by agent', async () => {
    const source = new MemorySource();
    source.add(S, log());
    const index = await indexOf(source, S);
    expect(index.page(0, 3)).toEqual({ indexes: [0, 1, 2], more: true });
    expect(index.page(9, 5)).toEqual({ indexes: [9, 10], more: false });
    expect(index.page(4, 3, { backward: true })).toEqual({ indexes: [4, 3, 2], more: true });
    expect(index.page(100, 2, { backward: true })).toEqual({ indexes: [10, 9], more: true });
    expect(index.page(0, 50, { agentKey: MAIN })).toEqual({ indexes: [0, 9, 10], more: false });
    expect(index.page(0, 50, { agentKey: 'nobody' })).toEqual({ indexes: [], more: false });
  });
});
