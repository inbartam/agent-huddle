/**
 * HuddleEvent: the one normalized, append-only event format.
 *
 * Every input (hook, telemetry record, stream message, user click) becomes one or more
 * HuddleEvents. State is a pure function of the event log:
 *
 *     state = events.reduce(reduce, EMPTY_STATE)
 *
 * That single decision buys run history, replay, deterministic tests from recorded fixtures,
 * and scorecards (they are queries over the log). See docs/DECISIONS.md, ADR-002.
 *
 * Rules
 *  - Events are facts in the past tense. Never mutate or delete one; append a correcting event.
 *  - Clip free text before it enters an event (CLIP_LIMITS). Raw payloads stay out of the log.
 *  - Adding a new event type is fine. Changing the meaning of an existing field is not:
 *    old logs must keep replaying.
 */
import type {
  AgentKey,
  AgentOrigin,
  ApprovalRequest,
  AttentionItem,
  Budget,
  Handoff,
  MessageDelivery,
  PermissionMode,
  QuestionRequest,
  RateLimits,
  WorktreeFile,
} from './model.js';
import type { HuddleTaskStatus } from './orch.js';
import type { PhoneAccessReason, PhoneDeviceChange, PhoneRevokeReason } from './phone.js';

export type EventSource =
  | 'hook' // Claude Code hook (HTTP or command forwarder)
  | 'telemetry' // OpenTelemetry export
  | 'stream' // stream-json output of a session the Huddle launched
  | 'statusline' // optional status line bridge
  | 'cli' // polled `claude agents --json`
  | 'huddle' // derived by the Huddle itself (detectors, policy engine, timers)
  | 'user'; // an action in the Huddle UI

/**
 * Maximum characters of free text stored per field.
 * description: an agent definition's description (role.described), added in M1 (ADR-015).
 */
export const CLIP_LIMITS = {
  prompt: 2000,
  brief: 4000,
  result: 4000,
  summary: 300,
  error: 1000,
  message: 2000,
  description: 1000,
  /** Identifiers from payloads: models, roles, tool names, task and agent ids, triggers. */
  id: 256,
  /** File system paths (cwd, file paths). Longer than `summary` so paths stay usable for comparison. */
  path: 1024,
} as const;

interface EventBase<T extends string> {
  /** Unique and sortable: timestamp plus counter, made at the ingest edge (core/ingest/ids.ts). */
  id: string;
  type: T;
  /** Epoch milliseconds, assigned by the Huddle on receipt. */
  ts: number;
  sessionId: string;
  agentKey: AgentKey;
  source: EventSource;
}

// --- sessions and agents -----------------------------------------------------
export interface SessionStarted extends EventBase<'session.started'> {
  origin: AgentOrigin;
  cwd: string | null;
  title: string | null;
  model: string | null;
  startKind: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'first_seen';
}
export interface SessionEnded extends EventBase<'session.ended'> {
  reason: string;
}
export interface PromptSubmitted extends EventBase<'prompt.submitted'> {
  text: string;
  promptId: string | null;
  /**
   * What sent the prompt (ADR-012, ADR-015). Added in M1; absent in older logs, read absent as 'user'.
   *   user:              typed by a person
   *   task_notification: a background subagent finished (prompt opens with <task-notification>)
   *   agent_message:     another agent wrote to this one (prompt opens with <agent-message from=...>)
   */
  kind?: 'user' | 'task_notification' | 'agent_message';
  /**
   * The hook's working folder (a common hook field). Added 2026-11-18 so a session the Huddle first sees mid-run (no
   * SessionStart, so no folder) learns it from its next prompt; absent in older logs.
   */
  cwd?: string;
}
/** A parent asked for a subagent (PreToolUse of the Agent tool). Carries the brief. */
export interface AgentSpawnRequested extends EventBase<'agent.spawn_requested'> {
  toolUseId: string | null;
  role: string | null;
  title: string | null;
  brief: string | null;
  model: string | null;
  /**
   * Added in M6: the Agent call's `name` (`tool_input.name`). In an interactive session with agent teams on, a named
   * Agent call starts a teammate of that name (S20). Absent when the call had no name (and in older logs).
   */
  name?: string;
}
export interface AgentStarted extends EventBase<'agent.started'> {
  agentId: string;
  role: string;
  parentKey: AgentKey;
  /**
   * Added in M6: present only when the agent is an agent-team teammate (S20); it is then the teammate's name (equal to
   * `role`). Absent: an ordinary subagent (and every agent in older logs).
   */
  teammateName?: string;
}
/**
 * An agent-team teammate finished its turn and now waits for messages (TeammateIdle hook, S20; added in M6). It is not
 * done: a new message starts it again (a new agent.started for the same key). agentKey is the teammate's key when the
 * hook carried `agent_id`; otherwise it is the session root's and `agentId` is null (the reducer finds it by name).
 */
