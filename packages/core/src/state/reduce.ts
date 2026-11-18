/**
 * The reducer: HuddleState x HuddleEvent -> HuddleState (ARCHITECTURE §4, CONTRIBUTING.md rule 1).
 *
 * Pure and total. No clock (time is `event.ts`), no randomness, no I/O. It never mutates its input:
 * every change copies the record or node it touches. An event type it does not know returns the
 * state unchanged, so old code can replay newer logs.
 *
 * Bookkeeping. The tree needs memory that `HuddleState` has no field for: spawn requests not yet matched to
 * a subagent, links that arrived before their child, models seen before their session, the rank of the
 * source an agent's model came from, nicknames, per-role ordinals and role descriptions. That memory lives
 * in `ReducerState.book`. It is plain JSON like the rest of the state. Strip it with `toHuddleState` before
 * the state crosses IPC. `reduce` accepts a plain `HuddleState` too (for example `EMPTY_STATE`) and treats a
 * missing book as empty.
 *
 * Rules (M1 plan WP6, ADR-012, ADR-015):
 *  - Unknown keys. `agent.stopped` and `turn.ended` for an unknown subagent create nothing. `model.observed`
 *    for an unknown agent is kept pending (bounded) and applied when the node appears. Any other event
 *    creates the session root (the Huddle may start mid-session); for an unknown *subagent* key the event
 *    itself is then dropped, because without its SubagentStart there is no role and it could be a hidden helper.
 *  - Placement. `agent.started.parentKey` is provisional. A new subagent goes under the caller of the first
 *    unmatched `agent.spawn_requested` with the same role (link 'heuristic'). `agent.linked` moves it to its real
 *    parent (link 'exact'), is idempotent, works after the child stopped, and is remembered when it arrives
 *    before the child starts.
 *  - A second `agent.started` for the same key reopens the node.
 *  - Teammates (M6, S20). An `agent.started` with `teammateName` makes a `teammate` node under the session root (the
 *    lead), matched to the Agent call that carried that name. `teammate.idle` sets it idle (replacing the done its
 *    SubagentStop gave it), makes an existing node a teammate under the root, and creates an unseen one. The next
 *    tool event or `agent.started` sets it working again. Name: nickname, else the teammate's name.
 *  - `teammate.reported` (M6 P5b, ADR-027): the lead's answer about a teammate of its session, found by name (its role).
 *    finished: done, with endedAt = the event time (it counts as finished for the lead's progress); waiting: no change
 *    (it stays idle). A done teammate is not final: its next tool event or `agent.started` sets it working again with
 *    endedAt null. An unknown name, or a teammate that is not idle (working, paused, failed, stopped): no change.
 *  - The main agent is idle only after its own Stop with an empty `backgroundAgentIds`. A subagent's
 *    `turn.ended` never decides that (its list is session-wide). See `mainStatusAfterStop` for `null`.
 *  - Model precedence: session_start, switch and model.changed (rank 3) beat main-loop telemetry and the Agent
 *    call's resolved model (rank 2), which beat the model alias requested in the Agent call (rank 1). Equal rank:
 *    the later one wins.
 *  - Name precedence: nickname, then session title (main) or handoff title (subagent), then role plus ordinal.
 *  - `lastPrompt` (main agents): the latest typed prompt's first line (`promptTopic`); other prompts leave it alone.
 *  - `firstPrompt` (main agents): the first typed prompt that `cleanPromptTitle` gives a title for, set once.
 *
 * Usage (M2 plan WP2, ADR-013):
 *  - `usage.recorded` adds into the agent's `usage`. Deduplicated per session by `requestId` with a bounded
 *    seen-list (MAX_SEEN_REQUEST_IDS, oldest forgotten first): telemetry can be re-sent, and a re-sent batch arrives
 *    seconds later, far inside the bound. A record without a request id cannot be deduplicated: it is counted and
 *    also counted in `requestsWithoutId`. A record without cost adds 0 and is counted in `requestsWithoutCost`.
 *  - Helper, compact and unknown-source requests (and a subagent-sourced request with no agent id) go to the root's
 *    `helperUsage`, never into the main agent's own `usage`. Session total = sum of `usage` + root `helperUsage`.
 *  - Usage for an agent not seen yet waits in a bounded pending buffer (MAX_PENDING agents) and is applied when the
 *    node appears. Telemetry never creates a session by itself, and does not touch `lastEventAt` (it is a late echo).
 *  - Context: a telemetry `context.measured` does not overwrite a status line reading less than
 *    STATUSLINE_CONTEXT_PRIORITY_MS old (by event ts). Telemetry context for an unknown agent is dropped (the next
 *    request brings a fresh one).
 *
 * Interaction (M3 plan WP3, F10 F11 F12 F13):
 *  - `approval.requested` and `question.asked` add an inbox item (`approval:<requestId>`, `question:<requestId>`) for a
 *    known agent. An approval item resolves on `approval.resolved`; a question item on `question.answered`,
 *    `question.closed`, or a `tool.finished` / `tool.failed` whose toolUseId is the question's requestId (answered in
 *    the terminal). The agent's own `turn.ended` and its end (`agent.stopped`, `session.ended`) resolve all of its open
 *    approval and question items: a request cannot still be waiting once the turn that made it is over.
 *  - An `approval.requested` for AskUserQuestion opens nothing: it is Claude Code's own question box (older logs have
 *    them; the normalizer no longer emits them). An end of a request whose item was already resolved (by the turn end
 *    just before it) leaves the status alone.
 *  - Pause: `hold.started` sets `hold` and status `paused`; `hold.ended` for that tool call clears it. While held, other
 *    activity (a parallel call finishing) keeps `paused`. `control.applied` pause sets `pausePending` (waiting for the
 *    next tool call); resume clears it; `hold.started` consumes it. A pause the Huddle asked for itself (source huddle,
 *    a budget) also sets `pausedBy` to the event's detail (the budget's over item id); resume, the hold ending and
 *    the agent's end clear it, so it names exactly the agents that pause still holds.
 *  - Dismiss: `attention.resolved` with reason 'dismissed' also marks the item `dismissed`.
 *  - Outbox: `message.queued` appends to `outbox`; `message.delivered` / `message.dropped` remove the message. An
 *    agent's end clears its outbox, hold and pausePending (its process is gone).
 *  - After a request resolves or a hold ends, status is the most urgent thing left: an open approval, then an open
 *    question, then a hold, else working.
 *
 * Managed runs (M4 plan WP1, ADR-020):
 *  - Runs are kept in `book.runs` by runId, so their events may come in any order (a worktree is made before the
 *    process starts). A run is shown on its root (`AgentNode.run`) once `run.launched` names its Claude Code session
 *    (`claudeSessionId`); the first session named wins. The envelope of a run event is never used to find the run.
 *  - `run.launched` with a session creates the root as managed, or turns an attached root managed (with every node of
 *    the session). A later `session.started{origin:'attached'}` (the hook cannot tell) never turns a managed root back.
 *  - `run.exited`: the root ends (completed -> done, failed and spawn_failed -> failed, stopped -> stopped) unless it
 *    already ended; every other running node of the session is stopped and all interaction state is cleared, as on
 *    `session.ended` (the process is gone).
 *  - `budget.set` keeps one budget per scope and target in `HuddleState.budgets`; a budget with no limit clears it.
 *  - Managed subagents can be messaged only through the outbox (`message: 'queued'`): stdin reaches the main agent only.
 *
 * Phone access (M6, F26):
 *  - `phone.access_changed` sets `HuddleState.phone` (enabled, url, when and why); turning it off marks every phone
 *    disconnected. `phone.device_changed` adds a phone (paired, known), removes it (revoked) or sets its connected flag
 *    and lastSeenAt (connected, disconnected); a connect or disconnect for a phone not listed changes nothing.
 *
 * The Huddle's task list (F29):
 *  - `huddle_task.created` adds a task (status todo; a second created for the same id is ignored), `huddle_task.updated`
 *    changes only the fields it carries (an unknown status or a wrong type is ignored field by field),
 *    `huddle_task.deleted` removes it; both ignore an unknown id. Text is clipped again. At most MAX_HUDDLE_TASKS are
 *    kept, the oldest go first. The shown status is a selector (`selectHuddleTasks`), which reads the linked run.
 *
 * History (M5 WP5, F22):
 *  - `history.pruned` forgets the named sessions (their events were deleted), except the Huddle's own sessions, a
 *    managed run not seen to exit, and a session with an event after the prune (see `prunable`).
 */
import {
  agentKey,
  CLIP_LIMITS,
  cleanPromptTitle,
  EMPTY_USAGE,
  HUDDLE_TASK_DETAILS_MAX,
  HUDDLE_TASK_STATUSES,
  HUDDLE_TASK_TITLE_MAX,
  isTerminal,
  MAX_HUDDLE_TASKS,
  PHONE_DEVICE_NAME_MAX,
  PHONE_MAX_DEVICES,
  promptTopic,
} from '@huddle/shared';
import type {
  AgentCapabilities,
  AgentKey,
  AgentKind,
  AgentNode,
  AgentOrigin,
  AgentStatus,
  AttentionItem,
  AgentRun,
  BudgetEntry,
  ContextHealth,
  EventOfType,
  Handoff,
  HuddleEvent,
  HuddleState,
  HuddleTask,
  PhoneDeviceState,
  PhoneState,
  ProgressEstimate,
  RateLimits,
  RunWorktree,
  TaskItem,
  TokenUsage,
} from '@huddle/shared';
import { HUDDLE_SESSION_IDS } from './huddle-sessions.js';

// ---------------------------------------------------------------------------
// Bookkeeping types
// ---------------------------------------------------------------------------

/** An Agent call (PreToolUse) waiting for, or matched to, the subagent it started. */
export interface SpawnRecord {
  toolUseId: string | null;
  /** The caller: the agent that will be the child's parent. */
  parentKey: AgentKey;
  role: string | null;
  title: string | null;
  brief: string | null;
  model: string | null;
  /** The Agent call's name (M6): a named call starts the teammate of that name (S20). Absent when unnamed. */
  name?: string;
  /** The subagent this call is matched to, or null while unmatched. */
  childKey: AgentKey | null;
  /** True when the match came from agent.linked, false when it was made by order. */
  exact: boolean;
}

export interface SessionRoleInfo {
  description: string;
  definedIn: 'project' | 'user';
}

export interface SessionBook {
  title: string | null;
  /** Agent calls in arrival order. Bounded by MAX_SPAWNS_PER_SESSION (oldest dropped first). */
  spawns: SpawnRecord[];
  /** Subagents started so far, per role: the next ordinal is count + 1. */
  roleCounts: Record<string, number>;
  roles: Record<string, SessionRoleInfo>;
  /** Request ids of usage already counted, oldest first, at most MAX_SEEN_REQUEST_IDS (M2). Absent: none yet. */
  seenRequestIds?: string[];
}

export interface AgentBook {
  /** Rank of the source the current model came from (0: none). */
  modelRank: number;
  nickname: string | null;
  /** 1-based start order among subagents of the same role in the session; 1 for the main agent. */
  ordinal: number;
  /** Event ts of the latest status line context reading (M2). Absent: none. */
  statuslineContextAt?: number;
  /**
   * Event ts of the agent's latest prompt.submitted: its current turn began here. An open approval or question from
   * before it never got an end (a crash, a log without the broker, a terminal No) and is no reason to wait. Absent: no
   * prompt seen (the Huddle started mid-turn), so every open request counts.
   */
  turnStartedAt?: number;
}

export interface PendingLink {
  parentKey: AgentKey;
  toolUseId: string;
  link: Handoff['link'];
}

export interface PendingModel {
  model: string;
  rank: number;
}

/** Usage that arrived before its agent's node. own: the agent's own requests. helper: root helper requests. */
export interface PendingUsage {
  own: TokenUsage | null;
  helper: TokenUsage | null;
}

/** A managed run (M4): the session it is, once known, and what is shown on that root. */
export interface RunBook {
  sessionId: string | null;
  run: AgentRun;
}

