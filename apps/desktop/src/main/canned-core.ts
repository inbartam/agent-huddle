/**
 * CANNED DEV DATA. A stand-in CoreHost that serves a hand-built HuddleState so the shell and renderer
 * can be built before the real core exists (M1 WP6 replaces this with the reducer-backed host).
 * Nothing here comes from a real Claude Code session. Commands are accepted and acknowledged but
 * change nothing.
 *
 * Four sessions:
 *  1. live: a main agent with three subagents, one of them with two nested Explore agents (one done,
 *     one still working on a best-guess link), and one subagent waiting for approval;
 *  2. idle: a finished turn whose subagents are done and failed (they sit under "Finished");
 *  3. ended: a session whose main agent is done (collapsed by default);
 *  4. interact (M3, for WP9): a main agent asking a multiSelect question with two queued messages (next_tool and
 *     turn_end), a subagent asking a single-select question, one paused with a hold countdown (`hold.limitAt`), and
 *     one that looks stuck and has a pause pending.
 *  5. tasks (Widget v2): a main agent working through a five-task list, three done, so its card reads "3/5 Drafting".
 *
 * The inbox (M3) holds one of each: approval (Bash), question (single-select), question (multiSelect), stuck, loop,
 * conflict. Item ids follow the plan's pattern (`approval:<requestId>`, `question:<requestId>`, `stuck:<agentKey>`,
 * `loop:<agentKey>:<digest>`, `conflict:<cwd>:<path>`); WP3 and WP7 own the real ones.
 *
 * With `freshItemAfterMs`, one more stuck item arrives that long after start, stamped "now", so a dev run shows a
 * desktop toast (items from before the app started are history and never toast).
 *
 * M5 (WP4a): the history, replay, report, scorecard and Ask questions are answered from canned-m5.ts (three stored
 * runs plus the live sessions above, which show as running).
 */
import {
  EMPTY_USAGE,
  agentKey,
  type AgentCapabilities,
  type AgentKey,
  type AgentNode,
  type ApprovalRequest,
  type AttentionItem,
  type CommandResult,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleState,
  type QuestionRequest,
  type HuddleQuery,
  type QueryResult,
  type SkillsAnswer,
} from '@huddle/shared';
import { isM5Query, previewRule } from '@huddle/core';
import { cannedM4 } from './canned-m4.js';
import { createCannedHistory } from './canned-m5.js';
import { createCannedSelfReport } from './canned-self-report.js';
import type { CoreHost, EventsListener } from './core-host.js';

const SESSION = 'canned-session-0001';
/** M6 (F26): sample data has no listener, so phone access says so instead of pretending to turn on. */
export const CANNED_PHONE_WORDS =
  'Phone access is not available with sample data. Start Huddle without HUDDLE_DEV_CANNED.';
/**
 * Anchored to when the dev app starts (whole minute, 100 s back), so progress and ETA in the UI, which run on the
 * renderer's clock, look like a run in progress rather than one from a fixed day long ago.
 */
const T0 = Math.floor(Date.now() / 60_000) * 60_000 - 100_000;

/** Canned usage: every field set, so the UI shows real-looking numbers. */
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

function context(
  used: number | null,
  window: number | null,
  measuredBy: AgentNode['context']['measuredBy'],
  extra: Partial<AgentNode['context']> = {},
): AgentNode['context'] {
  return {
    usedTokens: used,
    windowTokens: window,
    usedPct: used !== null && window !== null ? (used / window) * 100 : null,
    compactions: 0,
    lastCompactedAt: null,
    loadedInstructions: [],
    measuredBy,
    ...extra,
  };
}

/**
 * An attached session (M3): approve and answer through hooks, messages queued, pause by holding the next tool call;
 * no stop or model switch. A follow-up at turn end is for main agents only (MAIN_CAPS).
 */
const ATTACHED: AgentCapabilities = {
  approve: true,
  answerQuestions: true,
  message: 'queued',
  pause: true,
  stop: false,
  setModel: false,
  followUp: false,
};
const MAIN_CAPS: AgentCapabilities = { ...ATTACHED, followUp: true };

function node(partial: Partial<AgentNode> & Pick<AgentNode, 'key' | 'name' | 'role' | 'kind'>): AgentNode {
  return {
    sessionId: SESSION,
    agentId: null,
    parentKey: null,
    childKeys: [],
    origin: 'attached',
    roleDescription: null,
    model: null,
    cwd: 'C:\\projects\\example',
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
    capabilities: ATTACHED,
    toolCalls: 0,
    toolFailures: 0,
    startedAt: T0,
    endedAt: null,
    lastEventAt: T0,
    ...partial,
  };
}

