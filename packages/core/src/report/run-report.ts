/**
 * End-of-run report (M5, F23): a session's stored HuddleEvents -> `RunReport`. Pure: no clock, no I/O.
 *
 * What goes in: per-agent rows (agent-runs.ts) plus what each agent did (tools by name, files written, its result
 * line), the files changed (paths only, never contents), failures and approvals. Every free-text field is clipped
 * with CLIP_LIMITS again here, so a report is bounded whatever log it came from. Tool inputs are not read beyond the
 * `filePath` and `summary` the normalizer already kept; `tool_response` never reaches an event.
 *
 * Which events belong to the session: those whose envelope `sessionId` is the session, plus `run.*` and `worktree.*`
 * events of a run launched for it (a worktree is made before the session id is known, under the runId placeholder).
 */
import { CLIP_LIMITS, sessionTopic } from '@huddle/shared';
import type {
  AgentKey,
  AgentRunRow,
  EventOfType,
  HuddleEvent,
  ReportAgent,
  ReportApproval,
  ReportFailure,
  ReportFile,
  ReportSummary,
  ReportToolUse,
  ReportWorktree,
  RunReport,
  TokenCounts,
} from '@huddle/shared';
import { EDIT_TOOLS } from '../detect/conflict.js';
import { clip } from '../text.js';
import { replay, type ReducerState } from '../state/reduce.js';
import { reportNodes, rowFor, scanSession, tokenCounts, type SessionScan } from './agent-runs.js';

function isRunEvent(
  e: HuddleEvent,
): e is EventOfType<
  'run.launched' | 'run.exited' | 'run.result' | 'worktree.created' | 'worktree.summarized' | 'worktree.closed'
> {
  return e.type.startsWith('run.') || e.type.startsWith('worktree.');
}

/** The session's own events plus the run and worktree events of runs launched for it. */
export function sessionEvents(events: readonly HuddleEvent[], sessionId: string): HuddleEvent[] {
  const runIds = new Set<string>();
  for (const e of events) {
    if (e.type !== 'run.launched') continue;
    if (e.claudeSessionId === sessionId || e.sessionId === sessionId) runIds.add(e.runId);
  }
  return events.filter((e) => e.sessionId === sessionId || (isRunEvent(e) && runIds.has(e.runId)));
}

function clipOrNull(text: string | null | undefined, limit: number): string | null {
  return text === null || text === undefined ? null : clip(text, limit);
}

function addTokens(a: TokenCounts | null, b: TokenCounts | null): TokenCounts | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    requests: a.requests + b.requests,
  };
}

interface Activity {
  tools: Map<AgentKey, Map<string, ReportToolUse>>;
  writes: Map<AgentKey, number>;
  files: Map<string, ReportFile>;
  failures: ReportFailure[];
}

/**
 * Where each event sits in the session's stored log (`ReportFailure.index`, `ReportApproval.index`): its position among
 * the events whose `sessionId` is the session's, in the order given. The store keeps a session's rows by
 * `event.sessionId` and the replay index counts those rows (with an event) in `seq` order, so this is the index
 * `history.stateAt` and the scrubber markers use. A run event of another session (`sessionEvents` pulls them in) has
 * no place in this session's replay: null.
 */
function logIndexes(events: readonly HuddleEvent[], sessionId: string): (e: HuddleEvent) => number | null {
  const at = new Map<HuddleEvent, number>();
  let n = 0;
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    at.set(e, n);
    n += 1;
  }
  return (e) => at.get(e) ?? null;
}

