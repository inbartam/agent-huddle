import { describe, expect, it } from 'vitest';
import type { HuddleEvent } from './events.js';
import {
  budgetKeyOf,
  budgetOverItemId,
  DISMISS_REASONS,
  isDefaultRule,
  selectBudgetPaused,
  selectDismissControl,
  selectSessionBudgetPaused,
  RUN_REASONS,
  budgetTokens,
  selectBudgets,
  selectBudgetUsed,
  selectLaunchControl,
  selectPolicyDecisions,
  selectRunControls,
} from './manage.js';
import {
  EMPTY_USAGE,
  agentKey,
  type AgentNode,
  type AgentRun,
  type BudgetEntry,
  type HuddleState,
  type TokenUsage,
} from './model.js';
import { CONTROL_REASONS } from './selectors.js';

const T0 = 1_000_000;
const MIN = 60_000;
const S = 's1';
const MAIN = agentKey(S);
const SUB = agentKey(S, 'a');

const CAPS = {
  approve: true,
  answerQuestions: false,
  message: 'live',
  pause: true,
  stop: true,
  setModel: true,
} as const;

function node(partial: Partial<AgentNode> & Pick<AgentNode, 'key'>): AgentNode {
  return {
    sessionId: S,
    agentId: null,
    parentKey: null,
    childKeys: [],
    kind: 'main',
    origin: 'managed',
    name: partial.key,
    role: 'main',
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
    capabilities: { ...CAPS },
    toolCalls: 0,
    toolFailures: 0,
    startedAt: T0,
    endedAt: null,
    lastEventAt: T0,
    ...partial,
  };
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): TokenUsage {
  return {
    ...EMPTY_USAGE,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    requests: 3,
    estimatedCostUsd: cost,
  };
}

function run(partial: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    templateId: null,
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: { path: 'C:\\wt\\run-1', branch: 'huddle/run-1', state: 'active' },
    exited: null,
    result: null,
    ...partial,
  };
}

function state(nodes: AgentNode[], budgets: BudgetEntry[] = []): HuddleState {
  return {
    agents: Object.fromEntries(nodes.map((n) => [n.key, n])),
    rootKeys: nodes.filter((n) => n.kind === 'main').map((n) => n.key),
    inbox: [],
    rateLimits: null,
    budgets,
  };
}

describe('selectRunControls', () => {
  it('turns Stop and End off for an agent the Huddle did not launch', () => {
    const c = selectRunControls(node({ key: MAIN, run: null }));
    expect(c.stop).toEqual({ enabled: false, reason: RUN_REASONS.notManaged });
    expect(c.end.enabled).toBe(false);
    expect(c.discard.reason).toBe(RUN_REASONS.noWorktree);
  });

  it('follows the stop capability while the run is alive', () => {
    const c = selectRunControls(node({ key: MAIN, run: run(), capabilities: { ...CAPS, stop: false } }));
    expect(c.stop.reason).toBe(RUN_REASONS.noStop);
    expect(selectRunControls(node({ key: MAIN, run: run() })).stop.enabled).toBe(true);
  });

  it('refuses Discard while the process is alive, allows it after exit', () => {
    expect(selectRunControls(node({ key: MAIN, run: run() })).discard.reason).toBe(RUN_REASONS.alive);
    const exited = run({ exited: { at: T0, exitCode: 0, how: 'completed', error: null } });
    const c = selectRunControls(node({ key: MAIN, run: exited }));
    expect(c.discard.enabled).toBe(true);
    expect(c.stop.reason).toBe(RUN_REASONS.exited);
  });

  it('turns Keep and Discard off once the worktree is decided', () => {
    const kept = run({ worktree: { path: 'p', branch: 'b', state: 'kept' } });
    expect(selectRunControls(node({ key: MAIN, run: kept })).keep.reason).toBe(RUN_REASONS.kept);
    const gone = run({ worktree: { path: 'p', branch: 'b', state: 'discarded' } });
    expect(selectRunControls(node({ key: MAIN, run: gone })).open.reason).toBe(RUN_REASONS.discarded);
  });
});

