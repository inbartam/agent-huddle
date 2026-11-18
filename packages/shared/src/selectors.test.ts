import { describe, expect, it } from 'vitest';
import {
  EMPTY_USAGE,
  agentKey,
  priorKey,
  type AgentNode,
  type EtaPriors,
  type HuddleState,
  type TaskItem,
  type TokenUsage,
} from './model.js';
import { WRAP_UP_DURATION_FACTOR } from './progress.js';
import {
  priorMsFor,
  selectContextWarning,
  selectCurrentTask,
  selectProgress,
  selectUsageRollup,
  selfReportFor,
  SELF_REPORT_STALE_MS,
  USE_ETA_PRIORS,
} from './selectors.js';

const T0 = 1_000_000;
const MIN = 60_000;
const SESSION = 's1';

function node(partial: Partial<AgentNode> & Pick<AgentNode, 'key'>): AgentNode {
  return {
    sessionId: SESSION,
    agentId: null,
    parentKey: null,
    childKeys: [],
    kind: 'subagent',
    origin: 'attached',
    name: partial.key,
    role: 'Explore',
    roleDescription: null,
    model: null,
    cwd: null,
    status: 'working',
    currentActivity: null,
    tasks: [],
    progress: {
      fraction: null,
      completedTasks: 0,
      totalTasks: 0,
      etaMs: null,
      etaLowMs: null,
      etaHighMs: null,
      basis: 'none',
      confidence: 'low',
    },
    usage: { ...EMPTY_USAGE },
    context: {
      usedTokens: null,
      windowTokens: null,
      usedPct: null,
      compactions: 0,
      lastCompactedAt: null,
      loadedInstructions: [],
      measuredBy: null,
    },
    handoff: null,
    capabilities: {
      approve: true,
      answerQuestions: true,
      message: 'queued',
      pause: false,
      stop: false,
      setModel: false,
    },
    toolCalls: 0,
    toolFailures: 0,
    startedAt: T0,
    endedAt: null,
    lastEventAt: T0,
    ...partial,
  };
}

function usage(input: number, output: number, requests: number, cost: number): TokenUsage {
  return { ...EMPTY_USAGE, inputTokens: input, outputTokens: output, requests, estimatedCostUsd: cost };
}

function state(nodes: AgentNode[]): HuddleState {
  return {
    agents: Object.fromEntries(nodes.map((n) => [n.key, n])),
    rootKeys: nodes.filter((n) => n.kind === 'main').map((n) => n.key),
    inbox: [],
    rateLimits: null,
  };
}

const MAIN = agentKey(SESSION);
const A = agentKey(SESSION, 'a');
const B = agentKey(SESSION, 'b');
const C = agentKey(SESSION, 'c');

