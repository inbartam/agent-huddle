/**
 * The edge that carries out a budget action (F19). The happy paths run end to end in detect/budget.test.ts and
 * huddle-core.budget.test.ts; this file covers what those do not: a stopper that throws must never take the Huddle
 * down and must still leave the run paused (exceeded) or alone (lapsed), and the user is told in words.
 */
import { describe, expect, it } from 'vitest';
import type { AgentKey, CommandResult, HuddleEvent } from '@huddle/shared';
import type { BudgetAction } from '../detect/index.js';
import { carryOutBudgetAction, type StopRun } from './budget-runner.js';

const ROOT = 'run-1' as AgentKey;
const SUB = 'run-1::sub-a' as AgentKey;

function action(reason: BudgetAction['reason']): BudgetAction {
  return {
    reason,
    budgetKey: `session:${ROOT}`,
    itemId: `budget:session:${ROOT}:over`,
    onExceed: 'stop',
    pause: [],
    stop: [{ runId: 'run-1', rootKey: ROOT, agentKeys: [ROOT, SUB] }],
    notStoppable: [],
    item: null,
    target: { sessionId: 'run-1', agentKey: ROOT, ts: 1000 },
    trigger: 't',
  };
}

function harness(stopRun: StopRun) {
  const paused: AgentKey[] = [];
  const accepted: HuddleEvent[] = [];
  let n = 0;
  return {
    paused,
    accepted,
    deps: {
      pause: (key: AgentKey): CommandResult => {
        paused.push(key);
        return { ok: true };
      },
      stopRun,
      accept: (events: readonly HuddleEvent[]) => accepted.push(...events),
      now: () => 2000,
      nextId: () => `id-${String(++n)}`,
    },
  };
}

describe('carryOutBudgetAction', () => {
  it('a stop that throws is a failed stop, not a crash; an exceeded run is paused instead', async () => {
    const h = harness(() => Promise.reject(new Error('spawn exploded')));
    const outcome = await carryOutBudgetAction(action('exceeded'), h.deps);
    expect(outcome.stopped).toBe(0);
    expect(outcome.stopFailed).toEqual(['stopping the run failed']);
    expect(outcome.pausedInstead).toBe(2);
    expect(h.paused).toEqual([ROOT, SUB]);
    expect(h.accepted.filter((e) => e.type === 'control.applied')).toEqual([]);
  });

  it('after a lapse, a stop that fails pauses nothing more (it would only hold the agent another 10 minutes)', async () => {
    const h = harness(() => Promise.resolve({ ok: false, code: 'failed', message: 'could not stop' }));
    const outcome = await carryOutBudgetAction(action('lapsed'), h.deps);
    expect(outcome.stopFailed).toEqual(['could not stop']);
    expect(outcome.pausedInstead).toBe(0);
    expect(h.paused).toEqual([]);
  });

  it('a stop that works writes control.applied stop from the Huddle, naming the budget item', async () => {
    const h = harness(() => Promise.resolve({ ok: true }));
    const outcome = await carryOutBudgetAction(action('exceeded'), h.deps);
    expect(outcome.stopped).toBe(1);
    expect(h.paused).toEqual([]);
    expect(h.accepted).toHaveLength(1);
    expect(h.accepted[0]).toMatchObject({
      type: 'control.applied',
      action: 'stop',
      source: 'huddle',
      agentKey: ROOT,
      detail: `budget:session:${ROOT}:over`,
    });
  });
});
