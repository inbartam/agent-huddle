/**
 * History rows for renderer tests (M5, F22), shaped like the canned answers in `apps/desktop/src/main/canned-m5.ts`
 * (the renderer cannot import that: it runs the core's reducer). Hand-written; nothing came from a real session.
 */
import {
  agentKey,
  type AgentKey,
  type AgentNode,
  type AttentionItem,
  type HistoryRow,
  type HistorySearchHit,
  type HuddleEvent,
  type HuddleState,
  type QueryResult,
  type ReplayEventEntry,
  type ReplayEventsPage,
  type ReplayMarker,
  type ReplayMoment,
  type ReplayWhy,
  type ReportApproval,
  type ReportFailure,
  type RunHead,
  type RunReport,
  type Scorecard,
  type AgentRunRow,
} from '@huddle/shared';
import type { RunsList } from '../view/history.js';
import { NO_FILTERS } from '../view/history.js';
import { agent, XSS } from './fixture.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Saturday 14 Nov 2026, 18:00 local time. */
export const NOW_M5 = new Date(2026, 10, 14, 18, 0, 0).getTime();

export function historyRow(partial: Partial<HistoryRow> & Pick<HistoryRow, 'sessionId'>): HistoryRow {
  return {
    title: null,
    topic: null,
    folder: 'C:\\code\\agent-huddle',
    startTs: NOW_M5 - HOUR,
    durationMs: 10 * MIN,
    outcome: 'completed',
    origin: 'attached',
    model: 'claude-sonnet-5-5',
    otherModels: 0,
    tokens: { value: 12_000, partial: false },
    agentCount: 1,
    ...partial,
  };
}

/** The three canned stored runs plus one live one, newest first. */
export const CANNED_ROWS: HistoryRow[] = [
  historyRow({
    sessionId: 'canned-live',
    title: 'Widget polish',
    startTs: NOW_M5 - 80 * MIN,
    durationMs: null,
    outcome: 'running',
    model: 'claude-opus-5-5',
    tokens: { value: 61_000, partial: true },
    agentCount: 2,
  }),
  historyRow({
    sessionId: 'canned-hist-fix-parser',
    title: 'Fix parser tests',
    topic: 'fix the failing parser tests',
    startTs: NOW_M5 - 3 * HOUR,
    durationMs: 21 * MIN + 28_000,
    outcome: 'completed',
    origin: 'managed',
    model: 'claude-opus-5-5',
    otherModels: 2,
    tokens: { value: 182_000, partial: false },
    agentCount: 3,
  }),
  historyRow({
    sessionId: 'canned-hist-migrate-store',
    title: 'Migrate store',
    topic: 'move the event store to SQLite and keep the JSONL reader',
    startTs: NOW_M5 - DAY - 2 * HOUR,
    durationMs: 62 * MIN + 2_000,
    outcome: 'failed',
    model: 'claude-opus-5-5',
    tokens: { value: 1_200_000, partial: false },
    agentCount: 1,
  }),
  historyRow({
    sessionId: 'canned-hist-summarize',
    title: null,
    topic: 'summarize the repo',
    folder: 'C:\\code\\voice-scout',
    startTs: NOW_M5 - 2 * DAY - 5 * HOUR,
    durationMs: null,
    outcome: 'no_end',
    model: 'claude-haiku-5-5',
    tokens: null,
    agentCount: 1,
  }),
];

export const HOSTILE_TITLE = XSS;
export const MARKDOWN_TITLE = '**bold** # heading';

export const HOSTILE_ROWS: HistoryRow[] = [
  historyRow({ sessionId: 'hostile-1', title: HOSTILE_TITLE, topic: '<script>alert(1)</script>' }),
  historyRow({ sessionId: 'hostile-2', title: MARKDOWN_TITLE, folder: 'C:\\x\\<b>bold</b>' }),
];