describe('selectProgress', () => {
  it('returns null for an unknown key', () => {
    expect(selectProgress(state([]), MAIN, T0)).toBeNull();
  });

  it('no basis gives fraction null, ETA null, basis none', () => {
    const s = state([node({ key: MAIN, kind: 'main', role: 'main' })]);
    expect(selectProgress(s, MAIN, T0 + MIN)).toMatchObject({
      fraction: null,
      etaMs: null,
      etaLowMs: null,
      etaHighMs: null,
      basis: 'none',
      finishedSubagents: 0,
      startedSubagents: 0,
    });
  });

  it('counts direct subagents finished over started; running ones are not done', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A, B, C] }),
      node({ key: A, parentKey: MAIN, status: 'done', endedAt: T0 + 2 * MIN, childKeys: [] }),
      node({ key: B, parentKey: MAIN, status: 'failed', endedAt: T0 + 4 * MIN }),
      node({ key: C, parentKey: MAIN, status: 'working' }),
    ]);
    const p = selectProgress(s, MAIN, T0 + 4 * MIN);
    expect(p).toMatchObject({ basis: 'subagents', finishedSubagents: 2, startedSubagents: 3, scopeGrew: false });
    // The working parent's own wrap-up is one more unit: 2 / (3 + 1).
    expect(p?.fraction).toBe(0.5);
    expect(p?.confidence).toBe('medium');
    // 2 min left on C at the pace of completions, then the wrap-up: the mean duration of A and B (2 and 4 min).
    expect(p?.etaMs).toBe(2 * MIN + WRAP_UP_DURATION_FACTOR * 3 * MIN);
  });

  it('an idle parent has finished its turn: no wrap-up unit, the bar reaches 1', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', status: 'idle', childKeys: [A, B] }),
      node({ key: A, parentKey: MAIN, status: 'done', endedAt: T0 + 2 * MIN }),
      node({ key: B, parentKey: MAIN, status: 'done', endedAt: T0 + 3 * MIN }),
    ]);
    expect(selectProgress(s, MAIN, T0 + 4 * MIN)?.fraction).toBe(1);
  });

  it('counts only direct children, not grandchildren', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A] }),
      node({ key: A, parentKey: MAIN, childKeys: [B] }),
      node({ key: B, parentKey: A, status: 'done', endedAt: T0 + MIN }),
    ]);
    expect(selectProgress(s, MAIN, T0 + 2 * MIN)).toMatchObject({ fraction: 0, startedSubagents: 1 });
    expect(selectProgress(s, A, T0 + 2 * MIN)).toMatchObject({ fraction: 0.5, startedSubagents: 1 });
  });

  it('marks scope grew when a subagent starts after another finished', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A, B] }),
      node({ key: A, parentKey: MAIN, status: 'done', endedAt: T0 + 2 * MIN }),
      node({ key: B, parentKey: MAIN, startedAt: T0 + 3 * MIN, lastEventAt: T0 + 3 * MIN }),
    ]);
    const p = selectProgress(s, MAIN, T0 + 4 * MIN);
    expect(p?.scopeGrew).toBe(true);
    expect(p?.fraction).toBeCloseTo(1 / 3);
  });

  it('a parent still working after all its subagents finished is not at 1 and has no ETA of 0', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A, B, C] }),
      node({ key: A, parentKey: MAIN, status: 'done', endedAt: T0 + MIN }),
      node({ key: B, parentKey: MAIN, status: 'done', endedAt: T0 + 2 * MIN }),
      node({ key: C, parentKey: MAIN, status: 'done', endedAt: T0 + 3 * MIN }),
    ]);
    const p = selectProgress(s, MAIN, T0 + 3 * MIN);
    expect(p?.fraction).toBe(0.75);
    // Only the wrap-up is left: the mean duration of A, B and C (1, 2, 3 min).
    expect(p?.etaMs).toBe(WRAP_UP_DURATION_FACTOR * 2 * MIN);
    expect(p?.etaHighMs).toBeGreaterThan(p?.etaMs ?? Number.POSITIVE_INFINITY);
    expect(p?.confidence).toBe('low');
    const late = selectProgress(s, MAIN, T0 + 20 * MIN);
    expect(late?.fraction).toBeLessThan(1);
    expect(late?.etaMs).toBeGreaterThan(0);
  });

  it('a finished parent is at 1 with ETA 0', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', status: 'done', endedAt: T0 + 4 * MIN, childKeys: [A] }),
      node({ key: A, parentKey: MAIN, status: 'done', endedAt: T0 + 2 * MIN }),
    ]);
    expect(selectProgress(s, MAIN, T0 + 5 * MIN)).toMatchObject({ fraction: 1, etaMs: 0 });
  });

  it('falls back to tasks for an agent without subagents', () => {
    const s = state([
      node({
        key: MAIN,
        kind: 'main',
        role: 'main',
        tasks: [
          { id: '1', subject: 'one', status: 'completed', createdAt: T0, completedAt: T0 + MIN },
          { id: '2', subject: 'two', status: 'pending', createdAt: T0 },
        ],
      }),
    ]);
    expect(selectProgress(s, MAIN, T0 + MIN)).toMatchObject({ basis: 'tasks', fraction: 0.5 });
  });

  it('uses a self-report passed in when there are no subagents', () => {
    const s = state([node({ key: MAIN, kind: 'main', role: 'main' })]);
    const p = selectProgress(s, MAIN, T0, { selfReport: { fraction: 0.4, etaMinutes: null, reportedAt: T0 } });
    expect(p).toMatchObject({ basis: 'self_report', fraction: 0.4, etaMs: null });
  });

  it('prefers subagents over a self-report (ADR-010 order)', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A] }),
      node({ key: A, parentKey: MAIN }),
    ]);
    const p = selectProgress(s, MAIN, T0, { selfReport: { fraction: 0.9, etaMinutes: 1, reportedAt: T0 } });
    expect(p).toMatchObject({ basis: 'subagents', fraction: 0 });
  });
});