export interface Bookkeeping {
  sessions: Record<string, SessionBook>;
  agents: Record<AgentKey, AgentBook>;
  /** agent.linked that arrived before its child's agent.started, by child key. */
  pendingLinks: Record<AgentKey, PendingLink>;
  /** Insertion order of pendingLinks, oldest first, for eviction. */
  pendingLinkOrder: AgentKey[];
  /** model.observed for an agent not seen yet (telemetry can beat the first hook), by agent key. */
  pendingModels: Record<AgentKey, PendingModel>;
  pendingModelOrder: AgentKey[];
  /** usage.recorded for an agent not seen yet, summed, by agent key (M2). */
  pendingUsage: Record<AgentKey, PendingUsage>;
  pendingUsageOrder: AgentKey[];
  /** Managed runs by runId (M4). Absent: none yet. */
  runs?: Record<string, RunBook>;
  /** Insertion order of runs, oldest first, for eviction (M4). */
  runOrder?: string[];
}

export interface ReducerState extends HuddleState {
  book: Bookkeeping;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** At most this many pending links, pending models and agents with pending usage are kept; the oldest goes first. */
export const MAX_PENDING = 100;
export const MAX_SPAWNS_PER_SESSION = 200;
/**
 * Request ids remembered per session for usage deduplication. A re-sent OTLP batch arrives seconds after the first;
 * 5,000 requests is hours of a busy session, and the list (about 150 KB of ids) stays cheap to copy.
 * Sessions are not capped here (keeping the reducer simple and pure): the number of session books is bounded by what
 * token-authenticated loopback senders post, each holds at most MAX_SEEN_REQUEST_IDS ids, and the telemetry
 * normalizer refuses ids longer than CLIP_LIMITS.id, so one session's list is at most 5,000 x 256 characters.
 */
export const MAX_SEEN_REQUEST_IDS = 5000;
/** A status line context reading younger than this (by event ts) is not overwritten by telemetry. */
export const STATUSLINE_CONTEXT_PRIORITY_MS = 30_000;
const MAX_INSTRUCTION_FILES = 200;
const MAX_INBOX = 500;
/** Queued messages kept per agent (the oldest goes first); the broker refuses a new one once this many are queued. */
export const MAX_OUTBOX = 100;
/** Managed runs remembered (M4); the oldest is forgotten first. A run is also on its root node, which stays. */
export const MAX_RUNS = 500;
/** Budgets kept (M4); the oldest goes first. */
export const MAX_BUDGETS = 500;
/** Tasks kept per agent: past this, the oldest completed task goes first, then the oldest one (capTasks). */
export const MAX_TASKS_PER_AGENT = 200;

const RANK_SPAWN_REQUEST = 1;
const RANK_OBSERVED = 2;
const RANK_AUTHORITATIVE = 3;

const MODEL_RANK: Record<EventOfType<'model.observed'>['via'], number> = {
  session_start: RANK_AUTHORITATIVE,
  switch: RANK_AUTHORITATIVE,
  telemetry: RANK_OBSERVED,
  agent_call: RANK_OBSERVED,
};

/**
 * SPEC §5 capability matrix, attached column, for a main agent. A subagent gets the same with `followUp: false`
 * (see `capabilitiesFor`).
 */
export const ATTACHED_CAPABILITIES: AgentCapabilities = {
  approve: true,
  // S5: interactive sessions answer through a held PreToolUse(AskUserQuestion) with updatedInput.answers.
  answerQuestions: true,
  message: 'queued',
  pause: true,
  stop: false, // background sessions only; not known per node in M1
  setModel: false,
  // S7: Stop `decision: block` continues the main agent's turn. SubagentStop block is not used in M3.
  followUp: true,
};

/** SPEC §5 capability matrix, managed column, for the main agent (the one that owns stdin). */
export const MANAGED_CAPABILITIES: AgentCapabilities = {
  approve: true,
  // S5: headless sessions have no AskUserQuestion tool, so managed sessions never raise one (answered as messages).
  answerQuestions: false,
  message: 'live',
  pause: true,
  stop: true,
  setModel: true,
  followUp: true,
};

/**
 * A subagent of a managed run (ADR-020 §5). Stdin reaches only the main agent, so a message is queued for the subagent's
 * next tool call; stopping and switching the model are run-level actions (on the root). Approvals and pause use the same
 * hooks as for any agent.
 */
export const MANAGED_SUBAGENT_CAPABILITIES: AgentCapabilities = {
  approve: true,
  answerQuestions: false,
  message: 'queued',
  pause: true,
  stop: false,
  setModel: false,
  followUp: false,
};

const NO_PROGRESS: ProgressEstimate = {
  fraction: null,
  completedTasks: 0,
  totalTasks: 0,
  etaMs: null,
  etaLowMs: null,
  etaHighMs: null,
  basis: 'none',
  confidence: 'low',
};

const NO_CONTEXT: ContextHealth = {
  usedTokens: null,
  windowTokens: null,
  usedPct: null,
  compactions: 0,
  lastCompactedAt: null,
  loadedInstructions: [],
  measuredBy: null,
};

const RUNNING: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'starting',
  'working',
  'waiting_approval',
  'waiting_answer',
  'paused',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function emptyBook(): Bookkeeping {
  return {
    sessions: {},
    agents: {},
    pendingLinks: {},
    pendingLinkOrder: [],
    pendingModels: {},
    pendingModelOrder: [],
    pendingUsage: {},
    pendingUsageOrder: [],
  };
}

export function initialState(): ReducerState {
  return { agents: {}, rootKeys: [], inbox: [], rateLimits: null, book: emptyBook() };
}

/** The part of the state the UI sees: drops the reducer's bookkeeping. */
export function toHuddleState(state: HuddleState): HuddleState {
  const view: HuddleState = {
    agents: state.agents,
    rootKeys: state.rootKeys,
    inbox: state.inbox,
    rateLimits: state.rateLimits,
  };
  if (state.budgets !== undefined) view.budgets = state.budgets;
  if (state.phone !== undefined) view.phone = state.phone;
  if (state.huddleTasks !== undefined) view.huddleTasks = state.huddleTasks;
  return view;
}

/** Folds events into a fresh state. Same events, same state. */
export function replay(events: Iterable<HuddleEvent>, from: HuddleState = initialState()): ReducerState {
  let state = withBook(from);
  for (const event of events) state = reduce(state, event);
  return state;
}

/** Applies one event. Pure; never mutates `state` or `event`. Unknown event types return the state as is. */
export function reduce(state: HuddleState, event: HuddleEvent): ReducerState {
  const tx = new Tx(state);
  const changed = apply(tx, event);
  return changed ? tx.finish() : withBook(state);
}

function withBook(state: HuddleState): ReducerState {
  return 'book' in state ? (state as ReducerState) : { ...state, book: emptyBook() };
}

// ---------------------------------------------------------------------------
// Own-property helpers: keys come from payloads, so never trust the prototype chain.
// ---------------------------------------------------------------------------

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

function deleteOwn<T>(record: Record<string, T>, key: string): void {
  if (Object.hasOwn(record, key)) Reflect.deleteProperty(record, key);
}

// ---------------------------------------------------------------------------
// Transaction: copy-on-write working set for one event
// ---------------------------------------------------------------------------

class Tx {
  readonly agents: Record<AgentKey, AgentNode>;
  rootKeys: AgentKey[];
  inbox: AttentionItem[];
  rateLimits: RateLimits | null;
  readonly sessions: Record<string, SessionBook>;
  readonly agentBooks: Record<AgentKey, AgentBook>;
  readonly pendingLinks: Record<AgentKey, PendingLink>;
  pendingLinkOrder: AgentKey[];
  readonly pendingModels: Record<AgentKey, PendingModel>;
  pendingModelOrder: AgentKey[];
  readonly pendingUsage: Record<AgentKey, PendingUsage>;
  pendingUsageOrder: AgentKey[];
  readonly runs: Record<string, RunBook>;
  runOrder: string[];
  budgets: BudgetEntry[] | undefined;
  phone: PhoneState | undefined;
  huddleTasks: HuddleTask[] | undefined;

  constructor(state: HuddleState) {
    const book = withBook(state).book;
    // Shallow copies: nodes and records inside are replaced, never edited in place.
    this.agents = { ...state.agents };
    this.rootKeys = state.rootKeys;
    this.inbox = state.inbox;
    this.rateLimits = state.rateLimits;
    this.sessions = { ...book.sessions };
    this.agentBooks = { ...book.agents };
    this.pendingLinks = { ...book.pendingLinks };
    this.pendingLinkOrder = book.pendingLinkOrder;
    this.pendingModels = { ...book.pendingModels };
    this.pendingModelOrder = book.pendingModelOrder;
    // Absent in a book made before M2.
    const old: Partial<Bookkeeping> = book;
    this.pendingUsage = { ...(old.pendingUsage ?? {}) };
    this.pendingUsageOrder = old.pendingUsageOrder ?? [];
    // Absent before M4.
    this.runs = { ...(old.runs ?? {}) };
    this.runOrder = old.runOrder ?? [];
    this.budgets = state.budgets;
    this.phone = state.phone;
    this.huddleTasks = state.huddleTasks;
  }

  finish(): ReducerState {
    const book: Bookkeeping = {
      sessions: this.sessions,
      agents: this.agentBooks,
      pendingLinks: this.pendingLinks,
      pendingLinkOrder: this.pendingLinkOrder,
      pendingModels: this.pendingModels,
      pendingModelOrder: this.pendingModelOrder,
      pendingUsage: this.pendingUsage,
      pendingUsageOrder: this.pendingUsageOrder,
    };
    // Present only once a run was seen, so states made from logs without runs look exactly as before M4.
    if (this.runOrder.length > 0) {
      book.runs = this.runs;
      book.runOrder = this.runOrder;
    }
    const next: ReducerState = {
      agents: this.agents,
      rootKeys: this.rootKeys,
      inbox: this.inbox,
      rateLimits: this.rateLimits,
      book,
    };
    if (this.budgets !== undefined) next.budgets = this.budgets;
    if (this.phone !== undefined) next.phone = this.phone;
    if (this.huddleTasks !== undefined) next.huddleTasks = this.huddleTasks;
    return next;
  }

  run(runId: string): RunBook | undefined {
    return getOwn(this.runs, runId);
  }

  putRun(runId: string, run: RunBook): void {
    const isNew = !Object.hasOwn(this.runs, runId);
    setOwn(this.runs, runId, run);
    if (isNew) this.runOrder = [...this.runOrder, runId];
    while (this.runOrder.length > MAX_RUNS) {
      const [oldest, ...rest] = this.runOrder;
      this.runOrder = rest;
      if (oldest !== undefined) deleteOwn(this.runs, oldest);
    }
  }

  node(key: AgentKey): AgentNode | undefined {
    return getOwn(this.agents, key);
  }

  patch(key: AgentKey, patch: Partial<AgentNode>): AgentNode | undefined {
    const node = this.node(key);
    if (node === undefined) return undefined;
    const next = { ...node, ...patch };
    setOwn(this.agents, key, next);
    return next;
  }

  session(sessionId: string): SessionBook {
    return getOwn(this.sessions, sessionId) ?? { title: null, spawns: [], roleCounts: {}, roles: {} };
  }

  putSession(sessionId: string, book: SessionBook): void {
    setOwn(this.sessions, sessionId, book);
  }

  agentBook(key: AgentKey): AgentBook {
    return getOwn(this.agentBooks, key) ?? { modelRank: 0, nickname: null, ordinal: 1 };
  }

  putAgentBook(key: AgentKey, book: AgentBook): void {
    setOwn(this.agentBooks, key, book);
  }

  /** Moves the session's root to the front of rootKeys (most recently active first). */
  touchRoot(rootKey: AgentKey): void {
    if (this.rootKeys[0] === rootKey) return;
    this.rootKeys = [rootKey, ...this.rootKeys.filter((k) => k !== rootKey)];
  }

  /** Records that `key` did something at `ts`. */
  touch(key: AgentKey, ts: number): void {
    const node = this.node(key);
    if (node === undefined) return;
    if (ts > node.lastEventAt) this.patch(key, { lastEventAt: ts });
    this.touchRoot(agentKey(node.sessionId));
  }

  addPendingLink(childKey: AgentKey, link: PendingLink): void {
    const isNew = !Object.hasOwn(this.pendingLinks, childKey);
    setOwn(this.pendingLinks, childKey, link);
    if (isNew) this.pendingLinkOrder = [...this.pendingLinkOrder, childKey];
    while (this.pendingLinkOrder.length > MAX_PENDING) {
      const [oldest, ...rest] = this.pendingLinkOrder;
      this.pendingLinkOrder = rest;
      if (oldest !== undefined) deleteOwn(this.pendingLinks, oldest);
    }
  }

