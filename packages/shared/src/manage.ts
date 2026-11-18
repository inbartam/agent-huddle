/**
 * Pure selectors for the M4 management surfaces (F13 stop, F18 rules, F19 budgets, F20 worktrees): which run controls
 * work right now and why not, how far each budget is used, and the log of decisions rules made. No clock, no I/O:
 * `now` and the events are passed in. The renderer reads these; the words for disabled controls live here, next to
 * CONTROL_REASONS, so the UI and the tests agree.
 */
import type { ApprovalRequested, ApprovalResolved, HuddleEvent } from './events.js';
import type {
  AgentKey,
  AgentNode,
  AgentRun,
  AttentionItem,
  Budget,
  BudgetEntry,
  ConnectionStatus,
  HuddleState,
  PolicyRule,
  TokenUsage,
} from './model.js';
import type { ControlState } from './selectors.js';
import { CONTROL_REASONS, isTerminal, selectUsageRollup } from './selectors.js';
import { DEFAULT_BUDGET_WARN_AT_FRACTION } from './settings.js';

// ---------------------------------------------------------------------------
// Run controls (F13 stop, F20 worktree)
// ---------------------------------------------------------------------------

export const RUN_REASONS = {
  notManaged: 'Only runs Huddle launched can be stopped or ended from here. Use the terminal for this one.',
  noStop: "This run can't be stopped from Huddle.",
  exited: 'This run has already ended.',
  noWorktree: 'This run has no worktree.',
  alive: 'Stop or end the run first: it is still using the worktree.',
  kept: 'This worktree was kept.',
  discarded: 'This worktree was discarded.',
} as const;

export type RunControlName = 'stop' | 'end' | 'keep' | 'discard' | 'open';
export type RunControls = Record<RunControlName, ControlState>;

const ON: ControlState = { enabled: true, reason: null };
const off = (reason: string): ControlState => ({ enabled: false, reason });

/**
 * Launching needs an attached connection (ADR-020 §1): the run's hooks report to the Huddle through the user's own
 * settings, never through `--settings`. Without one, Launch is off with the connection's reason.
 */
export function selectLaunchControl(connection: ConnectionStatus | undefined): ControlState {
  switch (connection?.status) {
    case 'attached':
      return ON;
    case 'port_in_use':
      return off(CONTROL_REASONS.portInUse);
    case 'error':
      return off(CONTROL_REASONS.connectionError);
    default:
      return off(CONTROL_REASONS.notConnected);
  }
}

/** The run's process has not exited (no `run.exited` yet). */
export function isRunAlive(run: Pick<AgentRun, 'exited'>): boolean {
  return run.exited === undefined || run.exited === null;
}

/**
 * Stop, End and the worktree buttons for an agent (ADR-020). Stop and End need a run the Huddle launched, still alive,
 * and the `stop` capability. Keep and Discard need an active worktree; Discard also needs the process to have exited
 * (main refuses it otherwise). Open needs a worktree that was not discarded.
 */
export function selectRunControls(agent: Pick<AgentNode, 'run' | 'capabilities'>): RunControls {
  const run = agent.run ?? null;
  const lifecycle = ((): ControlState => {
    if (run === null) return off(RUN_REASONS.notManaged);
    if (!isRunAlive(run)) return off(RUN_REASONS.exited);
    if (!agent.capabilities.stop) return off(RUN_REASONS.noStop);
    return ON;
  })();
  const worktree = run?.worktree ?? null;
  const decided = ((): ControlState | null => {
    if (worktree === null) return off(RUN_REASONS.noWorktree);
    if (worktree.state === 'kept') return off(RUN_REASONS.kept);
    if (worktree.state === 'discarded') return off(RUN_REASONS.discarded);
    return null;
  })();
  const discard = decided ?? (run !== null && isRunAlive(run) ? off(RUN_REASONS.alive) : ON);
  const open =
    worktree === null ? off(RUN_REASONS.noWorktree) : worktree.state === 'discarded' ? off(RUN_REASONS.discarded) : ON;
  return { stop: lifecycle, end: lifecycle, keep: decided ?? ON, discard, open };
}

