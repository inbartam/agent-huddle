/**
 * Budget detector (F19, ADR-020 §4). Pure: the reducer's state, the time and this detector's own memory go in; attention
 * events and action requests come out. No clock, randomness or I/O. The runtime (huddle-core.ts) carries the actions
 * out through the M3 pause and a `stopRun` callback, then raises the exceed item with what happened.
 *
 * Counting is the UI's: every level comes from `selectBudgetView` (shared/manage.ts), so the Huddle acts on exactly
 * the numbers the budget meter shows. agent: that agent's own requests (not its subagents'); session: the whole session,
 * helper requests included; overall: every session. Tokens = input + output + cache creation. Cost: the summed
 * telemetry estimate; unknown stays unknown and never triggers. Minutes: agent and session from the agent's start,
 * overall from when the budget was set (the tick re-checks these).
 *
 * Per budget (one per scope and target, identified by `budgetKeyOf`) and per setting of it (`setAt`):
 *  - warning: at `warnAtFraction` of any cap, one `budget:<key>:warning` item (severity warning).
 *  - over: at a cap, one `budget:<key>:over` item (action_required); the warning item is resolved (superseded). The
 *    budget's action is requested once per setting: notify (the item only), pause or stop.
 *  - Both are resolved when the condition clears: the budget is removed, or set again (a new `setAt`, which is then
 *    checked afresh and may raise and act again: the user chose new limits), or what it measures is no longer known.
 *    Nothing is raised again while a condition holds.
 *  - Dismissed by the user (`attention.resolved` reason 'dismissed', not seen here: attention events change nothing):
 *    the memo still has the item open, so it is not raised again for the same setting; after a restart
 *    `seedBudgetState` reads the dismissed item the same way.
 *
 * Who is acted on (scope members that are live: not ended, and seen since this Huddle started):
 *  - pause: agent: the agent. session: every live agent of the session (a held PreToolUse is per agent, so pausing
 *    only the main agent would let running subagents go on spending). overall: every live agent on the machine,
 *    attached and managed alike (an overall budget counts them all).
 *  - stop: the managed runs those agents belong to (a run is one process; a subagent cannot be stopped on its own, so
 *    an agent budget on a subagent stops its run). Agents of attached sessions cannot be stopped: they are paused
 *    instead, and the item says so.
 *  - Lapse: when a pause this detector asked for reaches the hold limit (`hold.ended hold_limit`) on a managed run, the
 *    run is stopped (one request per run). On an attached session the agent continues and the item stays. A resume
 *    (any source), a user's own pause of the agent, or the budget clearing hands the pause back to the user: no stop.
 *
 * The state is plain JSON (records and arrays only).
 */
