/**
 * The Huddle's domain model: what the UI renders and what reducers produce from HuddleEvents.
 * Nothing here knows about hooks, OTLP or Electron. Keep it serializable (plain JSON only),
 * because the same objects cross the Electron IPC boundary and, later, go to the phone.
 */
import type { HuddleTask } from './orch.js';
import type { PhoneState } from './phone.js';
import type { UserSettings } from './settings.js';

/**
 * Stable identity of one agent in the tree.
 *   main agent of a session:  "<sessionId>"
 *   subagent:                 "<sessionId>::<agentId>"
 */
export type AgentKey = string;

export function agentKey(sessionId: string, agentId?: string | null): AgentKey {
  return agentId ? `${sessionId}::${agentId}` : sessionId;
}

/**
 * What a well-formed AgentKey looks like: a session id (the event store's file-name-safe charset, at most 128
 * characters) optionally followed by `::` and an agent id of the same charset. Use it to check a key that came from
 * outside the state (a URL, a command) before looking it up; a key from state always matches.
 */
export const AGENT_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(?:::[A-Za-z0-9_-][A-Za-z0-9._-]{0,127})?$/;

/** At most this many characters (two ids of 128 plus the separator); used by checks that also bound the length. */
export const AGENT_KEY_MAX_LENGTH = 258;

export function isAgentKeyFormat(value: unknown): value is AgentKey {
  return typeof value === 'string' && value.length <= AGENT_KEY_MAX_LENGTH && AGENT_KEY_PATTERN.test(value);
}

export type AgentKind = 'main' | 'subagent' | 'teammate';

/**
 * attached = started by the user in a terminal or in VS Code; the Huddle only listens through hooks.
 * managed  = launched by the Huddle, which also owns the process and its input stream.
 */
export type AgentOrigin = 'attached' | 'managed';

export type AgentStatus =
  | 'starting'
  | 'working'
  | 'waiting_approval'
  | 'waiting_answer'
  | 'paused'
  | 'idle' // finished its turn, waiting for the next prompt
  | 'done'
  | 'failed'
  | 'stopped';

/**
 * What the user can do to this agent right now. The UI disables controls from these flags,
 * so it never offers an action the session's origin cannot perform. See docs/SPEC.md,
 * "Capability matrix".
 */
export interface AgentCapabilities {
  approve: boolean;
  answerQuestions: boolean;
  /** none: cannot be messaged. queued: delivered at the next tool call or turn end. live: delivered at once. */
  message: 'none' | 'queued' | 'live';
  pause: boolean;
  stop: boolean;
  setModel: boolean;
  /**
   * Can a message land as a follow-up at the end of a turn (Stop `decision: block`, S7)? Main agents only: SubagentStop
   * block is not used in M3, so subagents get next-tool-call delivery only. Added in M3; absent means false.
   */
  followUp?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  /**
   * Sum of Claude Code's own per-request `cost_usd` (ADR-013), a client-side estimate. On a
   * subscription this is an API-equivalent figure, not money spent. Label it as an estimate everywhere it is shown.
   */
  estimatedCostUsd: number;
  /** Requests counted that had no request id, so could not be deduplicated (M2; absent means 0). */
  requestsWithoutId?: number;
  /** Requests counted that carried no cost: estimatedCostUsd is then a lower bound (M2; absent means 0). */
  requestsWithoutCost?: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests: 0,
  estimatedCostUsd: 0,
};

export interface ContextHealth {
  /** input + cache read + cache creation tokens of the latest API request. */
  usedTokens: number | null;
  windowTokens: number | null;
  usedPct: number | null;
  compactions: number;
  lastCompactedAt: number | null;
  /** CLAUDE.md and rule files reported by InstructionsLoaded. */
  loadedInstructions: string[];
  /** Where the number came from, so the UI can show how much to trust it. */
  measuredBy: 'statusline' | 'sdk' | 'telemetry' | null;
}

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'completed';
  createdAt: number;
  /**
   * When the agent last marked it in progress (task.started, added in M3). "In progress" is status 'pending' with
   * startedAt set; absent means not started, or not known to have started.
   */
  startedAt?: number;
  completedAt?: number;
}

/**
 * Where a queued message should land (M3, F12).
 *   next_tool: as `additionalContext` on the agent's next PreToolUse
 *   turn_end:  as a Stop `decision: block` follow-up (main agent only)
 *   auto:      whichever of the two comes first (added in M3)
 *   live:      written to the input stream of a managed session at once
 */