// ---------------------------------------------------------------------------
// Budgets (F19)
// ---------------------------------------------------------------------------

/** A Budget's scope in the event's words: 'all' (the M4 WP1 spelling) is read as 'overall'. */
export function budgetScopeOf(scope: Budget['scope']): BudgetEntry['scope'] {
  return scope === 'all' ? 'overall' : scope;
}

/** Tokens as budgets count them (ADR-020 §4): input + output + cache creation; cache reads are excluded. */
export function budgetTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens;
}

export type BudgetLimitKind = 'tokens' | 'cost' | 'minutes';

/** ok: under the warning line. warning: at or past it. over: at or past the cap. unknown: nothing measured yet. */
export type BudgetLevel = 'ok' | 'warning' | 'over' | 'unknown';

export interface BudgetLimitView {
  kind: BudgetLimitKind;
  cap: number;
  /** Used so far, or null when not measured (never 0 for unknown). */
  used: number | null;
  /** used / cap, or null when unknown (or a cap of 0 with nothing used). */
  fraction: number | null;
  level: BudgetLevel;
}

export interface BudgetView {
  scope: BudgetEntry['scope'];
  targetKey: AgentKey | null;
  budget: Budget;
  setAt: number;
  limits: BudgetLimitView[];
  /** The worst level among the limits ('unknown' only when every limit is unknown). */
  level: BudgetLevel;
}