export interface TeammateWentIdle extends EventBase<'teammate.idle'> {
  agentId: string | null;
  teammateName: string;
  /** The hook's `team_name` (deprecated there), e.g. `session-1a2b3c4d`; null when absent. */
  teamName: string | null;
}
/**
 * The lead said whether an idle teammate is finished or waiting (M6 P5b, ADR-027): one successful call of the Huddle MCP
 * tool `mcp__huddle__report_teammate`, read from its PostToolUse hook. `agentKey` is the CALLER (normally the lead, the
 * session root); the teammate is named by `teammateName` and found by the reducer in the caller's session (an unknown
 * name changes nothing). Agent text: `teammateName` and `note` are rendered as text.
 */
export interface TeammateReported extends EventBase<'teammate.reported'> {
  /** The teammate's name as the lead wrote it (trimmed, clipped to CLIP_LIMITS.id). */
  teammateName: string;
  /** finished: the teammate's work is done (it counts as finished); waiting: it waits for a result and stays idle. */
  status: 'finished' | 'waiting';
  /** Short note from the lead, masked and clipped to CLIP_LIMITS.summary; null when none. */
  note: string | null;
}
export interface AgentStopped extends EventBase<'agent.stopped'> {
  agentId: string;
  result: string | null;
}
/**
 * A parent's Agent call is now tied to the subagent it started (ADR-012, ADR-015).
 * Comes from PostToolUse(Agent): tool_response.agentId is the child, the caller is the parent.
 * SubagentStart arrives about 26 ms before that PostToolUse, so the tree first places the child by
 * order (link 'heuristic'); this event corrects that placement. agentKey is the child's key.
 */
export interface AgentLinked extends EventBase<'agent.linked'> {
  toolUseId: string;
  childAgentId: string;
  parentKey: AgentKey;
  link: Handoff['link'];
}
/**
 * The one-line description of a role, read from its agent definition file (ADR-015).
 * description is clipped to CLIP_LIMITS.description.
 */
export interface RoleDescribed extends EventBase<'role.described'> {
  role: string;
  description: string;
  /**
   * Where the definition was found. project: <cwd>/.claude/agents. user: ~/.claude/agents.
   * (Named definedIn, not source, because every event's envelope already has `source: EventSource`.)
   */
  definedIn: 'project' | 'user';
  /** The definition file it was read from, or null when unknown. */
  filePath: string | null;
}
export interface TurnEnded extends EventBase<'turn.ended'> {
  lastMessage: string | null;
  /**
   * Agent ids of subagents still running in the background when the turn ended (ADR-012).
   * The session is idle only when this is empty. null: the payload did not say (unknown, not "none").
   * Added in M1; absent in older logs, read absent as null.
   */
  backgroundAgentIds?: string[] | null;
}
export interface TurnFailed extends EventBase<'turn.failed'> {
  error: string | null;
}