export type MessageDelivery = 'next_tool' | 'turn_end' | 'auto' | 'live';

/** A message the user wrote that has not reached the agent yet (M3, F12). Built from `message.*` events. */
export interface QueuedMessage {
  messageId: string;
  /** Clipped to CLIP_LIMITS.message. */
  text: string;
  delivery: MessageDelivery;
  queuedAt: number;
  /**
   * Added in M6 P5b: 'huddle' when the Huddle wrote the message itself (the `message.queued` event's source is 'huddle',
   * e.g. the lead check on an idle teammate, ADR-027); it is then delivered without the "from the user" prefix. Absent:
   * the user wrote it (every message before M6).
   */
  author?: 'huddle';
}

/** A pause hold on the agent's current PreToolUse (M3, F13). */
export interface AgentHold {
  /** The held tool call, when the payload carried one. */
  toolUseId: string | null;
  since: number;
  /** Epoch ms when the Huddle releases the hold by itself (hook timeout minus a margin). */
  limitAt: number;
}

export interface ProgressEstimate {
  /** 0..1, or null when there is nothing to base an estimate on. */
  fraction: number | null;
  completedTasks: number;
  totalTasks: number;
  /** Remaining time in ms with a low/high range, or null when unknown. */
  etaMs: number | null;
  etaLowMs: number | null;
  etaHighMs: number | null;
  /** subagents (M2, ADR-010): direct subagents finished / started; `completedTasks`/`totalTasks` stay task counts. */
  basis: 'tasks' | 'self_report' | 'hybrid' | 'subagents' | 'none';
  confidence: 'low' | 'medium' | 'high';
  /** The denominator grew after work had finished (a subagent started after another finished). Absent means false. */
  scopeGrew?: boolean;
}

/** What a parent handed to a subagent, and what came back. */
export interface Handoff {
  toolUseId: string | null;
  title: string | null;
  brief: string | null;
  result: string | null;
  /** exact: linked by tool_use_id. heuristic: matched by order and agent type (see SPIKES S2). */
  link: 'exact' | 'heuristic' | 'unknown';
}

/** One self-report as the reducer keeps it (F27). Each field null when that report did not carry it. */
export interface AgentSelfReport {
  /** 0..1 */
  fraction: number | null;
  /** Minutes still needed, as the agent said at `at`. */
  minutesLeft: number | null;
  /** Agent text: render as text. */
  note: string | null;
  /** Event time of the report (epoch ms). */
  at: number;
}

export interface AgentNode {
  key: AgentKey;
  sessionId: string;
  agentId: string | null;
  parentKey: AgentKey | null;
  childKeys: AgentKey[];
  kind: AgentKind;
  origin: AgentOrigin;

  /** Display name: user nickname, else session title or handoff title, else role plus ordinal. */
  name: string;
  /** Role: the agent type ("Explore", "core-engineer") or "main". */
  role: string;
  /** One-line role description from the agent definition file, when it can be found. */
  roleDescription: string | null;
  model: string | null;
  cwd: string | null;
  /**
   * M4 (F18), main agents only: the folder the session started in, set once and never moved by a later hook (`cwd`
   * follows each SessionStart, whose payload cwd follows the agent's own `cd`). From `run.launched` for a managed
   * run (authoritative, replaces a first-seen value), else from the first `session.started` that carries a cwd.
   * Approval rules contain allow decisions in it. Absent or null: unknown.
   */
  sessionCwd?: string | null;
  /**
   * Main agents only (added in M4): the first line of the latest prompt the user typed (`prompt.submitted` with kind
   * 'user'), whitespace collapsed and clipped to TOPIC_MAX (`promptTopic`). Task notifications, agent messages and
   * prompts that open with a tag do not change it. Agent text: render as text. Absent or null: none seen.
   */
  lastPrompt?: string | null;
  /**
   * Main agents only (added for the main window redesign): the first typed prompt (`prompt.submitted` with kind
   * 'user') that gives a title, cleaned by `cleanPromptTitle` (Claude Code tag blocks stripped, first line, clipped to
   * TOPIC_MAX). Set once and never moved by a later prompt. The sidebar titles an unnamed session with it. Agent text:
   * render as text. Absent or null: none seen.
   */
  firstPrompt?: string | null;