describe("selectProgress with the agent's own self-report (F27, M6 P2)", () => {
  const report = (fraction: number | null, minutesLeft: number | null, at = T0) => ({
    fraction,
    minutesLeft,
    note: null,
    at,
  });

  it("uses the node's selfReport when no override is given", () => {
    const s = state([node({ key: MAIN, kind: 'main', role: 'main', selfReport: report(0.4, 5) })]);
    expect(selectProgress(s, MAIN, T0)).toMatchObject({ basis: 'self_report', fraction: 0.4, etaMs: 5 * MIN });
  });

  it('blends with the task list (hybrid), as estimateProgress defines', () => {
    const tasks: TaskItem[] = [
      { id: '1', subject: 'one', status: 'completed', createdAt: T0, completedAt: T0 + MIN },
      { id: '2', subject: 'two', status: 'pending', createdAt: T0 },
    ];
    const s = state([node({ key: MAIN, kind: 'main', role: 'main', tasks, selfReport: report(0.9, null, T0 + MIN) })]);
    const p = selectProgress(s, MAIN, T0 + MIN);
    expect(p?.basis).toBe('hybrid');
    expect(p?.fraction).toBeCloseTo(0.5 * 0.9 + 0.5 * 0.5);
  });

  it('an explicit override wins, and null means none', () => {
    const s = state([node({ key: MAIN, kind: 'main', role: 'main', selfReport: report(0.4, null) })]);
    expect(selectProgress(s, MAIN, T0, { selfReport: null })).toMatchObject({ basis: 'none', fraction: null });
    expect(
      selectProgress(s, MAIN, T0, { selfReport: { fraction: 0.7, etaMinutes: null, reportedAt: T0 } }),
    ).toMatchObject({ basis: 'self_report', fraction: 0.7 });
  });

  it('only minutes left: the fraction stays unknown, the ETA comes from the report', () => {
    const s = state([node({ key: MAIN, kind: 'main', role: 'main', selfReport: report(null, 3) })]);
    expect(selectProgress(s, MAIN, T0 + MIN)).toMatchObject({ basis: 'self_report', fraction: null, etaMs: 2 * MIN });
  });

  it('a note-only report gives no basis', () => {
    const s = state([node({ key: MAIN, kind: 'main', role: 'main', selfReport: report(null, null) })]);
    expect(selectProgress(s, MAIN, T0)).toMatchObject({ basis: 'none', fraction: null, etaMs: null });
  });

  it("a subagent's report is its own bar only: the parent counts subagents (ADR-010)", () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A], selfReport: report(0.2, null) }),
      node({ key: A, parentKey: MAIN, selfReport: report(1, 0) }),
    ]);
    expect(selectProgress(s, A, T0)).toMatchObject({ basis: 'self_report', fraction: 1 });
    const root = selectProgress(s, MAIN, T0);
    expect(root?.basis).toBe('subagents');
    expect(root?.fraction).toBe(0);
  });

  it('a stale report stops counting while the agent works', () => {
    const fresh = node({ key: MAIN, kind: 'main', role: 'main', selfReport: report(0.4, null) });
    expect(selfReportFor(fresh, T0 + SELF_REPORT_STALE_MS)).not.toBeNull();
    expect(selfReportFor(fresh, T0 + SELF_REPORT_STALE_MS + 1)).toBeNull();
    const s = state([fresh]);
    expect(selectProgress(s, MAIN, T0 + SELF_REPORT_STALE_MS + 1)).toMatchObject({ basis: 'none', fraction: null });
  });

  it.each(['waiting_approval', 'paused'] as const)('a %s agent is still in its turn: the cut-off applies', (status) => {
    const n = node({ key: MAIN, kind: 'main', role: 'main', status, selfReport: report(0.4, null) });
    expect(selfReportFor(n, T0 + SELF_REPORT_STALE_MS + 1)).toBeNull();
  });

  it.each(['idle', 'done', 'stopped'] as const)('a %s agent keeps its last report however old', (status) => {
    const n = node({ key: MAIN, kind: 'main', role: 'main', status, selfReport: report(0.4, null) });
    expect(selfReportFor(n, T0 + 10 * SELF_REPORT_STALE_MS)).toEqual({
      fraction: 0.4,
      etaMinutes: null,
      reportedAt: T0,
    });
  });

  it('no report (absent or null): none', () => {
    expect(selfReportFor(node({ key: MAIN }), T0)).toBeNull();
    expect(selfReportFor(node({ key: MAIN, selfReport: null }), T0)).toBeNull();
  });
});