// --- tools ---------------------------------------------------------------------
export interface ToolStarted extends EventBase<'tool.started'> {
  toolUseId: string | null;
  toolName: string;
  summary: string;
  /** Absolute path for file tools; feeds file-conflict detection. */
  filePath: string | null;
  /** Hash of tool name + input; feeds loop detection without storing the input. */
  inputDigest: string;
}
export interface ToolFinished extends EventBase<'tool.finished'> {
  toolUseId: string | null;
  toolName: string;
  durationMs: number | null;
}
export interface ToolFailed extends EventBase<'tool.failed'> {
  toolUseId: string | null;
  toolName: string;
  error: string;
  interrupted: boolean;
}

// --- approvals and questions ---------------------------------------------------
export interface ApprovalRequested extends EventBase<'approval.requested'> {
  request: ApprovalRequest;
}
export interface ApprovalResolved extends EventBase<'approval.resolved'> {
  requestId: string;
  outcome: 'allowed' | 'denied' | 'passed_through' | 'expired' | 'answered_elsewhere';
  /** shutdown (added in M3): the Huddle quit while holding the request and answered with no decision (fail open). */
  by: 'user' | 'policy' | 'timeout' | 'claude_code' | 'shutdown';
  policyRuleId: string | null;
  message: string | null;
  /**
   * M4 (F18): an "ask" rule matched this request, so it was held for the user because of that rule (its id). Absent or
   * null: no ask rule matched. Independent of `by`; `policyRuleId` stays the rule that decided (by 'policy' only).
   */
  askedByRuleId?: string | null;
  /**
   * M6 (F26): where a user's decision was made. 'phone': Approve or Deny on a paired phone (only with by 'user').
   * Absent: not said, read as the desktop (every decision before M6, and every desktop decision since).
   */
  via?: 'desktop' | 'phone';
}
export interface QuestionAsked extends EventBase<'question.asked'> {
  request: QuestionRequest;
}
export interface QuestionAnswered extends EventBase<'question.answered'> {
  requestId: string;
  answers: Record<string, string | string[]>;
  /** M6 (ADR-030): 'phone' when a paired phone sent it. Absent: the desktop (or the Huddle itself). */
  via?: 'desktop' | 'phone';
}
/**
 * A held question ended without an answer from the Huddle (M3, F11). The question is no longer the Huddle's to answer.
 *   passed_through:     the hold window ran out, or the user chose "answer in terminal"; released with no decision so
 *                       Claude Code shows its own question box
 *   expired:            Claude Code closed the request at about its hook timeout (inferred from timing)
 *   answered_elsewhere: Claude Code closed the request early, most likely answered in the terminal (inferred)
 *   shutdown:           the Huddle quit while holding it and released it with no decision
 */
export interface QuestionClosed extends EventBase<'question.closed'> {
  requestId: string;
  outcome: 'passed_through' | 'expired' | 'answered_elsewhere' | 'shutdown';
}

// --- pause holds (M3, F13) -----------------------------------------------------
/** The Huddle is holding this agent's PreToolUse to pause it. */
export interface HoldStarted extends EventBase<'hold.started'> {
  /** The held tool call; null when the payload carried none. */
  toolUseId: string | null;
  /** Epoch ms when the Huddle releases the hold by itself (hook timeout minus a margin). */
  limitAt: number;
}
/**
 * A pause hold ended, and how.
 *   resumed:               the user resumed the agent
 *   hold_limit:            the Huddle released it itself just before the hook timeout
 *   closed_by_claude_code: Claude Code closed the request first (timeout, or the session went away)
 *   shutdown:              the Huddle quit and released it
 */
export interface HoldEnded extends EventBase<'hold.ended'> {
  toolUseId: string | null;
  why: 'resumed' | 'hold_limit' | 'closed_by_claude_code' | 'shutdown';
}

// --- tasks and progress --------------------------------------------------------
export interface TaskCreated extends EventBase<'task.created'> {
  taskId: string;
  subject: string;
  description: string | null;
}
/**
 * The agent marked a task in progress (added in M3). Today the only source is a successful
 * TaskUpdate tool call with status in_progress (spike S4b); TaskCreated/TaskCompleted hooks have no
 * in-progress counterpart. An unknown taskId is ignored by the reducer.
 */
