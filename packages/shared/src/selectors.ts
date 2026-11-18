/**
 * Selectors: read-only views over HuddleState for the UI (F1 tree, F2 identity, F3 status, F8 timeline).
 * Pure functions; derived values such as sort order and roll-ups are computed here, never stored in state.
 */
import type {
  AgentKey,
  AgentKind,
  AgentNode,
  AgentStatus,
  ApprovalRequest,
  AttentionItem,
  ConnectionStatus,
  EtaPriors,
  Handoff,
  HuddleState,
  ProgressEstimate,
  QuestionRequest,
  TaskItem,
  TokenUsage,
} from './model.js';
import type { HuddleEvent } from './events.js';
import { EMPTY_USAGE, priorKey } from './model.js';
import { estimateProgress, estimateSubagentProgress } from './progress.js';
import type { EtaParams, SelfReport } from './progress.js';
import { roleKindOf, type RoleKindOverrides } from './roles.js';

const TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['done', 'failed', 'stopped']);

/**
 * True when an approval's summary does not show the whole command (AX-01): the request says so, or, for a request
 * stored before `hidden` existed, the summary holds the mask marker or ends in the clip ellipsis. Errs towards true,
 * which only adds a warning (and on the phone, sends the decision to the computer). Pure.
 */
export function approvalTextHidden(req: Pick<ApprovalRequest, 'summary' | 'hidden'>): boolean {
  return req.hidden === true || req.summary.includes('<redacted>') || req.summary.endsWith('…');
}

/** done, failed and stopped: the agent will not do more work. */
export function isTerminal(status: AgentStatus): boolean {
  return TERMINAL.has(status);
}

/** The agent timeline shows at most this many rows (the most recent ones). */
export const TIMELINE_LIMIT = 500;

export interface TreeNodeView {
  key: AgentKey;
  agentId: string | null;
  kind: AgentKind;
  name: string;
  role: string;
  roleDescription: string | null;
  model: string | null;
  status: AgentStatus;
  currentActivity: string | null;
  /** How this node was tied to its parent; null for the main agent. */
  link: Handoff['link'] | null;
  /** Finished (done, failed, stopped), or its session ended: render dimmed. */
  dimmed: boolean;
  /**
   * Its session is stale (see SessionView.stale) and it had not finished: `status` is the last one seen before the
   * Huddle restarted, not a live reading. A finished node (done, failed, stopped) is never stale: that status is
   * final. Present only when the selector was given `huddleStartedAt`; absent means "not known", treat as false.
   */
  stale?: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Children ordered by start time. */
  children: TreeNodeView[];
}

export interface SessionView {
  sessionId: string;
  rootKey: AgentKey;
  cwd: string | null;
  /** The session has ended (SessionEnd); its agents stay listed, dimmed. */
  ended: boolean;
  /**
   * Not ended, and nothing heard from it since the Huddle started: it was only replayed from the log, so its
   * statuses are the ones from before the restart. It turns live again with its next event (which moves
   * lastActivityAt past the start). Present only when the selector was given `huddleStartedAt`.
   */
  stale?: boolean;
  /** Latest event time anywhere in the session's tree. */
  lastActivityAt: number;
  /** Visible agents, main included. */
  agentCount: number;
  statusCounts: Record<AgentStatus, number>;
  root: TreeNodeView;
}

/** Options for the session selectors. Without them the output is exactly as before (no `stale` fields). */
export interface TreeOptions {
  /**
   * Epoch ms the Huddle started, normally `state.connection?.startedAt`. Passed in, never read from a clock, so the
   * selectors stay pure.
   */
  huddleStartedAt?: number;
}

const HIDDEN_ROLES: ReadonlySet<string> = new Set(['']);

