/**
 * Carries out what the budget detector asks for (F19, ADR-020 §4): the edge between the pure detector
 * (detect/budget.ts) and the pause path and the run stopper. Everything it touches is injected, so it is tested with
 * fakes; HuddleCore passes the broker's automatic pause, its `accept`, its clock and ids, and `stopRun`.
 *
 *  - Stop first: each run is stopped through `stopRun`; on success a `control.applied stop` (source huddle, detail:
 *    the budget item's id) is written. When a run cannot be stopped and the cap was just reached, its agents are
 *    paused instead; after a lapse nothing more is done (pausing again would only hold it another 10 minutes) and the
 *    item says the run continues.
 *  - Then the pauses, through the same checks as the user's `agent.pause` (source huddle).
 *  - Last, the over item is raised (or amended) with what happened, in words.
 * Never throws: a failing `stopRun` counts as "could not stop".
 */
import type { AgentKey, CommandResult, HuddleEvent } from '@huddle/shared';
import { finishBudgetAction, type BudgetAction, type BudgetOutcome } from '../detect/index.js';

/**
 * Stops a run the Huddle launched (the StreamDriver does it). Resolves with a CommandResult; it does
 * not write `control.applied` itself when called from here (the budget runner does, with source huddle).
 */
export type StopRun = (runId: string) => Promise<CommandResult>;

export interface BudgetRunnerDeps {
  /** The Huddle's own pause of one agent (Broker.pauseByHuddle). */
  pause: (agentKey: AgentKey, detail: string) => CommandResult;
  stopRun: StopRun;
  /** Reduce and store events (HuddleCore's accept). */
  accept: (events: readonly HuddleEvent[]) => void;
  now: () => number;
  nextId: () => string;
}

function sessionOfKey(key: AgentKey): string {
  const cut = key.indexOf('::');
  return cut < 0 ? key : key.slice(0, cut);
}

async function stopOne(stopRun: StopRun, runId: string): Promise<CommandResult> {
  try {
    return await stopRun(runId);
  } catch {
    return { ok: false, code: 'failed', message: 'stopping the run failed' };
  }
}

export async function carryOutBudgetAction(action: BudgetAction, deps: BudgetRunnerDeps): Promise<BudgetOutcome> {
  const outcome: BudgetOutcome = {
    pausedManaged: 0,
    pausedAttached: 0,
    pauseFailed: 0,
    stopped: 0,
    stopFailed: [],
    pausedInstead: 0,
  };
  for (const run of action.stop) {
    const result = await stopOne(deps.stopRun, run.runId);
    if (result.ok) {
      outcome.stopped += 1;
      deps.accept([
        {
          id: deps.nextId(),
          type: 'control.applied',
          ts: deps.now(),
          sessionId: sessionOfKey(run.rootKey),
          agentKey: run.rootKey,
          source: 'huddle',
          action: 'stop',
          detail: action.itemId,
        },
      ]);
      continue;
    }
    outcome.stopFailed.push(result.message);
    if (action.reason !== 'exceeded') continue;
    for (const key of run.agentKeys) {
      if (deps.pause(key, action.itemId).ok) outcome.pausedInstead += 1;
      else outcome.pauseFailed += 1;
    }
  }
  for (const p of action.pause) {
    if (!deps.pause(p.agentKey, action.itemId).ok) outcome.pauseFailed += 1;
    else if (p.managed) outcome.pausedManaged += 1;
    else outcome.pausedAttached += 1;
  }
  deps.accept(finishBudgetAction(action, outcome));
  return outcome;
}
