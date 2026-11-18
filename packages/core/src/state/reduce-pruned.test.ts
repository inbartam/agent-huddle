/**
 * `history.pruned` (M5 WP5, F22): the reducer forgets deleted sessions as if they had never been replayed, and leaves
 * the Huddle's own sessions, a managed run that may still be alive and a session active after the prune alone.
 */
import { describe, expect, it } from 'vitest';
import type { EventOfType, HuddleEvent } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { BUDGET_SESSION_ID, HISTORY_SESSION_ID } from './huddle-sessions.js';
import { reduce, replay, toHuddleState, type ReducerState } from './reduce.js';

/** Every string equal to `from`, or starting with `from::` (an agent key), now names session `to`. */
function renameSession(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    if (value === from) return to;
    return value.startsWith(`${from}::`) ? to + value.slice(from.length) : value;
  }
  if (Array.isArray(value)) return value.map((v) => renameSession(v, from, to));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameSession(v, from, to)]));
  }
  return value;
}

/** A recorded fixture as session `sessionId`, with ids of its own. */
function session(fixture: string, sessionId: string, shiftMs = 0): HuddleEvent[] {
  return fixtureEvents(fixture).map((e) => {
    const renamed = renameSession(e, 'session-1', sessionId) as HuddleEvent;
    return { ...renamed, id: `${sessionId}:${e.id}`, ts: e.ts + shiftMs };
  });
}

function lastTs(events: readonly HuddleEvent[]): number {
  return Math.max(...events.map((e) => e.ts));
}

function pruned(sessionIds: string[], ts: number, reason: 'retention' | 'delete_all' = 'retention'): HuddleEvent {
  const event: EventOfType<'history.pruned'> = {
    id: `prune-${String(ts)}`,
    type: 'history.pruned',
    ts,
    sessionId: HISTORY_SESSION_ID,
    agentKey: HISTORY_SESSION_ID,
    source: 'huddle',
    sessionIds,
    reason,
    count: sessionIds.length,
  };
  return event;
}

function budget(sessionId: string, scope: 'session' | 'overall', ts: number): HuddleEvent {
  const event: EventOfType<'budget.set'> = {
    id: `budget-${sessionId}-${scope}`,
    type: 'budget.set',
    ts,
    sessionId,
    agentKey: sessionId,
    source: 'user',
    scope,
    targetKey: scope === 'overall' ? null : sessionId,
    budget: { scope, maxTokens: 1000, warnAtFraction: 0.8, onExceed: 'notify' },
  };
  return event;
}

function runEvents(runId: string, ts: number, exited: boolean): HuddleEvent[] {
  const base = { sessionId: runId, agentKey: runId, source: 'huddle' as const };
  const launched: EventOfType<'run.launched'> = {
    ...base,
    id: `${runId}:launched`,
    type: 'run.launched',
    ts,
    runId,
    claudeSessionId: runId,
    templateId: null,
    cwd: 'C:/work',
    model: 'sonnet',
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: null,
  };
  const exit: EventOfType<'run.exited'> = {
    ...base,
    id: `${runId}:exited`,
    type: 'run.exited',
    ts: ts + 10,
    runId,
    exitCode: 0,
    how: 'completed',
    error: null,
  };
  return exited ? [launched, exit] : [launched];
}

describe('history.pruned over recorded fixtures', () => {
  const a = session('parallel-subagents.jsonl', 'sess-a');
  const b = session('permission-deny.jsonl', 'sess-b', 1000);
  const end = Math.max(lastTs(a), lastTs(b)) + 1;
  const overall = budget(BUDGET_SESSION_ID, 'overall', end);
  const both = [...a, ...b, budget('sess-a', 'session', end), overall];

  it('leaves exactly the state the other sessions alone would give', () => {
    const before = replay(both);
    expect(before.agents['sess-a']).toBeDefined();
    const after = reduce(before, pruned(['sess-a'], end + 1));
    const expected = replay([...b, overall]);
    expect(after.agents).toEqual(expected.agents);
    expect(after.rootKeys).toEqual(expected.rootKeys);
    expect(after.inbox).toEqual(expected.inbox);
    expect(after.budgets).toEqual(expected.budgets);
    expect(after.book).toEqual(expected.book);
    expect(Object.keys(after.agents).some((k) => k.startsWith('sess-a'))).toBe(false);
  });

  it('keeps the overall budget and drops the pruned session budget', () => {
    const after = reduce(replay(both), pruned(['sess-a'], end + 1, 'delete_all'));
    expect(after.budgets).toEqual([expect.objectContaining({ scope: 'overall', targetKey: null })]);
  });

  it('never drops the Huddle’s own sessions, an unknown id or the envelope session', () => {
    const before = replay(both);
    const after = reduce(before, pruned([BUDGET_SESSION_ID, HISTORY_SESSION_ID, 'never-seen'], end + 1));
    expect(after).toBe(before);
  });

  it('leaves a session with an event after the prune alone (it came back, or a replay read it first)', () => {
    const before = replay(both);
    const after = reduce(before, pruned(['sess-a'], lastTs(a) - 1));
    expect(after).toBe(before);
  });
});

describe('history.pruned and managed runs', () => {
  it('drops an exited run with its book entry, and keeps a run whose exit was never seen', () => {
    const state: ReducerState = replay([...runEvents('run-old', 100, true), ...runEvents('run-live', 200, false)]);
    expect(state.book.runs?.['run-old']).toBeDefined();
    const after = reduce(state, pruned(['run-old', 'run-live'], 1000));
    expect(after.agents['run-old']).toBeUndefined();
    expect(after.book.runs?.['run-old']).toBeUndefined();
    expect(after.book.runOrder).toEqual(['run-live']);
    expect(after.agents['run-live']).toBeDefined();
    expect(toHuddleState(after).rootKeys).toEqual(['run-live']);
  });
});