describe('selectProgress with scorecard priors (M5 WP7)', () => {
  const HAIKU = 'claude-haiku-5-5';
  const priors = (entries: [string, string | null, number][]): EtaPriors => ({
    byRoleModel: Object.fromEntries(entries.map(([role, model, ms]) => [priorKey(role, model), ms])),
    asOf: 0,
  });
  // Two subagents running, none finished: no basis without a prior.
  const running = state([
    node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A, B] }),
    node({ key: A, parentKey: MAIN, model: HAIKU }),
    node({ key: B, parentKey: MAIN, model: HAIKU }),
  ]);

  it('without priors (absent, null, or no pair) the ETA is what it was', () => {
    const base = selectProgress(running, MAIN, T0 + MIN);
    expect(base?.etaMs).toBeNull();
    expect(selectProgress(running, MAIN, T0 + MIN, { priors: null })).toEqual(base);
    expect(selectProgress(running, MAIN, T0 + MIN, { priors: priors([['Explore', 'claude-opus-5-5', MIN]]) })).toEqual(
      base,
    );
    expect(selectProgress(running, MAIN, T0 + MIN, { priors: priors([['Plan', HAIKU, MIN]]) })).toEqual(base);
  });

  it("uses the subagents' (role, model) prior for the subagent basis", () => {
    const p = selectProgress(running, MAIN, T0 + MIN, { priors: priors([['Explore', HAIKU, 4 * MIN]]) });
    expect(USE_ETA_PRIORS).toBe(true);
    expect(p?.basis).toBe('subagents');
    // The same as passing the prior by hand.
    expect(p).toEqual(selectProgress(running, MAIN, T0 + MIN, { priorUnitMs: 4 * MIN }));
    expect(p?.etaMs).not.toBeNull();
  });

  it('averages over the subagents that have a prior', () => {
    const mixed = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A, B, C] }),
      node({ key: A, parentKey: MAIN, model: HAIKU }),
      node({ key: B, parentKey: MAIN, role: 'Plan', model: HAIKU }),
      node({ key: C, parentKey: MAIN, role: 'unknown-role', model: HAIKU }),
    ]);
    const p = selectProgress(mixed, MAIN, T0 + MIN, {
      priors: priors([
        ['Explore', HAIKU, 2 * MIN],
        ['Plan', HAIKU, 4 * MIN],
      ]),
    });
    expect(p).toEqual(selectProgress(mixed, MAIN, T0 + MIN, { priorUnitMs: 3 * MIN }));
  });

  it("uses the agent's own (role, model) prior for the task basis", () => {
    const tasks: TaskItem[] = [
      { id: '1', subject: 'one', status: 'pending', createdAt: T0 },
      { id: '2', subject: 'two', status: 'pending', createdAt: T0 },
    ];
    const s = state([node({ key: MAIN, kind: 'main', role: 'main', model: HAIKU, tasks })]);
    const own = priors([['main', HAIKU, 5 * MIN]]);
    expect(selectProgress(s, MAIN, T0 + MIN)?.etaMs).toBeNull();
    expect(selectProgress(s, MAIN, T0 + MIN, { priors: own })).toEqual(
      selectProgress(s, MAIN, T0 + MIN, { priorUnitMs: 5 * MIN }),
    );
  });

  it('an explicit priorUnitMs wins, and usePriors false ignores the priors', () => {
    const some = priors([['Explore', HAIKU, 4 * MIN]]);
    expect(selectProgress(running, MAIN, T0 + MIN, { priors: some, priorUnitMs: MIN })).toEqual(
      selectProgress(running, MAIN, T0 + MIN, { priorUnitMs: MIN }),
    );
    expect(selectProgress(running, MAIN, T0 + MIN, { priors: some, usePriors: false })).toEqual(
      selectProgress(running, MAIN, T0 + MIN),
    );
  });

  it('priorMsFor reads only finite positive own values', () => {
    const odd = { byRoleModel: { [priorKey('a', null)]: -1, [priorKey('b', null)]: Number.NaN }, asOf: 0 };
    expect(priorMsFor(odd, 'a', null)).toBeNull();
    expect(priorMsFor(odd, 'b', null)).toBeNull();
    expect(priorMsFor(odd, 'toString', null)).toBeNull();
    expect(priorMsFor(undefined, 'a', null)).toBeNull();
    expect(priorMsFor(priors([['a', null, 7]]), 'a', null)).toBe(7);
  });
});