export interface TaskStarted extends EventBase<'task.started'> {
  taskId: string;
}
export interface TaskCompleted extends EventBase<'task.completed'> {
  taskId: string;
}
/**
 * The agent's own estimate, sent through the Huddle MCP tool (F27, M6): one successful call of
 * `mcp__huddle__report_progress`, read from its PostToolUse hook (spike S19). `agentKey` is the agent that called it;
 * a subagent's report is about the subagent's own task, never the run's. At least one of the three fields is non-null
 * (a call with none usable emits nothing).
 */
export interface ProgressReported extends EventBase<'progress.reported'> {
  /**
   * Share of the agent's task that is done, 0..1 (clamped at the boundary). Null: the call gave no usable fraction
   * (only minutes left or a note). Widened from `number` in M6 P2; nothing emitted this event before M6, so no stored
   * log holds the old shape, and a number keeps its meaning.
   */
  fraction: number | null;
  /** The agent's own estimate of minutes still needed, at the time of the report (>= 0, capped at 24 h). */
  etaMinutes: number | null;
  /** Short status note, masked and clipped to CLIP_LIMITS.summary. Agent text: render as text. */
  note: string | null;
}

// --- metering ------------------------------------------------------------------
export interface UsageRecorded extends EventBase<'usage.recorded'> {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  /** Deduplication key: one API request must be counted once. */
  requestId: string | null;
  /**
   * What kind of request this was, from telemetry `query_source` (added in M2; absent in older logs, read absent as
   * "count it on agentKey"). main: the session's main loop. subagent: a subagent's own request. helper: a hidden
   * helper (session title, prompt suggestion, away summary). compact: context compaction. other: a source this build
   * does not know. Only main and subagent count on the agent itself; the rest go to the root's helperUsage.
   */
  querySourceKind?: 'main' | 'subagent' | 'helper' | 'compact' | 'other';
  /** Telemetry `parent_agent_id` (nested subagents only). Added in M2. */
  parentAgentId?: string;
  /**
   * True when the record carried no cost. estimatedCostUsd is then 0 but means "unknown", not free. Added in M2;
   * absent means the cost was present.
   */
  costMissing?: boolean;
}
export interface ContextMeasured extends EventBase<'context.measured'> {
  usedTokens: number;
  windowTokens: number | null;
  measuredBy: 'statusline' | 'sdk' | 'telemetry';
}
export interface ContextCompacted extends EventBase<'context.compacted'> {
  phase: 'before' | 'after';
  trigger: 'manual' | 'auto' | 'unknown';
}
export interface ModelChanged extends EventBase<'model.changed'> {
  from: string | null;
  to: string;
}
/**
 * The model an agent was seen using, and how we know (ADR-015). Unlike model.changed it does not
 * claim a switch happened; the reducer applies precedence (session_start and switch, then main-loop
 * telemetry, never a helper request).
 */
export interface ModelObserved extends EventBase<'model.observed'> {
  model: string;
  via: 'session_start' | 'telemetry' | 'agent_call' | 'switch';
}
export interface InstructionsLoaded extends EventBase<'instructions.loaded'> {
  filePath: string | null;
}
/** Rate-limit windows. Envelope source: 'statusline' (M2) or, from M4, 'stream' (a managed run's stream-json). */
export interface LimitsMeasured extends EventBase<'limits.measured'> {
  limits: RateLimits;
}