export function hits(rows: readonly HistoryRow[]): HistorySearchHit[] {
  return rows.map((row) => ({ row, match: null }));
}

export function runsList(rows: readonly HistoryRow[], more: Partial<RunsList> = {}): RunsList {
  return { filters: NO_FILTERS, hits: hits(rows), total: null, next: null, migrating: false, ...more };
}

export function runHead(row: HistoryRow, more: Partial<RunHead> = {}): RunHead {
  return {
    row,
    eventCount: 28,
    startsWithSession: true,
    hasReport: false,
    markers: [],
    markersTruncated: false,
    quietGaps: [],
    lastTs: row.startTs + (row.durationMs ?? 0),
    ...more,
  };
}

/** Rows numbered 0..n-1, one minute apart, newest first. */
export function manyRows(n: number, from = 0): HistoryRow[] {
  return Array.from({ length: n }, (_, i) =>
    historyRow({ sessionId: `run-${String(from + i).padStart(4, '0')}`, startTs: NOW_M5 - (from + i) * MIN }),
  );
}

/** A fake `query` that records every question and answers from `answer`. */
export function fakeQuery(answer: (q: { type: string } & Record<string, unknown>) => QueryResult) {
  const asked: Array<{ type: string } & Record<string, unknown>> = [];
  const fn = (q: unknown) => {
    const rec = q as { type: string } & Record<string, unknown>;
    asked.push(rec);
    return Promise.resolve(answer(rec));
  };
  return { fn, asked };
}

// ---------------------------------------------------------------------------
// Replay (U2): "Fix parser tests" as the canned core tells it, cut down to what the Replay tab needs
// ---------------------------------------------------------------------------

export const REPLAY_SESSION = 'canned-hist-fix-parser';
export const RK = {
  main: agentKey(REPLAY_SESSION),
  explore: agentKey(REPLAY_SESSION, 'h-explore-2'),
  core: agentKey(REPLAY_SESSION, 'h-core-1'),
};
/** When the run started (the "Fix parser tests" row). */
export const R0 = NOW_M5 - 3 * HOUR;
/** Event index → time, like the canned log (25 events). */
const AT: Record<number, number> = {
  0: R0,
  12: R0 + 70_000,
  14: R0 + 75_000,
  15: R0 + 87_000,
  16: R0 + 88_000,
  17: R0 + 88_000 + 12 * MIN,
  18: R0 + 88_000 + 18 * MIN,
  19: R0 + 88_000 + 18 * MIN + 50,
  24: R0 + 88_000 + 21 * MIN,
};
export const REPLAY_EVENT_COUNT = 25;
export const STUCK_INDEX = 17;
export const APPROVAL_INDEX = 14;
export const STUCK_TITLE = 'core-engineer #1 looks stuck';
export const STUCK_DETAIL = 'No activity for 12 min. Still inside Bash npm test -- parser.';

export const REPLAY_MARKERS: ReplayMarker[] = [
  { index: APPROVAL_INDEX, ts: AT[14] ?? R0, kind: 'approval', agentKey: RK.core, itemId: 'approval:req-npm-test' },
  { index: STUCK_INDEX, ts: AT[17] ?? R0, kind: 'stuck', agentKey: RK.core, itemId: `stuck:${RK.core}` },
];

export function replayHead(more: Partial<RunHead> = {}): RunHead {
  const row = CANNED_ROWS[1];
  if (!row) throw new Error('fixture');
  return runHead(row, {
    eventCount: REPLAY_EVENT_COUNT,
    hasReport: true,
    markers: REPLAY_MARKERS,
    quietGaps: [{ afterIndex: 16, ms: 12 * MIN }],
    lastTs: AT[24] ?? R0,
    ...more,
  });
}