describe('budgets', () => {
  const tokens = (scope: BudgetEntry['scope'], targetKey: string | null, maxTokens: number): BudgetEntry => ({
    scope,
    targetKey,
    budget: { scope: scope === 'overall' ? 'all' : scope, maxTokens, warnAtFraction: 0.8, onExceed: 'pause' },
    setAt: T0,
  });

  it('counts input, output and cache creation, not cache reads', () => {
    expect(budgetTokens(usage(100, 50, 10_000, 25, 0))).toBe(175);
  });

  it('is unknown, never 0, before any request is recorded', () => {
    const s = state([node({ key: MAIN })], [tokens('session', MAIN, 1000)]);
    const [view] = selectBudgets(s, T0 + MIN, MAIN);
    expect(view?.limits[0]).toEqual({ kind: 'tokens', cap: 1000, used: null, fraction: null, level: 'unknown' });
    expect(view?.level).toBe('unknown');
  });

  it('rolls a session budget up over its agents and marks the warning and the cap', () => {
    const main = node({ key: MAIN, childKeys: [SUB], usage: usage(300, 100, 0, 0, 0.5) });
    const sub = node({ key: SUB, kind: 'subagent', parentKey: MAIN, usage: usage(400, 50, 0, 0, 0.25) });
    const s = state([main, sub], [tokens('session', MAIN, 1000), tokens('agent', SUB, 400)]);
    const views = selectBudgets(s, T0 + MIN, SUB);
    expect(views.map((v) => v.scope)).toEqual(['agent', 'session']);
    expect(views[0]?.limits[0]).toMatchObject({ used: 450, level: 'over' });
    expect(views[1]?.limits[0]).toMatchObject({ used: 850, level: 'warning' });
  });

  it('treats a cost no request carried as unknown', () => {
    const main = node({ key: MAIN, usage: { ...usage(1, 1, 0, 0, 0), requestsWithoutCost: 3 } });
    const entry: BudgetEntry = {
      scope: 'agent',
      targetKey: MAIN,
      budget: { scope: 'agent', maxEstimatedCostUsd: 1, maxMinutes: 10, warnAtFraction: 0.5, onExceed: 'notify' },
      setAt: T0,
    };
    const used = selectBudgetUsed(state([main], [entry]), entry, T0 + 6 * MIN);
    expect(used).toEqual({ tokens: 2, costUsd: null, minutes: 6 });
    expect(selectBudgets(state([main], [entry]), T0 + 6 * MIN, MAIN)[0]?.level).toBe('warning');
  });

  it('times an overall budget from when it was set, and lists budgets for an unknown agent as none', () => {
    const entry = { ...tokens('overall', null, 10), budget: { ...tokens('overall', null, 10).budget, maxMinutes: 30 } };
    const s = state([node({ key: MAIN })], [entry]);
    expect(selectBudgetUsed(s, entry, T0 + 3 * MIN)).toEqual({ tokens: null, costUsd: null, minutes: 3 });
    expect(selectBudgets(s, T0, 'nobody')).toEqual([]);
  });
});

describe('selectPolicyDecisions', () => {
  const base = (n: number, key = SUB) => ({ id: `e${String(n)}`, ts: T0 + n, sessionId: S, agentKey: key });
  const requested = (n: number, requestId: string, toolName: string, summary: string): HuddleEvent => ({
    ...base(n),
    source: 'hook',
    type: 'approval.requested',
    request: {
      requestId,
      agentKey: SUB,
      toolName,
      toolInput: {},
      summary,
      receivedAt: T0 + n,
      expiresAt: null,
      channel: 'hook',
    },
  });
  const resolved = (n: number, requestId: string, by: 'policy' | 'user', ruleId: string | null): HuddleEvent => ({
    ...base(n),
    source: 'huddle',
    type: 'approval.resolved',
    requestId,
    outcome: 'allowed',
    by,
    policyRuleId: ruleId,
    message: null,
  });

  it("joins policy decisions with their requests, newest first, and skips the user's own", () => {
    const events = [
      requested(1, 'r1', 'Bash', 'git status'),
      resolved(2, 'r1', 'policy', 'default:git-read'),
      requested(3, 'r2', 'Bash', 'npm test'),
      resolved(4, 'r2', 'user', null),
      resolved(6, 'r3', 'policy', 'gone-rule'),
    ];
    const rules = [
      { id: 'default:git-read', name: 'Read-only git', enabled: true, action: 'allow' as const, match: {} },
    ];
    const out = selectPolicyDecisions(events, rules);
    expect(out.map((d) => d.requestId)).toEqual(['r3', 'r1']);
    expect(out[1]).toMatchObject({ ruleName: 'Read-only git', toolName: 'Bash', summary: 'git status', agentKey: SUB });
    expect(out[0]).toMatchObject({ ruleName: null, toolName: null, summary: null });
  });

  it('marks default rules by id', () => {
    expect(isDefaultRule({ id: 'default:ls' })).toBe(true);
    expect(isDefaultRule({ id: 'my-rule' })).toBe(false);
  });
});