// --- messages and control ------------------------------------------------------
export interface NotificationRaised extends EventBase<'notification.raised'> {
  notificationType: string | null;
  message: string;
}
export interface MessageQueued extends EventBase<'message.queued'> {
  messageId: string;
  /** Clipped to CLIP_LIMITS.message. */
  text: string;
  /** Where it should land; 'auto' (first of next_tool and turn_end) added in M3. See MessageDelivery. */
  delivery: MessageDelivery;
  /** M6 (ADR-030): 'phone' when a paired phone sent it. Absent: the desktop (or the Huddle itself). */
  via?: 'desktop' | 'phone';
}
/** stream_input (M4): written to a managed root's stdin while it was idle (ADR-020 §5). */
export interface MessageDelivered extends EventBase<'message.delivered'> {
  messageId: string;
  via: 'pre_tool_context' | 'stop_continuation' | 'stream_input';
}
/**
 * A queued message will never be delivered (M3, F12).
 *   cancelled:   the user took it back
 *   agent_ended: the session or subagent ended first
 */
export interface MessageDropped extends EventBase<'message.dropped'> {
  messageId: string;
  reason: 'cancelled' | 'agent_ended';
}
/**
 * A control the Huddle applied. M4 (ADR-020) uses launch (a run started; detail: the runId), stop (the run's process
 * was stopped) and interrupt (the current turn was interrupted over stdin) on managed roots; the reducer does not
 * change status on these, run.exited does. A pause or stop a budget applied (F19, M4 WP5) has source 'huddle' and
 * `detail` the budget item's id (`budget:<scope>:<target>:over`); a user's pause and resume keep `detail` null.
 */
export interface ControlApplied extends EventBase<'control.applied'> {
  action: 'pause' | 'resume' | 'stop' | 'interrupt' | 'set_model' | 'rename' | 'launch';
  detail: string | null;
  /** M6 (ADR-030): 'phone' when a paired phone sent it. Absent: the desktop (or the Huddle itself). */
  via?: 'desktop' | 'phone';
}

// --- managed runs, worktrees, budgets (M4, ADR-020) ------------------------------
//
// Envelope. `runId` is the Huddle's id for one launch: file-name safe (the AgentKey charset, at most 128 characters),
// made at the edge. Every run.* and worktree.* event is about one run, and the reducer finds the run by `runId`, not
// by the envelope. The envelope's `sessionId` / `agentKey` are the run's Claude Code session and its root when that is
// known; before it is known (a worktree is made before the process starts, or the session id is learned from the
// stream later) they are the runId itself, a placeholder that never becomes a node in the tree.
// `source` is 'huddle' for what the Huddle did (launch, worktree, budget, exit) and 'stream' for what the stream said.

/**
 * The Huddle started a `claude -p` process for a run (F16). `permissionMode` accepts a string this build does not
 * know (forward-compatible); `model` is what was asked for (`--model`), not what Claude Code resolved.
 * A second run.launched for the same runId corrects the first (for example once `claudeSessionId` is learned).
 */
export interface RunLaunched extends EventBase<'run.launched'> {
  runId: string;
  /**
   * The Claude Code session this run is, when fixed at launch (`--session-id`, pending S16) or learned since; null
   * while unknown. When set, the reducer files the run under that session's root and marks the root managed.
   */
  claudeSessionId: string | null;
  templateId: string | null;
  /** Clipped to CLIP_LIMITS.path. */
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  mainAgent: string | null;
  /** Names passed with `--agents`. */
  agentNames: string[];
  worktree: { path: string; branch: string } | null;
}
/**
 * The run's process ended. completed: it exited by itself (exit code 0, or after its stdin closed). stopped: the Huddle
 * stopped it. failed: it exited with an error. spawn_failed: it never started. `error` clipped to CLIP_LIMITS.error.
 */