/** The team at an event: main working, Explore done, core-engineer inside `npm test -- parser`. */
export function replayState(at: number, inbox: AttentionItem[] = []): HuddleState {
  const base = { sessionId: REPLAY_SESSION, cwd: 'C:\\code\\agent-huddle', startedAt: R0, lastEventAt: at };
  const agents: Record<AgentKey, AgentNode> = {
    [RK.main]: agent({
      ...base,
      key: RK.main,
      name: 'Fix parser tests',
      kind: 'main',
      role: 'main',
      origin: 'managed',
      model: 'claude-opus-5-5',
      childKeys: [RK.explore, RK.core],
      lastEventAt: R0 + 62_000,
    }),
    [RK.explore]: agent({
      ...base,
      key: RK.explore,
      agentId: 'h-explore-2',
      name: 'Explore #2',
      role: 'Explore',
      parentKey: RK.main,
      status: 'done',
      endedAt: R0 + 60_000,
      handoff: { toolUseId: 'tu-explore', title: 'List parser test files', brief: null, result: null, link: 'exact' },
    }),
    [RK.core]: agent({
      ...base,
      key: RK.core,
      agentId: 'h-core-1',
      name: 'core-engineer #1',
      role: 'core-engineer',
      parentKey: RK.main,
      model: 'claude-sonnet-5-5',
      currentActivity: 'Bash: npm test -- parser',
      handoff: { toolUseId: 'tu-core', title: 'Fix exponent parsing', brief: null, result: null, link: 'heuristic' },
    }),
  };
  return { agents, rootKeys: [RK.main], inbox, rateLimits: null };
}

export function stuckItem(more: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `stuck:${RK.core}`,
    kind: 'stuck',
    severity: 'warning',
    agentKey: RK.core,
    title: STUCK_TITLE,
    detail: STUCK_DETAIL,
    createdAt: AT[17] ?? R0,
    resolvedAt: null,
    ...more,
  };
}

export function stuckWhy(more: Partial<ReplayWhy> = {}): ReplayWhy {
  return {
    itemId: `stuck:${RK.core}`,
    kind: 'stuck',
    agentKey: RK.core,
    title: STUCK_TITLE,
    detail: STUCK_DETAIL,
    raisedIndex: STUCK_INDEX,
    raisedTs: AT[17] ?? R0,
    lastToolCall: {
      toolName: 'Bash',
      summary: 'npm test -- parser',
      startedTs: AT[16] ?? R0,
      fate: { state: 'open' },
    },
    quietMs: 12 * MIN,
    request: null,
    later: { kind: 'cleared', index: 19, ts: AT[19] ?? R0, reason: 'condition_cleared' },
    ...more,
  };
}

/** The moment the stuck item was raised (index 17), or another index with no open item. */
export function replayMoment(index = STUCK_INDEX, more: Partial<ReplayMoment> = {}): ReplayMoment {
  const ts = AT[index] ?? R0 + index * 1000;
  const stuck = index === STUCK_INDEX;
  return {
    sessionId: REPLAY_SESSION,
    index,
    eventCount: REPLAY_EVENT_COUNT,
    event: {
      index,
      ts,
      type: stuck ? 'attention.raised' : index === REPLAY_EVENT_COUNT - 1 ? 'session.ended' : 'tool.started',
      agentKey: stuck ? RK.core : RK.main,
    },
    gapBeforeMs: stuck ? 12 * MIN : index === 0 ? null : 1000,
    state: replayState(ts, stuck ? [stuckItem()] : []),
    why: stuck ? [stuckWhy()] : [],
    ...more,
  };
}