/** Tool use, files written and failures, for the agents that have a row. */
function collectActivity(
  events: readonly HuddleEvent[],
  keys: ReadonlySet<AgentKey>,
  indexOf: (e: HuddleEvent) => number | null,
): Activity {
  const tools = new Map<AgentKey, Map<string, ReportToolUse>>();
  const writes = new Map<AgentKey, number>();
  const files = new Map<string, ReportFile>();
  const failures: ReportFailure[] = [];
  const pendingWrites = new Map<string, { agentKey: AgentKey; toolName: string; path: string }>();

  const toolUse = (key: AgentKey, toolName: string): ReportToolUse => {
    let byName = tools.get(key);
    if (byName === undefined) {
      byName = new Map();
      tools.set(key, byName);
    }
    const name = clip(toolName, CLIP_LIMITS.id);
    let use = byName.get(name);
    if (use === undefined) {
      use = { toolName: name, calls: 0, failures: 0 };
      byName.set(name, use);
    }
    return use;
  };

  for (const e of events) {
    switch (e.type) {
      case 'tool.started':
        if (!keys.has(e.agentKey)) break;
        toolUse(e.agentKey, e.toolName).calls += 1;
        // A write counts once it finished: a failed or never-answered Edit changed nothing we can vouch for.
        if (EDIT_TOOLS.has(e.toolName) && e.filePath !== null && e.toolUseId !== null) {
          pendingWrites.set(e.toolUseId, {
            agentKey: e.agentKey,
            toolName: e.toolName,
            path: clip(e.filePath, CLIP_LIMITS.path),
          });
        }
        break;
      case 'tool.finished': {
        if (e.toolUseId === null) break;
        const write = pendingWrites.get(e.toolUseId);
        if (write === undefined) break;
        pendingWrites.delete(e.toolUseId);
        writes.set(write.agentKey, (writes.get(write.agentKey) ?? 0) + 1);
        const id = `tool\u0000${write.path}`;
        const file = files.get(id) ?? {
          path: write.path,
          source: 'tool' as const,
          agentKeys: [],
          tools: [],
          writes: 0,
          worktreeStatus: null,
        };
        file.writes += 1;
        if (!file.agentKeys.includes(write.agentKey)) file.agentKeys.push(write.agentKey);
        if (!file.tools.includes(write.toolName)) file.tools = [...file.tools, write.toolName].sort();
        files.set(id, file);
        break;
      }
      case 'tool.failed':
        if (e.toolUseId !== null) pendingWrites.delete(e.toolUseId);
        if (!keys.has(e.agentKey)) break;
        toolUse(e.agentKey, e.toolName).failures += 1;
        failures.push({
          ts: e.ts,
          index: indexOf(e),
          agentKey: e.agentKey,
          kind: 'tool',
          toolName: clip(e.toolName, CLIP_LIMITS.id),
          error: clip(e.error, CLIP_LIMITS.error),
          interrupted: e.interrupted,
        });
        break;
      case 'turn.failed':
        if (!keys.has(e.agentKey)) break;
        failures.push({
          ts: e.ts,
          index: indexOf(e),
          agentKey: e.agentKey,
          kind: 'turn',
          toolName: null,
          error: clipOrNull(e.error, CLIP_LIMITS.error),
          interrupted: false,
        });
        break;
      default:
        break;
    }
  }
  return { tools, writes, files, failures };
}

function worktreeOf(events: readonly HuddleEvent[]): { worktree: ReportWorktree | null; files: ReportFile[] } {
  let created: EventOfType<'worktree.created'> | null = null;
  let summary: EventOfType<'worktree.summarized'> | null = null;
  let closed: EventOfType<'worktree.closed'> | null = null;
  for (const e of events) {
    if (e.type === 'worktree.created') created = e;
    else if (e.type === 'worktree.summarized') summary = e;
    else if (e.type === 'worktree.closed') closed = e;
  }
  if (created === null && summary === null) return { worktree: null, files: [] };
  const files: ReportFile[] = (summary?.files ?? []).map((f) => ({
    path: clip(f.path, CLIP_LIMITS.path),
    source: 'worktree',
    agentKeys: [],
    tools: [],
    writes: 0,
    worktreeStatus: f.status,
  }));
  return {
    worktree: {
      path: clipOrNull(created?.path, CLIP_LIMITS.path),
      branch: clipOrNull(created?.branch, CLIP_LIMITS.id),
      filesChanged: summary?.filesChanged ?? 0,
      insertions: summary?.insertions ?? 0,
      deletions: summary?.deletions ?? 0,
      untracked: summary?.untracked ?? 0,
      listed: files.length,
      closed: closed?.outcome ?? null,
    },
    files,
  };
}

function runFailures(
  events: readonly HuddleEvent[],
  rootKey: AgentKey,
  indexOf: (e: HuddleEvent) => number | null,
): ReportFailure[] {
  const out: ReportFailure[] = [];
  for (const e of events) {
    if (e.type !== 'run.exited' || (e.how !== 'failed' && e.how !== 'spawn_failed')) continue;
    out.push({
      ts: e.ts,
      index: indexOf(e),
      agentKey: rootKey,
      kind: 'run',
      toolName: null,
      error: clipOrNull(e.error ?? (e.how === 'spawn_failed' ? 'the process did not start' : null), CLIP_LIMITS.error),
      interrupted: false,
    });
  }
  return out;
}

/** The log index of the request that opened each approval: the first `approval.requested` per request id (as the scan). */
function requestIndexes(
  events: readonly HuddleEvent[],
  indexOf: (e: HuddleEvent) => number | null,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const e of events) {
    if (e.type === 'approval.requested' && !out.has(e.request.requestId)) out.set(e.request.requestId, indexOf(e));
  }
  return out;
}

function approvalsOf(
  scan: SessionScan,
  keys: ReadonlySet<AgentKey>,
  requestIndex: ReadonlyMap<string, number | null>,
): ReportApproval[] {
  return scan.approvals
    .filter((a) => keys.has(a.agentKey))
    .map((a) => ({
      ts: a.ts,
      index: requestIndex.get(a.requestId) ?? null,
      requestId: clip(a.requestId, CLIP_LIMITS.id),
      agentKey: a.agentKey,
      toolName: clip(a.toolName, CLIP_LIMITS.id),
      summary: clip(a.summary, CLIP_LIMITS.summary),
      outcome: a.resolution?.outcome ?? null,
      by: a.resolution?.by ?? null,
      policyRuleId: clipOrNull(a.resolution?.policyRuleId, CLIP_LIMITS.id),
      resolvedAt: a.resolution?.ts ?? null,
    }));
}