  status: AgentStatus;
  /** Human-readable "doing now": current task subject, else the running tool. */
  currentActivity: string | null;
  tasks: TaskItem[];
  /**
   * Deprecated: a placeholder the reducer never fills; use `selectProgress(state, key, now)` from selectors.ts.
   * (Not a JSDoc deprecated tag: lint's no-deprecated would then fail every place that builds an AgentNode.)
   */
  progress: ProgressEstimate;
  usage: TokenUsage;
  /**
   * Root (main agent) only, added in M2: the session's hidden helper and compaction requests (title, prompt
   * suggestion, away summary, compact, unknown sources). Not part of `usage`; session totals add it. Absent: none seen.
   */
  helperUsage?: TokenUsage;
  context: ContextHealth;
  handoff: Handoff | null;
  capabilities: AgentCapabilities;
  /** Messages queued for this agent, oldest first (M3). Absent means none. */
  outbox?: QueuedMessage[];
  /** The pause hold the Huddle has on this agent, or null when not held (M3). Absent means not held. */
  hold?: AgentHold | null;
  /** A pause was asked for and waits for the agent's next tool call (M3). Absent means false. */
  pausePending?: boolean;
  /**
   * Why the Huddle itself paused this agent, while that pause lasts (M4 runbook fix): the `detail` of the
   * `control.applied pause` with source huddle; for a budget that is the budget's over item id (`budgetOverItemId`).
   * Absent or null: not paused, or paused by the user. Cleared when the pause ends (resume, the hold ending, the
   * agent ending).
   */
  pausedBy?: string | null;
  /** Root of a run the Huddle launched (M4): template, worktree, how it ended. Absent: not launched by the Huddle. */
  run?: AgentRun | null;
  /**
   * The latest progress report this agent sent itself (F27, M6: `progress.reported`), raw: no blending, no aging.
   * `selectProgress` decides how much it counts. Absent or null: the agent never reported.
   */
  selfReport?: AgentSelfReport | null;

  toolCalls: number;
  toolFailures: number;
  startedAt: number;
  endedAt: number | null;
  lastEventAt: number;
}

// ---------------------------------------------------------------------------
// Things that need the user (the inbox)
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  requestId: string;
  agentKey: AgentKey;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** One line a person can read: the command, the file path, the URL. */
  summary: string;
  receivedAt: number;
  /** After this the hook times out and Claude Code falls back to its own prompt. */
  expiresAt: number | null;
  channel: 'hook' | 'stream';
  /**
   * True when `summary` does not show the whole command: a secret in it was masked, or it was cut at the summary
   * limit (AX-01). The card warns, and the phone does not allow it. Absent: nothing hidden, or an event stored before
   * this field existed (`approvalTextHidden` then reads the summary itself).
   */
  hidden?: boolean;
}

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect: boolean;
}
export interface QuestionRequest {
  requestId: string;
  agentKey: AgentKey;
  questions: AskQuestion[];
  receivedAt: number;
  /** After this the hook times out and Claude Code shows its own question box (M3); null or absent when unknown. */
  expiresAt?: number | null;
}

export type AttentionKind =
  | 'approval'
  | 'question'
  | 'stuck'
  | 'loop'
  | 'file_conflict'
  | 'budget'
  | 'context_high'
  | 'error'
  | 'finished'
  /** 2026-11-18: an agent whose type reads, not edits (reviewer, researcher) started a file edit. */
  | 'role_drift';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: 'info' | 'warning' | 'action_required';
  agentKey: AgentKey;
  title: string;
  detail: string;
  createdAt: number;
  resolvedAt: number | null;
  approval?: ApprovalRequest;
  question?: QuestionRequest;
  /** For file_conflict: every agent that touched the file. */
  relatedAgentKeys?: AgentKey[];
  /** True when the user dismissed it (`attention.resolved` with reason 'dismissed'). Absent: not dismissed. */
  dismissed?: boolean;
}

// ---------------------------------------------------------------------------
// Management: rules, budgets, templates (M4, ADR-020)
// ---------------------------------------------------------------------------

/**
 * An approval rule (F18, ADR-020 §3). Rules are evaluated on PermissionRequest only, so a rule can remove a prompt
 * Claude Code would show, never widen what is allowed. Precedence deny > ask > allow, whatever the order. An allow
 * rule never matches a clipped or masked input or a compound command. Stored by main in `policy-rules.json`; the
 * renderer reads them through `HuddleState.policy`.
 * Every `match` field given must match (AND); a rule with an empty `match` matches every request.
 */