  takePendingLink(childKey: AgentKey): PendingLink | undefined {
    const link = getOwn(this.pendingLinks, childKey);
    if (link === undefined) return undefined;
    deleteOwn(this.pendingLinks, childKey);
    this.pendingLinkOrder = this.pendingLinkOrder.filter((k) => k !== childKey);
    return link;
  }

  addPendingModel(key: AgentKey, model: PendingModel): void {
    const existing = getOwn(this.pendingModels, key);
    if (existing !== undefined && existing.rank > model.rank) return;
    setOwn(this.pendingModels, key, model);
    if (existing === undefined) this.pendingModelOrder = [...this.pendingModelOrder, key];
    while (this.pendingModelOrder.length > MAX_PENDING) {
      const [oldest, ...rest] = this.pendingModelOrder;
      this.pendingModelOrder = rest;
      if (oldest !== undefined) deleteOwn(this.pendingModels, oldest);
    }
  }

  addPendingUsage(key: AgentKey, delta: TokenUsage, helper: boolean): void {
    const existing = getOwn(this.pendingUsage, key);
    const entry: PendingUsage = existing ?? { own: null, helper: null };
    const next: PendingUsage = helper
      ? { ...entry, helper: addUsage(entry.helper ?? EMPTY_USAGE, delta) }
      : { ...entry, own: addUsage(entry.own ?? EMPTY_USAGE, delta) };
    setOwn(this.pendingUsage, key, next);
    if (existing === undefined) this.pendingUsageOrder = [...this.pendingUsageOrder, key];
    while (this.pendingUsageOrder.length > MAX_PENDING) {
      const [oldest, ...rest] = this.pendingUsageOrder;
      this.pendingUsageOrder = rest;
      if (oldest !== undefined) deleteOwn(this.pendingUsage, oldest);
    }
  }

  takePendingUsage(key: AgentKey): PendingUsage | undefined {
    const usage = getOwn(this.pendingUsage, key);
    if (usage === undefined) return undefined;
    deleteOwn(this.pendingUsage, key);
    this.pendingUsageOrder = this.pendingUsageOrder.filter((k) => k !== key);
    return usage;
  }