function handoff(n: number, title: string, link: 'exact' | 'heuristic'): NonNullable<AgentNode['handoff']> {
  return { toolUseId: `toolu_canned_${String(n)}`, title, brief: null, result: null, link };
}

const MAIN = agentKey(SESSION);
const PLANNER = agentKey(SESSION, 'a-core-1');
const EXPLORER = agentKey(SESSION, 'a-explore-1');
const EXPLORER2 = agentKey(SESSION, 'a-explore-2');
const TESTER = agentKey(SESSION, 'a-test-1');
const DOCS = agentKey(SESSION, 'a-docs-1');

const SESSION_B = 'canned-session-0002';
const MAIN_B = agentKey(SESSION_B);
const RESEARCH_B = agentKey(SESSION_B, 'b-research-1');
const RUNNER_B = agentKey(SESSION_B, 'b-runner-1');
const CWD_B = 'C:\\projects\\voice-scout';

const SESSION_C = 'canned-session-0003';
const MAIN_C = agentKey(SESSION_C);

const SESSION_D = 'canned-session-0004';
const MAIN_D = agentKey(SESSION_D);
const ASKER_D = agentKey(SESSION_D, 'd-docs-1');
const PAUSED_D = agentKey(SESSION_D, 'd-build-1');
const STUCK_D = agentKey(SESSION_D, 'd-e2e-1');
const CWD_D = 'C:\\projects\\release-notes';
const CWD_A = 'C:\\projects\\example';

const SESSION_E = 'canned-session-0005';
const MAIN_E = agentKey(SESSION_E);

/** When the canned "Huddle run" started: before every live canned session's last event (the oldest, MAIN_B, is T0 - 120 s). */
const CANNED_STARTED_AT = T0 - 700_000;

/** The canned hold started 40 s before "now"; the Huddle releases it 595 s after it started (hook timeout 600 s). */
const HOLD_SINCE = T0 + 60_000;
const HOLD_LIMIT_AT = HOLD_SINCE + 595_000;

const QUESTION_TONE: QuestionRequest = {
  requestId: 'canned-q-1',
  agentKey: ASKER_D,
  receivedAt: T0 + 84_000,
  questions: [
    {
      question: 'Which tone should the release notes use?',
      header: 'Tone',
      multiSelect: false,
      options: [
        { label: 'Plain', description: 'Short sentences, no marketing words' },
        { label: 'Friendly', description: 'Warmer, still factual' },
        { label: 'Technical', description: 'For developers: APIs, flags, migrations' },
      ],
    },
  ],
};

const QUESTION_SECTIONS: QuestionRequest = {
  requestId: 'canned-q-2',
  agentKey: MAIN_D,
  receivedAt: T0 + 86_000,
  questions: [
    {
      question: 'Which sections should the notes include?',
      header: 'Sections',
      multiSelect: true,
      options: [
        { label: 'New features' },
        { label: 'Fixes' },
        { label: 'Breaking changes', description: 'With a migration note for each' },
        { label: 'Contributors' },
      ],
    },
  ],
};

const APPROVAL_TEST: ApprovalRequest = {
  requestId: 'canned-req-1',
  agentKey: TESTER,
  toolName: 'Bash',
  toolInput: { command: 'npm test -- parser', description: 'Run the parser tests' },
  summary: 'npm test -- parser',
  receivedAt: T0 + 80_000,
  expiresAt: T0 + 80_000 + 600_000,
  channel: 'hook',
};