/** Hidden helpers never get a node (the normalizer drops them); this is a second guard. */
function isVisible(node: AgentNode): boolean {
  return !HIDDEN_ROLES.has(node.role);
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function emptyCounts(): Record<AgentStatus, number> {
  return {
    starting: 0,
    working: 0,
    waiting_approval: 0,
    waiting_answer: 0,
    paused: 0,
    idle: 0,
    done: 0,
    failed: 0,
    stopped: 0,
  };
}

function byStart(a: AgentNode, b: AgentNode): number {
  return a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

interface Walk {
  lastActivityAt: number;
  count: number;
  counts: Record<AgentStatus, number>;
  seen: Set<AgentKey>;
}

function buildNode(state: HuddleState, node: AgentNode, sessionEnded: boolean, walk: Walk): TreeNodeView {
  walk.seen.add(node.key);
  walk.count += 1;
  walk.counts[node.status] += 1;
  walk.lastActivityAt = Math.max(walk.lastActivityAt, node.lastEventAt);
  const children = node.childKeys
    .map((key) => getOwn(state.agents, key))
    .filter((child): child is AgentNode => child !== undefined && isVisible(child) && !walk.seen.has(child.key))
    .sort(byStart)
    .map((child) => buildNode(state, child, sessionEnded, walk));
  return {
    key: node.key,
    agentId: node.agentId,
    kind: node.kind,
    name: node.name,
    role: node.role,
    roleDescription: node.roleDescription,
    model: node.model,
    status: node.status,
    currentActivity: node.currentActivity,
    link: node.kind === 'main' ? null : (node.handoff?.link ?? 'unknown'),
    dimmed: sessionEnded || isTerminal(node.status),
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    children,
  };
}

/**
 * The task the agent is working on now (F4): the pending task with the latest `startedAt` (task.started, from a
 * TaskUpdate to in_progress). Null when no pending task was started, including agents without a task list. On a tie
 * the later task in the list wins.
 */
export function selectCurrentTask(agent: AgentNode): TaskItem | null {
  let current: TaskItem | null = null;
  let latest = -Infinity;
  for (const task of agent.tasks) {
    if (task.status !== 'pending' || task.startedAt === undefined) continue;
    if (task.startedAt >= latest) {
      current = task;
      latest = task.startedAt;
    }
  }
  return current;
}

function withStale(node: TreeNodeView, stale: boolean): TreeNodeView {
  // A finished agent's status is final, so it is not in doubt after a restart.
  return {
    ...node,
    stale: stale && !isTerminal(node.status),
    children: node.children.map((child) => withStale(child, stale)),
  };
}

/** Last event of the session (anywhere in its tree) is older than the Huddle's start, and it has not ended. */
function isStale(ended: boolean, lastActivityAt: number, huddleStartedAt: number | undefined): boolean {
  return !ended && huddleStartedAt !== undefined && lastActivityAt < huddleStartedAt;
}

/** One view of one session, or null when the root is unknown. */
export function selectSession(state: HuddleState, rootKey: AgentKey, opts?: TreeOptions): SessionView | null {
  const root = getOwn(state.agents, rootKey);
  if (root === undefined || root.kind !== 'main') return null;
  const ended = root.endedAt !== null;
  const walk: Walk = { lastActivityAt: root.lastEventAt, count: 0, counts: emptyCounts(), seen: new Set() };
  const view = buildNode(state, root, ended, walk);
  const session: SessionView = {
    sessionId: root.sessionId,
    rootKey: root.key,
    cwd: root.cwd,
    ended,
    lastActivityAt: walk.lastActivityAt,
    agentCount: walk.count,
    statusCounts: walk.counts,
    root: view,
  };
  const startedAt = opts?.huddleStartedAt;
  if (startedAt === undefined) return session;
  const stale = isStale(ended, walk.lastActivityAt, startedAt);
  return { ...session, stale, root: withStale(view, stale) };
}

/**
 * The team tree (F1): every session, most recently active first; under each main agent its subagents,
 * nested under the agent that spawned them and ordered by start. Finished agents stay, dimmed.
 * With `opts.huddleStartedAt`, sessions not heard from since the Huddle started are marked `stale`.
 */
export function selectTree(state: HuddleState, opts?: TreeOptions): SessionView[] {
  const sessions: SessionView[] = [];
  for (const key of state.rootKeys) {
    const view = selectSession(state, key, opts);
    if (view !== null) sessions.push(view);
  }
  return sessions.sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt || (a.rootKey < b.rootKey ? -1 : a.rootKey > b.rootKey ? 1 : 0),
  );
}

/** The full node for the detail pane, or null. */
export function selectAgent(state: HuddleState, key: AgentKey): AgentNode | null {
  return getOwn(state.agents, key) ?? null;
}

/**
 * Agents that need the user right now (waiting for approval or an answer), for the widget header.
 * With `opts.huddleStartedAt`, agents of stale sessions are not counted: a request from before the restart can no
 * longer be answered here.
 */
export function selectNeedsYouCount(state: HuddleState, opts?: TreeOptions): number {
  const staleSessions = selectStaleSessionIds(state, opts);
  let n = 0;
  for (const node of Object.values(state.agents)) {
    if (staleSessions.has(node.sessionId)) continue;
    if (node.status === 'waiting_approval' || node.status === 'waiting_answer') n += 1;
  }
  return n;
}

/** The session ids `selectTree(state, opts)` marks stale (empty without `huddleStartedAt`). */
export function selectStaleSessionIds(state: HuddleState, opts?: TreeOptions): Set<string> {
  const ids = new Set<string>();
  if (opts?.huddleStartedAt === undefined) return ids;
  for (const session of selectTree(state, opts)) if (session.stale === true) ids.add(session.sessionId);
  return ids;
}

// ---------------------------------------------------------------------------
// Timeline (F8)
// ---------------------------------------------------------------------------

export type TimelineKind =
  | 'prompt'
  | 'tool'
  | 'failure'
  | 'approval'
  | 'question'
  | 'task'
  | 'compaction'
  | 'agent'
  | 'turn'
  | 'session'
  | 'model'
  | 'notification'
  | 'rename';

export interface TimelineEntry {
  /** The event id the row came from. */
  id: string;
  ts: number;
  kind: TimelineKind;
  /** Short label. Plain text: render as text, never as HTML. */
  title: string;
  /** One line of detail (command, path, message), or null. Plain text. */
  detail: string | null;
  /** For tool rows: time until tool.finished or tool.failed, when known. */
  durationMs: number | null;
}

const PROMPT_TITLES = {
  user: 'Prompt',
  task_notification: 'Subagent finished',
  agent_message: 'Message from an agent',
} as const;

function entryFor(event: HuddleEvent, taskSubjects: Map<string, string>): TimelineEntry | null {
  const base = { id: event.id, ts: event.ts, durationMs: null };
  switch (event.type) {
    case 'prompt.submitted':
      return { ...base, kind: 'prompt', title: PROMPT_TITLES[event.kind ?? 'user'], detail: event.text };
    case 'tool.started':
      return { ...base, kind: 'tool', title: event.toolName, detail: event.summary };
    case 'tool.failed':
      return { ...base, kind: 'failure', title: `${event.toolName} failed`, detail: event.error || null };
    case 'turn.failed':
      return { ...base, kind: 'failure', title: 'Turn failed', detail: event.error };
    case 'approval.requested':
      return {
        ...base,
        kind: 'approval',
        title: `Approval requested: ${event.request.toolName}`,
        detail: event.request.summary,
      };
    case 'approval.resolved':
      return { ...base, kind: 'approval', title: `Approval ${event.outcome}`, detail: event.message };
    case 'question.asked':
      return {
        ...base,
        kind: 'question',
        title: 'Question asked',
        detail: event.request.questions[0]?.question ?? null,
      };
    case 'question.answered':
      return { ...base, kind: 'question', title: 'Question answered', detail: null };
    case 'task.created':
      taskSubjects.set(event.taskId, event.subject);
      return { ...base, kind: 'task', title: 'Task created', detail: event.subject };
    case 'task.started':
      return { ...base, kind: 'task', title: 'Task started', detail: taskSubjects.get(event.taskId) ?? null };
    case 'task.completed':
      return { ...base, kind: 'task', title: 'Task completed', detail: taskSubjects.get(event.taskId) ?? null };
    case 'context.compacted':
      return {
        ...base,
        kind: 'compaction',
        title: event.phase === 'before' ? 'Compaction started' : 'Compaction finished',
        detail: event.trigger,
      };
    case 'agent.started':
      return { ...base, kind: 'agent', title: `Started as ${event.role}`, detail: null };
    case 'agent.stopped':
      return { ...base, kind: 'agent', title: 'Finished', detail: event.result };
    case 'turn.ended':
      return { ...base, kind: 'turn', title: 'Turn ended', detail: event.lastMessage };
    case 'session.started':
      return { ...base, kind: 'session', title: `Session ${event.startKind}`, detail: event.cwd };
    case 'session.ended':
      return { ...base, kind: 'session', title: 'Session ended', detail: event.reason };
    case 'model.changed':
      return { ...base, kind: 'model', title: 'Model changed', detail: event.to };
    case 'notification.raised':
      return { ...base, kind: 'notification', title: 'Notification', detail: event.message };
    case 'control.applied':
      return event.action === 'rename' ? { ...base, kind: 'rename', title: 'Renamed', detail: event.detail } : null;
    default:
      return null;
  }
}

/**
 * The activity timeline of one agent (F8), oldest first, at most `limit` rows (the most recent).
 * `events` is that agent's slice of the log in log order (for example from `huddle:get-events`); events of
 * other agents are ignored. A tool row gets its duration from the matching tool.finished or tool.failed.
 */
export function selectTimeline(
  events: readonly HuddleEvent[],
  key: AgentKey,
  limit: number = TIMELINE_LIMIT,
): TimelineEntry[] {
  const rows: TimelineEntry[] = [];
  const openTools = new Map<string, number>();
  const taskSubjects = new Map<string, string>();
  for (const event of events) {
    if (event.agentKey !== key) continue;
    if ((event.type === 'tool.finished' || event.type === 'tool.failed') && event.toolUseId !== null) {
      const index = openTools.get(event.toolUseId);
      const row = index === undefined ? undefined : rows[index];
      if (index !== undefined && row !== undefined) {
        const durationMs =
          event.type === 'tool.finished' && event.durationMs !== null ? event.durationMs : event.ts - row.ts;
        rows[index] = { ...row, durationMs: Math.max(0, durationMs) };
        openTools.delete(event.toolUseId);
      }
    }
    const entry = entryFor(event, taskSubjects);
    if (entry === null) continue;
    if (event.type === 'tool.started' && event.toolUseId !== null) openTools.set(event.toolUseId, rows.length);
    rows.push(entry);
  }
  const max = Math.max(0, Math.floor(limit));
  return rows.length > max ? rows.slice(rows.length - max) : rows;
}

// ---------------------------------------------------------------------------
// Meter (F4 progress, F5 usage, F6 context)
// ---------------------------------------------------------------------------

/** A progress estimate plus the subagent counts behind basis 'subagents' (both 0 for other bases). */
export interface ProgressView extends ProgressEstimate {
  finishedSubagents: number;
  startedSubagents: number;
}

export interface ProgressOptions {
  /**
   * A self-report to use instead of the agent's own (`AgentNode.selfReport` through `selfReportFor`, F27). Absent:
   * the agent's own; null: none. Used only for an agent without subagents (ADR-010 order).
   */
  selfReport?: SelfReport | null;
  /** Typical time per unit (subagent or task) from past runs, if known. When given, `priors` is not consulted. */
  priorUnitMs?: number | null;
  /**
   * ETA priors from the scorecards (`state.priors`, M5 F24). Consulted only when `priorUnitMs` is not given and
   * `usePriors` is on. Subagent basis: the mean prior of the direct subagents' (role, model) pairs that have one (a
   * subagent is one unit of its parent's work). Task basis: the agent's own (role, model) prior. No prior for the
   * pair: no prior, as before.
   */
  priors?: EtaPriors | null;
  /** Whether `priors` is used (default USE_ETA_PRIORS); the evaluation harness compares both. */
  usePriors?: boolean;
  /** Constants to use instead of the exported ones (evaluation harness only). */
  params?: EtaParams;
}

/**
 * Whether the ETA uses the scorecard priors (`ProgressOptions.priors`) by default. Chosen by the leave-one-out
 * evaluation over fixtures/runs (`npm run eval:eta`, M5 WP7): the priors of each run come from the other runs only.
 */
export const USE_ETA_PRIORS = true;

/**
 * The prior ms per unit for one (role, model) from `HuddleState.priors`, or null when there is none. Defensive about
 * the shape: the state crossed IPC, so a value that is not a finite positive number counts as no prior.
 */
export function priorMsFor(
  priors: EtaPriors | null | undefined,
  role: string,
  model: string | null,
  roleKinds: RoleKindOverrides | null | undefined = null,
): number | null {
  if (priors === null || priors === undefined) return null;
  const value = getOwn(priors.byRoleModel, priorKey(role, model));
  if (isPositive(value)) return value;
  return kindPriorMs(priors, role, model, roleKinds);
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Fallback for a role with no prior of its own (2026-11-18, agent types by role): the mean prior of the other roles of
 * the same type on the same model ("a new reviewer takes about as long as the reviewers before it"). Never for
 * 'general', which says nothing about the work. Null when no role of that type has a prior.
 */
function kindPriorMs(
  priors: EtaPriors,
  role: string,
  model: string | null,
  roleKinds: RoleKindOverrides | null | undefined,
): number | null {
  const kind = roleKindOf(role, null, roleKinds);
  if (kind === 'general' || model === null) return null;
  const known: number[] = [];
  for (const [key, ms] of Object.entries(priors.byRoleModel)) {
    if (!isPositive(ms)) continue;
    let pair: unknown;
    try {
      pair = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || pair[1] !== model) continue;
    if (roleKindOf(pair[0], null, roleKinds) === kind) known.push(ms);
  }
  return known.length === 0 ? null : known.reduce((s, ms) => s + ms, 0) / known.length;
}

/** Mean prior over the subagents that have one; null when none has. */
function subagentPrior(
  priors: EtaPriors | null | undefined,
  children: readonly AgentNode[],
  roleKinds: RoleKindOverrides | null | undefined,
): number | null {
  const known = children.flatMap((c) => {
    const ms = priorMsFor(priors, c.role, c.model, roleKinds);
    return ms === null ? [] : [ms];
  });
  return known.length === 0 ? null : known.reduce((s, ms) => s + ms, 0) / known.length;
}

function directChildren(state: HuddleState, node: AgentNode): AgentNode[] {
  const seen = new Set<AgentKey>();
  const out: AgentNode[] = [];
  for (const key of node.childKeys) {
    const child = getOwn(state.agents, key);
    if (child === undefined || seen.has(key) || !isVisible(child)) continue;
    seen.add(key);
    out.push(child);
  }
  return out;
}

/**
 * A self-report older than this, from an agent that is still in its turn, no longer counts (F27).
 *
 * Why 10 minutes: agents are asked to report at the start, after each major step and before they finish, so a working
 * agent that has said nothing for 10 minutes is past the step its number described. By then the blend in
 * `estimateProgress` has already cut the report to an eighth of the say (two 5-minute half-lives); without a cut-off
 * an agent with no tasks would keep showing that old number alone, frozen. Once the agent is idle or has ended, it
 * did no more work after its report, so time passing does not make the report staler and it keeps counting.
 */
export const SELF_REPORT_STALE_MS = 10 * 60_000;

/**
 * The agent's own latest self-report as `estimateProgress` takes it, or null when it never reported, or the report is
 * stale (`SELF_REPORT_STALE_MS`, only while the agent is in its turn). Only this agent's report: a subagent's report
 * is about its own task and never stands for its parent's or the run's progress.
 */
export function selfReportFor(node: AgentNode, now: number): SelfReport | null {
  const report = node.selfReport;
  if (report === undefined || report === null) return null;
  const inTurn = node.status !== 'idle' && !isTerminal(node.status) && node.endedAt === null;
  if (inTurn && now - report.at > SELF_REPORT_STALE_MS) return null;
  return { fraction: report.fraction, etaMinutes: report.minutesLeft, reportedAt: report.at };
}

/**
 * Progress and ETA of one agent (F4, ADR-010), computed at `now` (passed in, never read from a clock).
 * Basis order: (1) direct subagents finished / started, a running one counting as not done (an agent-team teammate
 * counts as finished only when done, i.e. after the lead reported it finished with report_teammate; an idle teammate
 * waits for messages and counts as open; M6 P5b, ADR-027); (2) the agent's own
 * self-report (`selfReportFor`; with tasks too, blended as `estimateProgress` defines); (3) its task list. With none
 * of these: fraction null, etaMs null, basis 'none'.
 * Null when the key is unknown. Use this, not `AgentNode.progress`.
 */
export function selectProgress(
  state: HuddleState,
  key: AgentKey,
  now: number,
  opts?: ProgressOptions,
): ProgressView | null {
  const node = getOwn(state.agents, key);
  if (node === undefined) return null;
  const children = directChildren(state, node);
  const explicit = opts?.priorUnitMs;
  const priors = (opts?.usePriors ?? USE_ETA_PRIORS) ? (opts?.priors ?? null) : null;
  const priorUnitMs = explicit !== undefined ? explicit : subagentPrior(priors, children, state.settings?.roleKinds);
  const priorTaskMs =
    explicit !== undefined ? explicit : priorMsFor(priors, node.role, node.model, state.settings?.roleKinds);
  const units = children.map((child) => ({
    startedAt: child.startedAt,
    completedAt: isTerminal(child.status) ? (child.endedAt ?? child.lastEventAt) : null,
  }));
  // While the parent is still in its turn, its own wrap-up is one more unit: the bar does not reach 1 before the turn
  // ends. An idle parent has finished its turn (it waits for the next prompt), so nothing is left to wrap up.
  const parentWrapUp = node.status !== 'idle' && !isTerminal(node.status) && node.endedAt === null;
  const bySubagents = estimateSubagentProgress(units, now, {
    priorUnitMs,
    parentWrapUp,
    ...(opts?.params !== undefined ? { params: opts.params } : {}),
  });
  if (bySubagents !== null) {
    const finished = units.filter((u) => u.completedAt !== null).length;
    return { ...bySubagents, finishedSubagents: finished, startedSubagents: units.length };
  }
  const estimate = estimateProgress({
    tasks: node.tasks,
    selfReport: opts?.selfReport !== undefined ? opts.selfReport : selfReportFor(node, now),
    now,
    startedAt: node.startedAt,
    priorTaskMs,
  });
  return { ...estimate, finishedSubagents: 0, startedSubagents: 0 };
}

export interface UsageRollup {
  /** Sum over the agent and all its descendants (plus the root's helper requests). Null when nothing was recorded. */
  usage: TokenUsage | null;
  /** Some agent in the subtree has no usage records yet: the total is a lower bound. */
  partial: boolean;
  /** Agents summed (the agent itself included). */
  agentCount: number;
  /** Helper requests (title generation and the like) kept on the root, shown separately; null when none. */
  helperUsage: TokenUsage | null;
}

function isUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.inputTokens === 'number' &&
    typeof v.outputTokens === 'number' &&
    typeof v.cacheReadTokens === 'number' &&
    typeof v.cacheCreationTokens === 'number' &&
    typeof v.requests === 'number' &&
    typeof v.estimatedCostUsd === 'number'
  );
}