export interface RunExited extends EventBase<'run.exited'> {
  runId: string;
  exitCode: number | null;
  how: 'completed' | 'stopped' | 'failed' | 'spawn_failed';
  error: string | null;
}
/** The stream-json `result` message that ends one turn of a managed run. */
export interface RunResultEvent extends EventBase<'run.result'> {
  runId: string;
  isError: boolean;
  durationMs: number | null;
  numTurns: number | null;
  /** Claude Code's own estimate (ADR-013); not money spent. */
  totalCostUsd: number | null;
  /** How many tool calls were denied during the turn (length of `permission_denials`). */
  permissionDenials: number;
}
/** The Huddle made a git worktree for a run (ADR-020 §2). Paths clipped to CLIP_LIMITS.path. */
export interface WorktreeCreated extends EventBase<'worktree.created'> {
  runId: string;
  path: string;
  branch: string;
  baseCommit: string;
  repoRoot: string;
}
/** What the run changed in its worktree. `files` has at most MAX_WORKTREE_FILES entries, paths clipped. */
export interface WorktreeSummarized extends EventBase<'worktree.summarized'> {
  runId: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  untracked: number;
  files: WorktreeFile[];
}
/**
 * The user kept or discarded a run's worktree. `error`: something went wrong part way (for example the worktree was
 * removed but its branch was not), clipped to CLIP_LIMITS.error; null when it went cleanly.
 */
export interface WorktreeClosed extends EventBase<'worktree.closed'> {
  runId: string;
  outcome: 'kept' | 'discarded';
  error: string | null;
}
/**
 * A budget was set for an agent, a session or everything (F19). The event's `scope` is authoritative (the Budget's own
 * `scope` is not read here). `targetKey`: the agent key (agent), the root key (session), null (overall). A budget with
 * none of maxTokens, maxEstimatedCostUsd and maxMinutes clears that scope and target.
 */
export interface BudgetSet extends EventBase<'budget.set'> {
  scope: 'agent' | 'session' | 'overall';
  targetKey: AgentKey | null;
  budget: Budget;
}

// --- history (M5, F22) -------------------------------------------------------------
/**
 * The Huddle deleted stored sessions: their events, search rows, derived rows and report files are gone from this
 * computer. `retention`: they were older than the history retention. `delete_all`: the user deleted all history.
 *
 * `sessionIds` names the deleted sessions this Huddle had loaded in its state when it deleted them (the only ones the
 * reducer can drop; the rest were never loaded), so the event stays small however many runs went. `count` is how many
 * sessions were deleted in all. A running session, the overall budgets' session and the Huddle's own sessions are never
 * deleted, and the reducer leaves them alone even when named here.
 *
 * Envelope: `sessionId` and `agentKey` are the Huddle's own history session (`huddle-history`), which never becomes a
 * node in the tree. Source 'huddle' (retention) or 'user' (delete all).
 */
export interface HistoryPruned extends EventBase<'history.pruned'> {
  sessionIds: string[];
  reason: 'retention' | 'delete_all';
  count: number;
}

// --- phone access (M6, F26) ----------------------------------------------------------------------------------------
//
// Envelope: `sessionId` and `agentKey` are the Huddle's own phone session (`huddle-phone`), which never becomes a node
// in the tree and is never replayed at start (phone access always starts off; the paired phones are read from
// phone-devices.json and announced with `known`). Source 'user' for what the user did, 'huddle' otherwise.
// Neither event ever carries a token, a token hash or a pairing code.

/** Phone access was turned on or off. `url` is `http://<ip>:<port>/` while enabled, else null. */
export interface PhoneAccessChanged extends EventBase<'phone.access_changed'> {
  enabled: boolean;
  url: string | null;
  reason?: PhoneAccessReason;
}
/**
 * Something happened to one paired phone. `name` is what the phone called itself, clipped to PHONE_DEVICE_NAME_MAX
 * (text from the network). `pairedAt`: on paired and known, when it was paired. `reason`: on revoked, why.
 */
export interface PhoneDeviceChanged extends EventBase<'phone.device_changed'> {
  deviceId: string;
  name: string;
  change: PhoneDeviceChange;
  pairedAt?: number | null;
  reason?: PhoneRevokeReason;
}

