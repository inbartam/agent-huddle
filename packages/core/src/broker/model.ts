/**
 * The broker's plain-data model (M3 WP5): what it knows, what it is told, and what it decides.
 *
 * The pure half (`decide` and approvals/questions/pause/outbox) maps a `BrokerView` plus one `BrokerInput` to
 * `BrokerEffects`. The runtime (`broker.ts`) owns the held HTTP responses and timers, applies the effects and feeds
 * every event through HuddleCore's `accept`, so state still changes only in the reducer (CONTRIBUTING.md rule 1).
 *
 * Time enters only as `ctx.now` and ids only as `ctx.nextId`, so the same inputs always give the same effects.
 */
import {
  agentKey,
  isRunAlive,
  type AgentKey,
  type AgentNode,
  type ApprovalRequest,
  type CommandResult,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';
import type { HookReplyDecision } from '../ingest/hook-replies.js';
import type { HookFacts, PolicyFacts, RawQuestionCall, ToolCallKey } from '../normalize/hook-facts.js';

/** The broker answers a hold by itself this long before Claude Code's hook timeout, so it never loses the race. */
export const SELF_RELEASE_MARGIN_MS = 5_000;
/**
 * A hold Claude Code closed within this long of its hook timeout is labelled `expired`; earlier, `answered_elsewhere`.
 * This is an inference from timing: Claude Code does not say why it closed the request.
 */
export const EXPIRY_WINDOW_MS = 2_000;

export type HoldKind = 'approval' | 'question' | 'pause';

/** One held hook response, as the broker remembers it next to the handle. Plain data. */
export interface HeldEntry {
  holdId: string;
  kind: HoldKind;
  agentKey: AgentKey;
  sessionId: string;
  /** approval: the `approval.requested` request id. question: the `question.asked` request id. pause: null. */
  requestId: string | null;
  /** The held tool call (PreToolUse); null for approvals or when the payload had none. */
  toolUseId: string | null;
  receivedAt: number;
  /** receivedAt + the hook's timeout: when Claude Code gives up on the request. */
  timeoutAt: number;
  /** question only: the questions as Claude Code sent them, to build the answer from. */
  question: RawQuestionCall | null;
  /**
   * approval only: the tool call asked about, to recognize its PostToolUse when the terminal answered (2.1.325 does not
   * close the held request then, SPIKES S1). Null for questions and pauses.
   */
  call: ToolCallKey | null;
  /**
   * approval only (M4, F18): the request's raw facts for the approval rules, kept in memory while it is held so
   * `approval.allowAllMatchingPolicy` can check it again. Never written to the log. Absent or null: not available.
   */
  policy?: PolicyFacts | null;
  /** approval only (M4, F18): the "ask" rule that sent this request to the user; written on its `approval.resolved`. */
  askedByRuleId?: string | null;
}

/** Hook timeouts in ms, as installed (ADR-019). */
export interface HoldTimeoutsMs {
  permissionRequest: number;
  preToolUse: number;
}

export interface BrokerView {
  /** The reducer's state, after this input's own normalized events were applied. */
  state: HuddleState;
  /** Holds open right now, oldest first. */
  held: readonly HeldEntry[];
  /** `UserSettings.questionHoldSeconds`, read live. */
  questionHoldSeconds: number;
  timeouts: HoldTimeoutsMs;
  /** Epoch ms this Huddle run started; agents last seen before it are replayed history. Null: unknown. */
  huddleStartedAt: number | null;
  /**
   * Ending 2 (a policy rule decides). The hook point for the M4 policy engine; absent means `noRuleDecision` (no rule
   * applies). With the Huddle closed no rule applies at all, because nothing is listening.
   */
  ruleDecision?: RuleHook;
  /**
   * Is this run's process alive right now (the core's `RunHost.isAlive`)? Absent: no run is live, so no session counts
   * as managed for the rules (fail safe). See `managedRunLive`.
   */
  runLive?: (runId: string) => boolean;
}

/**
 * Does this agent belong to a run the Huddle launched whose process is alive now? Its root carries the run, with no
 * `run.exited`, and `view.runLive` says the process is alive (a run from before a Huddle restart is not). A managed
 * root resumed in a terminal (`claude --resume <runId>`) keeps its `managed` origin, but it is an interactive session
 * then: rules and `allowAllMatchingPolicy` must treat it as attached (security review 2026-11-14, L1). Pure.
 */
export function managedRunLive(view: Pick<BrokerView, 'state' | 'runLive'>, node: AgentNode): boolean {
  if (node.origin !== 'managed' || view.runLive === undefined) return false;
  const run = agentOf(view.state, agentKey(node.sessionId))?.run;
  if (run === undefined || run === null || !isRunAlive(run)) return false;
  return view.runLive(run.runId);
}

/**
 * What a policy rule decided for an approval request (M4, F18). allow / deny: answered at once, by 'policy'. ask:
 * held for the user as without rules, with the rule's id noted on the hold and on its `approval.resolved`.
 */
export interface RuleVerdict {
  decision: 'allow' | 'deny' | 'ask';
  ruleId: string;
  /** For a deny: what the agent is told, sent as is (it names the rule; never the user's DENY_PREFIX). */
  message: string | null;
}

/** What a rule hook is shown: the stored request, the agent it is for, and the raw facts (in memory only). */
export interface RuleSubject {
  /** As stored: clipped and masked. For display; rules match on `facts`. */
  request: ApprovalRequest;
  node: AgentNode;
  /** Null when the hook carried none: then no allow can be justified. */
  facts: PolicyFacts | null;
  /** The trusted session folder: the root node's `sessionCwd` (null when unknown). Allows are contained in it. */
  sessionCwd: string | null;
  /** `managedRunLive`: only then do the rules treat the session as managed. */
  managedRunLive: boolean;
}

export type RuleHook = (subject: RuleSubject) => RuleVerdict | null;

/** M3 has no policy engine: no rule ever decides. */
export const noRuleDecision: RuleHook = () => null;

export interface BrokerCtx {
  now: number;
  nextId: () => string;
}

export type TimerKind = 'question_window' | 'hold_limit';

/** Commands the broker answers. */
export type BrokerCommand = Extract<
  HuddleCommand,
  {
    type:
      | 'approval.decide'
      | 'approval.passThrough'
      | 'approval.allowAllMatchingPolicy'
      | 'question.answer'
      | 'agent.message'
      | 'message.cancel'
      | 'agent.pause'
      | 'agent.resume'
      | 'all.pause'
      | 'all.resume';
  }
>;

export const BROKER_COMMAND_TYPES: ReadonlySet<string> = new Set<BrokerCommand['type']>([
  'approval.decide',
  'approval.passThrough',
  'approval.allowAllMatchingPolicy',
  'question.answer',
  'agent.message',
  'message.cancel',
  'agent.pause',
  'agent.resume',
  'all.pause',
  'all.resume',
]);

export function isBrokerCommand(cmd: HuddleCommand): cmd is BrokerCommand {
  return BROKER_COMMAND_TYPES.has(cmd.type);
}

export type BrokerInput =
  /** A hook arrived. `requestIds` come from the events normalized from it. */
  | {
      type: 'hook';
      facts: HookFacts;
      receivedAt: number;
      approvalRequestId: string | null;
      questionRequestId: string | null;
    }
  /**
   * A command. `via` (M6, F26): 'phone' when a paired phone sent it (PhoneHost: approvals, and since ADR-030 answers, messages, pause and resume); never read from the
   * command itself, so no IPC caller can claim to be a phone. Absent: the desktop.
   */
  | { type: 'command'; command: BrokerCommand; via?: 'phone' }
  | { type: 'timer'; holdId: string; kind: TimerKind }
  /** The hold ended without the broker answering it (ending 3, or the server's own shutdown release). */
  | { type: 'closed'; holdId: string; why: 'closed_by_claude_code' | 'shutdown' }
  /** The server refused a planned hold (cap reached or closing) and answered it with no decision. */
  | { type: 'refused'; plan: HoldPlan; why: 'cap' | 'closing' }
  /** The Huddle is quitting: answer every hold with no decision (ending 4). */
  | { type: 'shutdown' };

/** A hold to start. `events` are written once the server has actually started holding. */
export interface HoldPlan {
  entry: HeldEntry;
  timers: { at: number; kind: TimerKind }[];
  events: HuddleEvent[];
}

/** Answer held response `holdId` with `reply`. `events` are written only if the answer was actually sent. */
export interface Release {
  holdId: string;
  reply: HookReplyDecision;
  events: HuddleEvent[];
}

export interface BrokerWarning {
  message: string;
  data: Record<string, unknown>;
}

export interface BrokerEffects {
  /** Written at once. */
  events: HuddleEvent[];
  releases: Release[];
  /** For a hook input: answer now with this (when `hold` is null). */
  reply: HookReplyDecision;
  hold: HoldPlan | null;
  /** For a command input. */
  result: CommandResult | null;
  warnings: BrokerWarning[];
}

export const NO_DECISION: HookReplyDecision = { kind: 'none' };

export function effects(partial: Partial<BrokerEffects> = {}): BrokerEffects {
  return {
    events: partial.events ?? [],
    releases: partial.releases ?? [],
    reply: partial.reply ?? NO_DECISION,
    hold: partial.hold ?? null,
    result: partial.result ?? null,
    warnings: partial.warnings ?? [],
  };
}

export function commandResult(result: CommandResult, partial: Partial<BrokerEffects> = {}): BrokerEffects {
  return effects({ ...partial, result });
}

type Envelope = 'id' | 'ts' | 'sessionId' | 'agentKey' | 'source';
/** Fields of one event type without its envelope. */
export type EventFields<T extends HuddleEvent['type']> = Omit<Extract<HuddleEvent, { type: T }>, Envelope>;

/** Builds one event with an id from `ctx` and ts `ctx.now`. */
export function makeEvent<T extends HuddleEvent['type']>(
  ctx: BrokerCtx,
  who: { sessionId: string; agentKey: AgentKey },
  source: 'user' | 'huddle',
  fields: EventFields<T>,
): Extract<HuddleEvent, { type: T }> {
  return {
    id: ctx.nextId(),
    ts: ctx.now,
    sessionId: who.sessionId,
    agentKey: who.agentKey,
    source,
    ...fields,
  } as Extract<HuddleEvent, { type: T }>;
}

/** The envelope fields of an agent node. */
export function whoOf(node: { sessionId: string; key: AgentKey }): { sessionId: string; agentKey: AgentKey } {
  return { sessionId: node.sessionId, agentKey: node.key };
}

/** Own-property lookup: keys come from commands and payloads. */
export function agentOf(state: HuddleState, key: string): HuddleState['agents'][string] | undefined {
  return Object.hasOwn(state.agents, key) ? state.agents[key] : undefined;
}

/** When the broker releases a hold by itself (hook timeout minus the margin). */
export function holdLimitAt(entry: Pick<HeldEntry, 'timeoutAt'>): number {
  return entry.timeoutAt - SELF_RELEASE_MARGIN_MS;
}

/** Claude Code closed it at about its own timeout (inferred from timing), rather than early. */
export function closedAtTimeout(entry: Pick<HeldEntry, 'timeoutAt'>, now: number): boolean {
  return now >= entry.timeoutAt - EXPIRY_WINDOW_MS;
}
