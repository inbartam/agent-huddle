/**
 * CANNED DEV DATA for M4 (WP7a): what `HUDDLE_DEV_CANNED=1` adds so the launch, template, rule, budget, run and
 * worktree surfaces render before the real StreamDriver, policy engine and worktree code exist. Pure data built from
 * `@huddle/shared` only; canned-core.ts merges it into its state and events. Nothing here came from a real session.
 *
 *  - Run 1 (live, managed): a run from the three-agent "Parser team" template in its own worktree, two subagents
 *    working, the last turn's result, a diff summary. Session budget at about 50% of its tokens; an agent budget on
 *    the coder past its 80% warning line (with the budget inbox item); an overall cost budget.
 *  - Run 2 (ended, managed): an inline launch that finished; its worktree waits for keep or discard (Discard is on).
 *  - Rules: three defaults (`default:` ids) and two of the user's (one allow, one deny); templates: "Parser team"
 *    (three agents) and "Docs pass" (none); four decisions made by rules, as approval.requested + approval.resolved.
 */
import {
  EMPTY_USAGE,
  agentKey,
  type AgentCapabilities,
  type AgentKey,
  type AgentNode,
  type AttentionItem,
  type BudgetEntry,
  type HuddleEvent,
  type PolicyRule,
  type TeamTemplate,
} from '@huddle/shared';

const RUN_SESSION = 'canned-run-0001';
const RUN_ID = 'run-canned-0001';
const DONE_SESSION = 'canned-run-0002';
const DONE_RUN_ID = 'run-canned-0002';

export const M4_KEYS = {
  run: agentKey(RUN_SESSION),
  planner: agentKey(RUN_SESSION, 'r-plan-1'),
  coder: agentKey(RUN_SESSION, 'r-code-1'),
  done: agentKey(DONE_SESSION),
} as const;

/** A session the Huddle launched: approvals through the same hook, messages live, stop and model switch work. */
const MANAGED: AgentCapabilities = {
  approve: true,
  answerQuestions: false,
  message: 'live',
  pause: true,
  stop: true,
  setModel: true,
  followUp: false,
};
const MANAGED_SUB: AgentCapabilities = { ...MANAGED, message: 'queued', stop: false, setModel: false };

const RUN_CWD = 'C:\\Users\\dev\\AppData\\Local\\agent-huddle\\worktrees\\run-canned-0001';
const DONE_CWD = 'C:\\Users\\dev\\AppData\\Local\\agent-huddle\\worktrees\\run-canned-0002';

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, requests: number, usd: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    requests,
    estimatedCostUsd: usd,
  };
}

function node(t0: number, partial: Partial<AgentNode> & Pick<AgentNode, 'key' | 'name' | 'role' | 'kind'>): AgentNode {
  return {
    sessionId: RUN_SESSION,
    agentId: null,
    parentKey: null,
    childKeys: [],
    origin: 'managed',
    roleDescription: null,
    model: null,
    cwd: RUN_CWD,
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
    usage: EMPTY_USAGE,
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
    capabilities: MANAGED_SUB,
    toolCalls: 0,
    toolFailures: 0,
    startedAt: t0,
    endedAt: null,
    lastEventAt: t0,
    ...partial,
  };
}

export function cannedRules(): PolicyRule[] {
  return [
    {
      id: 'default:git-read',
      name: 'Read-only git',
      enabled: true,
      action: 'allow',
      match: { tool: 'Bash', commandPrefix: 'git status' },
      note: 'git status, diff and log without --output.',
    },
    {
      id: 'default:list-files',
      name: 'List files',
      enabled: true,
      action: 'allow',
      match: { tool: 'Bash', commandPrefix: 'ls' },
    },
    {
      id: 'default:versions',
      name: 'Version checks',
      enabled: false,
      action: 'allow',
      match: { tool: 'Bash', commandPrefix: 'node --version', commandExact: true },
    },
    {
      id: 'user-tests-example',
      name: 'Run the parser tests',
      enabled: true,
      action: 'allow',
      match: { tool: 'Bash', commandPrefix: 'npm test -- parser', folder: 'C:\\projects\\example' },
      note: 'Read-only: the tests do not write outside the coverage folder.',
    },
    {
      id: 'user-no-force-push',
      name: 'Never force-push',
      enabled: true,
      action: 'deny',
      match: { tool: 'Bash', commandPrefix: 'git push --force' },
    },
  ];
}