// --- the Huddle's own task list (F29) ------------------------------------------------------------------------------
//
// Envelope: `sessionId` and `agentKey` are the Huddle's own tasks session (`huddle-tasks`, TASKS_SESSION_ID in
// orch.ts), which never becomes a node in the tree, is replayed at every start and is kept by the retention and by
// "delete all history" (like the overall budgets). Source 'user' for what the user did, 'huddle' when the core records
// the outcome of a task's run. Text is the user's own, clipped (HUDDLE_TASK_TITLE_MAX, HUDDLE_TASK_DETAILS_MAX) and
// masked by the store like every free-text field. These are not Claude Code's own tasks (`task.created` above).

/** The user made a task. `projectPath`: a known project, or null (the template's folder). */
export interface HuddleTaskCreated extends EventBase<'huddle_task.created'> {
  taskId: string;
  title: string;
  details: string;
  projectPath: string | null;
  templateId: string | null;
}
/**
 * Something about a task changed; only the fields present change. `runId` links the run launched for it (with
 * `launchedAt`); `status` is the user's mark (todo, done) or the run's outcome recorded by the core (running, done,
 * failed).
 */
export interface HuddleTaskUpdated extends EventBase<'huddle_task.updated'> {
  taskId: string;
  title?: string;
  details?: string;
  projectPath?: string | null;
  templateId?: string | null;
  status?: HuddleTaskStatus;
  runId?: string | null;
  launchedAt?: number | null;
}
/** The user deleted a task. */
export interface HuddleTaskDeleted extends EventBase<'huddle_task.deleted'> {
  taskId: string;
}

// --- attention (derived) ---------------------------------------------------------
export interface AttentionRaised extends EventBase<'attention.raised'> {
  item: AttentionItem;
}
export interface AttentionResolved extends EventBase<'attention.resolved'> {
  itemId: string;
  /**
   * Added after the M4 runbook: 'dismissed' when the user dismissed the item (`attention.dismiss`, source user) while
   * its condition may still hold. Absent: the condition cleared or the request was handled.
   */
  reason?: 'dismissed';
}

export type HuddleEvent =
  | SessionStarted
  | SessionEnded
  | PromptSubmitted
  | AgentSpawnRequested
  | AgentStarted
  | AgentStopped
  | AgentLinked
  | TeammateWentIdle
  | TeammateReported
  | RoleDescribed
  | TurnEnded
  | TurnFailed
  | ToolStarted
  | ToolFinished
  | ToolFailed
  | ApprovalRequested
  | ApprovalResolved
  | QuestionAsked
  | QuestionAnswered
  | QuestionClosed
  | HoldStarted
  | HoldEnded
  | TaskCreated
  | TaskStarted
  | TaskCompleted
  | ProgressReported
  | UsageRecorded
  | ContextMeasured
  | ContextCompacted
  | ModelChanged
  | ModelObserved
  | InstructionsLoaded
  | LimitsMeasured
  | NotificationRaised
  | MessageQueued
  | MessageDelivered
  | MessageDropped
  | ControlApplied
  | AttentionRaised
  | AttentionResolved
  | RunLaunched
  | RunExited
  | RunResultEvent
  | WorktreeCreated
  | WorktreeSummarized
  | WorktreeClosed
  | BudgetSet
  | HistoryPruned
  | PhoneAccessChanged
  | PhoneDeviceChanged
  | HuddleTaskCreated
  | HuddleTaskUpdated
  | HuddleTaskDeleted;

export type HuddleEventType = HuddleEvent['type'];

/** Narrow a HuddleEvent by its type string. */
export type EventOfType<T extends HuddleEventType> = Extract<HuddleEvent, { type: T }>;

/** Storage contract. M1: JSONL files. M5: SQLite. Swapping must not touch reducers or UI. */
export interface EventStore {
  append(events: readonly HuddleEvent[]): Promise<void>;
  /** Events of one session in order, for replay and reports. */
  readSession(sessionId: string): AsyncIterable<HuddleEvent>;
  listSessions(options?: { limit?: number }): Promise<{ sessionId: string; firstTs: number; lastTs: number }[]>;
}