/** Adds every numeric field, so optional counters added to TokenUsage later are summed too. */
function addUsage(into: Record<string, number>, part: TokenUsage): void {
  for (const [field, value] of Object.entries(part)) {
    if (typeof value === 'number' && Number.isFinite(value)) into[field] = (into[field] ?? 0) + value;
  }
}

function hasRecords(usage: TokenUsage): boolean {
  return usage.requests > 0;
}

/**
 * Token usage of an agent rolled up over all its descendants (F5). On a root, the session's helper usage
 * (`helperUsage`, when present) counts in the total and is also returned on its own. Unknown stays unknown:
 * with no record anywhere, `usage` is null, never zeros. Null when the key is unknown.
 */
export function selectUsageRollup(state: HuddleState, key: AgentKey): UsageRollup | null {
  const root = getOwn(state.agents, key);
  if (root === undefined) return null;
  const sum: Record<string, number> = {};
  let any = false;
  let partial = false;
  let agentCount = 0;
  const seen = new Set<AgentKey>();
  const stack: AgentNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AgentNode;
    if (seen.has(node.key)) continue;
    seen.add(node.key);
    agentCount += 1;
    if (hasRecords(node.usage)) {
      any = true;
      addUsage(sum, node.usage);
    } else {
      partial = true;
    }
    for (const childKey of node.childKeys) {
      const child = getOwn(state.agents, childKey);
      if (child !== undefined && !seen.has(childKey)) stack.push(child);
    }
  }
  // helperUsage is added to AgentNode in M2 (root only); read it defensively so this works before and after.
  const rawHelper: unknown = root.kind === 'main' && 'helperUsage' in root ? root.helperUsage : undefined;
  const helperUsage = isUsage(rawHelper) && hasRecords(rawHelper) ? rawHelper : null;
  if (helperUsage !== null) {
    any = true;
    addUsage(sum, helperUsage);
  }
  return {
    usage: any ? { ...EMPTY_USAGE, ...sum } : null,
    partial,
    agentCount,
    helperUsage,
  };
}