export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  /** allow: answer allow. deny: answer deny with a message naming the rule. ask: hold for the user, as without rules. */
  action: 'allow' | 'deny' | 'ask';
  match: {
    /** Exact tool name ("Bash", "Read", "mcp__server__tool"). */
    tool?: string;
    /** Bash and PowerShell: the command starts with this text (at a word boundary), e.g. "git status". */
    commandPrefix?: string;
    /** With `commandPrefix`: the command must be exactly the prefix, with no arguments (`node --version`). M4 WP2. */
    commandExact?: boolean;
    /** File tools: glob over the tool's file path, relative to the session cwd. */
    pathGlob?: string;
    /** The agent's role ("main", "Explore", "core-engineer"). */
    role?: string;
    /** The session cwd is this folder or inside it. */
    folder?: string;
  };
  /** Why the rule exists, shown next to it. */
  note?: string;
}

/**
 * A limit on tokens, estimated cost or time (F19, ADR-020 §4). Enforced with the M3 pause; telemetry lands 1-3 s late,
 * so a run can overshoot by about one API call.
 */
export interface Budget {
  /**
   * What the limit applies to inside a template or a `budget.set` command. In a `budget.set` event the event's own
   * `scope` is authoritative and this field is not read. 'overall' and 'all' mean the same (everything); 'all' is the
   * M4 WP1 spelling, still accepted on read. New code writes 'overall' (normalize with `budgetScopeOf`, manage.ts).
   */
  scope: 'agent' | 'session' | 'overall' | 'all';
  /**
   * Tokens counted as input + output + cache creation, summed over the scope's requests; cache reads are excluded
   * (ADR-020 §4).
   */
  maxTokens?: number;
  /** Claude Code's own client-side cost estimate (ADR-013), never money spent. */
  maxEstimatedCostUsd?: number;
  maxMinutes?: number;
  warnAtFraction: number;
  onExceed: 'notify' | 'pause' | 'stop';
}

/**
 * The `--permission-mode` values Claude Code documents (INTEGRATION.md section 3, "M4 launch flags"); `manual` is an
 * alias of `default`.
 */
export const PERMISSION_MODES = [
  'default',
  'manual',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

export type KnownPermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * A permission mode: one of the documented values, or a string a newer Claude Code added (kept as is, so a stored
 * template or event never fails to load). `string & {}` keeps editor completion for the known values.
 */
export type PermissionMode = KnownPermissionMode | (string & {});

/** One agent a template defines, passed to Claude Code with `--agents` (INTEGRATION.md section 3). */
export interface TemplateAgent {
  description: string;
  /** The agent's system prompt. */
  prompt: string;
  /** Tool names it may use; absent: every tool. */
  tools?: string[];
  /** Model alias or id; absent: inherit. */
  model?: string;
}

/**
 * A team the Huddle can launch (F16, ADR-020 §1). Stored by main in `templates.json`; the renderer reads them through
 * `HuddleState.templates`.
 */
export interface TeamTemplate {
  id: string;
  name: string;
  /** One line for the template list. Optional. */
  description?: string;
  /** The first prompt, sent over stdin (never on the command line). */
  prompt: string;
  cwd: string;
  /** Run the whole session as this agent (`--agent`), or null for Claude Code's default main loop. */
  mainAgent: string | null;
  /** `--model`, or null for the user's default. */
  model: string | null;
  permissionMode: PermissionMode;
  /** Agents defined for this run only (`--agents`), by name. A name must not start with "-". */
  agents?: Record<string, TemplateAgent>;
  budgets?: Budget[];
  /** Policy rules (by id) that apply to this run on top of the enabled global ones. */
  ruleIds?: string[];
  /** Give the run its own git worktree (ADR-020 §2). */
  worktree: boolean;
  /**
   * M6 (F27, ADR-025): false turns self-reported progress off for this template's runs (no `--mcp-config`, no prompt
   * line). Absent or true: on, unless the global `selfReport.enabled` setting is off (the global switch wins).
   */
  selfReport?: boolean;
}

/** How git reports one changed file in a worktree. `unknown`: a status this build does not know. */
export type WorktreeFileStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed' | 'unmerged' | 'untracked' | 'unknown';

export interface WorktreeFile {
  /** Relative to the worktree root, clipped to CLIP_LIMITS.path. */
  path: string;
  status: WorktreeFileStatus;
}

/** The most files a worktree.summarized event lists; `filesChanged` keeps the true count. */
export const MAX_WORKTREE_FILES = 50;

/** What a run changed in its worktree, against its base commit (worktree.summarized). */
export interface WorktreeSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  untracked: number;
  /** At most MAX_WORKTREE_FILES entries. */
  files: WorktreeFile[];
  summarizedAt: number;
}