export interface BudgetUsed {
  tokens: number | null;
  costUsd: number | null;
  minutes: number | null;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function known(usage: TokenUsage | null | undefined): TokenUsage | null {
  return usage && usage.requests > 0 ? usage : null;
}

/** A cost only when some request carried one (a missing cost is counted as 0, which means unknown). */
function knownCost(usage: TokenUsage | null): number | null {
  if (usage === null) return null;
  return (usage.requestsWithoutCost ?? 0) >= usage.requests ? null : usage.estimatedCostUsd;
}

function elapsedMinutes(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return (to - from) / 60_000;
}

/**
 * What a budget has used so far. agent: that agent's own requests and run time. session: the session's roll-up (every
 * agent in it, helper requests included) and the main agent's run time. overall: every session summed, and the time
 * since the budget was set. An agent the state no longer has, or one with no recorded request, is unknown.
 */
export function selectBudgetUsed(state: HuddleState, entry: BudgetEntry, now: number): BudgetUsed {
  if (entry.scope === 'overall') {
    let any = false;
    let tokens = 0;
    let cost = 0;
    let costKnown = false;
    for (const rootKey of state.rootKeys) {
      const usage = known(selectUsageRollup(state, rootKey)?.usage);
      if (usage === null) continue;
      any = true;
      tokens += budgetTokens(usage);
      const c = knownCost(usage);
      if (c !== null) {
        cost += c;
        costKnown = true;
      }
    }
    return {
      tokens: any ? tokens : null,
      costUsd: costKnown ? cost : null,
      minutes: elapsedMinutes(entry.setAt, now),
    };
  }
  const target = entry.targetKey === null ? undefined : getOwn(state.agents, entry.targetKey);
  if (target === undefined) return { tokens: null, costUsd: null, minutes: null };
  const usage = entry.scope === 'session' ? known(selectUsageRollup(state, target.key)?.usage) : known(target.usage);
  return {
    tokens: usage === null ? null : budgetTokens(usage),
    costUsd: knownCost(usage),
    minutes: elapsedMinutes(target.startedAt, target.endedAt ?? now),
  };
}

const LEVEL_RANK: Record<BudgetLevel, number> = { unknown: 0, ok: 1, warning: 2, over: 3 };

function limitView(kind: BudgetLimitKind, cap: number, used: number | null, warnAt: number): BudgetLimitView {
  if (used === null || !Number.isFinite(used)) return { kind, cap, used: null, fraction: null, level: 'unknown' };
  const fraction = cap > 0 ? used / cap : used > 0 ? Number.POSITIVE_INFINITY : null;
  const level: BudgetLevel = fraction === null ? 'ok' : fraction >= 1 ? 'over' : fraction >= warnAt ? 'warning' : 'ok';
  return { kind, cap, used, fraction: fraction === Number.POSITIVE_INFINITY ? 1 : fraction, level };
}

export function selectBudgetView(state: HuddleState, entry: BudgetEntry, now: number): BudgetView {
  const used = selectBudgetUsed(state, entry, now);
  const b = entry.budget;
  const warnAt = Number.isFinite(b.warnAtFraction) ? b.warnAtFraction : DEFAULT_BUDGET_WARN_AT_FRACTION;
  const limits: BudgetLimitView[] = [];
  if (b.maxTokens !== undefined) limits.push(limitView('tokens', b.maxTokens, used.tokens, warnAt));
  if (b.maxEstimatedCostUsd !== undefined) limits.push(limitView('cost', b.maxEstimatedCostUsd, used.costUsd, warnAt));
  if (b.maxMinutes !== undefined) limits.push(limitView('minutes', b.maxMinutes, used.minutes, warnAt));
  const level = limits.reduce<BudgetLevel>(
    (worst, l) => (LEVEL_RANK[l.level] > LEVEL_RANK[worst] ? l.level : worst),
    'unknown',
  );
  return { scope: entry.scope, targetKey: entry.targetKey, budget: b, setAt: entry.setAt, limits, level };
}

/**
 * The budgets that bear on one agent, most specific first: its own, its session's (keyed by the session's main agent),
 * then the overall one. Without `key`, every budget in force, in the order they were set.
 */
export function selectBudgets(state: HuddleState, now: number, key?: AgentKey): BudgetView[] {
  const entries = state.budgets ?? [];
  if (key === undefined) return entries.map((e) => selectBudgetView(state, e, now));
  const agent = getOwn(state.agents, key);
  if (agent === undefined) return [];
  const rootKey = agent.sessionId;
  const rank = (e: BudgetEntry): number =>
    e.scope === 'agent' && e.targetKey === key
      ? 0
      : e.scope === 'session' && e.targetKey === rootKey
        ? 1
        : e.scope === 'overall'
          ? 2
          : -1;
  return entries
    .map((e) => ({ e, r: rank(e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => selectBudgetView(state, x.e, now));
}

/** `<scope>:<targetKey>`, with `*` for the overall budget's null target. One budget per scope and target. */
export function budgetKeyOf(entry: Pick<BudgetEntry, 'scope' | 'targetKey'>): string {
  return `${entry.scope}:${entry.targetKey ?? '*'}`;
}

/** The budget detector's warning item id for a budget key. */
export function budgetWarningItemId(key: string): string {
  return `budget:${key}:warning`;
}

/**
 * The budget detector's over item id for a budget key. It is also the `detail` of the Huddle's pause when the budget
 * paused an agent, so it names those agents (`AgentNode.pausedBy`) after the item itself is resolved.
 */
export function budgetOverItemId(key: string): string {
  return `budget:${key}:over`;
}

/** The pause is in force: held at a tool call, or waiting for the next one. */
function isPausedNow(node: AgentNode): boolean {
  if (isTerminal(node.status) || node.endedAt !== null) return false;
  return (node.hold !== undefined && node.hold !== null) || node.pausePending === true;
}

/**
 * The agents a budget paused that are still paused, sorted by key. `itemId`: the budget's over item id (the detail
 * of the Huddle's pause). Empty once each was resumed, let go at the hold limit, or ended.
 */
export function selectBudgetPaused(state: HuddleState, itemId: string): AgentNode[] {
  return Object.keys(state.agents)
    .sort()
    .map((k) => state.agents[k])
    .filter((n): n is AgentNode => n !== undefined && n.pausedBy === itemId && isPausedNow(n));
}

/** Every agent of a session that a budget (any budget) paused and that is still paused, sorted by key. */
export function selectSessionBudgetPaused(state: HuddleState, sessionId: string): AgentNode[] {
  return Object.keys(state.agents)
    .sort()
    .map((k) => state.agents[k])
    .filter(
      (n): n is AgentNode =>
        n !== undefined &&
        n.sessionId === sessionId &&
        typeof n.pausedBy === 'string' &&
        n.pausedBy.startsWith('budget:') &&
        isPausedNow(n),
    );
}

export const DISMISS_REASONS = {
  request: 'Answer it, or pass it to the terminal: Claude Code is waiting on it.',
  budgetPaused: 'This budget still holds paused agents. Resume them (Resume all) or stop the run first.',
  handled: 'Already handled.',
} as const;

/**
 * Whether an open inbox item may be dismissed (`attention.dismiss`). Approvals and questions never: Claude Code is
 * waiting on them, and dismissing would hide a held request. A budget item not while agents it paused are still
 * paused (dismissing would hide the way to resume them). Everything else (detector items, warnings, errors) yes: the
 * detector does not raise it again while the same condition holds, and does when it comes back.
 */
export function selectDismissControl(
  state: HuddleState,
  item: Pick<AttentionItem, 'id' | 'kind' | 'resolvedAt'>,
): ControlState {
  if (item.resolvedAt !== null) return off(DISMISS_REASONS.handled);
  if (item.kind === 'approval' || item.kind === 'question') return off(DISMISS_REASONS.request);
  if (item.kind === 'budget' && selectBudgetPaused(state, item.id).length > 0) return off(DISMISS_REASONS.budgetPaused);
  return ON;
}

// ---------------------------------------------------------------------------
// Rules (F18)
// ---------------------------------------------------------------------------

/** Rules the Huddle ships with have ids starting "default:". */
export function isDefaultRule(rule: Pick<PolicyRule, 'id'>): boolean {
  return rule.id.startsWith('default:');
}

/** One request a rule decided, joined from its `approval.requested` and `approval.resolved` events. */
export interface PolicyDecision {
  requestId: string;
  agentKey: AgentKey;
  ruleId: string | null;
  /** The rule's name now, or null when the rule is no longer in the list. */
  ruleName: string | null;
  outcome: ApprovalResolved['outcome'];
  /** From the request; null when its request event was not among those read. */
  toolName: string | null;
  summary: string | null;
  at: number;
  /** The message sent with a deny, clipped. */
  message: string | null;
}

/**
 * Every automatic decision (`approval.resolved` with `by: 'policy'`) in the events, newest first, one per request.
 * The tool and summary come from the matching `approval.requested`; the rule name from `rules` by id.
 */
export function selectPolicyDecisions(
  events: readonly HuddleEvent[],
  rules: readonly PolicyRule[] = [],
): PolicyDecision[] {
  const requests = new Map<string, ApprovalRequested['request']>();
  for (const e of events) if (e.type === 'approval.requested') requests.set(e.request.requestId, e.request);
  const names = new Map(rules.map((r) => [r.id, r.name]));
  const byRequest = new Map<string, PolicyDecision>();
  for (const e of events) {
    if (e.type !== 'approval.resolved' || e.by !== 'policy') continue;
    const req = requests.get(e.requestId);
    const prior = byRequest.get(e.requestId);
    if (prior !== undefined && prior.at > e.ts) continue;
    byRequest.set(e.requestId, {
      requestId: e.requestId,
      agentKey: req?.agentKey ?? e.agentKey,
      ruleId: e.policyRuleId,
      ruleName: e.policyRuleId === null ? null : (names.get(e.policyRuleId) ?? null),
      outcome: e.outcome,
      toolName: req?.toolName ?? null,
      summary: req?.summary ?? null,
      at: e.ts,
      message: e.message,
    });
  }
  return [...byRequest.values()].sort((a, b) => b.at - a.at || (a.requestId < b.requestId ? -1 : 1));
}
