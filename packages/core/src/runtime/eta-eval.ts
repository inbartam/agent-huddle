/**
 * ETA evaluation harness (M2, F4). Replays a recorded run through the reducer event by event and, at every subagent
 * completion, asks `selectProgress` for the ETA range of the parent. The range is turned into absolute times and
 * compared with when the parent really finished. Pure: events and parameters in, numbers out.
 *
 * Check points
 *   For every agent with subagents (the session root, or a subagent with children of its own), one check point
 *   after each direct child's `agent.stopped` that happens before the parent ends; optionally also after each
 *   `agent.started` of a child beyond the first. The parent's end is its last `turn.ended` (a subagent parent:
 *   `agent.stopped`), falling back to `session.ended` for the root.
 *
 * Verdict
 *   A check point "contains" the finish when etaLow <= finish <= etaHigh (absolute). A run contains the finish when
 *   most of its check points that have a range contain it (owner default, plan 2026-11-14-m2-meter). A run with
 *   no ranged check point has no verdict.
 */
import {
  etaPriorsFrom,
  median,
  selectProgress,
  type AgentRunRow,
  type EtaParams,
  type EtaPriors,
  type HuddleEvent,
  type HuddleState,
  type ProgressOptions,
} from '@huddle/shared';
import { agentRunRows, scorecardRows } from '../report/agent-runs.js';
import { computeScorecards } from '../report/scorecards.js';
import { initialState, reduce } from '../state/reduce.js';

export interface EtaCheckpoint {
  parentKey: string;
  /** Event time of the check point. */
  at: number;
  trigger: 'subagent_stopped' | 'subagent_started';
  finishedSubagents: number;
  startedSubagents: number;
  confidence: 'low' | 'medium' | 'high';
  /** Absolute times; null when the estimator gave no range. */
  etaLowAt: number | null;
  etaPointAt: number | null;
  etaHighAt: number | null;
  actualFinishAt: number;
  contained: boolean | null;
  /** |point ETA - actual finish|, ms; null without a point ETA. */
  absErrorMs: number | null;
}

export type Verdict = 'contains' | 'misses' | 'no data';

export interface EtaRunResult {
  checkpoints: EtaCheckpoint[];
  /** Check points that have a range. */
  ranged: number;
  contained: number;
  verdict: Verdict;
  medianAbsErrorMs: number | null;
}

export interface EtaEvalOptions {
  /** Constants to try instead of the exported ones. */
  params?: EtaParams;
  /** Also take a check point at each child start after the first (default false). */
  includeStarts?: boolean;
  progress?: Omit<ProgressOptions, 'params'>;
}

/** End of each agent's own work (last turn end; else agent.stopped), plus session end times per session. */
function finishTimes(events: readonly HuddleEvent[]): { byAgent: Map<string, number>; bySession: Map<string, number> } {
  const turnEnd = new Map<string, number>();
  const stopped = new Map<string, number>();
  const bySession = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'turn.ended') turnEnd.set(e.agentKey, e.ts);
    else if (e.type === 'agent.stopped') stopped.set(e.agentKey, e.ts);
    else if (e.type === 'session.ended') bySession.set(e.sessionId, e.ts);
  }
  // A subagent's turn.ended and agent.stopped come together; the root only has turn.ended (Stop).
  return { byAgent: new Map([...stopped, ...turnEnd]), bySession };
}