export const DEFAULT_CONTEXT_WARNING_PCT = 80;

export type ContextWarning = 'none' | 'high' | 'unknown';

/** F6: 'high' at or above the threshold (percent, 0..100), 'unknown' when context use is not measured. */
export function selectContextWarning(
  node: Pick<AgentNode, 'context'>,
  thresholdPct: number = DEFAULT_CONTEXT_WARNING_PCT,
): ContextWarning {
  const pct = node.context.usedPct;
  if (pct === null || !Number.isFinite(pct)) return 'unknown';
  return pct >= thresholdPct ? 'high' : 'none';
}

// ---------------------------------------------------------------------------
// Controls (M3: F10 approvals, F11 questions, F12 messages, F13 pause)
// ---------------------------------------------------------------------------

export type ControlName =
  'approve' | 'deny' | 'passThrough' | 'answer' | 'message' | 'messageTurnEnd' | 'pause' | 'resume' | 'cancelMessage';

export interface ControlState {
  enabled: boolean;
  /** Why it is disabled, in words for the user (a tooltip or a line under the button); null when enabled. */
  reason: string | null;
}

export type ControlsView = Record<ControlName, ControlState>;

/** Words for the reasons, in one place so the UI and tests agree. */
export const CONTROL_REASONS = {
  notConnected: "Huddle isn't connected to Claude Code yet.",
  portInUse: "Huddle can't receive from Claude Code: its port is in use by another program.",
  connectionError: "Huddle can't reach Claude Code right now.",
  ended: 'This agent is no longer running.',
  noApprove: "This agent's requests can't be answered from Huddle.",
  noAnswer: "This agent's questions can't be answered from Huddle. Answer in the terminal.",
  noMessage: "This agent can't be messaged from Huddle.",
  noFollowUp: 'Subagents get messages at their next tool call only.',
  noPause: "This agent can't be paused from Huddle.",
  noApproval: 'Nothing is waiting for approval.',
  noQuestion: 'No question is waiting for an answer.',
  answered: 'This was already answered.',
  /** No longer used since S14 b wired multi-select and typed answers (kept: the words are a stable export). */
  multiSelectOrText: 'Questions with several choices or a typed answer are answered in the terminal for now.',
  ambiguousChoice: 'Two choices or questions look the same here, so answer this one in the terminal.',
  beforeRestart: 'This came in before Huddle restarted, so it can only be answered in the terminal.',
  holdBeforeRestart: 'This pause was set before Huddle restarted and has already been released.',
  alreadyPaused: 'Already paused.',
  pausePending: 'Pausing at the next tool call.',
  notPaused: "This agent isn't paused.",
  noQueued: 'No message is waiting to be delivered.',
} as const;