export function cannedTemplates(): TeamTemplate[] {
  return [
    {
      id: 'tpl-parser-team',
      name: 'Parser team',
      description: 'Plan, implement and test a parser change in its own worktree.',
      prompt:
        'Refactor the tokenizer into a pure function, then port the parser to it. Plan first, then code, then test.',
      cwd: 'C:\\projects\\example',
      mainAgent: null,
      model: 'sonnet',
      permissionMode: 'default',
      agents: {
        planner: {
          description: 'Breaks the change into steps before any code is written.',
          prompt: 'You plan. Read the code, list the steps and the files each touches. Do not edit files.',
          tools: ['Read', 'Grep', 'Glob'],
          model: 'opus',
        },
        coder: {
          description: 'Implements one planned step at a time.',
          prompt: 'You implement the step you are given, with tests, and nothing else.',
        },
        tester: {
          description: 'Runs the tests and reports failures with the smallest repro.',
          prompt: 'Run the test suite. Report each failure with file, test name and the shortest way to see it.',
          tools: ['Bash', 'Read'],
          model: 'haiku',
        },
      },
      budgets: [{ scope: 'session', maxTokens: 200_000, warnAtFraction: 0.8, onExceed: 'pause' }],
      worktree: true,
    },
    {
      id: 'tpl-docs-pass',
      name: 'Docs pass',
      prompt: 'Read docs/ and fix broken links and outdated commands. Keep the wording.',
      cwd: 'C:\\projects\\example',
      mainAgent: null,
      model: null,
      permissionMode: 'acceptEdits',
      worktree: false,
    },
  ];
}

export interface CannedM4 {
  agents: Record<AgentKey, AgentNode>;
  /** Roots to add, most recently active first. */
  rootKeys: AgentKey[];
  inbox: AttentionItem[];
  budgets: BudgetEntry[];
  policy: PolicyRule[];
  templates: TeamTemplate[];
  events: HuddleEvent[];
}