function cannedInbox(): AttentionItem[] {
  return [
    {
      id: 'approval:canned-req-1',
      kind: 'approval',
      severity: 'action_required',
      agentKey: TESTER,
      title: 'Write parser tests needs approval',
      detail: 'Bash: npm test -- parser',
      createdAt: APPROVAL_TEST.receivedAt,
      resolvedAt: null,
      approval: APPROVAL_TEST,
    },
    {
      id: 'question:canned-q-1',
      kind: 'question',
      severity: 'action_required',
      agentKey: ASKER_D,
      title: 'Draft the summary asked a question',
      detail: 'Which tone should the release notes use?',
      createdAt: QUESTION_TONE.receivedAt,
      resolvedAt: null,
      question: QUESTION_TONE,
    },
    {
      id: 'question:canned-q-2',
      kind: 'question',
      severity: 'action_required',
      agentKey: MAIN_D,
      title: 'Tidy the release notes asked a question',
      detail: 'Which sections should the notes include?',
      createdAt: QUESTION_SECTIONS.receivedAt,
      resolvedAt: null,
      question: QUESTION_SECTIONS,
    },
    {
      id: `stuck:${STUCK_D}`,
      kind: 'stuck',
      severity: 'warning',
      agentKey: STUCK_D,
      title: 'Run the e2e suite looks stuck',
      detail: 'No activity for 6 min while working.',
      createdAt: T0 + 70_000,
      resolvedAt: null,
    },
    {
      id: `loop:${EXPLORER2}:canned-digest-7f3a`,
      kind: 'loop',
      severity: 'warning',
      agentKey: EXPLORER2,
      title: 'Map token kinds may be in a loop',
      detail: 'Grep TokenKind ran 5 times in a row with the same input.',
      createdAt: T0 + 89_000,
      resolvedAt: null,
    },
    {
      id: `conflict:${CWD_A}:${CWD_A}\\src\\tokenizer.ts`,
      kind: 'file_conflict',
      severity: 'warning',
      agentKey: PLANNER,
      title: 'File conflict on src\\tokenizer.ts',
      detail: 'Rewrite tokenizer and Update parser docs both edited src\\tokenizer.ts in the last 10 min.',
      createdAt: T0 + 91_000,
      resolvedAt: null,
      relatedAgentKeys: [PLANNER, DOCS],
    },
  ];
}