/** The worktree of a managed run (ADR-020 §2). */
export interface RunWorktree {
  path: string;
  branch: string;
  /** active: in use or not decided yet. kept: the user kept it (branch stays). discarded: worktree and branch removed. */
  state: 'active' | 'kept' | 'discarded';
  /** Commit the worktree was made from; absent when only run.launched was seen. */
  baseCommit?: string;
  /** The repository the worktree belongs to; absent when only run.launched was seen. */
  repoRoot?: string;
  summary?: WorktreeSummary;
  /** What went wrong while keeping or discarding it (worktree.closed error); absent or null when clean. */
  closeError?: string | null;
}

/** How a managed run's process ended (run.exited). */
export interface RunExit {
  at: number;
  exitCode: number | null;
  /** completed: exited by itself. stopped: the Huddle stopped it. failed: exited with an error. spawn_failed: never started. */
  how: 'completed' | 'stopped' | 'failed' | 'spawn_failed';
  error: string | null;
}

/** The stream-json `result` of a managed run's latest turn (run.result). */
export interface RunResult {
  at: number;
  isError: boolean;
  durationMs: number | null;
  numTurns: number | null;
  /** Claude Code's own estimate; an API-equivalent figure, not money spent. */
  totalCostUsd: number | null;
  permissionDenials: number;
}

/** A run the Huddle launched, on its root node (M4). */
export interface AgentRun {
  runId: string;
  templateId: string | null;
  permissionMode: PermissionMode;
  /** The `--agent` the session runs as, or null. */
  mainAgent: string | null;
  /** Names of the agents passed with `--agents`. */
  agentNames: string[];
  worktree: RunWorktree | null;
  /** How the process ended; absent or null while it runs. */
  exited?: RunExit | null;
  /** The latest turn's result; absent or null before the first. */
  result?: RunResult | null;
}

/** A budget in force (budget.set), one per scope and target. Reducer-owned, unlike `policy` and `templates`. */
export interface BudgetEntry {
  scope: 'agent' | 'session' | 'overall';
  /** agent: the agent key. session: the session's root key. overall: null. */
  targetKey: AgentKey | null;
  budget: Budget;
  setAt: number;
}

/** Subscription rate-limit windows, when Claude Code reports them. */
export interface RateLimits {
  fiveHourUsedPct: number | null;
  fiveHourResetsAt: number | null;
  sevenDayUsedPct: number | null;
  sevenDayResetsAt: number | null;
  measuredAt: number;
}