import {
  budgetKeyOf,
  budgetOverItemId,
  budgetWarningItemId,
  CLIP_LIMITS,
  isRunAlive,
  isTerminal,
  selectBudgetView,
  type AgentKey,
  type AgentNode,
  type AttentionItem,
  type Budget,
  type BudgetEntry,
  type BudgetLimitView,
  type BudgetView,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';
import { raisedEvent, resolvedEvent, without, type DetectorEmit, type EmitTarget } from './common.js';
import { plain } from '../text.js';

/** `<scope>:<targetKey>`, with `*` for the overall budget's null target. */
export type BudgetKey = string;

/** What this detector remembers about one budget, for the setting it saw last. */
export interface BudgetMemo {
  setAt: number;
  /** The warning item is open. */
  warning: boolean;
  /** The over item is open. */
  over: boolean;
  /** The budget's action was requested for this setting (at most once). */
  acted: boolean;
  /** Envelope of this budget's items, fixed when first raised (so the resolve goes where the raise went). */
  sessionId: string;
  agentKey: AgentKey;
}

/** A pause this detector asked for, waiting to be resumed or to lapse. */
export interface BudgetPause {
  budgetKey: BudgetKey;
  itemId: string;
}

export interface BudgetState {
  memo: Record<BudgetKey, BudgetMemo>;
  paused: Record<AgentKey, BudgetPause>;
  /** Runs a lapse already asked to stop, oldest first (bounded by MAX_STOP_ASKED). */
  stopAsked: string[];
}

/** A managed run to stop, with the in-scope agents to pause if stopping it is not possible. */
export interface RunTarget {
  runId: string;
  rootKey: AgentKey;
  agentKeys: AgentKey[];
}

/** An agent to pause; `managed`: it belongs to a run the Huddle launched (a lapse stops that run). */
export interface PauseTarget {
  agentKey: AgentKey;
  managed: boolean;
}

/**
 * What the runtime is asked to do.
 *  exceeded: a cap was reached and the budget's action is pause or stop. `item` is the over item to raise once done,
 *    its detail without the outcome (see `finishBudgetAction`).
 *  lapsed: a budget pause reached its hold limit on a managed run: stop it. `item` is the open over item, amended
 *    with the outcome; null when it is no longer in the inbox.
 */
export interface BudgetAction {
  reason: 'exceeded' | 'lapsed';
  budgetKey: BudgetKey;
  itemId: string;
  onExceed: Budget['onExceed'];
  pause: PauseTarget[];
  stop: RunTarget[];
  /** In `pause` because stop was asked for but the agent's session was not started by the Huddle. */
  notStoppable: AgentKey[];
  item: AttentionItem | null;
  target: EmitTarget;
  trigger: string;
}

/** What the runtime did with one action. */
export interface BudgetOutcome {
  pausedManaged: number;
  pausedAttached: number;
  pauseFailed: number;
  stopped: number;
  /** One message per run that could not be stopped (from `stopRun`'s result). */
  stopFailed: string[];
  /** Agents paused because their run could not be stopped. */
  pausedInstead: number;
}

export interface BudgetStep {
  state: BudgetState;
  emit: DetectorEmit[];
  actions: BudgetAction[];
}

export const MAX_STOP_ASKED = 200;

/** Roughly how long a pause holds before the Huddle lets the agent go (ADR-019: 595 s). Words only. */
const HOLD_WORDS = 'about 10 min';
const OVERSHOOT = 'Usage arrives a few seconds late, so it can pass the cap by about one call.';

export function emptyBudgetState(): BudgetState {
  return { memo: {}, paused: {}, stopAsked: [] };
}

// The ids live in shared (manage.ts): the renderer finds the agents a budget paused by its over item id.
export { budgetKeyOf, budgetOverItemId, budgetWarningItemId };

function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------------------------------------------------

/** Not ended, and (when known) seen since this Huddle started: an agent a pause can still reach. */
export function isLiveAgent(node: AgentNode, liveSince: number | null): boolean {
  if (isTerminal(node.status) || node.endedAt !== null) return false;
  return liveSince === null || node.lastEventAt >= liveSince;
}

function rootOf(state: HuddleState, node: AgentNode): AgentNode {
  let current = node;
  const seen = new Set<AgentKey>([node.key]);
  while (current.parentKey !== null) {
    const parent = getOwn(state.agents, current.parentKey);
    if (parent === undefined || seen.has(parent.key)) break;
    seen.add(parent.key);
    current = parent;
  }
  return current;
}

/** The root's run, when it is a live run the Huddle launched and can stop. */
function stoppableRun(root: AgentNode): string | null {
  const run = root.run ?? null;
  if (run === null || root.origin !== 'managed' || !root.capabilities.stop || !isRunAlive(run)) return null;
  return run.runId;
}

function isManagedNode(state: HuddleState, node: AgentNode): boolean {
  return stoppableRun(rootOf(state, node)) !== null;
}

/** Everyone the budget counts, sorted by key (deterministic). */
function membersOf(state: HuddleState, entry: BudgetEntry): AgentNode[] {
  const all = Object.keys(state.agents)
    .sort()
    .map((k) => state.agents[k])
    .filter((n): n is AgentNode => n !== undefined);
  if (entry.scope === 'overall') return all;
  const target = entry.targetKey === null ? undefined : getOwn(state.agents, entry.targetKey);
  if (target === undefined) return [];
  if (entry.scope === 'agent') return [target];
  return all.filter((n) => n.sessionId === target.sessionId);
}

function plan(
  state: HuddleState,
  entry: BudgetEntry,
  liveSince: number | null,
): Pick<BudgetAction, 'pause' | 'stop' | 'notStoppable'> {
  const live = membersOf(state, entry).filter((n) => isLiveAgent(n, liveSince));
  const pausable = live.filter((n) => n.capabilities.pause);
  if (entry.budget.onExceed !== 'stop') {
    return {
      pause: pausable.map((n) => ({ agentKey: n.key, managed: isManagedNode(state, n) })),
      stop: [],
      notStoppable: [],
    };
  }
  const runs = new Map<string, RunTarget>();
  const pause: PauseTarget[] = [];
  const notStoppable: AgentKey[] = [];
  for (const node of live) {
    const root = rootOf(state, node);
    const runId = stoppableRun(root);
    if (runId !== null) {
      const run = runs.get(runId) ?? { runId, rootKey: root.key, agentKeys: [] };
      if (node.capabilities.pause) run.agentKeys.push(node.key);
      runs.set(runId, run);
    } else if (node.capabilities.pause) {
      pause.push({ agentKey: node.key, managed: false });
      notStoppable.push(node.key);
    }
  }
  return { pause, stop: [...runs.values()], notStoppable };
}

/** Where a budget's items are filed: its agent, its session's root, or (overall) the most recently active session. */
function envelopeOf(state: HuddleState, entry: BudgetEntry): { sessionId: string; agentKey: AgentKey } | null {
  const key = entry.scope === 'overall' ? (state.rootKeys[0] ?? null) : entry.targetKey;
  const node = key === null ? undefined : getOwn(state.agents, key);
  return node === undefined ? null : { sessionId: node.sessionId, agentKey: node.key };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** 950, 8.6k, 86k, 1.2M. */
export function tokensText(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${String(Math.round(n / 1000))}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function limitText(l: BudgetLimitView): string {
  const used = l.used ?? 0;
  switch (l.kind) {
    case 'tokens':
      return `${tokensText(used)} of ${tokensText(l.cap)} tokens`;
    case 'cost':
      return `$${used.toFixed(2)} of $${l.cap.toFixed(2)} estimated cost`;
    case 'minutes':
      return `${String(Math.floor(used))} of ${String(l.cap)} min`;
  }
}

function usageText(view: BudgetView, levels: readonly BudgetLimitView['level'][]): string {
  return view.limits
    .filter((l) => levels.includes(l.level))
    .map(limitText)
    .join('; ');
}

function whoText(state: HuddleState, entry: BudgetEntry): string {
  if (entry.scope === 'overall') return 'The overall budget';
  const node = entry.targetKey === null ? undefined : getOwn(state.agents, entry.targetKey);
  const name = plain(node?.name ?? 'An agent', 80);
  return entry.scope === 'session' ? `The session budget of ${name}` : `The budget of ${name}`;
}

const AT_CAP: Record<Budget['onExceed'], string> = {
  notify: 'At the cap you are told; nothing is paused.',
  pause: 'At the cap it pauses.',
  stop: 'At the cap it stops.',
};

interface ItemArgs {
  entry: BudgetEntry;
  view: BudgetView;
  key: BudgetKey;
  agentKey: AgentKey;
  now: number;
}

function warningItem(state: HuddleState, { entry, view, key, agentKey, now }: ItemArgs): AttentionItem {
  return {
    id: budgetWarningItemId(key),
    kind: 'budget',
    severity: 'warning',
    agentKey,
    title: plain(`${whoText(state, entry)} is nearly used`),
    detail: plain(`${usageText(view, ['warning', 'over'])}. ${AT_CAP[entry.budget.onExceed]}`),
    createdAt: now,
    resolvedAt: null,
  };
}

function overItem(state: HuddleState, { entry, view, key, agentKey, now }: ItemArgs): AttentionItem {
  // An item with an action gets the outcome and the overshoot note when it is finished (finishBudgetAction).
  const tail = entry.budget.onExceed === 'notify' ? ` Notify only: nothing was paused. ${OVERSHOOT}` : '';
  return {
    id: budgetOverItemId(key),
    kind: 'budget',
    severity: 'action_required',
    agentKey,
    title: plain(`${whoText(state, entry)} is used up`),
    detail: plain(`${usageText(view, ['over'])}.${tail}`, CLIP_LIMITS.summary),
    createdAt: now,
    resolvedAt: null,
  };
}

/** One clipped line ending in a period. */
function sentence(text: string): string {
  const line = plain(text, 160);
  return line === '' || /[.!?…]$/.test(line) ? line : `${line}.`;
}

/** The outcome in words, appended to the over item. */
export function outcomeText(action: BudgetAction, outcome: BudgetOutcome): string {
  if (action.reason === 'lapsed') {
    if (outcome.stopped > 0) return 'The pause ran out, so the run was stopped.';
    const why = sentence(outcome.stopFailed[0] ?? 'the run could not be stopped').replace(/.$/, '');
    return `The pause ran out and the run could not be stopped (${why}), so it continues.`;
  }
  const parts: string[] = [];
  if (outcome.stopped > 0) parts.push(`Stopped ${count(outcome.stopped, 'run')}.`);
  if (outcome.stopFailed.length > 0) {
    const instead = outcome.pausedInstead > 0 ? ' Paused instead.' : '';
    parts.push(
      `Could not stop ${count(outcome.stopFailed.length, 'run')}: ${sentence(outcome.stopFailed[0] ?? '')}${instead}`,
    );
  }
  if (action.notStoppable.length > 0) {
    parts.push('A session started outside Huddle cannot be stopped from here, so it is paused instead.');
  }
  const paused = outcome.pausedManaged + outcome.pausedAttached;
  if (paused > 0) {
    parts.push(`Paused ${count(paused, 'agent')}.`);
    if (outcome.pausedManaged > 0) parts.push(`A run Huddle launched is stopped if still paused after ${HOLD_WORDS}.`);
    if (outcome.pausedAttached > 0) parts.push(`A terminal session goes on by itself after ${HOLD_WORDS}.`);
  }
  if (outcome.pauseFailed > 0) parts.push(`${count(outcome.pauseFailed, 'agent')} could not be paused.`);
  if (parts.length === 0) parts.push('No running agent to pause.');
  return parts.join(' ');
}

/**
 * The events that finish an action: exceeded -> the over item, raised with the outcome; lapsed -> the open over item,
 * resolved and raised again with the outcome added (same id, so the inbox shows one item). Pure.
 */
export function finishBudgetAction(action: BudgetAction, outcome: BudgetOutcome): DetectorEmit[] {
  const item = action.item;
  if (item === null) return [];
  // The outcome goes before the overshoot note, so clipping drops the note first.
  const base = item.detail.replace(OVERSHOOT, '').trim();
  const detail = plain(`${base} ${outcomeText(action, outcome)} ${OVERSHOOT}`, CLIP_LIMITS.summary);
  const raised = raisedEvent(action.target, { ...item, detail, resolvedAt: null }, action.trigger);
  if (action.reason === 'exceeded') return [raised];
  return [resolvedEvent(action.target, item.id, action.trigger), raised];
}

// ---------------------------------------------------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------------------------------------------------

function dropPauses(paused: Record<AgentKey, BudgetPause>, key: BudgetKey): Record<AgentKey, BudgetPause> {
  let next = paused;
  for (const [agent, p] of Object.entries(paused)) if (p.budgetKey === key) next = without(next, agent);
  return next;
}

function closeMemo(memo: BudgetMemo, key: BudgetKey, now: number, trigger: string): DetectorEmit[] {
  const target: EmitTarget = { sessionId: memo.sessionId, agentKey: memo.agentKey, ts: now };
  const emit: DetectorEmit[] = [];
  if (memo.warning) emit.push(resolvedEvent(target, budgetWarningItemId(key), trigger));
  if (memo.over) emit.push(resolvedEvent(target, budgetOverItemId(key), trigger));
  return emit;
}

/** Check every budget against the state at `now`. `trigger` makes the emitted ids unique and repeatable. */
function evaluate(
  state: BudgetState,
  huddle: HuddleState,
  now: number,
  trigger: string,
  liveSince: number | null,
): BudgetStep {
  const entries = huddle.budgets ?? [];
  if (entries.length === 0 && Object.keys(state.memo).length === 0) return { state, emit: [], actions: [] };
  const emit: DetectorEmit[] = [];
  const actions: BudgetAction[] = [];
  let memo: Record<BudgetKey, BudgetMemo> = {};
  let paused = state.paused;
  const seen = new Set<BudgetKey>();

  for (const entry of entries) {
    const key = budgetKeyOf(entry);
    seen.add(key);
    const trig = `${String(entry.setAt)}:${trigger}`;
    let prior = getOwn(state.memo, key);
    if (prior !== undefined && prior.setAt !== entry.setAt) {
      // Set again: the old setting's items close; the new one is checked afresh.
      emit.push(...closeMemo(prior, key, now, trig));
      paused = dropPauses(paused, key);
      prior = undefined;
    }
    const envelope = prior ?? envelopeOf(huddle, entry);
    if (envelope === null) continue; // Nobody to file an item under yet (and so nothing measured).
    const m: BudgetMemo = prior ?? {
      setAt: entry.setAt,
      warning: false,
      over: false,
      acted: false,
      sessionId: envelope.sessionId,
      agentKey: envelope.agentKey,
    };
    const target: EmitTarget = { sessionId: m.sessionId, agentKey: m.agentKey, ts: now };
    const view = selectBudgetView(huddle, entry, now);
    const next = { ...m };

    if (view.level === 'over') {
      if (next.warning) {
        emit.push(resolvedEvent(target, budgetWarningItemId(key), trig));
        next.warning = false;
      }
      if (!next.over) {
        next.over = true;
        const item = overItem(huddle, { entry, view, key, agentKey: m.agentKey, now });
        if (!next.acted && entry.budget.onExceed !== 'notify') {
          next.acted = true;
          const who = plan(huddle, entry, liveSince);
          for (const p of who.pause) paused = { ...paused, [p.agentKey]: { budgetKey: key, itemId: item.id } };
          actions.push({
            reason: 'exceeded',
            budgetKey: key,
            itemId: item.id,
            onExceed: entry.budget.onExceed,
            ...who,
            item,
            target,
            trigger: trig,
          });
        } else {
          next.acted = true;
          emit.push(raisedEvent(target, item, trig));
        }
      }
    } else {
      if (next.over) {
        emit.push(resolvedEvent(target, budgetOverItemId(key), trig));
        next.over = false;
        paused = dropPauses(paused, key);
      }
      if (view.level === 'warning' && !next.warning) {
        next.warning = true;
        emit.push(raisedEvent(target, warningItem(huddle, { entry, view, key, agentKey: m.agentKey, now }), trig));
      } else if (view.level !== 'warning' && next.warning) {
        next.warning = false;
        emit.push(resolvedEvent(target, budgetWarningItemId(key), trig));
      }
    }
    memo = { ...memo, [key]: next };
  }

  // Budgets no longer set: their items close, their pauses go back to the user.
  for (const key of Object.keys(state.memo).sort()) {
    if (seen.has(key)) continue;
    const m = state.memo[key];
    if (m === undefined) continue;
    emit.push(...closeMemo(m, key, now, `removed:${trigger}`));
    paused = dropPauses(paused, key);
  }
  return { state: { ...state, memo, paused }, emit, actions };
}

/** A pause hold of `event.agentKey` ended or was taken over: lapse -> maybe stop its run. */
function trackPauses(
  state: BudgetState,
  huddle: HuddleState,
  event: HuddleEvent,
): { state: BudgetState; actions: BudgetAction[] } {
  const key = event.agentKey;
  const mine = getOwn(state.paused, key);
  if (mine === undefined) return { state, actions: [] };
  const handedBack =
    (event.type === 'control.applied' &&
      (event.action === 'resume' || (event.action === 'pause' && event.source === 'user'))) ||
    (event.type === 'hold.ended' && event.why !== 'hold_limit');
  if (handedBack) return { state: { ...state, paused: without(state.paused, key) }, actions: [] };
  if (event.type !== 'hold.ended') return { state, actions: [] };

  // The pause ran out (hold_limit).
  const paused = without(state.paused, key);
  const node = getOwn(huddle.agents, key);
  const root = node === undefined ? undefined : rootOf(huddle, node);
  const runId = root === undefined ? null : stoppableRun(root);
  if (root === undefined || runId === null || state.stopAsked.includes(runId)) {
    // Attached (or already being stopped): the agent continues and the budget item stays.
    return { state: { ...state, paused }, actions: [] };
  }
  const stopAsked = [...state.stopAsked, runId].slice(-MAX_STOP_ASKED);
  const memo = getOwn(state.memo, mine.budgetKey);
  const item = huddle.inbox.find((i) => i.id === mine.itemId && i.resolvedAt === null) ?? null;
  const target: EmitTarget = {
    sessionId: memo?.sessionId ?? event.sessionId,
    agentKey: memo?.agentKey ?? key,
    ts: event.ts,
  };
  const action: BudgetAction = {
    reason: 'lapsed',
    budgetKey: mine.budgetKey,
    itemId: mine.itemId,
    onExceed: 'pause',
    pause: [],
    stop: [{ runId, rootKey: root.key, agentKeys: [] }],
    notStoppable: [],
    item,
    target,
    trigger: `lapse:${event.id}`,
  };
  return { state: { ...state, paused, stopAsked }, actions: [action] };
}

/**
 * Fold one live event. `huddle` is the reducer's state with this event in it. `liveSince`: when this Huddle started
 * (agents not seen since are not acted on), or null. Attention events change nothing.
 */
export function stepBudget(
  state: BudgetState,
  huddle: HuddleState,
  event: HuddleEvent,
  liveSince: number | null,
): BudgetStep {
  if (event.type === 'attention.raised' || event.type === 'attention.resolved') return { state, emit: [], actions: [] };
  const tracked = trackPauses(state, huddle, event);
  const out = evaluate(tracked.state, huddle, event.ts, event.id, liveSince);
  return { state: out.state, emit: out.emit, actions: [...tracked.actions, ...out.actions] };
}

/** Time passes: minute budgets. */
export function tickBudget(state: BudgetState, huddle: HuddleState, now: number, liveSince: number | null): BudgetStep {
  return evaluate(state, huddle, now, `t${String(now)}`, liveSince);
}

/**
 * After a restart: what the replayed inbox says was already raised (and so acted on) for the budgets in force, so
 * the first live event does not raise or pause again. A pause from before the restart is gone with its connection.
 */
export function seedBudgetState(huddle: HuddleState): BudgetState {
  let memo: Record<BudgetKey, BudgetMemo> = {};
  for (const entry of huddle.budgets ?? []) {
    const key = budgetKeyOf(entry);
    // Open, or dismissed by the user: either way it was raised for this setting and must not be raised (or acted on)
    // again.
    const open = (id: string): AttentionItem | undefined =>
      huddle.inbox.find(
        (i) => i.id === id && (i.resolvedAt === null || i.dismissed === true) && i.createdAt >= entry.setAt,
      );
    const warning = open(budgetWarningItemId(key));
    const over = open(budgetOverItemId(key));
    const any = over ?? warning;
    if (any === undefined) continue;
    const node = getOwn(huddle.agents, any.agentKey);
    memo = {
      ...memo,
      [key]: {
        setAt: entry.setAt,
        warning: warning !== undefined,
        over: over !== undefined,
        acted: over !== undefined,
        sessionId: node?.sessionId ?? any.agentKey,
        agentKey: any.agentKey,
      },
    };
  }
  return { memo, paused: {}, stopAsked: [] };
}