export function cannedState(): HuddleState {
  const agents: Record<AgentKey, AgentNode> = {
    [MAIN]: node({
      key: MAIN,
      kind: 'main',
      name: 'Refactor the parser',
      role: 'main',
      model: 'claude-opus-5-5[1m]',
      sessionCwd: CWD_A,
      lastPrompt: 'Refactor the parser so the tokenizer streams tokens instead of building one big array',
      capabilities: MAIN_CAPS,
      childKeys: [PLANNER, TESTER, DOCS],
      currentActivity: 'Waiting for subagents',
      toolCalls: 14,
      lastEventAt: T0 + 95_000,
      usage: usage(18_400, 6_200, 412_000, 38_000, 22, 1.84),
      helperUsage: usage(2_100, 140, 0, 0, 3, 0.004),
      context: context(96_000, 200_000, 'statusline', {
        compactions: 1,
        lastCompactedAt: T0 + 10_000,
        loadedInstructions: ['C:\\projects\\example\\CLAUDE.md', 'C:\\projects\\example\\.claude\\rules\\parser.md'],
      }),
    }),
    [PLANNER]: node({
      key: PLANNER,
      agentId: 'a-core-1',
      parentKey: MAIN,
      childKeys: [EXPLORER, EXPLORER2],
      kind: 'subagent',
      name: 'Rewrite tokenizer',
      role: 'core-engineer',
      roleDescription: 'Implements the core packages',
      model: 'claude-sonnet-5',
      currentActivity: 'Edit src/tokenizer.ts',
      toolCalls: 6,
      toolFailures: 1,
      // Started well before the others, so its finished Explore gives the ETA a pace of a few minutes.
      startedAt: T0 - 620_000,
      lastEventAt: T0 + 90_000,
      usage: { ...usage(9_800, 4_100, 188_000, 21_000, 11, 0.62), requestsWithoutCost: 1 },
      context: context(172_000, 200_000, 'telemetry', {
        loadedInstructions: ['C:\\projects\\example\\CLAUDE.md'],
      }),
      handoff: {
        ...handoff(1, 'Rewrite tokenizer', 'exact'),
        brief:
          'Rewrite src/tokenizer.ts as a pure function: no module state, no I/O.\nKeep the public tokenize() signature. <b>Do not</b> touch the parser yet.\nReport the call sites you changed.',
      },
    }),
    [EXPLORER]: node({
      key: EXPLORER,
      agentId: 'a-explore-1',
      parentKey: PLANNER,
      kind: 'subagent',
      name: 'Find tokenizer call sites',
      role: 'Explore',
      roleDescription: 'Fast read-only search across the codebase',
      model: 'claude-haiku-5',
      status: 'done',
      currentActivity: null,
      toolCalls: 9,
      startedAt: T0 - 600_000,
      endedAt: T0 - 330_000,
      lastEventAt: T0 - 330_000,
      usage: usage(3_200, 900, 41_000, 6_000, 5, 0.03),
      context: context(28_000, 200_000, 'telemetry'),
      handoff: {
        ...handoff(2, 'Find tokenizer call sites', 'heuristic'),
        brief: 'Find every call to tokenize( in src/ and test/. List file and line.',
        result: 'Found 4 call sites.\nsrc/parser.ts:12\nsrc/parser.ts:88\nsrc/repl.ts:30\ntest/tokenizer.test.ts:5',
      },
    }),
    [EXPLORER2]: node({
      key: EXPLORER2,
      agentId: 'a-explore-2',
      parentKey: PLANNER,
      kind: 'subagent',
      name: 'Map token kinds',
      role: 'Explore',
      roleDescription: 'Fast read-only search across the codebase',
      model: 'claude-haiku-5',
      currentActivity: 'Grep TokenKind',
      toolCalls: 4,
      startedAt: T0 - 200_000,
      lastEventAt: T0 + 88_000,
      usage: usage(1_900, 400, 12_000, 4_000, 3, 0.01),
      context: context(19_000, 200_000, 'telemetry'),
      handoff: handoff(3, 'Map token kinds', 'heuristic'),
    }),
    [TESTER]: node({
      key: TESTER,
      agentId: 'a-test-1',
      parentKey: MAIN,
      kind: 'subagent',
      name: 'Write parser tests',
      role: 'test-engineer',
      model: null,
      status: 'waiting_approval',
      currentActivity: 'Bash: npm test -- parser',
      toolCalls: 3,
      startedAt: T0 + 25_000,
      lastEventAt: T0 + 80_000,
      handoff: handoff(4, 'Write parser tests', 'exact'),
    }),
    [DOCS]: node({
      key: DOCS,
      agentId: 'a-docs-1',
      parentKey: MAIN,
      kind: 'subagent',
      name: 'Update parser docs',
      role: 'docs-writer',
      model: 'claude-sonnet-5',
      currentActivity: 'Write docs/parser.md',
      toolCalls: 2,
      startedAt: T0 + 40_000,
      lastEventAt: T0 + 85_000,
      usage: usage(2_400, 1_300, 9_000, 5_000, 4, 0.05),
      // Tokens measured, but the window of this model is not known: the percentage stays unknown.
      context: context(41_000, null, 'telemetry'),
      handoff: handoff(5, 'Update parser docs', 'exact'),
    }),

    [MAIN_B]: node({
      key: MAIN_B,
      sessionId: SESSION_B,
      kind: 'main',
      // F2: no session title (the usual case): the card is titled by the project folder and shows the last prompt.
      name: 'main',
      role: 'main',
      capabilities: MAIN_CAPS,
      model: 'claude-sonnet-5-5',
      cwd: CWD_B,
      sessionCwd: CWD_B,
      lastPrompt: 'Survey the speech-to-text APIs and compare latency on the sample clips',
      status: 'idle',
      childKeys: [RESEARCH_B, RUNNER_B],
      toolCalls: 21,
      startedAt: T0 - 600_000,
      lastEventAt: T0 - 120_000,
    }),
    [RESEARCH_B]: node({
      key: RESEARCH_B,
      sessionId: SESSION_B,
      agentId: 'b-research-1',
      parentKey: MAIN_B,
      kind: 'subagent',
      name: 'Compare latency claims',
      role: 'general-purpose',
      model: 'claude-sonnet-5',
      cwd: CWD_B,
      status: 'done',
      toolCalls: 12,
      startedAt: T0 - 500_000,
      endedAt: T0 - 200_000,
      lastEventAt: T0 - 200_000,
      handoff: handoff(6, 'Compare latency claims', 'exact'),
    }),
    [RUNNER_B]: node({
      key: RUNNER_B,
      sessionId: SESSION_B,
      agentId: 'b-runner-1',
      parentKey: MAIN_B,
      kind: 'subagent',
      name: 'Run the benchmark script',
      role: 'test-engineer',
      model: 'claude-haiku-5',
      cwd: CWD_B,
      status: 'failed',
      toolCalls: 5,
      toolFailures: 3,
      startedAt: T0 - 400_000,
      endedAt: T0 - 150_000,
      lastEventAt: T0 - 150_000,
      handoff: handoff(7, 'Run the benchmark script', 'heuristic'),
    }),

    [MAIN_C]: node({
      key: MAIN_C,
      sessionId: SESSION_C,
      kind: 'main',
      name: 'main',
      role: 'main',
      capabilities: MAIN_CAPS,
      model: 'claude-opus-5-5',
      cwd: 'C:\\projects\\infra',
      sessionCwd: 'C:\\projects\\infra',
      lastPrompt: 'Fix the CI cache so builds stop downloading node_modules every run',
      status: 'done',
      toolCalls: 8,
      startedAt: T0 - 3_600_000,
      endedAt: T0 - 3_000_000,
      lastEventAt: T0 - 3_000_000,
    }),

    [MAIN_D]: node({
      key: MAIN_D,
      sessionId: SESSION_D,
      kind: 'main',
      name: 'main',
      role: 'main',
      model: 'claude-sonnet-5',
      cwd: CWD_D,
      sessionCwd: CWD_D,
      lastPrompt: 'Tidy the release notes for 2.4 and ask me which sections to keep',
      capabilities: MAIN_CAPS,
      status: 'waiting_answer',
      currentActivity: 'AskUserQuestion: Which sections should the notes include?',
      childKeys: [ASKER_D, PAUSED_D, STUCK_D],
      toolCalls: 11,
      startedAt: T0 - 300_000,
      lastEventAt: T0 + 92_000,
      usage: usage(7_200, 2_300, 96_000, 12_000, 9, 0.41),
      outbox: [
        {
          messageId: 'canned-msg-1',
          text: 'Keep the notes under one page.',
          delivery: 'next_tool',
          queuedAt: T0 + 87_000,
        },
        {
          messageId: 'canned-msg-2',
          text: 'When you are done, also list the open issues that did not make it in.',
          delivery: 'turn_end',
          queuedAt: T0 + 92_000,
        },
      ],
    }),
    [ASKER_D]: node({
      key: ASKER_D,
      sessionId: SESSION_D,
      agentId: 'd-docs-1',
      parentKey: MAIN_D,
      kind: 'subagent',
      name: 'Draft the summary',
      role: 'docs-writer',
      model: 'claude-haiku-5',
      cwd: CWD_D,
      status: 'waiting_answer',
      currentActivity: 'AskUserQuestion: Which tone should the release notes use?',
      toolCalls: 3,
      startedAt: T0 - 200_000,
      lastEventAt: T0 + 84_000,
      handoff: handoff(8, 'Draft the summary', 'exact'),
    }),
    [PAUSED_D]: node({
      key: PAUSED_D,
      sessionId: SESSION_D,
      agentId: 'd-build-1',
      parentKey: MAIN_D,
      kind: 'subagent',
      name: 'Build the changelog',
      role: 'general-purpose',
      model: 'claude-haiku-5',
      cwd: CWD_D,
      status: 'paused',
      currentActivity: 'Bash: git log --oneline v1.4..HEAD',
      toolCalls: 5,
      startedAt: T0 - 180_000,
      lastEventAt: HOLD_SINCE,
      handoff: handoff(9, 'Build the changelog', 'exact'),
      hold: { toolUseId: 'toolu_canned_hold_1', since: HOLD_SINCE, limitAt: HOLD_LIMIT_AT },
    }),
    [STUCK_D]: node({
      key: STUCK_D,
      sessionId: SESSION_D,
      agentId: 'd-e2e-1',
      parentKey: MAIN_D,
      kind: 'subagent',
      name: 'Run the e2e suite',
      role: 'test-engineer',
      model: 'claude-sonnet-5',
      cwd: CWD_D,
      status: 'working',
      currentActivity: 'Bash: npm run e2e',
      toolCalls: 2,
      startedAt: T0 - 420_000,
      lastEventAt: T0 - 290_000,
      handoff: handoff(10, 'Run the e2e suite', 'heuristic'),
      // A pause was asked for; it lands at this agent's next tool call.
      pausePending: true,
    }),

    [MAIN_E]: node({
      key: MAIN_E,
      sessionId: SESSION_E,
      kind: 'main',
      // F2: same project as MAIN_B, a different prompt: the topic line tells the two cards apart. The tag in the
      // prompt must render as text.
      name: 'main',
      role: 'main',
      model: 'claude-sonnet-5',
      cwd: CWD_B,
      sessionCwd: CWD_B,
      lastPrompt: 'Write the launch post for the voice-scout beta <img src=x onerror=alert(1)>',
      capabilities: MAIN_CAPS,
      currentActivity: 'Drafting',
      toolCalls: 17,
      startedAt: T0 - 540_000,
      lastEventAt: T0 + 93_000,
      usage: usage(11_000, 5_400, 140_000, 9_000, 12, 0.58),
      tasks: [
        {
          id: '1',
          subject: 'Collect the release facts',
          status: 'completed',
          createdAt: T0 - 530_000,
          completedAt: T0 - 420_000,
        },
        { id: '2', subject: 'Outline', status: 'completed', createdAt: T0 - 530_000, completedAt: T0 - 300_000 },
        {
          id: '3',
          subject: 'Pick the screenshots',
          status: 'completed',
          createdAt: T0 - 530_000,
          completedAt: T0 - 120_000,
        },
        // In progress (TaskUpdate in_progress, `task.started`): the card shows it and the list marks it ◐.
        { id: '4', subject: 'Drafting', status: 'pending', createdAt: T0 - 530_000, startedAt: T0 - 100_000 },
        { id: '5', subject: 'Proofread and trim', status: 'pending', createdAt: T0 - 530_000 },
      ],
    }),
  };
  return {
    agents,
    rootKeys: [MAIN, MAIN_D, MAIN_E, MAIN_B, MAIN_C],
    inbox: cannedInbox(),
    // WP9: attached, so selectControls enables what the agents' capabilities allow (without a connection everything
    // is "not connected"). Started before every live session's last event, so none of them reads as stale and every
    // canned request and hold counts as this run's own.
    connection: { status: 'attached', message: null, startedAt: CANNED_STARTED_AT },
    rateLimits: {
      fiveHourUsedPct: 42,
      fiveHourResetsAt: T0 + 2 * 3_600_000,
      sevenDayUsedPct: 18,
      sevenDayResetsAt: T0 + 4 * 86_400_000,
      measuredAt: T0 + 90_000,
    },
  };
}