describe('selectUsageRollup', () => {
  it('returns null for an unknown key', () => {
    expect(selectUsageRollup(state([]), MAIN)).toBeNull();
  });

  it('sums own usage and every descendant across nesting levels', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A, C], usage: usage(100, 10, 1, 0.1) }),
      node({ key: A, parentKey: MAIN, childKeys: [B], usage: usage(200, 20, 2, 0.2) }),
      node({ key: B, parentKey: A, usage: usage(300, 30, 3, 0.3) }),
      node({ key: C, parentKey: MAIN, usage: usage(400, 40, 4, 0.4) }),
    ]);
    const all = selectUsageRollup(s, MAIN);
    expect(all).toMatchObject({ partial: false, agentCount: 4, helperUsage: null });
    expect(all?.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, requests: 10 });
    expect(all?.usage?.estimatedCostUsd).toBeCloseTo(1.0);

    const sub = selectUsageRollup(s, A);
    expect(sub).toMatchObject({ agentCount: 2, partial: false });
    expect(sub?.usage).toMatchObject({ inputTokens: 500, requests: 5 });
  });

  it('keeps unknown as unknown: no records anywhere gives null, not zeros', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A] }),
      node({ key: A, parentKey: MAIN }),
    ]);
    expect(selectUsageRollup(s, MAIN)).toMatchObject({ usage: null, partial: true, agentCount: 2 });
  });

  it('flags a partial total when some agents have no records', () => {
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A], usage: usage(100, 10, 1, 0.1) }),
      node({ key: A, parentKey: MAIN }),
    ]);
    const r = selectUsageRollup(s, MAIN);
    expect(r?.partial).toBe(true);
    expect(r?.usage).toMatchObject({ inputTokens: 100, requests: 1 });
  });

  it('adds the root helper usage to the total and returns it separately', () => {
    const root = {
      ...node({ key: MAIN, kind: 'main', role: 'main', usage: usage(100, 10, 1, 0.1) }),
      helperUsage: usage(5, 1, 1, 0.01),
    };
    const r = selectUsageRollup(state([root]), MAIN);
    expect(r?.helperUsage).toMatchObject({ inputTokens: 5, requests: 1 });
    expect(r?.usage).toMatchObject({ inputTokens: 105, outputTokens: 11, requests: 2 });
  });

  it('sums optional counters present on the usage records', () => {
    const withExtra = { ...usage(100, 10, 2, 0.1), requestsWithoutId: 1 };
    const s = state([
      node({ key: MAIN, kind: 'main', role: 'main', childKeys: [A], usage: withExtra }),
      node({ key: A, parentKey: MAIN, usage: { ...usage(1, 1, 1, 0), requestsWithoutId: 2 } }),
    ]);
    expect(selectUsageRollup(s, MAIN)?.usage).toMatchObject({ requestsWithoutId: 3 });
  });
});