export function evaluateRun(events: readonly HuddleEvent[], opts: EtaEvalOptions = {}): EtaRunResult {
  const finish = finishTimes(events);
  const childrenStarted = new Map<string, number>();

  let state: HuddleState = initialState();
  const checkpoints: EtaCheckpoint[] = [];

  for (const e of events) {
    state = reduce(state, e);
    let trigger: EtaCheckpoint['trigger'];
    if (e.type === 'agent.stopped') trigger = 'subagent_stopped';
    else if (e.type === 'agent.started') trigger = 'subagent_started';
    else continue;
    const parentKey = state.agents[e.agentKey]?.parentKey ?? null;
    if (parentKey === null) continue;
    if (trigger === 'subagent_started') {
      const n = (childrenStarted.get(parentKey) ?? 0) + 1;
      childrenStarted.set(parentKey, n);
      if (opts.includeStarts !== true || n < 2) continue;
    }
    const parent = state.agents[parentKey];
    if (parent === undefined) continue;
    const actual = finish.byAgent.get(parentKey) ?? finish.bySession.get(parent.sessionId);
    if (actual === undefined || e.ts >= actual) continue;
    const view = selectProgress(state, parentKey, e.ts, {
      ...opts.progress,
      ...(opts.params !== undefined ? { params: opts.params } : {}),
    });
    if (view === null) continue;
    const abs = (ms: number | null): number | null => (ms === null ? null : e.ts + ms);
    const low = abs(view.etaLowMs);
    const point = abs(view.etaMs);
    const high = abs(view.etaHighMs);
    checkpoints.push({
      parentKey,
      at: e.ts,
      trigger,
      finishedSubagents: view.finishedSubagents,
      startedSubagents: view.startedSubagents,
      confidence: view.confidence,
      etaLowAt: low,
      etaPointAt: point,
      etaHighAt: high,
      actualFinishAt: actual,
      contained: low !== null && high !== null ? low <= actual && actual <= high : null,
      absErrorMs: point === null ? null : Math.abs(point - actual),
    });
  }

  const ranged = checkpoints.filter((c) => c.contained !== null);
  const contained = ranged.filter((c) => c.contained === true).length;
  const verdict: Verdict = ranged.length === 0 ? 'no data' : contained * 2 > ranged.length ? 'contains' : 'misses';
  const errors = checkpoints.flatMap((c) => (c.absErrorMs === null ? [] : [c.absErrorMs]));
  return { checkpoints, ranged: ranged.length, contained, verdict, medianAbsErrorMs: median(errors) };
}

export interface EtaReportRow {
  run: string;
  group: string;
  result: EtaRunResult;
}

const pad = (s: string, n: number): string => s.padEnd(n);

const seconds = (ms: number | null): string => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);

/**
 * Plain-text table: one line per run, then totals per group (tune, then judge; a group with no rows is left out).
 * Coverage is how many check points had a range at all: returning no range is honest where there is no basis, but it
 * must not be how the containment numbers improve.
 */
export function formatEtaReport(rows: readonly EtaReportRow[]): string {
  const header = `${pad('run', 20)}${pad('group', 8)}${pad('check pts', 11)}${pad('contained', 11)}${pad('verdict', 10)}median abs err`;
  const lines = [header, '-'.repeat(header.length + 6)];
  for (const r of rows) {
    lines.push(
      pad(r.run, 20) +
        pad(r.group, 8) +
        pad(String(r.result.checkpoints.length), 11) +
        pad(`${String(r.result.contained)}/${String(r.result.ranged)}`, 11) +
        pad(r.result.verdict, 10) +
        seconds(r.result.medianAbsErrorMs),
    );
  }
  for (const group of ['tune', 'judge']) {
    const g = rows.filter((r) => r.group === group);
    if (g.length === 0) continue;
    const withVerdict = g.filter((r) => r.result.verdict !== 'no data');
    const ok = withVerdict.filter((r) => r.result.verdict === 'contains').length;
    const cp = g.reduce((s, r) => s + r.result.ranged, 0);
    const all = g.reduce((s, r) => s + r.result.checkpoints.length, 0);
    const inside = g.reduce((s, r) => s + r.result.contained, 0);
    const errors = g.flatMap((r) => r.result.checkpoints.flatMap((c) => (c.absErrorMs === null ? [] : [c.absErrorMs])));
    lines.push(
      `total ${group}: ${String(ok)}/${String(withVerdict.length)} runs contain the finish; ` +
        `${String(inside)}/${String(cp)} check points contain it; coverage ${String(cp)}/${String(all)} ranged; ` +
        `median abs err ${seconds(median(errors))} (${String(g.length)} runs)`,
    );
  }
  return lines.join('\n');
}