  takePendingModel(key: AgentKey): PendingModel | undefined {
    const model = getOwn(this.pendingModels, key);
    if (model === undefined) return undefined;
    deleteOwn(this.pendingModels, key);
    this.pendingModelOrder = this.pendingModelOrder.filter((k) => k !== key);
    return model;
  }
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/**
 * The capabilities of a node, by origin and kind. A subagent never gets end-of-turn follow-ups (M3: main agents only);
 * a managed subagent gets MANAGED_SUBAGENT_CAPABILITIES (M4).
 */
export function capabilitiesFor(origin: AgentOrigin, kind: AgentKind): AgentCapabilities {
  if (origin === 'managed' && kind !== 'main') return { ...MANAGED_SUBAGENT_CAPABILITIES };
  const base = origin === 'managed' ? MANAGED_CAPABILITIES : ATTACHED_CAPABILITIES;
  return { ...base, followUp: kind === 'main' && base.followUp === true };
}

function newNode(args: {
  key: AgentKey;
  sessionId: string;
  agentId: string | null;
  parentKey: AgentKey | null;
  kind: AgentKind;
  origin: AgentOrigin;
  role: string;
  handoff: Handoff | null;
  status: AgentStatus;
  ts: number;
}): AgentNode {
  return {
    key: args.key,
    sessionId: args.sessionId,
    agentId: args.agentId,
    parentKey: args.parentKey,
    childKeys: [],
    kind: args.kind,
    origin: args.origin,
    name: args.role,
    role: args.role,
    roleDescription: null,
    model: null,
    cwd: null,
    status: args.status,
    currentActivity: null,
    tasks: [],
    progress: { ...NO_PROGRESS },
    usage: { ...EMPTY_USAGE },
    context: { ...NO_CONTEXT, loadedInstructions: [] },
    handoff: args.handoff,
    capabilities: capabilitiesFor(args.origin, args.kind),
    toolCalls: 0,
    toolFailures: 0,
    startedAt: args.ts,
    endedAt: null,
    lastEventAt: args.ts,
  };
}

/** Display name: nickname, then session title (main) or handoff title (subagent), then role plus ordinal. */
function displayName(node: AgentNode, agent: AgentBook, session: SessionBook): string {
  if (agent.nickname !== null) return agent.nickname;
  if (node.kind === 'main') return session.title ?? 'main';
  // A teammate's role is its name (S20): the name the lead gave it, which is how the user refers to it.
  if (node.kind === 'teammate') return node.role;
  const title = node.handoff?.title ?? null;
  if (title !== null && title.trim() !== '') return title;
  return `${node.role} #${String(agent.ordinal)}`;
}

function refreshName(tx: Tx, key: AgentKey): void {
  const node = tx.node(key);
  if (node === undefined) return;
  const name = displayName(node, tx.agentBook(key), tx.session(node.sessionId));
  if (name !== node.name) tx.patch(key, { name });
}

function refreshRoleDescription(tx: Tx, key: AgentKey): void {
  const node = tx.node(key);
  if (node === undefined || node.kind === 'main') return;
  const description = getOwn(tx.session(node.sessionId).roles, node.role)?.description ?? null;
  if (description !== node.roleDescription) tx.patch(key, { roleDescription: description });
}

function applyModel(tx: Tx, key: AgentKey, model: string, rank: number): void {
  const node = tx.node(key);
  if (node === undefined) {
    tx.addPendingModel(key, { model, rank });
    return;
  }
  const book = tx.agentBook(key);
  if (rank < book.modelRank) return;
  tx.putAgentBook(key, { ...book, modelRank: rank });
  if (node.model !== model) tx.patch(key, { model });
}

/** a + b. The optional counters are present only when non-zero, so "none" stays absent. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    requests: a.requests + b.requests,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
  };
  const withoutId = (a.requestsWithoutId ?? 0) + (b.requestsWithoutId ?? 0);
  const withoutCost = (a.requestsWithoutCost ?? 0) + (b.requestsWithoutCost ?? 0);
  if (withoutId > 0) sum.requestsWithoutId = withoutId;
  if (withoutCost > 0) sum.requestsWithoutCost = withoutCost;
  return sum;
}

function addToNode(tx: Tx, key: AgentKey, delta: TokenUsage, helper: boolean): void {
  const node = tx.node(key);
  if (node === undefined) return;
  if (helper) tx.patch(key, { helperUsage: addUsage(node.helperUsage ?? EMPTY_USAGE, delta) });
  else tx.patch(key, { usage: addUsage(node.usage, delta) });
}

function applyPendingUsage(tx: Tx, key: AgentKey): void {
  const pending = tx.takePendingUsage(key);
  if (pending === undefined) return;
  if (pending.own !== null) addToNode(tx, key, pending.own, false);
  if (pending.helper !== null) addToNode(tx, key, pending.helper, true);
}

function applyPendingModel(tx: Tx, key: AgentKey): void {
  const pending = tx.takePendingModel(key);
  if (pending !== undefined) applyModel(tx, key, pending.model, pending.rank);
}

/** The session's main agent, created on first sight (the Huddle may start mid-session). */
function ensureRoot(tx: Tx, sessionId: string, ts: number, origin: AgentOrigin = 'attached'): AgentNode {
  const key = agentKey(sessionId);
  const existing = tx.node(key);
  if (existing !== undefined) return existing;
  const node = newNode({
    key,
    sessionId,
    agentId: null,
    parentKey: null,
    kind: 'main',
    origin,
    role: 'main',
    handoff: null,
    status: 'starting',
    ts,
  });
  setOwn(tx.agents, key, node);
  tx.putAgentBook(key, { modelRank: 0, nickname: null, ordinal: 1 });
  tx.touchRoot(key);
  applyPendingModel(tx, key);
  applyPendingUsage(tx, key);
  refreshName(tx, key);
  return tx.node(key) ?? node;
}

function isMainKey(event: HuddleEvent): boolean {
  return event.agentKey === agentKey(event.sessionId);
}

/**
 * The node an event is about. Creates the session root when needed. Returns undefined for an unknown
 * subagent: without its SubagentStart there is no role, and it may be a hidden helper.
 */
function target(tx: Tx, event: HuddleEvent): AgentNode | undefined {
  ensureRoot(tx, event.sessionId, event.ts);
  return tx.node(event.agentKey);
}

/**
 * Status after an activity signal: finished agents stay finished, a held agent stays paused, and a waiting state
 * clears unless the agent still has an open approval or question (a parallel call finishing while a request waits).
 * `endedTool`: the tool of a `tool.finished` / `tool.failed`. An approval for that tool counts as answered for the
 * status: PermissionRequest has no tool_use_id, and that call ending means it was answered (in the terminal, M1).
 * The item itself stays open until its own end, so a held request never leaves the inbox on a guess.
 */
function activeStatus(tx: Tx, node: AgentNode, endedTool: string | null): AgentStatus {
  // A teammate's done is not final (M6 P5b): one that acts again is working again (reviveTeammate clears endedAt).
  if (isTerminal(node.status) && !(node.kind === 'teammate' && node.status === 'done')) return node.status;
  if (node.status === 'waiting_approval' || node.status === 'waiting_answer') {
    if (hasOpenItem(tx, node.key, 'approval', (i) => i.approval?.toolName !== endedTool)) return 'waiting_approval';
    if (hasOpenItem(tx, node.key, 'question')) return 'waiting_answer';
  }
  return isHeld(node) ? 'paused' : 'working';
}

/** activeStatus, plus endedAt null when a done teammate acts again (M6 P5b): it is not finished any more. */
function activePatch(
  tx: Tx,
  node: AgentNode,
  endedTool: string | null,
): Pick<AgentNode, 'status'> & Partial<Pick<AgentNode, 'endedAt'>> {
  const status = activeStatus(tx, node, endedTool);
  return node.kind === 'teammate' && node.status === 'done' && status !== 'done'
    ? { status, endedAt: null }
    : { status };
}

function isHeld(node: AgentNode): boolean {
  return node.hold !== undefined && node.hold !== null;
}

/** Is any subagent of the session still running? */
function hasRunningSubagent(tx: Tx, sessionId: string): boolean {
  for (const node of Object.values(tx.agents)) {
    if (node.sessionId === sessionId && node.kind !== 'main' && RUNNING.has(node.status)) return true;
  }
  return false;
}

/**
 * Main agent after its own Stop (ADR-012): idle only when no background subagent is left.
 * `backgroundAgentIds` null (the payload did not say, or an older log): fall back to the tree itself:
 * idle when no subagent of the session is still running, otherwise working. A later Stop corrects it.
 */
function mainStatusAfterStop(tx: Tx, sessionId: string, backgroundAgentIds: string[] | null): AgentStatus {
  if (backgroundAgentIds === null) return hasRunningSubagent(tx, sessionId) ? 'working' : 'idle';
  return backgroundAgentIds.length === 0 ? 'idle' : 'working';
}

function unknownHandoff(): Handoff {
  return { toolUseId: null, title: null, brief: null, result: null, link: 'unknown' };
}

function handoffFromSpawn(spawn: SpawnRecord, link: Handoff['link'], result: string | null): Handoff {
  return { toolUseId: spawn.toolUseId, title: spawn.title, brief: spawn.brief, result, link };
}

/** A spawn without subagent_type starts the default agent, general-purpose. */
function spawnRoleMatches(spawn: SpawnRecord, role: string): boolean {
  return (spawn.role ?? 'general-purpose') === role;
}

/**
 * Does an unmatched Agent call belong to this new agent? A teammate matches the call that named it (its role is its
 * name, the call's subagent_type is the template); anything else matches by role. A named call can still start a plain
 * subagent (with -p, S20 a), so a name does not exclude a role match.
 */
function spawnMatches(spawn: SpawnRecord, event: EventOfType<'agent.started'>): boolean {
  if (event.teammateName !== undefined) return spawn.name === event.teammateName;
  return spawnRoleMatches(spawn, event.role);
}

/** Makes an existing non-main node a teammate under the session root (M6, S20). */
function makeTeammate(tx: Tx, node: AgentNode, root: AgentNode): void {
  if (node.kind === 'main') return;
  if (node.kind !== 'teammate') {
    tx.patch(node.key, { kind: 'teammate', capabilities: capabilitiesFor(node.origin, 'teammate') });
  }
  if (node.parentKey !== root.key) {
    detach(tx, node.key, node.parentKey);
    attach(tx, node.key, root.key);
    tx.patch(node.key, { parentKey: root.key });
  }
}

/** Would making `parentKey` the parent of `childKey` create a cycle? */
function wouldCycle(tx: Tx, childKey: AgentKey, parentKey: AgentKey): boolean {
  let cursor: AgentKey | null = parentKey;
  for (let guard = 0; cursor !== null && guard < 10_000; guard += 1) {
    if (cursor === childKey) return true;
    cursor = tx.node(cursor)?.parentKey ?? null;
  }
  return false;
}

function detach(tx: Tx, childKey: AgentKey, parentKey: AgentKey | null): void {
  if (parentKey === null) return;
  const parent = tx.node(parentKey);
  if (parent === undefined || !parent.childKeys.includes(childKey)) return;
  tx.patch(parentKey, { childKeys: parent.childKeys.filter((k) => k !== childKey) });
}

function attach(tx: Tx, childKey: AgentKey, parentKey: AgentKey): void {
  const parent = tx.node(parentKey);
  if (parent === undefined || parent.childKeys.includes(childKey)) return;
  tx.patch(parentKey, { childKeys: [...parent.childKeys, childKey] });
}

/** Ties spawn `toolUseId` to `childKey` exactly, releasing any order-based match the child held before. */
function markSpawnExact(tx: Tx, sessionId: string, childKey: AgentKey, toolUseId: string): SpawnRecord | undefined {
  const session = tx.session(sessionId);
  let found: SpawnRecord | undefined;
  const spawns = session.spawns.map((spawn) => {
    if (spawn.toolUseId === toolUseId) {
      found = { ...spawn, childKey, exact: true };
      return found;
    }
    if (spawn.childKey === childKey && !spawn.exact) return { ...spawn, childKey: null };
    return spawn;
  });
  tx.putSession(sessionId, { ...session, spawns });
  return found;
}

// ---------------------------------------------------------------------------
// Event handlers. Each returns false when the state did not change.
// ---------------------------------------------------------------------------

function apply(tx: Tx, event: HuddleEvent): boolean {
  switch (event.type) {
    case 'session.started':
      return onSessionStarted(tx, event);
    case 'session.ended':
      return onSessionEnded(tx, event);
    case 'prompt.submitted':
      return onPromptSubmitted(tx, event);
    case 'agent.spawn_requested':
      return onSpawnRequested(tx, event);
    case 'agent.started':
      return onAgentStarted(tx, event);
    case 'agent.stopped':
      return onAgentStopped(tx, event);
    case 'agent.linked':
      return onAgentLinked(tx, event);
    case 'teammate.idle':
      return onTeammateIdle(tx, event);
    case 'teammate.reported':
      return onTeammateReported(tx, event);
    case 'role.described':
      return onRoleDescribed(tx, event);
    case 'turn.ended':
      return onTurnEnded(tx, event);
    case 'turn.failed':
      return onTurnFailed(tx, event);
    case 'tool.started':
      return onToolStarted(tx, event);
    case 'tool.finished':
      return onToolFinished(tx, event);
    case 'tool.failed':
      return onToolFailed(tx, event);
    case 'approval.requested':
      return onApprovalRequested(tx, event);
    case 'question.asked':
      return onQuestionAsked(tx, event);
    case 'approval.resolved':
      return onRequestEnded(tx, event, approvalItemId(event.requestId));
    case 'question.answered':
    case 'question.closed':
      return onRequestEnded(tx, event, questionItemId(event.requestId));
    case 'hold.started':
      return onHoldStarted(tx, event);
    case 'hold.ended':
      return onHoldEnded(tx, event);
    case 'message.queued':
      return onMessageQueued(tx, event);
    case 'message.delivered':
    case 'message.dropped':
      return onMessageGone(tx, event, event.messageId);
    case 'task.created':
      return onTaskCreated(tx, event);
    case 'task.started':
      return onTaskStarted(tx, event);
    case 'task.completed':
      return onTaskCompleted(tx, event);
    case 'context.measured':
      return onContextMeasured(tx, event);
    case 'context.compacted':
      return onContextCompacted(tx, event);
    case 'model.changed':
      return onModel(tx, event, event.to, RANK_AUTHORITATIVE);
    case 'model.observed':
      return onModelObserved(tx, event);
    case 'instructions.loaded':
      return onInstructionsLoaded(tx, event);
    case 'limits.measured':
      tx.rateLimits = mergeLimits(tx.rateLimits, event.limits);
      return true;
    case 'control.applied':
      return onControlApplied(tx, event);
    case 'attention.raised':
      return onAttentionRaised(tx, event);
    case 'attention.resolved':
      return onAttentionResolved(tx, event);
    case 'notification.raised':
      return onTouchOnly(tx, event);
    case 'progress.reported':
      return onProgressReported(tx, event);
    case 'usage.recorded':
      return onUsageRecorded(tx, event);
    case 'run.launched':
      return onRunLaunched(tx, event);
    case 'run.exited':
      return onRunExited(tx, event);
    case 'run.result':
      return onRunResult(tx, event);
    case 'worktree.created':
      return onWorktreeCreated(tx, event);
    case 'worktree.summarized':
      return onWorktreeSummarized(tx, event);
    case 'worktree.closed':
      return onWorktreeClosed(tx, event);
    case 'budget.set':
      return onBudgetSet(tx, event);
    case 'history.pruned':
      return onHistoryPruned(tx, event);
    case 'phone.access_changed':
      return onPhoneAccessChanged(tx, event);
    case 'phone.device_changed':
      return onPhoneDeviceChanged(tx, event);
    case 'huddle_task.created':
      return onHuddleTaskCreated(tx, event);
    case 'huddle_task.updated':
      return onHuddleTaskUpdated(tx, event);
    case 'huddle_task.deleted':
      return onHuddleTaskDeleted(tx, event);
    default:
      // An event type this build does not know (a newer log): unchanged.
      return false;
  }
}

/**
 * M4 WP6: a reading replaces only the windows it carries. A managed run's stream reports the seven-day window alone
 * (S16); replacing the whole value would blank the five-hour window the status line reported a moment ago. A window
 * counts as carried when its percentage or its reset time is known. `measuredAt` is the newest reading's.
 */
function mergeLimits(previous: RateLimits | null, next: RateLimits): RateLimits {
  if (previous === null) return next;
  const fiveHour = next.fiveHourUsedPct !== null || next.fiveHourResetsAt !== null;
  const sevenDay = next.sevenDayUsedPct !== null || next.sevenDayResetsAt !== null;
  return {
    fiveHourUsedPct: fiveHour ? next.fiveHourUsedPct : previous.fiveHourUsedPct,
    fiveHourResetsAt: fiveHour ? next.fiveHourResetsAt : previous.fiveHourResetsAt,
    sevenDayUsedPct: sevenDay ? next.sevenDayUsedPct : previous.sevenDayUsedPct,
    sevenDayResetsAt: sevenDay ? next.sevenDayResetsAt : previous.sevenDayResetsAt,
    measuredAt: next.measuredAt,
  };
}

/**
 * F27 (M6): keep the agent's latest self-report, raw. A report older than the one kept (by event time) is ignored, so
 * a late duplicate cannot move the bar back. Only the calling agent: a subagent's report never lands on its parent.
 * The report is activity (touch) but not a status change: the tool.* events of the same call already say "working".
 */
function onProgressReported(tx: Tx, event: EventOfType<'progress.reported'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  const kept = node.selfReport ?? null;
  if (kept === null || event.ts >= kept.at) {
    tx.patch(node.key, {
      selfReport: { fraction: event.fraction, minutesLeft: event.etaMinutes, note: event.note, at: event.ts },
    });
  }
  tx.touch(node.key, event.ts);
  return true;
}

function onTouchOnly(tx: Tx, event: HuddleEvent): boolean {
  if (target(tx, event) !== undefined) tx.touch(event.agentKey, event.ts);
  return true;
}

function onSessionStarted(tx: Tx, event: EventOfType<'session.started'>): boolean {
  const root = ensureRoot(tx, event.sessionId, event.ts, event.origin);
  const patch: Partial<AgentNode> = {};
  if (event.cwd !== null) patch.cwd = event.cwd;
  // The trusted session folder (M4, F18) is set once: a later SessionStart (compact, clear) never moves it.
  if (event.cwd !== null && (root.sessionCwd ?? null) === null) patch.sessionCwd = event.cwd;
  // Only attached -> managed may switch: a managed run's own SessionStart hook says attached (it cannot tell).
  if (root.origin !== event.origin && event.origin === 'managed') {
    patch.origin = event.origin;
    patch.capabilities = capabilitiesFor(event.origin, 'main');
  }
  // resume / clear after the session ended: the main agent is back.
  if (isTerminal(root.status)) {
    patch.status = 'starting';
    patch.endedAt = null;
  }
  tx.patch(root.key, patch);
  if (event.title !== null) {
    const session = tx.session(event.sessionId);
    tx.putSession(event.sessionId, { ...session, title: event.title });
  }
  // Older logs carry the model only here; newer ones also emit model.observed{session_start}.
  if (event.model !== null) applyModel(tx, root.key, event.model, RANK_AUTHORITATIVE);
  refreshName(tx, root.key);
  tx.touch(root.key, event.ts);
  return true;
}

function onSessionEnded(tx: Tx, event: EventOfType<'session.ended'>): boolean {
  const root = ensureRoot(tx, event.sessionId, event.ts);
  tx.patch(root.key, { status: 'done', endedAt: event.ts, currentActivity: null });
  // The session's process is gone, so anything still running in it is stopped.
  for (const node of Object.values(tx.agents)) {
    if (node.sessionId !== event.sessionId) continue;
    endInteraction(tx, node.key, event.ts);
    if (node.kind === 'main' || isTerminal(node.status)) continue;
    tx.patch(node.key, { status: 'stopped', endedAt: event.ts, currentActivity: null });
  }
  tx.touch(root.key, event.ts);
  return true;
}

function onPromptSubmitted(tx: Tx, event: EventOfType<'prompt.submitted'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  // A prompt (typed, a task notification or an agent message) starts a new turn.
  const patch: Partial<AgentNode> = { status: 'working', endedAt: null, currentActivity: null };
  // A session first seen mid-run never sent SessionStart: its prompt's folder is the first one Huddle learns. Only
  // `cwd`; the trusted `sessionCwd` rules match against is never set from here.
  if (node.kind === 'main' && node.cwd === null && event.cwd !== undefined && event.cwd !== '') patch.cwd = event.cwd;
  // What the user last asked a main agent, so its card can say what the session is about. Typed prompts only: task
  // notifications, agent messages and anything that opens with a tag (`<browser_instruction>`) leave it as it was.
  if (node.kind === 'main' && (event.kind ?? 'user') === 'user') {
    const topic = promptTopic(event.text);
    if (topic !== null) patch.lastPrompt = topic;
    // The sidebar's title for an unnamed session: the first typed prompt that still says something once Claude Code's
    // tag blocks are stripped. Set once; a later prompt never moves it.
    if (node.firstPrompt === undefined || node.firstPrompt === null) {
      const first = cleanPromptTitle(event.text);
      if (first !== null) patch.firstPrompt = first;
    }
  }
  tx.patch(node.key, patch);
  tx.putAgentBook(node.key, { ...tx.agentBook(node.key), turnStartedAt: event.ts });
  tx.touch(node.key, event.ts);
  return true;
}

function onSpawnRequested(tx: Tx, event: EventOfType<'agent.spawn_requested'>): boolean {
  const root = ensureRoot(tx, event.sessionId, event.ts);
  const caller = tx.node(event.agentKey) ?? root;
  const session = tx.session(event.sessionId);
  const spawn: SpawnRecord = {
    toolUseId: event.toolUseId,
    parentKey: caller.key,
    role: event.role,
    title: event.title,
    brief: event.brief,
    model: event.model,
    childKey: null,
    exact: false,
    ...(event.name !== undefined ? { name: event.name } : {}),
  };
  const spawns = [...session.spawns, spawn];
  tx.putSession(event.sessionId, {
    ...session,
    spawns: spawns.length > MAX_SPAWNS_PER_SESSION ? spawns.slice(spawns.length - MAX_SPAWNS_PER_SESSION) : spawns,
  });
  tx.touch(caller.key, event.ts);
  return true;
}

function onAgentStarted(tx: Tx, event: EventOfType<'agent.started'>): boolean {
  const root = ensureRoot(tx, event.sessionId, event.ts);
  const key = event.agentKey;
  if (key === root.key) {
    tx.touch(key, event.ts);
    return true;
  }

  const existing = tx.node(key);
  if (existing !== undefined) {
    // Resumed subagent (S2 addendum), or a teammate handling a new message (S20): reopen the same node.
    tx.patch(key, { status: 'working', endedAt: null, currentActivity: null });
    const pending = tx.takePendingLink(key);
    if (pending !== undefined) linkExisting(tx, event.sessionId, key, pending);
    if (event.teammateName !== undefined) {
      const node = tx.node(key);
      if (node !== undefined) makeTeammate(tx, node, root);
      refreshName(tx, key);
    }
    tx.touch(key, event.ts);
    return true;
  }

  // Placement: an early exact link first, else the first unmatched Agent call with the same role.
  const session = tx.session(event.sessionId);
  let parentKey: AgentKey = tx.node(event.parentKey) !== undefined ? event.parentKey : root.key;
  let handoff: Handoff = unknownHandoff();
  let spawnModel: string | null = null;

  const pending = tx.takePendingLink(key);
  if (pending !== undefined && tx.node(pending.parentKey) !== undefined && !wouldCycle(tx, key, pending.parentKey)) {
    parentKey = pending.parentKey;
    const spawn = markSpawnExact(tx, event.sessionId, key, pending.toolUseId);
    handoff =
      spawn !== undefined
        ? handoffFromSpawn(spawn, pending.link, null)
        : { ...unknownHandoff(), toolUseId: pending.toolUseId, link: pending.link };
    spawnModel = spawn?.model ?? null;
  } else {
    const index = session.spawns.findIndex((s) => s.childKey === null && spawnMatches(s, event));
    const spawn = session.spawns[index];
    if (spawn !== undefined) {
      if (tx.node(spawn.parentKey) !== undefined) parentKey = spawn.parentKey;
      handoff = handoffFromSpawn(spawn, 'heuristic', null);
      spawnModel = spawn.model;
      const spawns = session.spawns.map((s, i) => (i === index ? { ...s, childKey: key, exact: false } : s));
      tx.putSession(event.sessionId, { ...session, spawns });
    }
  }

  const latest = tx.session(event.sessionId);
  const ordinal = (getOwn(latest.roleCounts, event.role) ?? 0) + 1;
  const roleCounts = { ...latest.roleCounts };
  setOwn(roleCounts, event.role, ordinal);
  tx.putSession(event.sessionId, { ...latest, roleCounts });

  // A teammate always sits under the lead, the session root (S20: it shares the lead's session_id; no nested teams).
  const teammate = event.teammateName !== undefined;
  const parent = teammate ? root : (tx.node(parentKey) ?? root);
  const node = newNode({
    key,
    sessionId: event.sessionId,
    agentId: event.agentId,
    parentKey: parent.key,
    kind: teammate ? 'teammate' : 'subagent',
    origin: parent.origin,
    role: event.role,
    handoff,
    status: 'working',
    ts: event.ts,
  });
  setOwn(tx.agents, key, node);
  tx.putAgentBook(key, { modelRank: 0, nickname: null, ordinal });
  attach(tx, key, parent.key);
  if (spawnModel !== null) applyModel(tx, key, spawnModel, RANK_SPAWN_REQUEST);
  applyPendingModel(tx, key);
  applyPendingUsage(tx, key);
  refreshRoleDescription(tx, key);
  refreshName(tx, key);
  tx.touch(key, event.ts);
  return true;
}

/** Moves an existing child under the parent named by an exact link. Idempotent. */
function linkExisting(tx: Tx, sessionId: string, childKey: AgentKey, link: PendingLink): void {
  const child = tx.node(childKey);
  if (child === undefined || tx.node(link.parentKey) === undefined) return;
  if (wouldCycle(tx, childKey, link.parentKey)) return;
  if (child.parentKey !== link.parentKey) {
    detach(tx, childKey, child.parentKey);
    attach(tx, childKey, link.parentKey);
  }
  const spawn = markSpawnExact(tx, sessionId, childKey, link.toolUseId);
  const result = child.handoff?.result ?? null;
  const handoff =
    spawn !== undefined
      ? handoffFromSpawn(spawn, link.link, result)
      : { ...(child.handoff ?? unknownHandoff()), toolUseId: link.toolUseId, link: link.link };
  tx.patch(childKey, { parentKey: link.parentKey, handoff });
  refreshName(tx, childKey);
}

function onAgentLinked(tx: Tx, event: EventOfType<'agent.linked'>): boolean {
  const root = ensureRoot(tx, event.sessionId, event.ts);
  const link: PendingLink = { parentKey: event.parentKey, toolUseId: event.toolUseId, link: event.link };
  const child = tx.node(event.agentKey);
  if (child === undefined) {
    // The link beat the child's agent.started: remember it, and keep the Agent call from being matched by order.
    if (event.agentKey !== root.key) {
      tx.addPendingLink(event.agentKey, link);
      markSpawnExact(tx, event.sessionId, event.agentKey, event.toolUseId);
    }
    return true;
  }
  if (child.kind === 'main') return true;
  linkExisting(tx, event.sessionId, child.key, link);
  return true;
}

/**
 * TeammateIdle (S20): the teammate finished its turn and waits for messages. It follows the teammate's SubagentStop
 * (which marked it done) by about 20 ms, so idle replaces done; failed and stopped stay. The node becomes a teammate
 * under the root if it was not one yet. Without an agent id it is found by name; a teammate never seen before (the
 * Huddle started mid-run) is created idle when the event names its agent id, because TeammateIdle is never a helper.
 */
function onTeammateIdle(tx: Tx, event: EventOfType<'teammate.idle'>): boolean {
  const root = ensureRoot(tx, event.sessionId, event.ts);
  const node =
    event.agentId !== null
      ? tx.node(event.agentKey)
      : Object.values(tx.agents).find(
          (n) => n.sessionId === event.sessionId && n.kind === 'teammate' && n.role === event.teammateName,
        );
  if (node === undefined) {
    if (event.agentId === null || event.agentKey === root.key) return true;
    const latest = tx.session(event.sessionId);
    const ordinal = (getOwn(latest.roleCounts, event.teammateName) ?? 0) + 1;
    const roleCounts = { ...latest.roleCounts };
    setOwn(roleCounts, event.teammateName, ordinal);
    tx.putSession(event.sessionId, { ...latest, roleCounts });
    const created = newNode({
      key: event.agentKey,
      sessionId: event.sessionId,
      agentId: event.agentId,
      parentKey: root.key,
      kind: 'teammate',
      origin: root.origin,
      role: event.teammateName,
      handoff: unknownHandoff(),
      status: 'idle',
      ts: event.ts,
    });
    setOwn(tx.agents, created.key, created);
    tx.putAgentBook(created.key, { modelRank: 0, nickname: null, ordinal });
    attach(tx, created.key, root.key);
    applyPendingModel(tx, created.key);
    applyPendingUsage(tx, created.key);
    refreshRoleDescription(tx, created.key);
    refreshName(tx, created.key);
    tx.touch(created.key, event.ts);
    return true;
  }
  if (node.kind === 'main') return true;
  makeTeammate(tx, node, root);
  const keep = node.status === 'failed' || node.status === 'stopped';
  if (!keep) tx.patch(node.key, { status: isHeld(node) ? 'paused' : 'idle', endedAt: null, currentActivity: null });
  refreshName(tx, node.key);
  tx.touch(node.key, event.ts);
  return true;
}

/**
 * The lead's answer about one of its teammates (M6 P5b, ADR-027). The teammate is the session's teammate node whose
 * role (its name, S20) equals `teammateName`; with several (a name reused after a stop), the one seen last. finished:
 * done, endedAt = the event time, so it reads finished and counts in the lead's subagent basis; waiting: nothing changes
 * (an idle teammate is already counted as open). Only an idle teammate changes: the question was about an idle one, and
 * a working, paused, failed or stopped teammate (or one already done) is left as it is.
 */
function onTeammateReported(tx: Tx, event: EventOfType<'teammate.reported'>): boolean {
  ensureRoot(tx, event.sessionId, event.ts);
  let mate: AgentNode | undefined;
  for (const n of Object.values(tx.agents)) {
    if (n.sessionId !== event.sessionId || n.kind !== 'teammate' || n.role !== event.teammateName) continue;
    if (mate === undefined || n.lastEventAt >= mate.lastEventAt) mate = n;
  }
  if (mate === undefined || event.status === 'waiting') return true;
  if (mate.status !== 'idle' || isHeld(mate)) return true;
  tx.patch(mate.key, { status: 'done', endedAt: event.ts, currentActivity: null });
  return true;
}

function onAgentStopped(tx: Tx, event: EventOfType<'agent.stopped'>): boolean {
  const node = tx.node(event.agentKey);
  if (node === undefined) return false; // unknown subagent: creates nothing
  const handoff: Handoff = { ...(node.handoff ?? unknownHandoff()), result: event.result };
  tx.patch(node.key, { status: 'done', endedAt: event.ts, currentActivity: null, handoff });
  endInteraction(tx, node.key, event.ts);
  tx.touch(node.key, event.ts);
  return true;
}

function onTurnEnded(tx: Tx, event: EventOfType<'turn.ended'>): boolean {
  if (isMainKey(event)) {
    const root = ensureRoot(tx, event.sessionId, event.ts);
    // A Stop after the session ended changes nothing; a Stop after a failed turn does.
    const status =
      root.status === 'done' || root.status === 'stopped'
        ? root.status
        : mainStatusAfterStop(tx, event.sessionId, event.backgroundAgentIds ?? null);
    resolveRequestsOf(tx, root.key, event.ts);
    tx.patch(root.key, { status, currentActivity: null });
    tx.touch(root.key, event.ts);
    return true;
  }
  const node = tx.node(event.agentKey);
  if (node === undefined) return false; // unknown subagent: creates nothing
  // A subagent's turn end; agent.stopped follows and marks it done. Its backgroundAgentIds are session-wide: ignored.
  resolveRequestsOf(tx, node.key, event.ts);
  tx.patch(node.key, { status: isTerminal(node.status) ? node.status : 'idle', currentActivity: null });
  tx.touch(node.key, event.ts);
  return true;
}

function onTurnFailed(tx: Tx, event: EventOfType<'turn.failed'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  tx.patch(node.key, { status: 'failed', currentActivity: null });
  tx.touch(node.key, event.ts);
  return true;
}

function activityText(toolName: string, summary: string): string {
  return summary === '' || summary === toolName ? toolName : `${toolName}: ${summary}`;
}

function onToolStarted(tx: Tx, event: EventOfType<'tool.started'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  tx.patch(node.key, {
    ...activePatch(tx, node, null),
    // "Doing now" is the running (or last started) tool; tasks and self-reports have fields of their own.
    currentActivity: activityText(event.toolName, event.summary),
    toolCalls: node.toolCalls + 1,
  });
  tx.touch(node.key, event.ts);
  return true;
}

function onToolFailed(tx: Tx, event: EventOfType<'tool.failed'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  tx.patch(node.key, { ...activePatch(tx, node, event.toolName), toolFailures: node.toolFailures + 1 });
  if (event.toolUseId !== null) resolveQuestionByToolUse(tx, node.key, event.toolUseId, event.ts);
  tx.touch(node.key, event.ts);
  return true;
}

/**
 * A tool call ended: a waiting state clears unless a request of the agent is still open (activeStatus). Questions and
 * approvals resolve on their own ends; a question also on its tool call ending (onToolFinished).
 */
function onActivity(tx: Tx, event: EventOfType<'tool.finished'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  const patch = activePatch(tx, node, event.toolName);
  if (patch.status !== node.status) tx.patch(node.key, patch);
  tx.touch(node.key, event.ts);
  return true;
}

function onToolFinished(tx: Tx, event: EventOfType<'tool.finished'>): boolean {
  const changed = onActivity(tx, event);
  // PostToolUse(AskUserQuestion): the question was answered, here or in the terminal.
  if (event.toolUseId !== null) resolveQuestionByToolUse(tx, event.agentKey, event.toolUseId, event.ts);
  return changed;
}

// --- inbox: approvals and questions (M3, F10 F11) ---------------------------------

/** Inbox item ids for requests. The desktop's toasts and `#item=` deep links use the same ids. */
export function approvalItemId(requestId: string): string {
  return `approval:${requestId}`;
}

export function questionItemId(requestId: string): string {
  return `question:${requestId}`;
}

function isRequestItem(item: AttentionItem): boolean {
  return item.kind === 'approval' || item.kind === 'question';
}

/**
 * Adds an inbox item. An open item with the same id wins (the new one is a duplicate). A resolved one with the same id
 * is replaced when `reopen` (a detector's stable id raised again: a new episode, appended as the newest item), and
 * otherwise kept (a request id answered once stays answered). The inbox keeps the newest MAX_INBOX items.
 */
function addItem(tx: Tx, item: AttentionItem, reopen = false): boolean {
  const existing = tx.inbox.find((i) => i.id === item.id);
  if (existing !== undefined && (existing.resolvedAt === null || !reopen)) return false;
  const inbox = [...tx.inbox.filter((i) => i.id !== item.id), item];
  tx.inbox = inbox.length > MAX_INBOX ? inbox.slice(inbox.length - MAX_INBOX) : inbox;
  return true;
}

/** Marks every open item matching `match` resolved at `ts`. Returns the agents whose items changed. */
function resolveItems(tx: Tx, ts: number, match: (item: AttentionItem) => boolean): AgentKey[] {
  const touched: AgentKey[] = [];
  if (!tx.inbox.some((i) => i.resolvedAt === null && match(i))) return touched;
  tx.inbox = tx.inbox.map((item) => {
    if (item.resolvedAt !== null || !match(item)) return item;
    if (!touched.includes(item.agentKey)) touched.push(item.agentKey);
    return { ...item, resolvedAt: ts };
  });
  return touched;
}

/** The agent's open approvals and questions end with its turn or its life. */
function resolveRequestsOf(tx: Tx, key: AgentKey, ts: number): void {
  resolveItems(tx, ts, (i) => i.agentKey === key && isRequestItem(i));
}

function resolveQuestionByToolUse(tx: Tx, key: AgentKey, toolUseId: string, ts: number): void {
  const id = questionItemId(toolUseId);
  const touched = resolveItems(tx, ts, (i) => i.id === id && i.agentKey === key);
  for (const agent of touched) settleStatus(tx, agent);
}

/**
 * An open approval or question of the agent's current turn (`AgentBook.turnStartedAt`) that also passes `also`. Older
 * open items stay in the inbox as they are; they only stop counting for the agent's status.
 */
function hasOpenItem(
  tx: Tx,
  key: AgentKey,
  kind: 'approval' | 'question',
  also: (item: AttentionItem) => boolean = () => true,
): boolean {
  const since = tx.agentBook(key).turnStartedAt ?? -Infinity;
  return tx.inbox.some(
    (i) => i.agentKey === key && i.kind === kind && i.resolvedAt === null && i.createdAt >= since && also(i),
  );
}

/**
 * After a request resolved or a hold ended: the most urgent thing still open (an approval, a question, a hold), else
 * working. Leaves finished agents, and agents not in a waiting or paused state, alone.
 */
function settleStatus(tx: Tx, key: AgentKey): void {
  const node = tx.node(key);
  if (node === undefined || isTerminal(node.status)) return;
  if (node.status !== 'waiting_approval' && node.status !== 'waiting_answer' && node.status !== 'paused') return;
  const status: AgentStatus = hasOpenItem(tx, key, 'approval')
    ? 'waiting_approval'
    : hasOpenItem(tx, key, 'question')
      ? 'waiting_answer'
      : isHeld(node)
        ? 'paused'
        : 'working';
  if (status !== node.status) tx.patch(key, { status });
}

/** The agent's process is gone (or its subagent finished): nothing can still be held, queued or asked. */
function endInteraction(tx: Tx, key: AgentKey, ts: number): void {
  resolveRequestsOf(tx, key, ts);
  const node = tx.node(key);
  if (node === undefined) return;
  const patch: Partial<AgentNode> = {};
  if (node.outbox !== undefined && node.outbox.length > 0) patch.outbox = [];
  if (isHeld(node)) patch.hold = null;
  if (node.pausePending === true) patch.pausePending = false;
  if (hasPausedBy(node)) patch.pausedBy = null;
  if (Object.keys(patch).length > 0) tx.patch(key, patch);
}

/** The Huddle's own pause reason is set (`pausedBy`, M4 runbook fix). */
function hasPausedBy(node: AgentNode): boolean {
  return node.pausedBy !== undefined && node.pausedBy !== null;
}

/**
 * Claude Code 2.1.325 sends a PermissionRequest for AskUserQuestion right before it shows its own question box. Not an
 * approval: the user answers the question in the terminal. Older logs still hold `approval.requested` events for it.
 */
const QUESTION_BOX_TOOL = 'AskUserQuestion';

function onApprovalRequested(tx: Tx, event: EventOfType<'approval.requested'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  if (event.request.toolName === QUESTION_BOX_TOOL) {
    tx.touch(node.key, event.ts);
    return true;
  }
  if (!isTerminal(node.status)) tx.patch(node.key, { status: 'waiting_approval' });
  const request = event.request;
  addItem(tx, {
    id: approvalItemId(request.requestId),
    kind: 'approval',
    severity: 'action_required',
    agentKey: node.key,
    title: `${node.name} needs approval`,
    detail: activityText(request.toolName, request.summary),
    createdAt: event.ts,
    resolvedAt: null,
    approval: request,
  });
  tx.touch(node.key, event.ts);
  return true;
}

function onQuestionAsked(tx: Tx, event: EventOfType<'question.asked'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  if (!isTerminal(node.status)) tx.patch(node.key, { status: 'waiting_answer' });
  const request = event.request;
  addItem(tx, {
    id: questionItemId(request.requestId),
    kind: 'question',
    severity: 'action_required',
    agentKey: node.key,
    title: `${node.name} asked a question`,
    detail: request.questions[0]?.question ?? '',
    createdAt: event.ts,
    resolvedAt: null,
    question: request,
  });
  tx.touch(node.key, event.ts);
  return true;
}

/** approval.resolved, question.answered, question.closed: the item resolves and the agent moves on. */
function onRequestEnded(tx: Tx, event: HuddleEvent, itemId: string): boolean {
  // Already resolved (the agent's turn ended first, then the broker let go of the hold): the turn end decided the status.
  const alreadyResolved = tx.inbox.some((i) => i.id === itemId && i.resolvedAt !== null);
  const touched = resolveItems(tx, event.ts, (i) => i.id === itemId);
  const node = target(tx, event);
  if (node !== undefined && !touched.includes(node.key)) touched.push(node.key);
  for (const key of touched) settleStatus(tx, key);
  // An older log has no inbox item: the end of a request is still a sign the agent works again.
  if (node !== undefined) {
    const latest = tx.node(node.key) ?? node;
    if (!alreadyResolved && (latest.status === 'starting' || latest.status === 'idle')) {
      tx.patch(node.key, { status: 'working' });
    }
    tx.touch(node.key, event.ts);
  }
  return true;
}

// --- pause holds (M3, F13) -------------------------------------------------------------

function onHoldStarted(tx: Tx, event: EventOfType<'hold.started'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  if (isTerminal(node.status)) return true;
  const waiting = node.status === 'waiting_approval' || node.status === 'waiting_answer';
  tx.patch(node.key, {
    hold: { toolUseId: event.toolUseId, since: event.ts, limitAt: event.limitAt },
    pausePending: false,
    status: waiting ? node.status : 'paused',
  });
  tx.touch(node.key, event.ts);
  return true;
}

function onHoldEnded(tx: Tx, event: EventOfType<'hold.ended'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  const hold = node.hold ?? null;
  // A parallel call's hold ending leaves the newer one in place; an unknown tool call (null) ends whatever is held.
  const matches =
    hold !== null && (event.toolUseId === null || hold.toolUseId === null || hold.toolUseId === event.toolUseId);
  if (matches) {
    // The pause is over (resumed, let go at the limit, closed): who asked for it no longer matters.
    const clearBy = hasPausedBy(node) && node.pausePending !== true;
    tx.patch(node.key, { hold: null, ...(clearBy ? { pausedBy: null } : {}) });
    settleStatus(tx, node.key);
  }
  tx.touch(node.key, event.ts);
  return true;
}

// --- outbox (M3, F12) ----------------------------------------------------------------------

function onMessageQueued(tx: Tx, event: EventOfType<'message.queued'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  const outbox = node.outbox ?? [];
  if (!isTerminal(node.status) && !outbox.some((m) => m.messageId === event.messageId)) {
    const next = [
      ...outbox,
      {
        messageId: event.messageId,
        text: event.text,
        delivery: event.delivery,
        queuedAt: event.ts,
        // M6 P5b: a message the Huddle wrote itself (ADR-027) is delivered without the 'from the user' prefix.
        ...(event.source === 'huddle' ? { author: 'huddle' as const } : {}),
      },
    ];
    tx.patch(node.key, { outbox: next.length > MAX_OUTBOX ? next.slice(next.length - MAX_OUTBOX) : next });
  }
  tx.touch(node.key, event.ts);
  return true;
}

/** message.delivered and message.dropped: the message leaves the outbox it is in (normally the event's agent). */
function onMessageGone(tx: Tx, event: HuddleEvent, messageId: string): boolean {
  const holds = (n: AgentNode): boolean => (n.outbox ?? []).some((m) => m.messageId === messageId);
  const own = tx.node(event.agentKey);
  const node =
    own !== undefined && holds(own)
      ? own
      : Object.values(tx.agents).find((n) => n.sessionId === event.sessionId && holds(n));
  if (node === undefined) return false;
  tx.patch(node.key, { outbox: (node.outbox ?? []).filter((m) => m.messageId !== messageId) });
  // Delivery is not activity: the hook that carried it is logged as its own event.
  return true;
}

function onTaskCreated(tx: Tx, event: EventOfType<'task.created'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  const known = node.tasks.some((t) => t.id === event.taskId);
  const tasks = known
    ? node.tasks.map((t) => (t.id === event.taskId ? { ...t, subject: event.subject } : t))
    : [
        ...node.tasks,
        {
          id: event.taskId,
          subject: event.subject,
          ...(event.description !== null ? { description: event.description } : {}),
          status: 'pending' as const,
          createdAt: event.ts,
        },
      ];
  tx.patch(node.key, { tasks: capTasks(tasks) });
  tx.touch(node.key, event.ts);
  return true;
}

/** At most MAX_TASKS_PER_AGENT: drops the oldest completed tasks first, then the oldest pending ones. Keeps order. */
function capTasks(tasks: TaskItem[]): TaskItem[] {
  let over = tasks.length - MAX_TASKS_PER_AGENT;
  if (over <= 0) return tasks;
  const drop = new Set<TaskItem>();
  for (const t of tasks) {
    if (over === 0) break;
    if (t.status === 'completed') {
      drop.add(t);
      over -= 1;
    }
  }
  for (const t of tasks) {
    if (over === 0) break;
    if (!drop.has(t)) {
      drop.add(t);
      over -= 1;
    }
  }
  return tasks.filter((t) => !drop.has(t));
}

/**
 * The agent put a task in progress: stamp startedAt on it (the latest one wins if it is started again). Only a known,
 * pending task changes; an unknown agent or task id, or a completed task, leaves the state unchanged. "In progress" is
 * derived (pending with startedAt), so status stays 'pending' and older consumers keep working.
 */
function onTaskStarted(tx: Tx, event: EventOfType<'task.started'>): boolean {
  const node = tx.node(event.agentKey);
  if (node === undefined) return false;
  if (!node.tasks.some((t) => t.id === event.taskId && t.status === 'pending')) return false;
  const tasks = node.tasks.map((t) =>
    t.id === event.taskId && t.status === 'pending' ? { ...t, startedAt: event.ts } : t,
  );
  tx.patch(node.key, { tasks });
  tx.touch(node.key, event.ts);
  return true;
}

function onTaskCompleted(tx: Tx, event: EventOfType<'task.completed'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  const tasks = node.tasks.map((t) =>
    t.id === event.taskId && t.status !== 'completed'
      ? { ...t, status: 'completed' as const, completedAt: event.ts }
      : t,
  );
  tx.patch(node.key, { tasks });
  tx.touch(node.key, event.ts);
  return true;
}

function onContextMeasured(tx: Tx, event: EventOfType<'context.measured'>): boolean {
  if (event.measuredBy === 'telemetry') {
    // Telemetry never creates a session; a reading for an agent not seen yet is dropped (the next request brings one).
    const known = tx.node(event.agentKey);
    if (known === undefined) return false;
    const at = tx.agentBook(known.key).statuslineContextAt;
    const statuslineFresh =
      known.context.measuredBy === 'statusline' && at !== undefined && event.ts - at < STATUSLINE_CONTEXT_PRIORITY_MS;
    if (statuslineFresh) return false;
  }
  const node = target(tx, event);
  if (node === undefined) return true;
  if (event.measuredBy === 'statusline') {
    tx.putAgentBook(node.key, { ...tx.agentBook(node.key), statuslineContextAt: event.ts });
  }
  const usedPct =
    event.windowTokens !== null && event.windowTokens > 0 ? (event.usedTokens / event.windowTokens) * 100 : null;
  tx.patch(node.key, {
    context: {
      ...node.context,
      usedTokens: event.usedTokens,
      windowTokens: event.windowTokens,
      usedPct,
      measuredBy: event.measuredBy,
    },
  });
  // A telemetry reading is a late echo of a request, not activity (see onUsageRecorded).
  if (event.measuredBy !== 'telemetry') tx.touch(node.key, event.ts);
  return true;
}

/** Is this request the agent's own (counts in its usage), or a helper request for the root's helperUsage? */
function isHelperUsage(event: EventOfType<'usage.recorded'>): boolean {
  const kind = event.querySourceKind;
  if (kind === undefined || kind === 'main') return false;
  // A subagent-sourced request without agent_id has no subagent to go to: keep it out of the main agent's usage.
  if (kind === 'subagent') return isMainKey(event);
  return true; // helper, compact, other
}

function usageDelta(event: EventOfType<'usage.recorded'>): TokenUsage {
  const delta: TokenUsage = {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    requests: 1,
    estimatedCostUsd: event.costMissing === true ? 0 : event.estimatedCostUsd,
  };
  if (event.requestId === null) delta.requestsWithoutId = 1;
  if (event.costMissing === true) delta.requestsWithoutCost = 1;
  return delta;
}

function onUsageRecorded(tx: Tx, event: EventOfType<'usage.recorded'>): boolean {
  if (event.requestId !== null) {
    const session = tx.session(event.sessionId);
    const seen = session.seenRequestIds ?? [];
    if (seen.includes(event.requestId)) return false; // a re-sent record: counted once
    const next = [...seen, event.requestId];
    tx.putSession(event.sessionId, {
      ...session,
      seenRequestIds: next.length > MAX_SEEN_REQUEST_IDS ? next.slice(next.length - MAX_SEEN_REQUEST_IDS) : next,
    });
  }
  const helper = isHelperUsage(event);
  const key = helper ? agentKey(event.sessionId) : event.agentKey;
  const delta = usageDelta(event);
  if (tx.node(key) === undefined) {
    // Telemetry can beat the first hook (or SubagentStart): wait for the node instead of creating it.
    tx.addPendingUsage(key, delta, helper);
    return true;
  }
  // No touch: telemetry arrives 1-3 s after the request (export interval), so it is not a sign of activity and
  // must not move lastEventAt or the session order.
  addToNode(tx, key, delta, helper);
  return true;
}

function onContextCompacted(tx: Tx, event: EventOfType<'context.compacted'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  if (event.phase === 'after') {
    tx.patch(node.key, {
      context: { ...node.context, compactions: node.context.compactions + 1, lastCompactedAt: event.ts },
    });
  }
  tx.touch(node.key, event.ts);
  return true;
}

function onModel(tx: Tx, event: HuddleEvent, model: string, rank: number): boolean {
  const node = target(tx, event);
  if (node === undefined) {
    tx.addPendingModel(event.agentKey, { model, rank });
    return true;
  }
  applyModel(tx, node.key, model, rank);
  tx.touch(node.key, event.ts);
  return true;
}

function onModelObserved(tx: Tx, event: EventOfType<'model.observed'>): boolean {
  const rank = MODEL_RANK[event.via];
  // Telemetry can arrive before the session's first hook: keep it pending instead of creating the session.
  if (tx.node(event.agentKey) === undefined) {
    tx.addPendingModel(event.agentKey, { model: event.model, rank });
    return true;
  }
  applyModel(tx, event.agentKey, event.model, rank);
  return true;
}

function onInstructionsLoaded(tx: Tx, event: EventOfType<'instructions.loaded'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  const files = node.context.loadedInstructions;
  if (event.filePath !== null && !files.includes(event.filePath) && files.length < MAX_INSTRUCTION_FILES) {
    tx.patch(node.key, { context: { ...node.context, loadedInstructions: [...files, event.filePath] } });
  }
  tx.touch(node.key, event.ts);
  return true;
}

function onRoleDescribed(tx: Tx, event: EventOfType<'role.described'>): boolean {
  ensureRoot(tx, event.sessionId, event.ts);
  const session = tx.session(event.sessionId);
  const existing = getOwn(session.roles, event.role);
  // A project definition shadows a user one, as in Claude Code.
  if (existing?.definedIn === 'project' && event.definedIn === 'user') return true;
  const roles = { ...session.roles };
  setOwn(roles, event.role, { description: event.description, definedIn: event.definedIn });
  tx.putSession(event.sessionId, { ...session, roles });
  for (const node of Object.values(tx.agents)) {
    if (node.sessionId === event.sessionId && node.role === event.role) refreshRoleDescription(tx, node.key);
  }
  return true;
}

function onControlApplied(tx: Tx, event: EventOfType<'control.applied'>): boolean {
  const node = target(tx, event);
  if (node === undefined) return true;
  if (event.action === 'rename') {
    // ADR-015: a nickname is a control.applied rename event; detail is the new name, empty or null clears it.
    const nickname = event.detail !== null && event.detail.trim() !== '' ? event.detail.trim() : null;
    tx.putAgentBook(node.key, { ...tx.agentBook(node.key), nickname });
    refreshName(tx, node.key);
  } else if (event.action === 'pause') {
    // Pause waits for the agent's next tool call; already held (or finished), there is nothing to wait for.
    if (!isHeld(node) && !isTerminal(node.status) && node.pausePending !== true) {
      // Who asked: the Huddle's own pause (a budget) names why in `detail`; the user's leaves no reason.
      const by = event.source === 'huddle' && event.detail !== null && event.detail !== '' ? event.detail : null;
      tx.patch(node.key, { pausePending: true, ...(by !== null || hasPausedBy(node) ? { pausedBy: by } : {}) });
    }
  } else if (event.action === 'resume') {
    const patch: Partial<AgentNode> = {};
    if (node.pausePending === true) patch.pausePending = false;
    if (hasPausedBy(node)) patch.pausedBy = null;
    if (Object.keys(patch).length > 0) tx.patch(node.key, patch);
  }
  return true;
}

function onAttentionRaised(tx: Tx, event: EventOfType<'attention.raised'>): boolean {
  return addItem(tx, event.item, true);
}

function onAttentionResolved(tx: Tx, event: EventOfType<'attention.resolved'>): boolean {
  if (!tx.inbox.some((item) => item.id === event.itemId && item.resolvedAt === null)) return false;
  const dismissed = event.reason === 'dismissed';
  tx.inbox = tx.inbox.map((item) =>
    item.id === event.itemId && item.resolvedAt === null
      ? { ...item, resolvedAt: event.ts, ...(dismissed ? { dismissed: true } : {}) }
      : item,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Managed runs, worktrees, budgets (M4, ADR-020)
// ---------------------------------------------------------------------------

/** A run seen first through a worktree.created (made before the process starts): filled in by run.launched. */
function placeholderRun(runId: string): AgentRun {
  return {
    runId,
    templateId: null,
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: null,
    exited: null,
    result: null,
  };
}

const STATUS_AFTER_EXIT: Record<EventOfType<'run.exited'>['how'], AgentStatus> = {
  completed: 'done',
  stopped: 'stopped',
  failed: 'failed',
  spawn_failed: 'failed',
};

/** Shows the run on its root, when the run's session is known and its root exists. */
function projectRun(tx: Tx, runId: string): void {
  const book = tx.run(runId);
  if (book === undefined || book.sessionId === null) return;
  const root = tx.node(agentKey(book.sessionId));
  if (root === undefined || root.run === book.run) return;
  tx.patch(root.key, { run: book.run });
}

/** Every node of the session becomes managed, with the capabilities that go with its kind. */
function makeManaged(tx: Tx, sessionId: string): void {
  for (const node of Object.values(tx.agents)) {
    if (node.sessionId !== sessionId || node.origin === 'managed') continue;
    tx.patch(node.key, { origin: 'managed', capabilities: capabilitiesFor('managed', node.kind) });
  }
}

/** The run's process is gone: the root ends with the exit's status (unless it already ended), the rest is stopped. */
function applyExit(tx: Tx, sessionId: string, how: EventOfType<'run.exited'>['how'], ts: number): void {
  const rootKey = agentKey(sessionId);
  for (const node of Object.values(tx.agents)) {
    if (node.sessionId !== sessionId) continue;
    endInteraction(tx, node.key, ts);
    if (isTerminal(node.status)) continue;
    const status = node.key === rootKey ? STATUS_AFTER_EXIT[how] : 'stopped';
    tx.patch(node.key, { status, endedAt: ts, currentActivity: null });
  }
  tx.touch(rootKey, ts);
}

function onRunLaunched(tx: Tx, event: EventOfType<'run.launched'>): boolean {
  const previous = tx.run(event.runId);
  const before = previous?.run;
  // A worktree.created before the launch carries more (base commit, repo) than the launch's path and branch.
  const worktree: RunWorktree | null =
    before?.worktree ?? (event.worktree !== null ? { ...event.worktree, state: 'active' } : null);
  const run: AgentRun = {
    runId: event.runId,
    templateId: event.templateId,
    permissionMode: event.permissionMode,
    mainAgent: event.mainAgent,
    agentNames: event.agentNames,
    worktree,
    exited: before?.exited ?? null,
    result: before?.result ?? null,
  };
  // The first session named wins: a run is one process, which is one session.
  const sessionId = previous?.sessionId ?? event.claudeSessionId;
  const newlyLinked = sessionId !== null && (previous?.sessionId ?? null) === null;
  tx.putRun(event.runId, { sessionId, run });
  if (sessionId === null) return true;

  const root = ensureRoot(tx, sessionId, event.ts, 'managed');
  makeManaged(tx, sessionId);
  if (root.cwd === null && event.cwd !== '') tx.patch(root.key, { cwd: event.cwd });
  // The Huddle chose where this run works: that folder (its worktree, if any) is the trusted session folder (F18),
  // replacing one learned from a hook first.
  const launchedIn = event.worktree?.path ?? event.cwd;
  if (launchedIn !== '' && root.sessionCwd !== launchedIn) tx.patch(root.key, { sessionCwd: launchedIn });
  // What was asked for (`--model sonnet`); the session's own report of the resolved model outranks it.
  if (event.model !== null) applyModel(tx, root.key, event.model, RANK_SPAWN_REQUEST);
  projectRun(tx, event.runId);
  // The run ended before its session was known (learned late): end the root now.
  if (newlyLinked && run.exited) applyExit(tx, sessionId, run.exited.how, run.exited.at);
  tx.touch(root.key, event.ts);
  return true;
}

function onRunExited(tx: Tx, event: EventOfType<'run.exited'>): boolean {
  const book = tx.run(event.runId) ?? { sessionId: null, run: placeholderRun(event.runId) };
  const exited = { at: event.ts, exitCode: event.exitCode, how: event.how, error: event.error };
  tx.putRun(event.runId, { ...book, run: { ...book.run, exited } });
  if (book.sessionId === null) return true;
  projectRun(tx, event.runId);
  if (tx.node(agentKey(book.sessionId)) !== undefined) applyExit(tx, book.sessionId, event.how, event.ts);
  return true;
}

function onRunResult(tx: Tx, event: EventOfType<'run.result'>): boolean {
  const book = tx.run(event.runId) ?? { sessionId: null, run: placeholderRun(event.runId) };
  const result = {
    at: event.ts,
    isError: event.isError,
    durationMs: event.durationMs,
    numTurns: event.numTurns,
    totalCostUsd: event.totalCostUsd,
    permissionDenials: event.permissionDenials,
  };
  tx.putRun(event.runId, { ...book, run: { ...book.run, result } });
  projectRun(tx, event.runId);
  if (book.sessionId !== null) tx.touch(agentKey(book.sessionId), event.ts);
  return true;
}

function onWorktreeCreated(tx: Tx, event: EventOfType<'worktree.created'>): boolean {
  const book = tx.run(event.runId) ?? { sessionId: null, run: placeholderRun(event.runId) };
  const worktree: RunWorktree = {
    ...book.run.worktree,
    path: event.path,
    branch: event.branch,
    state: book.run.worktree?.state ?? 'active',
    baseCommit: event.baseCommit,
    repoRoot: event.repoRoot,
  };
  tx.putRun(event.runId, { ...book, run: { ...book.run, worktree } });
  projectRun(tx, event.runId);
  return true;
}

/** Changes a run's worktree; a run or worktree this state does not know is left alone (returns false). */
function updateWorktree(tx: Tx, runId: string, patch: Partial<RunWorktree>): boolean {
  const book = tx.run(runId);
  const current = book?.run.worktree ?? null;
  if (book === undefined || current === null) return false;
  tx.putRun(runId, { ...book, run: { ...book.run, worktree: { ...current, ...patch } } });
  projectRun(tx, runId);
  return true;
}

function onWorktreeSummarized(tx: Tx, event: EventOfType<'worktree.summarized'>): boolean {
  return updateWorktree(tx, event.runId, {
    summary: {
      filesChanged: event.filesChanged,
      insertions: event.insertions,
      deletions: event.deletions,
      untracked: event.untracked,
      files: event.files,
      summarizedAt: event.ts,
    },
  });
}

function onWorktreeClosed(tx: Tx, event: EventOfType<'worktree.closed'>): boolean {
  return updateWorktree(tx, event.runId, { state: event.outcome, closeError: event.error });
}

function hasLimit(budget: EventOfType<'budget.set'>['budget']): boolean {
  return budget.maxTokens !== undefined || budget.maxEstimatedCostUsd !== undefined || budget.maxMinutes !== undefined;
}

/**
 * May the reducer drop this session for a `history.pruned`? Never the Huddle's own sessions or the event's envelope
 * session, never a managed run whose process may still be alive (`run.exited` not seen), and never a session with
 * activity after the deletion (a session that came back, or a replay that reads it before the prune record). The core
 * leaves live sessions out before it deletes anything; this is the defence in depth.
 */
function prunable(tx: Tx, sessionId: string, event: EventOfType<'history.pruned'>): boolean {
  if (HUDDLE_SESSION_IDS.includes(sessionId) || sessionId === event.sessionId) return false;
  const root = tx.node(agentKey(sessionId));
  const run = root?.run ?? null;
  if (run !== null && (run.exited ?? null) === null) return false;
  for (const node of Object.values(tx.agents)) {
    if (node.sessionId === sessionId && node.lastEventAt > event.ts) return false;
  }
  return true;
}

/**
 * `history.pruned` (M5, F22): the named sessions' events were deleted from the database, so the state forgets them as
 * if they had never been replayed: their agents, tree roots, inbox items, bookkeeping, runs and agent or session
 * budgets. The overall budget, other sessions and every unnamed session are untouched.
 */
function onHistoryPruned(tx: Tx, event: EventOfType<'history.pruned'>): boolean {
  const drop = new Set(event.sessionIds.filter((sessionId) => prunable(tx, sessionId, event)));
  if (drop.size === 0) return false;
  const inDropped = (key: string): boolean => {
    const at = key.indexOf('::');
    return drop.has(at === -1 ? key : key.slice(0, at));
  };
  let changed = false;
  for (const node of Object.values(tx.agents)) {
    if (!drop.has(node.sessionId)) continue;
    deleteOwn(tx.agents, node.key);
    deleteOwn(tx.agentBooks, node.key);
    changed = true;
  }
  for (const key of Object.keys(tx.agentBooks)) if (inDropped(key)) deleteOwn(tx.agentBooks, key);
  for (const sessionId of drop) {
    if (Object.hasOwn(tx.sessions, sessionId)) {
      deleteOwn(tx.sessions, sessionId);
      changed = true;
    }
  }
  const rootKeys = tx.rootKeys.filter((k) => !inDropped(k));
  if (rootKeys.length !== tx.rootKeys.length) tx.rootKeys = rootKeys;
  const inbox = tx.inbox.filter((item) => !inDropped(item.agentKey));
  if (inbox.length !== tx.inbox.length) {
    tx.inbox = inbox;
    changed = true;
  }
  for (const key of tx.pendingLinkOrder) if (inDropped(key)) deleteOwn(tx.pendingLinks, key);
  tx.pendingLinkOrder = tx.pendingLinkOrder.filter((k) => !inDropped(k));
  for (const key of tx.pendingModelOrder) if (inDropped(key)) deleteOwn(tx.pendingModels, key);
  tx.pendingModelOrder = tx.pendingModelOrder.filter((k) => !inDropped(k));
  for (const key of tx.pendingUsageOrder) if (inDropped(key)) deleteOwn(tx.pendingUsage, key);
  tx.pendingUsageOrder = tx.pendingUsageOrder.filter((k) => !inDropped(k));
  // A run belongs to its session, or (before the session was known) to its runId placeholder.
  const goneRuns = tx.runOrder.filter((runId) => {
    const book = tx.run(runId);
    return drop.has(runId) || (book?.sessionId !== null && book?.sessionId !== undefined && drop.has(book.sessionId));
  });
  if (goneRuns.length > 0) {
    for (const runId of goneRuns) deleteOwn(tx.runs, runId);
    const gone = new Set(goneRuns);
    tx.runOrder = tx.runOrder.filter((runId) => !gone.has(runId));
    changed = true;
  }
  if (tx.budgets !== undefined) {
    const budgets = tx.budgets.filter((b) => b.targetKey === null || !inDropped(b.targetKey));
    if (budgets.length !== tx.budgets.length) {
      tx.budgets = budgets;
      changed = true;
    }
  }
  return changed;
}

function onBudgetSet(tx: Tx, event: EventOfType<'budget.set'>): boolean {
  const targetKey = event.scope === 'overall' ? null : event.targetKey;
  // An agent or session budget must say whose it is.
  if (event.scope !== 'overall' && targetKey === null) return false;
  const kept = (tx.budgets ?? []).filter((b) => b.scope !== event.scope || b.targetKey !== targetKey);
  const next = hasLimit(event.budget)
    ? [...kept, { scope: event.scope, targetKey, budget: event.budget, setAt: event.ts }]
    : kept;
  if (next.length === 0 && tx.budgets === undefined) return false;
  tx.budgets = next.length > MAX_BUDGETS ? next.slice(next.length - MAX_BUDGETS) : next;
  return true;
}

// ---------------------------------------------------------------------------
// Phone access (M6, F26)
// ---------------------------------------------------------------------------

const NO_PHONE: PhoneState = { enabled: false, url: null, changedAt: 0, reason: null, devices: [] };

function onPhoneAccessChanged(tx: Tx, event: EventOfType<'phone.access_changed'>): boolean {
  const prev = tx.phone ?? NO_PHONE;
  const enabled = event.enabled;
  tx.phone = {
    ...prev,
    enabled,
    url: enabled && typeof event.url === 'string' ? event.url : null,
    changedAt: event.ts,
    reason: event.reason ?? null,
    // Off: the listener is closed, so no phone is connected any more.
    devices: enabled ? prev.devices : prev.devices.map((d) => (d.connected ? { ...d, connected: false } : d)),
  };
  return true;
}

function onPhoneDeviceChanged(tx: Tx, event: EventOfType<'phone.device_changed'>): boolean {
  if (typeof event.deviceId !== 'string' || event.deviceId === '') return false;
  const prev = tx.phone ?? NO_PHONE;
  const at = prev.devices.findIndex((d) => d.deviceId === event.deviceId);
  const known = at === -1 ? undefined : prev.devices[at];
  const name = typeof event.name === 'string' ? event.name.slice(0, PHONE_DEVICE_NAME_MAX) : (known?.name ?? '');
  let devices: PhoneDeviceState[];
  switch (event.change) {
    case 'paired':
    case 'known': {
      const pairedAt = event.pairedAt ?? (event.change === 'paired' ? event.ts : (known?.pairedAt ?? null));
      const device: PhoneDeviceState = {
        deviceId: event.deviceId,
        name,
        pairedAt,
        lastSeenAt: known?.lastSeenAt ?? null,
        connected: known?.connected ?? false,
      };
      devices = known === undefined ? [...prev.devices, device] : prev.devices.map((d, i) => (i === at ? device : d));
      // Bounded like the file (the core refuses pairing past the limit); the oldest goes first.
      if (devices.length > PHONE_MAX_DEVICES * 2) devices = devices.slice(devices.length - PHONE_MAX_DEVICES * 2);
      break;
    }
    case 'revoked':
      if (known === undefined) return false;
      devices = prev.devices.filter((_, i) => i !== at);
      break;
    case 'connected':
    case 'disconnected':
      if (known === undefined) return false;
      devices = prev.devices.map((d, i) =>
        i === at ? { ...d, connected: event.change === 'connected', lastSeenAt: event.ts } : d,
      );
      break;
    default:
      // A change this build does not know (a newer log): unchanged.
      return false;
  }
  tx.phone = { ...prev, devices };
  return true;
}

// ---------------------------------------------------------------------------
// The Huddle's task list (F29)
// ---------------------------------------------------------------------------

const CLIP_PATH = CLIP_LIMITS.path;
const CLIP_ID = CLIP_LIMITS.id;

function clipText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function nullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return clipText(value, max);
}

function onHuddleTaskCreated(tx: Tx, event: EventOfType<'huddle_task.created'>): boolean {
  if (typeof event.taskId !== 'string' || event.taskId === '') return false;
  const prev = tx.huddleTasks ?? [];
  if (prev.some((t) => t.taskId === event.taskId)) return false;
  const task: HuddleTask = {
    taskId: event.taskId,
    title: clipText(event.title, HUDDLE_TASK_TITLE_MAX) ?? '',
    details: clipText(event.details, HUDDLE_TASK_DETAILS_MAX) ?? '',
    projectPath: nullableText(event.projectPath, CLIP_PATH) ?? null,
    templateId: nullableText(event.templateId, CLIP_ID) ?? null,
    status: 'todo',
    runId: null,
    createdAt: event.ts,
    updatedAt: event.ts,
    launchedAt: null,
  };
  const next = [...prev, task];
  tx.huddleTasks = next.length > MAX_HUDDLE_TASKS ? next.slice(next.length - MAX_HUDDLE_TASKS) : next;
  return true;
}

function onHuddleTaskUpdated(tx: Tx, event: EventOfType<'huddle_task.updated'>): boolean {
  const prev = tx.huddleTasks ?? [];
  const at = prev.findIndex((t) => t.taskId === event.taskId);
  const old = prev[at];
  if (old === undefined) return false;
  const task: HuddleTask = { ...old, updatedAt: event.ts };
  const title = clipText(event.title, HUDDLE_TASK_TITLE_MAX);
  if (title !== undefined) task.title = title;
  const details = clipText(event.details, HUDDLE_TASK_DETAILS_MAX);
  if (details !== undefined) task.details = details;
  const projectPath = nullableText(event.projectPath, CLIP_PATH);
  if (projectPath !== undefined) task.projectPath = projectPath;
  const templateId = nullableText(event.templateId, CLIP_ID);
  if (templateId !== undefined) task.templateId = templateId;
  const runId = nullableText(event.runId, CLIP_ID);
  if (runId !== undefined) task.runId = runId;
  if (event.launchedAt === null || (typeof event.launchedAt === 'number' && Number.isFinite(event.launchedAt))) {
    task.launchedAt = event.launchedAt;
  }
  if (typeof event.status === 'string' && (HUDDLE_TASK_STATUSES as readonly string[]).includes(event.status)) {
    task.status = event.status;
  }
  tx.huddleTasks = prev.map((t, i) => (i === at ? task : t));
  return true;
}

function onHuddleTaskDeleted(tx: Tx, event: EventOfType<'huddle_task.deleted'>): boolean {
  const prev = tx.huddleTasks ?? [];
  if (!prev.some((t) => t.taskId === event.taskId)) return false;
  tx.huddleTasks = prev.filter((t) => t.taskId !== event.taskId);
  return true;
}