function cannedEvents(): HuddleEvent[] {
  const base = (key: AgentKey, n: number, suffix = '') => ({
    id: `canned-${String(n).padStart(4, '0')}-${key.slice(-4)}${suffix}`,
    ts: T0 + n * 1000,
    sessionId: SESSION,
    agentKey: key,
    source: 'hook' as const,
  });
  /** A tool call: started, then finished after `ms`, failed with `fail`, or still running (ms null). */
  const tool = (key: AgentKey, n: number, toolName: string, summary: string, ms: number | null, fail?: string) => {
    const toolUseId = `toolu_c${String(n)}_${key.slice(-4)}`;
    const out: HuddleEvent[] = [
      { ...base(key, n), type: 'tool.started', toolUseId, toolName, summary, filePath: null, inputDigest: 'canned' },
    ];
    if (fail) {
      out.push({
        ...base(key, n, '-f'),
        ts: T0 + n * 1000 + 400,
        type: 'tool.failed',
        toolUseId,
        toolName,
        error: fail,
        interrupted: false,
      });
    } else if (ms !== null) {
      out.push({
        ...base(key, n, '-d'),
        ts: T0 + n * 1000 + ms,
        type: 'tool.finished',
        toolUseId,
        toolName,
        durationMs: ms,
      });
    }
    return out;
  };
  return [
    {
      ...base(MAIN, 0),
      type: 'session.started',
      origin: 'attached',
      cwd: 'C:\\projects\\example',
      // The title the hand-built team shows, so History's live row and Replay's tree name this run the same way.
      title: 'Refactor the parser',
      model: 'claude-opus-5-5',
      startKind: 'startup',
    },
    {
      ...base(MAIN, 1),
      type: 'prompt.submitted',
      text: 'Split the parser into a tokenizer and a parser, keep the tests green',
      promptId: null,
    },
    ...tool(MAIN, 5, 'Read', 'docs/SPEC.md', 8),
    { ...base(MAIN, 9), type: 'task.created', taskId: 't1', subject: 'Split tokenizer from parser', description: null },
    {
      ...base(MAIN, 19),
      type: 'agent.spawn_requested',
      toolUseId: 'toolu_canned_1',
      role: 'core-engineer',
      title: 'Rewrite tokenizer',
      brief: null,
      model: null,
    },
    { ...base(PLANNER, 20), type: 'agent.started', agentId: 'a-core-1', role: 'core-engineer', parentKey: MAIN },
    {
      ...base(PLANNER, 21),
      type: 'prompt.submitted',
      text: 'Rewrite the tokenizer as a pure function.',
      promptId: null,
    },
    ...tool(PLANNER, 24, 'Read', 'src/tokenizer.ts', 6),
    ...tool(PLANNER, 27, 'Grep', 'export function tokenize', 41),
    // The spawns carry the hand-built team's titles, so the replayed tree names every agent as the live team does.
    {
      ...base(MAIN, 24),
      type: 'agent.spawn_requested',
      toolUseId: 'toolu_canned_2',
      role: 'test-engineer',
      title: 'Write parser tests',
      brief: null,
      model: null,
    },
    { ...base(TESTER, 25), type: 'agent.started', agentId: 'a-test-1', role: 'test-engineer', parentKey: MAIN },
    {
      ...base(PLANNER, 29, '-s'),
      type: 'agent.spawn_requested',
      toolUseId: 'toolu_canned_3',
      role: 'Explore',
      title: 'Find tokenizer call sites',
      brief: null,
      model: null,
    },
    { ...base(EXPLORER, 30), type: 'agent.started', agentId: 'a-explore-1', role: 'Explore', parentKey: PLANNER },
    {
      ...base(MAIN, 39),
      type: 'agent.spawn_requested',
      toolUseId: 'toolu_canned_5',
      role: 'docs-writer',
      title: 'Update parser docs',
      brief: null,
      model: null,
    },
    { ...base(DOCS, 40), type: 'agent.started', agentId: 'a-docs-1', role: 'docs-writer', parentKey: MAIN },
    ...tool(DOCS, 85, 'Write', 'docs/parser.md', null),
    ...tool(EXPLORER, 40, 'Grep', 'tokenize\\(', 35),
    { ...base(EXPLORER, 60), type: 'agent.stopped', agentId: 'a-explore-1', result: 'Found 4 call sites' },
    ...tool(PLANNER, 62, 'Bash', 'npm run typecheck', null, 'Process exited with code 2'),
    // Map token kinds is in the replayed tree too, so its stuck item (freshItemAfterMs) has its agent there.
    {
      ...base(PLANNER, 63, '-s'),
      type: 'agent.spawn_requested',
      toolUseId: 'toolu_canned_4',
      role: 'Explore',
      title: 'Map token kinds',
      brief: null,
      model: null,
    },
    { ...base(EXPLORER2, 64), type: 'agent.started', agentId: 'a-explore-2', role: 'Explore', parentKey: PLANNER },
    ...tool(EXPLORER2, 88, 'Grep', 'TokenKind', null),
    ...tool(PLANNER, 66, 'Edit', 'src/tokenizer.ts', 120),
    ...tool(PLANNER, 72, 'Bash', 'npm run typecheck', 6400),
    ...tool(PLANNER, 80, 'Read', 'src/parser.ts', 7),
    { ...base(PLANNER, 82), type: 'task.created', taskId: 't2', subject: 'Port number literals', description: null },
    ...tool(PLANNER, 90, 'Edit', 'src/tokenizer.ts', null),
    ...tool(TESTER, 70, 'Write', 'test/parser.test.ts', 30),
    {
      ...base(TESTER, 80),
      type: 'approval.requested',
      request: APPROVAL_TEST,
    },
    // Session 4 (M3): the hold, the questions and the queued messages, as the broker would write them.
    {
      ...base(PAUSED_D, 60),
      sessionId: SESSION_D,
      type: 'hold.started',
      toolUseId: 'toolu_canned_hold_1',
      limitAt: HOLD_LIMIT_AT,
    },
    { ...base(ASKER_D, 84), sessionId: SESSION_D, type: 'question.asked', request: QUESTION_TONE },
    { ...base(MAIN_D, 86), sessionId: SESSION_D, type: 'question.asked', request: QUESTION_SECTIONS },
    {
      ...base(MAIN_D, 87),
      sessionId: SESSION_D,
      source: 'user',
      type: 'message.queued',
      messageId: 'canned-msg-1',
      text: 'Keep the notes under one page.',
      delivery: 'next_tool',
    },
    {
      ...base(MAIN_D, 92),
      sessionId: SESSION_D,
      source: 'user',
      type: 'message.queued',
      messageId: 'canned-msg-2',
      text: 'When you are done, also list the open issues that did not make it in.',
      delivery: 'turn_end',
    },
  ];
}