/** core-engineer's events up to the stuck moment, newest first, as `history.events` (backward, full) returns them. */
export function coreEventsPage(): ReplayEventsPage {
  const ev = (index: number, rest: Record<string, unknown>): ReplayEventEntry => {
    const ts = AT[index] ?? R0;
    const event = {
      id: `${REPLAY_SESSION}-${String(index).padStart(4, '0')}`,
      ts,
      sessionId: REPLAY_SESSION,
      agentKey: RK.core,
      source: 'hook',
      ...rest,
    } as unknown as HuddleEvent;
    return { index, ts, type: event.type, agentKey: RK.core, event };
  };
  return {
    entries: [
      ev(17, { type: 'attention.raised', item: stuckItem() }),
      ev(16, {
        type: 'tool.started',
        toolUseId: 'tu-c2',
        toolName: 'Bash',
        summary: 'npm test -- parser',
        filePath: null,
        inputDigest: 'c2',
      }),
      ev(15, {
        type: 'approval.resolved',
        requestId: 'req-npm-test',
        outcome: 'allowed',
        by: 'user',
        policyRuleId: null,
        message: null,
      }),
      ev(12, {
        type: 'tool.started',
        toolUseId: 'tu-c1',
        toolName: 'Edit',
        summary: 'packages\\core\\src\\parse\\number.ts',
        filePath: null,
        inputDigest: 'c1',
      }),
    ],
    eventCount: REPLAY_EVENT_COUNT,
    more: false,
  };
}

/** A promise you resolve by hand (late answers). */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Report (U3): "Fix parser tests" as the canned core reports it, plus hostile text
// ---------------------------------------------------------------------------

export const REPORT_PATH =
  'C:\\Users\\dev\\AppData\\Roaming\\agent-huddle\\reports\\2026-11-14 canned-hist-fix-parser.md';
/** The failure in the report: core-engineer's Bash call at event 20 (a marker carries the index). */
export const FAILURE_INDEX = 20;
const FAILURE_TS = R0 + 88_000 + 18 * MIN + 1_000;

export function runRow(partial: Partial<AgentRunRow> & Pick<AgentRunRow, 'agentKey'>): AgentRunRow {
  return {
    sessionId: REPLAY_SESSION,
    parentKey: null,
    kind: 'subagent',
    role: 'main',
    model: 'claude-opus-5-5',
    startedAt: R0,
    endedAt: R0 + 21 * MIN,
    durationMs: 21 * MIN,
    outcome: 'completed',
    tasksCreated: 0,
    tasksCompleted: 0,
    toolCalls: 0,
    toolFailures: 0,
    approvals: { requested: 0, byUser: 0, byPolicy: 0, other: 0, unresolved: 0 },
    stuckIncidents: 0,
    tokens: null,
    estimatedCostUsd: null,
    costPartial: false,
    ...partial,
  };
}

const tokens = (input: number, output: number, requests: number) => ({
  input,
  output,
  cacheRead: input * 6,
  cacheCreation: Math.round(input / 4),
  requests,
});