/** Everything M4 adds, anchored at canned-core's T0 so times look like a run in progress. */
export function cannedM4(t0: number): CannedM4 {
  const { run, planner, coder, done } = M4_KEYS;
  const agents: Record<AgentKey, AgentNode> = {
    [run]: node(t0, {
      key: run,
      kind: 'main',
      // F2: a managed run without a session title: titled by its repository ("example"), tagged worktree.
      name: 'main',
      role: 'main',
      model: 'claude-sonnet-5',
      sessionCwd: RUN_CWD,
      lastPrompt: 'Make the tokenizer stream tokens; plan first, then implement and test',
      capabilities: MANAGED,
      childKeys: [planner, coder],
      currentActivity: 'Waiting for subagents',
      toolCalls: 9,
      startedAt: t0 - 480_000,
      lastEventAt: t0 + 94_000,
      usage: usage(21_000, 7_400, 260_000, 30_000, 14, 0.92),
      run: {
        runId: RUN_ID,
        templateId: 'tpl-parser-team',
        permissionMode: 'default',
        mainAgent: null,
        agentNames: ['planner', 'coder', 'tester'],
        worktree: {
          path: RUN_CWD,
          branch: `huddle/${RUN_ID}`,
          state: 'active',
          baseCommit: '7f3a9c2e1b4d5a6f7e8d9c0b1a2f3e4d5c6b7a89',
          repoRoot: 'C:\\projects\\example',
          summary: {
            filesChanged: 4,
            insertions: 182,
            deletions: 37,
            untracked: 1,
            files: [
              { path: 'src/tokenizer.ts', status: 'modified' },
              { path: 'src/parser.ts', status: 'modified' },
              { path: 'test/tokenizer.test.ts', status: 'added' },
              { path: 'docs/notes <b>draft</b>.md', status: 'untracked' },
            ],
            summarizedAt: t0 + 90_000,
          },
          closeError: null,
        },
        exited: null,
        result: {
          at: t0 - 200_000,
          isError: false,
          durationMs: 252_000,
          numTurns: 6,
          totalCostUsd: 0.61,
          permissionDenials: 1,
        },
      },
    }),
    [planner]: node(t0, {
      key: planner,
      agentId: 'r-plan-1',
      parentKey: run,
      kind: 'subagent',
      name: 'Plan the tokenizer change',
      role: 'planner',
      roleDescription: 'Breaks the change into steps before any code is written.',
      model: 'claude-opus-5-5',
      status: 'done',
      toolCalls: 7,
      startedAt: t0 - 460_000,
      endedAt: t0 - 260_000,
      lastEventAt: t0 - 260_000,
      usage: usage(12_000, 3_100, 88_000, 9_000, 6, 0.44),
      handoff: {
        toolUseId: 'toolu_canned_run_1',
        title: 'Plan the tokenizer change',
        brief: null,
        result: null,
        link: 'exact',
      },
    }),
    [coder]: node(t0, {
      key: coder,
      agentId: 'r-code-1',
      parentKey: run,
      kind: 'subagent',
      name: 'Implement the tokenizer',
      role: 'coder',
      roleDescription: 'Implements one planned step at a time.',
      model: 'claude-sonnet-5',
      currentActivity: 'Edit src/tokenizer.ts',
      toolCalls: 15,
      startedAt: t0 - 250_000,
      lastEventAt: t0 + 92_000,
      // 64k + 14k + 8k = 86k budget tokens of a 100k agent budget: past the 80% warning line.
      usage: usage(64_000, 14_000, 310_000, 8_000, 18, 1.12),
      handoff: {
        toolUseId: 'toolu_canned_run_2',
        title: 'Implement the tokenizer',
        brief: null,
        result: null,
        link: 'exact',
      },
    }),
    [done]: node(t0, {
      key: done,
      sessionId: DONE_SESSION,
      kind: 'main',
      name: 'Fix the broken links in the docs',
      role: 'main',
      model: 'claude-haiku-5',
      cwd: DONE_CWD,
      capabilities: MANAGED,
      status: 'done',
      toolCalls: 12,
      startedAt: t0 - 1_500_000,
      endedAt: t0 - 1_100_000,
      lastEventAt: t0 - 1_100_000,
      usage: usage(9_000, 2_200, 40_000, 3_000, 8, 0.09),
      run: {
        runId: DONE_RUN_ID,
        templateId: null,
        permissionMode: 'acceptEdits',
        mainAgent: null,
        agentNames: [],
        worktree: {
          path: DONE_CWD,
          branch: `huddle/${DONE_RUN_ID}`,
          state: 'active',
          baseCommit: '1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e',
          repoRoot: 'C:\\projects\\example',
          summary: {
            filesChanged: 2,
            insertions: 6,
            deletions: 6,
            untracked: 0,
            files: [
              { path: 'docs/SPEC.md', status: 'modified' },
              { path: 'README.md', status: 'modified' },
            ],
            summarizedAt: t0 - 1_100_000,
          },
          closeError: null,
        },
        exited: { at: t0 - 1_100_000, exitCode: 0, how: 'completed', error: null },
        result: {
          at: t0 - 1_100_000,
          isError: false,
          durationMs: 398_000,
          numTurns: 3,
          totalCostUsd: 0.09,
          permissionDenials: 0,
        },
      },
    }),
  };

  const budgets: BudgetEntry[] = [
    {
      // Session roll-up: (21k+7.4k+30k) + (12k+3.1k+9k) + (64k+14k+8k) = 168.5k of 300k tokens: about 56%.
      scope: 'session',
      targetKey: run,
      budget: { scope: 'session', maxTokens: 300_000, maxMinutes: 30, warnAtFraction: 0.8, onExceed: 'pause' },
      setAt: t0 - 480_000,
    },
    {
      scope: 'agent',
      targetKey: coder,
      budget: { scope: 'agent', maxTokens: 100_000, warnAtFraction: 0.8, onExceed: 'pause' },
      setAt: t0 - 250_000,
    },
    {
      scope: 'overall',
      targetKey: null,
      budget: { scope: 'all', maxEstimatedCostUsd: 10, warnAtFraction: 0.8, onExceed: 'notify' },
      setAt: t0 - 3_600_000,
    },
  ];

  const inbox: AttentionItem[] = [
    {
      id: `budget:agent:${coder}`,
      kind: 'budget',
      severity: 'warning',
      agentKey: coder,
      title: 'Implement the tokenizer is near its budget',
      detail: '86k of 100k tokens, est. It pauses at the cap.',
      createdAt: t0 + 88_000,
      resolvedAt: null,
    },
  ];

  const base = (key: AgentKey, n: number, sessionId: string) => ({
    id: `canned-m4-${String(n).padStart(4, '0')}`,
    ts: t0 + n * 1000,
    sessionId,
    agentKey: key,
  });
  const decided = (
    n: number,
    key: AgentKey,
    requestId: string,
    command: string,
    ruleId: string,
    outcome: 'allowed' | 'denied',
  ): HuddleEvent[] => [
    {
      ...base(key, n, RUN_SESSION),
      source: 'hook',
      type: 'approval.requested',
      request: {
        requestId,
        agentKey: key,
        toolName: 'Bash',
        toolInput: { command },
        summary: command,
        receivedAt: t0 + n * 1000,
        expiresAt: null,
        channel: 'hook',
      },
    },
    {
      ...base(key, n, RUN_SESSION),
      id: `canned-m4-${String(n).padStart(4, '0')}-r`,
      ts: t0 + n * 1000 + 3,
      source: 'huddle',
      type: 'approval.resolved',
      requestId,
      outcome,
      by: 'policy',
      policyRuleId: ruleId,
      message: outcome === 'denied' ? 'Denied by the rule "Never force-push".' : null,
    },
  ];
  const events: HuddleEvent[] = [
    ...decided(-300, run, 'canned-pol-1', 'git status', 'default:git-read', 'allowed'),
    ...decided(-200, coder, 'canned-pol-2', 'ls src', 'default:list-files', 'allowed'),
    ...decided(
      -60,
      coder,
      'canned-pol-3',
      'npm test -- parser <img src=x onerror=alert(1)>',
      'user-tests-example',
      'allowed',
    ),
    ...decided(40, coder, 'canned-pol-4', 'git push --force origin main', 'user-no-force-push', 'denied'),
  ];

  return {
    agents,
    rootKeys: [run, done],
    inbox,
    budgets,
    policy: cannedRules(),
    templates: cannedTemplates(),
    events,
  };
}