/** Library › Skills with sample data: one project skill that can be edited, and one of the user's own (read-only). */
const CANNED_SKILLS: SkillsAnswer = {
  projects: [{ key: 'c:/projects/example', path: 'C:\\projects\\example', name: 'example' }],
  skills: [
    {
      scope: 'project',
      projectPath: 'C:\\projects\\example',
      dirName: 'run-parser-tests',
      name: 'run-parser-tests',
      description: 'Run the parser and tokenizer tests and summarise the failures.',
      file: 'C:\\projects\\example\\.claude\\skills\\run-parser-tests\\SKILL.md',
      problem: null,
      editable: true,
    },
    {
      scope: 'user',
      projectPath: null,
      dirName: 'release-notes',
      name: 'release-notes',
      description: 'Draft release notes from the pull requests merged since the last tag.',
      file: 'C:\\Users\\you\\.claude\\skills\\release-notes\\SKILL.md',
      problem: null,
      editable: false,
    },
  ],
};

export interface CannedCoreOptions {
  /** Emit a synthetic canned tool call this often (ms) so the batching path can be watched. 0 = never. */
  tickMs?: number;
  /** Raise one fresh stuck item (stamped at that moment) this long after start, to see a toast. 0 = never. */
  freshItemAfterMs?: number;
}