function sum(rows: readonly AgentRunRow[], pick: (r: AgentRunRow) => number): number {
  return rows.reduce((s, r) => s + pick(r), 0);
}

function lastOf<T extends HuddleEvent['type']>(events: readonly HuddleEvent[], type: T): EventOfType<T> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === type) return e as EventOfType<T>;
  }
  return null;
}

function sessionTitle(events: readonly HuddleEvent[]): string | null {
  let title: string | null = null;
  for (const e of events) if (e.type === 'session.started' && e.title !== null) title = e.title;
  return title;
}

export interface BuildRunReportOptions {
  /**
   * `replay(sessionEvents(allEvents, sessionId))`, when the caller already has it: the history service folds a long
   * log in chunks and yields between them (runtime/history.ts), so the hook server is not blocked by one long replay.
   * Must be exactly that state; anything else gives a wrong report.
   */
  state?: ReducerState;
}

/** The report for one session, or null when the events hold no root for it. */
export function buildRunReport(
  allEvents: readonly HuddleEvent[],
  sessionId: string,
  options: BuildRunReportOptions = {},
): RunReport | null {
  const events = sessionEvents(allEvents, sessionId);
  const state = options.state ?? replay(events);
  const scan = scanSession(events);
  const nodes = reportNodes(state, sessionId);
  const root = nodes.find((n) => n.kind === 'main');
  if (root === undefined) return null;

  const keys = new Set(nodes.map((n) => n.key));
  const indexOf = logIndexes(events, sessionId);
  const activity = collectActivity(events, keys, indexOf);
  const rows = nodes.map((n) => rowFor(n, scan));

  const agents: ReportAgent[] = nodes.map((node, i) => ({
    row: rows[i] as AgentRunRow,
    name: clip(node.name, CLIP_LIMITS.summary),
    title: node.kind === 'main' ? null : clipOrNull(node.handoff?.title, CLIP_LIMITS.summary),
    result: node.kind === 'main' ? null : clipOrNull(node.handoff?.result, CLIP_LIMITS.summary),
    tools: [...(activity.tools.get(node.key)?.values() ?? [])].sort(
      (a, b) => b.calls - a.calls || (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0),
    ),
    fileWrites: activity.writes.get(node.key) ?? 0,
  }));

  const { worktree, files: worktreeFiles } = worktreeOf(events);
  const byPath = (a: ReportFile, b: ReportFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const filesChanged = [...[...activity.files.values()].sort(byPath), ...worktreeFiles.sort(byPath)];

  const failures = [...activity.failures, ...runFailures(events, root.key, indexOf)].sort((a, b) => a.ts - b.ts);
  const approvals = approvalsOf(scan, keys, requestIndexes(events, indexOf));

  const rootRow = rows[nodes.indexOf(root)] as AgentRunRow;
  const agentTokens = rows.reduce<TokenCounts | null>((acc, r) => addTokens(acc, r.tokens), null);
  const helperTokens = tokenCounts(root.helperUsage);
  const helperCost = helperTokens === null ? null : (root.helperUsage?.estimatedCostUsd ?? 0);
  const costs = [...rows.map((r) => r.estimatedCostUsd), helperCost].filter((c): c is number => c !== null);
  const ended = lastOf(events, 'session.ended');

  const summary: ReportSummary = {
    title: clipOrNull(sessionTitle(events), CLIP_LIMITS.summary),
    topic: clipOrNull(sessionTopic(root.lastPrompt, root.firstPrompt), CLIP_LIMITS.summary),
    cwd: clipOrNull(root.sessionCwd ?? root.cwd, CLIP_LIMITS.path),
    model: rootRow.model,
    origin: root.origin,
    startedAt: rootRow.startedAt,
    endedAt: rootRow.endedAt,
    durationMs: rootRow.durationMs,
    outcome: rootRow.outcome,
    endReason: ended === null ? null : clip(ended.reason, CLIP_LIMITS.id),
    agents: rows.length,
    toolCalls: sum(rows, (r) => r.toolCalls),
    toolFailures: sum(rows, (r) => r.toolFailures),
    tasksCompleted: sum(rows, (r) => r.tasksCompleted),
    approvalsRequested: sum(rows, (r) => r.approvals.requested),
    stuckIncidents: sum(rows, (r) => r.stuckIncidents),
    tokens: agentTokens,
    tokensPartial: agentTokens !== null && rows.some((r) => r.tokens === null),
    helperTokens,
    estimatedCostUsd: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0),
    costPartial:
      rows.some((r) => r.costPartial || (r.tokens === null && costs.length > 0)) ||
      (root.helperUsage?.requestsWithoutCost ?? 0) > 0,
  };

  return { version: 1, sessionId, summary, agents, filesChanged, worktree, failures, approvals };
}
