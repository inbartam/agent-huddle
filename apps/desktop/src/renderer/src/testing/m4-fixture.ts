/**
 * M4 renderer fixtures (WP7a): a managed run root with a worktree and a diff summary, two subagents, budgets, rules
 * (defaults and the user's), a three-agent template, and policy decisions as events. Shaped like what core's reducer
 * produces for `run.*`, `worktree.*` and `budget.set` (reduce-runs.test.ts), built with the shared model only.
 * Hostile text (XSS) sits in a file path, a template name, a rule name and a request summary.
 */
import {
  agentKey,
  EMPTY_USAGE,
  type AgentCapabilities,
  type AgentNode,
  type AgentRun,
  type BudgetEntry,
  type HuddleEvent,
  type HuddleState,
  type PolicyRule,
  type TeamTemplate,
} from '@huddle/shared';
import { agent, T0, XSS } from './fixture.js';
import { CONNECTED } from './interact-fixture.js';

export const NOW_M4 = T0 + 10 * 60_000;
export const RUN_SESSION = 'run-session';

export const MK = {
  run: agentKey(RUN_SESSION),
  planner: agentKey(RUN_SESSION, 'plan-1'),
  coder: agentKey(RUN_SESSION, 'code-1'),
};

export const MANAGED: AgentCapabilities = {
  approve: true,
  answerQuestions: false,
  message: 'live',
  pause: true,
  stop: true,
  setModel: true,
  followUp: false,
};

export function runOf(partial: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    templateId: 'tpl-team',
    permissionMode: 'default',
    mainAgent: null,
    agentNames: ['planner', 'coder', 'tester'],
    worktree: {
      path: 'C:\\wt\\run-1',
      branch: 'huddle/run-1',
      state: 'active',
      baseCommit: '7f3a9c2e1b4d5a6f7e8d',
      repoRoot: 'C:\\projects\\fixture',
      summary: {
        filesChanged: 3,
        insertions: 120,
        deletions: 14,
        untracked: 1,
        files: [
          { path: 'src/tokenizer.ts', status: 'modified' },
          { path: 'test/tokenizer.test.ts', status: 'added' },
          { path: `notes ${XSS}.md`, status: 'untracked' },
        ],
        summarizedAt: T0 + 60_000,
      },
      closeError: null,
    },
    exited: null,
    result: {
      at: T0 + 50_000,
      isError: false,
      durationMs: 252_000,
      numTurns: 6,
      totalCostUsd: 0.61,
      permissionDenials: 1,
    },
    ...partial,
  };
}

const usage = (input: number, output: number, cacheWrite: number) => ({
  ...EMPTY_USAGE,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 999_999,
  cacheCreationTokens: cacheWrite,
  requests: 5,
  estimatedCostUsd: 0.5,
});

export const RULES: PolicyRule[] = [
  {
    id: 'default:git-read',
    name: 'Read-only git',
    enabled: true,
    action: 'allow',
    match: { tool: 'Bash', commandPrefix: 'git status' },
  },
  {
    id: 'user-no-force',
    name: `Never force-push ${XSS}`,
    enabled: true,
    action: 'deny',
    match: { commandPrefix: 'git push --force' },
  },
  { id: 'user-off', name: 'Old rule', enabled: false, action: 'ask', match: {} },
];

export const TEAM: TeamTemplate = {
  id: 'tpl-team',
  name: `Parser team ${XSS}`,
  description: 'Plan, code, test',
  prompt: 'Refactor the tokenizer.',
  cwd: 'C:\\projects\\fixture',
  mainAgent: null,
  model: 'sonnet',
  permissionMode: 'default',
  agents: {
    planner: { description: 'Plans the change', prompt: 'Plan only.', tools: ['Read', 'Grep'], model: 'opus' },
    coder: { description: 'Implements a step', prompt: 'Implement one step.' },
    tester: { description: 'Runs the tests', prompt: 'Run the tests.', tools: ['Bash'], model: 'haiku' },
  },
  budgets: [{ scope: 'session', maxTokens: 200_000, warnAtFraction: 0.8, onExceed: 'pause' }],
  worktree: true,
};

export interface M4Options {
  run?: Partial<AgentRun> | null;
  root?: Partial<AgentNode>;
  coder?: Partial<AgentNode>;
  budgets?: BudgetEntry[];
}

export function m4State(opts: M4Options = {}): HuddleState {
  const nodes: AgentNode[] = [
    agent({
      key: MK.run,
      sessionId: RUN_SESSION,
      name: 'Parser run',
      kind: 'main',
      role: 'main',
      origin: 'managed',
      capabilities: MANAGED,
      childKeys: [MK.planner, MK.coder],
      lastEventAt: T0 + 60_000,
      usage: usage(20_000, 5_000, 25_000),
      run: opts.run === null ? null : runOf(opts.run ?? {}),
      ...opts.root,
    }),
    agent({
      key: MK.planner,
      sessionId: RUN_SESSION,
      agentId: 'plan-1',
      parentKey: MK.run,
      name: 'Plan',
      role: 'planner',
      origin: 'managed',
      status: 'done',
      endedAt: T0 + 30_000,
      usage: usage(10_000, 2_000, 8_000),
    }),
    agent({
      key: MK.coder,
      sessionId: RUN_SESSION,
      agentId: 'code-1',
      parentKey: MK.run,
      name: 'Code',
      role: 'coder',
      origin: 'managed',
      usage: usage(64_000, 14_000, 8_000),
      ...opts.coder,
    }),
  ];
  return {
    agents: Object.fromEntries(nodes.map((n) => [n.key, n])),
    rootKeys: [MK.run],
    inbox: [],
    rateLimits: null,
    connection: CONNECTED,
    budgets: opts.budgets ?? [
      {
        scope: 'session',
        targetKey: MK.run,
        budget: { scope: 'session', maxTokens: 300_000, warnAtFraction: 0.8, onExceed: 'pause' },
        setAt: T0,
      },
      {
        scope: 'agent',
        targetKey: MK.coder,
        budget: { scope: 'agent', maxTokens: 100_000, warnAtFraction: 0.8, onExceed: 'pause' },
        setAt: T0,
      },
    ],
    policy: RULES,
    templates: [TEAM],
  };
}

/** Policy decisions as the broker writes them: approval.requested, then approval.resolved by 'policy'. */
export function decisionEvents(): HuddleEvent[] {
  const ev = (
    n: number,
    requestId: string,
    summary: string,
    ruleId: string,
    outcome: 'allowed' | 'denied',
  ): HuddleEvent[] => [
    {
      id: `d${String(n)}`,
      ts: T0 + n * 1000,
      sessionId: RUN_SESSION,
      agentKey: MK.coder,
      source: 'hook',
      type: 'approval.requested',
      request: {
        requestId,
        agentKey: MK.coder,
        toolName: 'Bash',
        toolInput: {},
        summary,
        receivedAt: T0 + n * 1000,
        expiresAt: null,
        channel: 'hook',
      },
    },
    {
      id: `d${String(n)}r`,
      ts: T0 + n * 1000 + 2,
      sessionId: RUN_SESSION,
      agentKey: MK.coder,
      source: 'huddle',
      type: 'approval.resolved',
      requestId,
      outcome,
      by: 'policy',
      policyRuleId: ruleId,
      message: null,
    },
  ];
  return [
    ...ev(1, 'p1', 'git status', 'default:git-read', 'allowed'),
    ...ev(2, 'p2', `git push --force ${XSS}`, 'user-no-force', 'denied'),
    ...ev(3, 'p3', 'git status --short', 'default:git-read', 'allowed'),
  ];
}