export interface HuddleState {
  agents: Record<AgentKey, AgentNode>;
  /** Root agents (sessions), most recently active first. */
  rootKeys: AgentKey[];
  inbox: AttentionItem[];
  rateLimits: RateLimits | null;
  /**
   * Whether the Huddle is receiving Claude Code events (ADR-017). Added in M1. Filled by Electron main next to the
   * reducer's state (it is setup status, not derived from events); absent in replays and tests.
   */
  connection?: ConnectionStatus;
  /**
   * The user's settings (M3). Like `connection`, filled by Electron main next to the reducer's state, not derived from
   * events; absent in replays and tests (read absent as DEFAULT_USER_SETTINGS).
   */
  settings?: UserSettings;
  /**
   * Whether the global shortcut (F15) is registered (M3). Filled by Electron main like `connection`; absent in replays
   * and tests, and before main has tried to register it.
   */
  shortcut?: ShortcutStatus;
  /**
   * The approval rules (M4, F18). Like `settings`, filled by Electron main (from `policy-rules.json`), not derived
   * from events; absent in replays and tests (read absent as "no rules").
   */
  policy?: PolicyRule[];
  /**
   * Why `policy-rules.json` was not used and the default rules are in force (A2-02), in words, or null. Filled by the
   * core like `policy`; absent: no problem known. A bad file is moved aside before the next save, never overwritten.
   */
  policyWarning?: string | null;
  /**
   * The team templates (M4, F16). Filled by Electron main (from `templates.json`) like `policy`; absent in replays and
   * tests.
   */
  templates?: TeamTemplate[];
  /** Budgets in force (M4, F19), oldest first. Derived from `budget.set` events by the reducer; absent: none set. */
  budgets?: BudgetEntry[];
  /**
   * ETA priors from the scorecards (M5, F24). Like `connection`, filled by the core next to the reducer's state from the
   * stored history, never by the reducer; absent in replays and tests (read absent as "no priors").
   */
  priors?: EtaPriors;
  /**
   * Ask the Huddle (M5, F25), what the UI needs before it asks. Like `connection`, filled by the core next to the
   * reducer's state, never by the reducer; absent in replays, tests and the canned dev core (read absent as unknown:
   * the `huddle.ask` answer still says why an ask was refused).
   */
  ask?: AskStatus;
  /**
   * Phone access (M6, F26): on or off, its address, the paired phones and which are connected. Derived from `phone.*`
   * events by the reducer (never replayed: it describes this run); absent until the core announced phone access.
   */
  phone?: PhoneState;
  /**
   * The Huddle's own task list (F29), oldest first. Derived from `huddle_task.*` events by the reducer; absent: none
   * made. The status to show comes from `selectHuddleTasks` (orch.ts), which reads the linked run.
   */
  huddleTasks?: HuddleTask[];
}

/** `HuddleState.ask` (M5, F25). */
export interface AskStatus {
  /** Ask is on in Settings (`settings.ask.enabled`). */
  enabled: boolean;
  /**
   * ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is in the env the Huddle would pass to claude, so `huddle.ask` is refused
   * with `api_key_set`. Also true when the same names are in the `env` block of Claude Code's user settings.json (claude
   * applies it on top), or it sets `apiKeyHelper` (M5 security review L1).
   */
  apiKeySet: boolean;
  /**
   * The summary would go to another provider (ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY in the
   * env or in settings.json's `env` block), so `huddle.ask` is refused with `other_provider`. Added in M5; absent
   * from an older core (read absent as false).
   */
  otherProvider?: boolean;
  /** An ask is running now; another is refused with `busy`. */
  busy: boolean;
}

/**
 * Typical ms per unit of work by role and model (`priorUnitMsFor` over today's scorecards): only pairs with at least
 * MIN_PRIOR_SAMPLES completed runs are present. Keys are `priorKey(role, model)`.
 */
export interface EtaPriors {
  byRoleModel: Record<string, number>;
  /** When the scorecards were computed, epoch ms. */
  asOf: number;
}

/** The `EtaPriors.byRoleModel` key for a role and model: unambiguous for any strings, and never a prototype key. */
export function priorKey(role: string, model: string | null): string {
  return JSON.stringify([role, model]);
}

/** The global shortcut as Electron main last tried to register it (M3, F15). */
export interface ShortcutStatus {
  /** The accelerator from the user's settings. */
  accelerator: string;
  registered: boolean;
  /** What went wrong and what to do, when not registered; null otherwise. */
  message: string | null;
  /** When `accelerator` failed but the previous shortcut was kept: that one, which still works. */
  activeAccelerator?: string;
}

/** ADR-017. What the first-run screen and the "not connected" banner show. */
export interface ConnectionStatus {
  /**
   * attached:      hooks installed, server listening
   * needs_consent: first run; nothing written yet, `preview` holds the change to show
   * port_in_use:   another process (often another running Agent Huddle) holds the port; nothing new is received
   * error:         something else failed; `message` says what and what to do
   */
  status: 'attached' | 'needs_consent' | 'port_in_use' | 'error';
  message: string | null;
  preview?: ConnectionPreview;
  /**
   * Epoch ms when this Huddle run started (set by HuddleCore; added in M1). A session not ended whose last event is
   * older than this was only replayed from the log: `selectTree(state, { huddleStartedAt })` marks it stale.
   */
  startedAt?: number;
}

export interface ConnectionPreview {
  settingsPath: string;
  /** Human-readable diff of settings.json; the token is shown as `<token>`, never in clear. */
  diffText: string;
  warnings: string[];
}

export const EMPTY_STATE: HuddleState = { agents: {}, rootKeys: [], inbox: [], rateLimits: null };