/**
 * Which recorded-run group to evaluate, from the ETA_GROUP environment value: 'tune' or 'judge', anything else
 * (unset) for both. Tuning looks at 'tune' only; 'judge' is run once, at the end, and not tuned against.
 */
export function parseEtaGroup(value: string | undefined): 'tune' | 'judge' | null {
  return value === 'tune' || value === 'judge' ? value : null;
}

// ---------------------------------------------------------------------------
// Leave-one-out priors (M5 WP7, F24 -> F4)
// ---------------------------------------------------------------------------

/**
 * The ETA priors a run would have had if every other recorded run were its history: scorecards over the agent run rows
 * of all runs but `leaveOut`, then `etaPriorsFrom`. Never scores a run with priors that saw that run (tuning and scoring
 * on the same runs would flatter the prior). `asOf` is 0: the evaluation has no clock.
 */
export function leaveOneOutPriors(rowsByRun: readonly (readonly AgentRunRow[])[], leaveOut: number): EtaPriors {
  const others = rowsByRun.flatMap((rows, i) => (i === leaveOut ? [] : rows));
  return etaPriorsFrom(computeScorecards(others), 0);
}

export interface LeaveOneOutRow extends EtaReportRow {
  /** The same run with no priors (today's default). */
  without: EtaRunResult;
  /** Pairs in the priors this run was scored with. */
  priorPairs: number;
}

/**
 * Each run evaluated twice: without priors, and with the priors of the other runs (`leaveOneOutPriors`). `result` is
 * the run with priors, so `formatEtaReport` prints the "with" table.
 */
export function evaluateLeaveOneOut(
  runs: readonly { run: string; group: string; events: readonly HuddleEvent[] }[],
  opts: Omit<EtaEvalOptions, 'progress'> = {},
): LeaveOneOutRow[] {
  // The rows the app's scorecards would count (no rootless sessions, no agents that did nothing).
  const rowsByRun = runs.map((r) => scorecardRows(agentRunRows(r.events), r.events));
  return runs.map((r, i) => {
    const priors = leaveOneOutPriors(rowsByRun, i);
    return {
      run: r.run,
      group: r.group,
      without: evaluateRun(r.events, { ...opts, progress: { usePriors: false } }),
      result: evaluateRun(r.events, { ...opts, progress: { priors, usePriors: true } }),
      priorPairs: Object.keys(priors.byRoleModel).length,
    };
  });
}

/** One line per group: runs and check points that contain the finish, without priors and with leave-one-out priors. */
export function formatLeaveOneOut(rows: readonly LeaveOneOutRow[]): string {
  const lines: string[] = [];
  for (const group of ['tune', 'judge']) {
    const g = rows.filter((r) => r.group === group);
    if (g.length === 0) continue;
    const tally = (pick: (r: LeaveOneOutRow) => EtaRunResult): string => {
      const results = g.map(pick);
      const withVerdict = results.filter((x) => x.verdict !== 'no data');
      const runsOk = withVerdict.filter((x) => x.verdict === 'contains').length;
      const inside = results.reduce((s, x) => s + x.contained, 0);
      const ranged = results.reduce((s, x) => s + x.ranged, 0);
      const errors = results.flatMap((x) =>
        x.checkpoints.flatMap((c) => (c.absErrorMs === null ? [] : [c.absErrorMs])),
      );
      return `${String(runsOk)}/${String(withVerdict.length)} runs, ${String(inside)}/${String(ranged)} check points, median abs err ${seconds(median(errors))}`;
    };
    lines.push(
      `leave-one-out ${group}: without priors ${tally((r) => r.without)}; with priors ${tally((r) => r.result)}`,
    );
  }
  return lines.join('\n');
}