export function fixReport(more: Partial<RunReport> = {}): RunReport {
  return {
    version: 1,
    sessionId: REPLAY_SESSION,
    summary: {
      title: 'Fix parser tests',
      topic: 'fix the failing parser tests',
      cwd: 'C:\\code\\agent-huddle',
      model: 'claude-opus-5-5',
      origin: 'managed',
      startedAt: R0,
      endedAt: R0 + 21 * MIN + 28_000,
      durationMs: 21 * MIN + 28_000,
      outcome: 'completed',
      endReason: 'prompt_input_exit',
      agents: 3,
      toolCalls: 5,
      toolFailures: 1,
      tasksCompleted: 1,
      approvalsRequested: 1,
      stuckIncidents: 1,
      tokens: tokens(47_000, 7_400, 3),
      tokensPartial: true,
      helperTokens: tokens(1_800, 300, 2),
      estimatedCostUsd: 0.88,
      costPartial: false,
    },
    agents: [
      {
        row: runRow({
          agentKey: RK.main,
          kind: 'main',
          tasksCreated: 1,
          tasksCompleted: 1,
          tokens: tokens(21_000, 3_300, 2),
          estimatedCostUsd: 0.4,
        }),
        name: 'Fix parser tests',
        title: null,
        result: null,
        tools: [],
        fileWrites: 0,
      },
      {
        row: runRow({
          agentKey: RK.explore,
          parentKey: RK.main,
          role: 'Explore',
          model: 'claude-haiku-5-5',
          durationMs: 51_500,
          toolCalls: 1,
        }),
        name: 'Explore #2',
        title: 'List parser test files',
        result: 'Three parser test files; parse-number.test.ts fails on exponents.',
        tools: [{ toolName: 'Grep', calls: 1, failures: 0 }],
        fileWrites: 0,
      },
      {
        row: runRow({
          agentKey: RK.core,
          parentKey: RK.main,
          role: 'core-engineer',
          model: 'claude-sonnet-5-5',
          durationMs: 19 * MIN,
          toolCalls: 3,
          toolFailures: 1,
          approvals: { requested: 1, byUser: 1, byPolicy: 0, other: 0, unresolved: 0 },
          stuckIncidents: 1,
          tokens: tokens(26_000, 4_100, 1),
          estimatedCostUsd: 0.48,
          costPartial: true,
        }),
        name: 'core-engineer #1',
        title: 'Fix exponent parsing',
        result: 'Exponents now parse; all 41 parser tests pass.',
        tools: [
          { toolName: 'Bash', calls: 2, failures: 1 },
          { toolName: 'Edit', calls: 1, failures: 0 },
        ],
        fileWrites: 1,
      },
    ],
    filesChanged: [
      {
        path: 'C:\\code\\agent-huddle\\packages\\core\\src\\parse\\number.ts',
        source: 'tool',
        agentKeys: [RK.core],
        tools: ['Edit'],
        writes: 3,
        worktreeStatus: null,
      },
      {
        path: 'packages/core/src/parse/number.test.ts',
        source: 'worktree',
        agentKeys: [],
        tools: [],
        writes: 0,
        worktreeStatus: 'modified',
      },
    ],
    worktree: {
      path: 'C:\\Users\\dev\\.huddle\\worktrees\\run-1a2b',
      branch: 'huddle/run-1a2b',
      filesChanged: 120,
      insertions: 120,
      deletions: 40,
      untracked: 2,
      listed: 50,
      closed: 'kept',
    },
    failures: [
      {
        ts: FAILURE_TS,
        // Null here so the marker fallback in `replayIndexes` stays covered; report.test.tsx sets it.
        index: null,
        agentKey: RK.core,
        kind: 'tool',
        toolName: 'Bash',
        error: 'exit code 1: 2 tests failed\n  at parse-number.test.ts:12',
        interrupted: false,
      },
    ],
    approvals: [
      {
        ts: R0 + 75_000,
        index: null,
        requestId: 'req-npm-test',
        agentKey: RK.core,
        toolName: 'Bash',
        summary: 'npm test -- parser',
        outcome: 'allowed',
        by: 'user',
        policyRuleId: null,
        resolvedAt: R0 + 87_000,
      },
      {
        ts: R0 + 90_000,
        index: null,
        requestId: 'req-git',
        agentKey: RK.core,
        toolName: 'Bash',
        summary: 'git status',
        outcome: 'allowed',
        by: 'policy',
        policyRuleId: 'default:git-status',
        resolvedAt: R0 + 90_010,
      },
      {
        ts: R0 + 95_000,
        index: null,
        requestId: 'req-open',
        agentKey: RK.core,
        toolName: 'WebFetch',
        summary: 'https://example.com',
        outcome: null,
        by: null,
        policyRuleId: null,
        resolvedAt: null,
      },
    ],
    ...more,
  };
}

/** The head markers that carry the report rows' event indexes (the third approval has none). */
export const REPORT_MARKERS: ReplayMarker[] = [
  ...REPLAY_MARKERS,
  { index: 15, ts: R0 + 90_000, kind: 'approval', agentKey: RK.core, itemId: 'approval:req-git' },
  { index: FAILURE_INDEX, ts: FAILURE_TS, kind: 'failure', agentKey: RK.core, itemId: null },
];