describe('selectContextWarning', () => {
  const ctx = (usedPct: number | null): Pick<AgentNode, 'context'> => ({
    context: { ...node({ key: MAIN }).context, usedPct },
  });

  it('is unknown when context use is not measured', () => {
    expect(selectContextWarning(ctx(null))).toBe('unknown');
  });

  it('is high at or above the default 80% threshold', () => {
    expect(selectContextWarning(ctx(80))).toBe('high');
    expect(selectContextWarning(ctx(79.9))).toBe('none');
  });

  it('takes a custom threshold', () => {
    expect(selectContextWarning(ctx(60), 50)).toBe('high');
    expect(selectContextWarning(ctx(40), 50)).toBe('none');
  });
});

describe('selectCurrentTask (F4)', () => {
  function task(id: string, extra: Partial<TaskItem> = {}): TaskItem {
    return { id, subject: `Task ${id}`, status: 'pending', createdAt: T0, ...extra };
  }
  const withTasks = (tasks: TaskItem[]) => node({ key: MAIN, kind: 'main', tasks });

  it('is null without tasks, or when no pending task was started', () => {
    expect(selectCurrentTask(withTasks([]))).toBeNull();
    expect(selectCurrentTask(withTasks([task('1'), task('2')]))).toBeNull();
  });

  it('is the started pending task', () => {
    expect(selectCurrentTask(withTasks([task('1'), task('2', { startedAt: T0 + 5 })]))?.id).toBe('2');
  });

  it('skips completed tasks even when they had started', () => {
    const done = task('1', { status: 'completed', startedAt: T0 + 9, completedAt: T0 + 10 });
    expect(selectCurrentTask(withTasks([done]))).toBeNull();
    expect(selectCurrentTask(withTasks([done, task('2', { startedAt: T0 + 1 })]))?.id).toBe('2');
  });

  it('picks the latest start when several are in progress, the later task on a tie', () => {
    const tasks = [
      task('1', { startedAt: T0 + 30 }),
      task('2', { startedAt: T0 + 10 }),
      task('3', { startedAt: T0 + 20 }),
    ];
    expect(selectCurrentTask(withTasks(tasks))?.id).toBe('1');
    expect(selectCurrentTask(withTasks([task('1', { startedAt: T0 }), task('2', { startedAt: T0 })]))?.id).toBe('2');
  });
});

describe('selectProgress with agent-team teammates (M6 P5b, ADR-027)', () => {
  // The lead is idle (it waits while its teammates work); each teammate is one unit of the lead's work.
  const lead = (childKeys: string[]) => node({ key: MAIN, kind: 'main', role: 'main', status: 'idle', childKeys });

  it('an idle teammate (not reported) counts as open: idle is not done', () => {
    const s = state([
      lead([A, B]),
      node({ key: A, parentKey: MAIN, kind: 'teammate', role: 'alpha', status: 'idle', endedAt: null }),
      node({ key: B, parentKey: MAIN, kind: 'teammate', role: 'beta', status: 'idle', endedAt: null }),
    ]);
    expect(selectProgress(s, MAIN, T0 + 4 * MIN)).toMatchObject({
      basis: 'subagents',
      finishedSubagents: 0,
      startedSubagents: 2,
      fraction: 0,
    });
  });

  it('a teammate the lead reported finished (done, endedAt set) counts as finished; waiting stays open', () => {
    const s = state([
      lead([A, B]),
      node({ key: A, parentKey: MAIN, kind: 'teammate', role: 'alpha', status: 'done', endedAt: T0 + 2 * MIN }),
      node({ key: B, parentKey: MAIN, kind: 'teammate', role: 'beta', status: 'idle', endedAt: null }),
    ]);
    expect(selectProgress(s, MAIN, T0 + 4 * MIN)).toMatchObject({
      basis: 'subagents',
      finishedSubagents: 1,
      startedSubagents: 2,
      fraction: 0.5,
    });
  });
});