describe('selectLaunchControl', () => {
  it('needs an attached connection (ADR-020 §1)', () => {
    expect(selectLaunchControl({ status: 'attached', message: null })).toEqual({ enabled: true, reason: null });
    expect(selectLaunchControl(undefined).reason).toBe(CONTROL_REASONS.notConnected);
    expect(selectLaunchControl({ status: 'port_in_use', message: null }).reason).toBe(CONTROL_REASONS.portInUse);
    expect(selectLaunchControl({ status: 'error', message: 'x' }).reason).toBe(CONTROL_REASONS.connectionError);
  });
});

describe('agents a budget paused, and what may be dismissed (M4 runbook fixes)', () => {
  const OVER = budgetOverItemId(budgetKeyOf({ scope: 'session', targetKey: MAIN }));
  function state(nodes: AgentNode[]): HuddleState {
    return { agents: Object.fromEntries(nodes.map((n) => [n.key, n])), rootKeys: [MAIN], inbox: [], rateLimits: null };
  }
  const held = { toolUseId: 't', since: T0, limitAt: T0 + 10 * MIN };

  it('budget ids are the detector ids', () => {
    expect(OVER).toBe(`budget:session:${MAIN}:over`);
    expect(budgetKeyOf({ scope: 'overall', targetKey: null })).toBe('overall:*');
  });

  it('selectBudgetPaused: held or pending agents whose Huddle pause names the item; not ended, not resumed', () => {
    const s = state([
      node({ key: MAIN, pausePending: true, pausedBy: OVER }),
      node({ key: SUB, parentKey: MAIN, kind: 'subagent', status: 'paused', hold: held, pausedBy: OVER }),
      node({ key: agentKey(S, 'b'), parentKey: MAIN, pausedBy: OVER }), // resumed: neither held nor pending
      node({ key: agentKey(S, 'c'), parentKey: MAIN, status: 'done', endedAt: T0, pausedBy: OVER, hold: held }),
      node({ key: agentKey(S, 'd'), parentKey: MAIN, pausePending: true, pausedBy: null }), // the user's pause
    ]);
    expect(selectBudgetPaused(s, OVER).map((n) => n.key)).toEqual([MAIN, SUB].sort());
    expect(selectSessionBudgetPaused(s, S).map((n) => n.key)).toEqual([MAIN, SUB].sort());
    expect(selectSessionBudgetPaused(s, 'other')).toEqual([]);
  });

  it('selectDismissControl: never approvals or questions, a budget item only once nothing it paused is paused', () => {
    const item = (kind: 'budget' | 'approval' | 'question' | 'stuck' | 'error') => ({
      id: kind === 'budget' ? OVER : `${kind}:1`,
      kind,
      resolvedAt: null,
    });
    const paused = state([node({ key: MAIN, pausePending: true, pausedBy: OVER })]);
    const free = state([node({ key: MAIN })]);
    expect(selectDismissControl(free, item('approval'))).toEqual({ enabled: false, reason: DISMISS_REASONS.request });
    expect(selectDismissControl(free, item('question')).enabled).toBe(false);
    expect(selectDismissControl(paused, item('budget'))).toEqual({
      enabled: false,
      reason: DISMISS_REASONS.budgetPaused,
    });
    expect(selectDismissControl(free, item('budget')).enabled).toBe(true);
    expect(selectDismissControl(paused, item('stuck')).enabled).toBe(true);
    expect(selectDismissControl(free, item('error')).enabled).toBe(true);
    expect(selectDismissControl(free, { ...item('stuck'), resolvedAt: T0 })).toEqual({
      enabled: false,
      reason: DISMISS_REASONS.handled,
    });
  });
});