export function createCannedCore(options: CannedCoreOptions = {}): CoreHost {
  // M4 (WP7a): a managed run with a worktree, budgets, rules, templates (canned-m4.ts). Merged here, not in
  // cannedState(), so the M1-M3 samples that tests pin stay as they were.
  const m4 = cannedM4(T0);
  const base = cannedState();
  const state: HuddleState = {
    ...base,
    agents: { ...base.agents, ...m4.agents },
    rootKeys: [...base.rootKeys.slice(0, 1), ...m4.rootKeys, ...base.rootKeys.slice(1)],
    inbox: [...base.inbox, ...m4.inbox],
    budgets: m4.budgets,
    policy: m4.policy,
    templates: m4.templates,
  };
  const events = [...m4.events, ...cannedEvents()];
  const listeners = new Set<EventsListener>();
  let seq = events.length;
  let timer: ReturnType<typeof setInterval> | null = null;
  let fresh: ReturnType<typeof setTimeout> | null = null;
  const history = createCannedHistory({ now: Date.now(), liveEvents: () => events, liveState: () => state });

  if (options.freshItemAfterMs && options.freshItemAfterMs > 0) {
    fresh = setTimeout(() => {
      fresh = null;
      const ts = Date.now();
      const item: AttentionItem = {
        id: `stuck:${EXPLORER2}`,
        kind: 'stuck',
        severity: 'warning',
        agentKey: EXPLORER2,
        title: 'Map token kinds looks stuck',
        detail: 'No activity for 5 min while working.',
        createdAt: ts,
        resolvedAt: null,
      };
      state.inbox = [...state.inbox, item];
      const event: HuddleEvent = {
        id: `canned-fresh-${String(ts)}`,
        ts,
        sessionId: SESSION,
        agentKey: EXPLORER2,
        source: 'huddle',
        type: 'attention.raised',
        item,
      };
      events.push(event);
      for (const l of listeners) l([event]);
    }, options.freshItemAfterMs);
  }

  if (options.tickMs && options.tickMs > 0) {
    timer = setInterval(() => {
      seq += 1;
      const ts = Date.now();
      const id = `canned-tick-${String(seq)}`;
      const common = {
        ts,
        sessionId: SESSION,
        agentKey: PLANNER,
        source: 'huddle' as const,
        toolUseId: id,
        toolName: 'Read',
      };
      const batch: HuddleEvent[] = [
        {
          ...common,
          id,
          type: 'tool.started',
          summary: `canned tick ${String(seq)}`,
          filePath: null,
          inputDigest: 'canned',
        },
        { ...common, id: `${id}-done`, ts: ts + 9, type: 'tool.finished', durationMs: 9 },
      ];
      events.push(...batch);
      if (events.length > 1000) events.splice(0, events.length - 1000);
      for (const l of listeners) l(batch);
    }, options.tickMs);
  }

  const selfReport = createCannedSelfReport();

  return {
    getState: () => state,
    getEvents: (key, limit) => events.filter((e) => e.agentKey === key).slice(-limit),
    command: (cmd: HuddleCommand): Promise<CommandResult> =>
      history.command(cmd) ??
      Promise.resolve(
        selfReport.command(cmd) ??
          (cmd.type === 'run.openWorktree'
            ? { ok: false, code: 'unsupported', message: 'Sample data: there is no worktree folder to open.' }
            : cmd.type.startsWith('phone.')
              ? { ok: false, code: 'unsupported', message: CANNED_PHONE_WORDS }
              : { ok: true, detail: `canned core: ${cmd.type} acknowledged, nothing changed` }),
      ),
    // policy.preview runs the real (pure) preview over the canned approval requests; the folder picker is main's.
    query: (q: HuddleQuery): Promise<QueryResult> =>
      Promise.resolve(
        isM5Query(q)
          ? history.query(q)
          : q.type === 'setup.selfReportPreview'
            ? { ok: true, type: 'setup.selfReportPreview', preview: selfReport.preview(q.mode) }
            : q.type === 'phone.addresses'
              ? { ok: false, code: 'unsupported', message: CANNED_PHONE_WORDS }
              : q.type === 'policy.preview'
                ? { ok: true, type: 'policy.preview', preview: previewRule(q.rule, events, state.agents) }
                : q.type === 'skills.list'
                  ? { ok: true, type: 'skills.list', answer: CANNED_SKILLS }
                  : { ok: false, code: 'unsupported', message: 'The sample data has no answer for this.' },
      ),
    onEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (timer) clearInterval(timer);
      if (fresh) clearTimeout(fresh);
      listeners.clear();
      return Promise.resolve();
    },
  };
}
