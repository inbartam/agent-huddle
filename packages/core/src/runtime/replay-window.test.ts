import { describe, expect, it } from 'vitest';
import type { Budget, HuddleEvent } from '@huddle/shared';
import {
  activeOverallBudgetSince,
  REPLAY_RECENT_MS,
  selectReplaySessions,
  type ReplayCandidate,
} from './replay-window.js';

function budgetSet(ts: number, scope: 'overall' | 'session', limits: Partial<Budget>): HuddleEvent {
  return {
    id: `b-${String(ts)}`,
    type: 'budget.set',
    ts,
    sessionId: 'huddle-budgets',
    agentKey: 'huddle-budgets',
    source: 'user',
    scope,
    targetKey: scope === 'overall' ? null : 'sess-1',
    budget: { scope, warnAtFraction: 0.8, onExceed: 'notify', ...limits },
  };
}

describe('activeOverallBudgetSince', () => {
  it('is the setAt of the overall budget left in force, null when none is', () => {
    expect(activeOverallBudgetSince([])).toBeNull();
    expect(activeOverallBudgetSince([budgetSet(10, 'overall', { maxTokens: 5 })])).toBe(10);
    // A new setting replaces the budget, with a new setAt.
    expect(
      activeOverallBudgetSince([
        budgetSet(10, 'overall', { maxTokens: 5 }),
        budgetSet(20, 'overall', { maxMinutes: 9 }),
      ]),
    ).toBe(20);
    // A setting with no limit clears it; a later one starts again.
    expect(
      activeOverallBudgetSince([budgetSet(10, 'overall', { maxTokens: 5 }), budgetSet(20, 'overall', {})]),
    ).toBeNull();
    expect(
      activeOverallBudgetSince([
        budgetSet(10, 'overall', { maxTokens: 5 }),
        budgetSet(20, 'overall', {}),
        budgetSet(30, 'overall', { maxEstimatedCostUsd: 1 }),
      ]),
    ).toBe(30);
    // Other scopes do not count.
    expect(activeOverallBudgetSince([budgetSet(10, 'session', { maxTokens: 5 })])).toBeNull();
  });
});

const NOW = 10 * REPLAY_RECENT_MS;

function rec(sessionId: string, lastTs: number, ended: boolean, firstTs = lastTs - 1000): ReplayCandidate {
  return { sessionId, firstTs, lastTs, ended };
}

describe('selectReplaySessions', () => {
  it('loads open sessions of any age and ended ones from the last 24 hours', () => {
    const records = [
      rec('old-open', NOW - 5 * REPLAY_RECENT_MS, false),
      rec('old-ended', NOW - 2 * REPLAY_RECENT_MS, true),
      rec('edge-ended', NOW - REPLAY_RECENT_MS, true),
      rec('just-too-old', NOW - REPLAY_RECENT_MS - 1, true),
      rec('recent-ended', NOW - 60_000, true),
    ];
    expect(selectReplaySessions(records, { now: NOW }).map((r) => r.sessionId)).toEqual([
      'old-open',
      'edge-ended',
      'recent-ended',
    ]);
  });

  it('always loads the named sessions, without regard to case', () => {
    const records = [rec('huddle-budgets', 1, true), rec('ABCD-run', 2, true), rec('other', 3, true)];
    const chosen = selectReplaySessions(records, { now: NOW, always: ['huddle-budgets', 'abcd-RUN'] });
    expect(chosen.map((r) => r.sessionId)).toEqual(['huddle-budgets', 'ABCD-run']);
  });

  it('while an overall budget is in force, loads every session active since it was set', () => {
    const records = [
      rec('since-budget', NOW - 2 * REPLAY_RECENT_MS, true),
      rec('before-budget', NOW - 5 * REPLAY_RECENT_MS, true),
    ];
    const since = NOW - 3 * REPLAY_RECENT_MS;
    expect(selectReplaySessions(records, { now: NOW, activeSince: since }).map((r) => r.sessionId)).toEqual([
      'since-budget',
    ]);
    expect(selectReplaySessions(records, { now: NOW, activeSince: null })).toEqual([]);
  });

  it('orders by first event, then session id', () => {
    const records = [rec('b', NOW, false, 5), rec('a', NOW, false, 5), rec('c', NOW, false, 1)];
    expect(selectReplaySessions(records, { now: NOW }).map((r) => r.sessionId)).toEqual(['c', 'a', 'b']);
  });
});