const ON: ControlState = { enabled: true, reason: null };

function off(reason: string): ControlState {
  return { enabled: false, reason };
}

function connectionReason(connection: ConnectionStatus | undefined): string | null {
  if (connection === undefined) return CONTROL_REASONS.notConnected;
  switch (connection.status) {
    case 'attached':
      return null;
    case 'needs_consent':
      return CONTROL_REASONS.notConnected;
    case 'port_in_use':
      return CONTROL_REASONS.portInUse;
    default:
      return CONTROL_REASONS.connectionError;
  }
}

/** True when the list has a value twice. */
function hasRepeat(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * The shown question words are masked and clipped, so two options (or two questions) can look the same although
 * Claude Code's are different. An answer could then reach the wrong one: such a question is answered in the terminal.
 * Pure; the broker refuses an answer for it with the same rule.
 */
export function questionIsAmbiguous(question: Pick<QuestionRequest, 'questions'>): boolean {
  return (
    hasRepeat(question.questions.map((q) => q.question)) ||
    question.questions.some((q) => hasRepeat(q.options.map((o) => o.label))) ||
    // A multi-select answer joins the chosen labels with ", " (S14 b): a label that holds ", " could be read as two.
    question.questions.some((q) => q.multiSelect && q.options.some((o) => o.label.includes(', ')))
  );
}

/**
 * What the user can do with this agent right now (M3), with a reason for every disabled control. Pure: the connection
 * and the Huddle's start time are passed in (`state.connection`, `state.connection?.startedAt`).
 *
 * `item` is the inbox item the request controls are for: approve and deny need an open approval item of this agent,
 * answer an open question item, and passThrough either one ("answer in terminal" for a question, whatever its shape);
 * without one they are disabled. A request (or a pause hold) from before
 * `huddleStartedAt` belonged to an earlier Huddle process, whose held connection is gone, so its controls are disabled.
 * Checks run in order: connection, agent ended, capability, then the request or hold itself.
 */
export function selectControls(
  agent: AgentNode,
  connection: ConnectionStatus | undefined,
  huddleStartedAt: number | undefined,
  item: AttentionItem | null = null,
): ControlsView {
  const common =
    connectionReason(connection) ?? (isTerminal(agent.status) || agent.endedAt !== null ? CONTROL_REASONS.ended : null);
  const beforeStart = (ts: number): boolean => huddleStartedAt !== undefined && ts < huddleStartedAt;
  const caps = agent.capabilities;
  const mine = item !== null && item.agentKey === agent.key ? item : null;

  const approval = ((): ControlState => {
    if (common !== null) return off(common);
    if (!caps.approve) return off(CONTROL_REASONS.noApprove);
    const request = mine?.kind === 'approval' ? (mine.approval ?? null) : null;
    if (mine === null || request === null) return off(CONTROL_REASONS.noApproval);
    if (mine.resolvedAt !== null) return off(CONTROL_REASONS.answered);
    if (beforeStart(request.receivedAt)) return off(CONTROL_REASONS.beforeRestart);
    return ON;
  })();

  const answer = ((): ControlState => {
    if (common !== null) return off(common);
    if (!caps.answerQuestions) return off(CONTROL_REASONS.noAnswer);
    const question = mine?.kind === 'question' ? (mine.question ?? null) : null;
    if (mine === null || question === null) return off(CONTROL_REASONS.noQuestion);
    if (mine.resolvedAt !== null) return off(CONTROL_REASONS.answered);
    if (questionIsAmbiguous(question)) return off(CONTROL_REASONS.ambiguousChoice);
    if (beforeStart(question.receivedAt)) return off(CONTROL_REASONS.beforeRestart);
    return ON;
  })();

  // "Answer in terminal" is `approval.passThrough` with the question's request id (control.ts). It needs a question this Huddle holds:
  // open, answerable from here (the broker holds none otherwise), and received since this Huddle started.
  const questionPassThrough = ((): ControlState => {
    if (common !== null) return off(common);
    if (!caps.answerQuestions) return off(CONTROL_REASONS.noAnswer);
    const question = mine?.kind === 'question' ? (mine.question ?? null) : null;
    if (mine === null || question === null) return off(CONTROL_REASONS.noQuestion);
    if (mine.resolvedAt !== null) return off(CONTROL_REASONS.answered);
    if (beforeStart(question.receivedAt)) return off(CONTROL_REASONS.beforeRestart);
    return ON;
  })();

  const message = ((): ControlState => {
    if (common !== null) return off(common);
    return caps.message === 'none' ? off(CONTROL_REASONS.noMessage) : ON;
  })();

  const messageTurnEnd = ((): ControlState => {
    if (!message.enabled) return message;
    return caps.followUp === true ? ON : off(CONTROL_REASONS.noFollowUp);
  })();

  const hold = agent.hold ?? null;
  const pending = agent.pausePending === true;

  const pause = ((): ControlState => {
    if (common !== null) return off(common);
    if (!caps.pause) return off(CONTROL_REASONS.noPause);
    if (hold !== null && !beforeStart(hold.since)) return off(CONTROL_REASONS.alreadyPaused);
    if (pending) return off(CONTROL_REASONS.pausePending);
    return ON;
  })();

  const resume = ((): ControlState => {
    if (common !== null) return off(common);
    if (!caps.pause) return off(CONTROL_REASONS.noPause);
    if (hold !== null) return beforeStart(hold.since) ? off(CONTROL_REASONS.holdBeforeRestart) : ON;
    // A pause still waiting for the next tool call can be called off.
    return pending ? ON : off(CONTROL_REASONS.notPaused);
  })();

  const cancelMessage = ((): ControlState => {
    if (!message.enabled) return message;
    return (agent.outbox ?? []).length > 0 ? ON : off(CONTROL_REASONS.noQueued);
  })();

  return {
    approve: approval,
    deny: approval,
    passThrough: mine?.kind === 'question' ? questionPassThrough : approval,
    answer,
    message,
    messageTurnEnd,
    pause,
    resume,
    cancelMessage,
  };
}

/** The composer's delivery choice (the `agent.message` command's `delivery`). */
export type ComposerMode = 'auto' | 'next_tool' | 'turn_end';

export type MessageLanding =
  | 'at once'
  | 'after the next tool call'
  | 'when this turn ends'
  | 'after the next tool call or when this turn ends'
  | 'agent is idle: when it next works';

/**
 * Words for where a message will land (F12), shown under the composer. Pure. A managed session takes it at once. An
 * idle agent has no tool call or turn end coming until it is prompted again. A subagent has no end-of-turn follow-up
 * (`capabilities.followUp`), so every mode lands at its next tool call.
 */
export function whereMessageLands(
  agent: Pick<AgentNode, 'status' | 'capabilities'>,
  mode: ComposerMode,
): MessageLanding {
  if (agent.capabilities.message === 'live') return 'at once';
  if (agent.status === 'idle') return 'agent is idle: when it next works';
  if (agent.capabilities.followUp !== true) return 'after the next tool call';
  switch (mode) {
    case 'next_tool':
      return 'after the next tool call';
    case 'turn_end':
      return 'when this turn ends';
    default:
      return 'after the next tool call or when this turn ends';
  }
}