export function reportHead(more: Partial<RunHead> = {}): RunHead {
  return replayHead({ markers: REPORT_MARKERS, ...more });
}

export const HOSTILE_MD = '[x](javascript:alert(1)) **b** # h';

/** Every agent-text field of the report carries hostile text. */
export function hostileReport(): RunReport {
  const base = fixReport();
  const [main, explore, core] = base.agents;
  const [failure] = base.failures;
  const [approval, ruled] = base.approvals;
  if (!main || !explore || !core || !failure || !approval || !ruled) throw new Error('fixture');
  return {
    ...base,
    summary: { ...base.summary, title: XSS, topic: HOSTILE_MD, endReason: XSS },
    agents: [
      { ...main, name: XSS },
      { ...explore, name: HOSTILE_MD, title: XSS, result: `${HOSTILE_MD}\n${XSS}` },
      { ...core, title: HOSTILE_MD, tools: [{ toolName: XSS, calls: 1, failures: 0 }] },
    ],
    filesChanged: [
      {
        path: `C:\\code\\agent-huddle\\${XSS}`,
        source: 'tool',
        agentKeys: [RK.core],
        tools: [HOSTILE_MD],
        writes: 1,
        worktreeStatus: null,
      },
    ],
    failures: [{ ...failure, toolName: XSS, error: `${HOSTILE_MD}\n${XSS}` } satisfies ReportFailure],
    approvals: [
      { ...approval, toolName: XSS, summary: HOSTILE_MD } satisfies ReportApproval,
      { ...ruled, policyRuleId: XSS } satisfies ReportApproval,
    ],
  };
}

// ---------------------------------------------------------------------------
// Scorecards (U3): like the canned core's, two models on core-engineer
// ---------------------------------------------------------------------------

export function scorecard(partial: Partial<Scorecard> & Pick<Scorecard, 'role' | 'model'>): Scorecard {
  return {
    runs: 5,
    tasksCompleted: 5,
    units: 5,
    medianTaskMs: 3 * MIN,
    sampleSize: 5,
    tokensPerTask: 10_000,
    tokenSampleSize: 5,
    failureRate: 0,
    toolFailureRate: 0.01,
    approvalsRequested: 0,
    stuckIncidents: 0,
    firstRunAt: NOW_M5 - 10 * DAY,
    lastRunAt: NOW_M5 - HOUR,
    ...partial,
  };
}

export const CANNED_SCORECARDS: Scorecard[] = [
  scorecard({
    role: 'core-engineer',
    model: 'claude-sonnet-5-5',
    runs: 12,
    tasksCompleted: 41,
    units: 41,
    medianTaskMs: 4.2 * MIN,
    sampleSize: 10,
    tokensPerTask: 18_000,
    tokenSampleSize: 10,
    failureRate: 1 / 12,
    toolFailureRate: 0.03,
    approvalsRequested: 9,
    stuckIncidents: 1,
  }),
  scorecard({
    role: 'core-engineer',
    model: 'claude-haiku-5-5',
    runs: 2,
    tasksCompleted: 3,
    units: 3,
    medianTaskMs: 2.1 * MIN,
    sampleSize: 2,
    tokensPerTask: 9_000,
    tokenSampleSize: 2,
    failureRate: 0,
  }),
  scorecard({
    role: 'Explore',
    model: 'claude-haiku-5-5',
    runs: 40,
    tasksCompleted: 0,
    units: 38,
    medianTaskMs: 1.1 * MIN,
    sampleSize: 38,
    tokensPerTask: 6_000,
    tokenSampleSize: 38,
    failureRate: 0.03,
    toolFailureRate: 0.02,
    stuckIncidents: 2,
  }),
  scorecard({
    role: 'main',
    model: null,
    runs: 8,
    medianTaskMs: null,
    sampleSize: 0,
    tokensPerTask: null,
    tokenSampleSize: 0,
    failureRate: null,
    toolFailureRate: null,
  }),
];
