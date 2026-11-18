/**
 * Run history contracts (M5, F23 end-of-run report, F24 scorecards): the rows, report and scorecards that
 * `packages/core/src/report` derives from a session's stored HuddleEvents. Types plus pure helpers only, so the
 * renderer can import them (ADR-016).
 *
 * Unknown is `null`, never 0: an agent with no usage record has `tokens: null`, a run that has not ended has
 * `endedAt: null` and `durationMs: null`. Everything here survives `JSON.parse(JSON.stringify(x))`.
 *
 * Agent-derived text (names, titles, results, errors, summaries, paths) is clipped with CLIP_LIMITS when the report is
 * built. It is still agent text: render it as text, and escape it before it goes into Markdown.
 */
import type { ApprovalResolved } from './events.js';
import type { AgentKey, AgentKind, AgentOrigin, EtaPriors, WorktreeFileStatus } from './model.js';
import { priorKey } from './model.js';

/**
 * How an agent's run ended.
 *   completed: it finished by itself (a subagent's SubagentStop, the session ending, a managed run exiting cleanly)
 *   failed:    its last turn failed (StopFailure), or a managed run exited with an error or never started
 *   stopped:   it was stopped from outside (the Huddle stopped the run, or the session ended while it still ran)
 *   unknown:   the log does not say (still running, idle at the end of the log, or ended without a known reason)
 */
export type RunOutcome = 'completed' | 'failed' | 'stopped' | 'unknown';

/** Token counts as Claude Code's telemetry gives them (`api_request`), summed over the agent's own requests. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** API requests counted (deduplicated by request id). */
  requests: number;
}

/** Permission requests an agent raised, and who answered them. */
export interface ApprovalCounts {
  requested: number;
  /** Answered by the user in the Huddle. */
  byUser: number;
  /** Answered by an approval rule. */
  byPolicy: number;
  /** Ended without a Huddle decision: timeout, closed by Claude Code (answered in the terminal), Huddle shutdown. */
  other: number;
  /** No end recorded in the log. */
  unresolved: number;
}

/** One agent's run in one session: the unit the scorecards aggregate (F24). */
export interface AgentRunRow {
  sessionId: string;
  agentKey: AgentKey;
  parentKey: AgentKey | null;
  kind: AgentKind;
  /** The agent type (`SubagentStart.agent_type`, e.g. "Explore", "core-engineer"), or "main" for the session root. */
  role: string;
  /** The model the agent ran on (reducer precedence: session start / switch, then telemetry or the Agent call's
   * resolved model, then the alias the Agent call asked for). Null when never seen. */
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  outcome: RunOutcome;
  /** Tasks in the agent's task list (TaskCreate), and how many it completed. 0 when it kept no task list. */
  tasksCreated: number;
  tasksCompleted: number;
  toolCalls: number;
  toolFailures: number;
  approvals: ApprovalCounts;
  /** Times a stuck item was raised for this agent (a re-raise while still open counts once). */
  stuckIncidents: number;
  /** Null when no usage record was seen for this agent (unknown, not zero). */
  tokens: TokenCounts | null;
  /** Claude Code's own client-side estimate (ADR-013), not money spent. Null when no usage record was seen. */
  estimatedCostUsd: number | null;
  /** Some requests carried no cost, so `estimatedCostUsd` is a lower bound. */
  costPartial: boolean;
}

// ---------------------------------------------------------------------------
// End-of-run report (F23)
// ---------------------------------------------------------------------------

export interface ReportToolUse {
  toolName: string;
  calls: number;
  failures: number;
}

export interface ReportAgent {
  row: AgentRunRow;
  /** Display name (nickname, session or handoff title, else role plus ordinal). Agent text, clipped. */
  name: string;
  /** The short title the parent gave in its Agent call. Agent text, clipped. Null for the root or when unknown. */
  title: string | null;
  /** The subagent's final message (SubagentStop). Agent text, clipped to CLIP_LIMITS.summary. */
  result: string | null;
  /** Tool calls by tool name, most used first. */
  tools: ReportToolUse[];
  /** Successful Write / Edit / MultiEdit / NotebookEdit calls. */
  fileWrites: number;
}

/**
 * A file the run changed. Paths only, never contents.
 *   tool:     a Write / Edit / MultiEdit / NotebookEdit call that finished without failing (absolute path as given)
 *   worktree: listed by the Huddle's git summary of a managed run's worktree (path relative to the worktree)
 */
export interface ReportFile {
  path: string;
  source: 'tool' | 'worktree';
  /** Agents that wrote it (tool source); empty for worktree entries. */
  agentKeys: AgentKey[];
  /** Tools used on it (tool source), sorted. */
  tools: string[];
  /** Successful writes (tool source); 0 for worktree entries. */
  writes: number;
  /** Git status (worktree source); null for tool entries. */
  worktreeStatus: WorktreeFileStatus | null;
}

export interface ReportWorktree {
  path: string | null;
  branch: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  untracked: number;
  /** How many of the changed files are listed (the summary event keeps at most MAX_WORKTREE_FILES). */
  listed: number;
  closed: 'kept' | 'discarded' | null;
}

export interface ReportFailure {
  ts: number;
  /**
   * The failing event's position in the session's stored log: the index `history.stateAt` and the replay markers use
   * (M5 WP7). Null when the event is not in this session's log (a run event stored under another session).
   */
  index: number | null;
  agentKey: AgentKey;
  /** tool: a tool call failed. turn: the agent's turn failed. run: a managed run's process failed or never started. */
  kind: 'tool' | 'turn' | 'run';
  toolName: string | null;
  /** Clipped to CLIP_LIMITS.error; null when the event carried none. */
  error: string | null;
  /** A tool call the user interrupted. */
  interrupted: boolean;
}

export interface ReportApproval {
  ts: number;
  /** The `approval.requested` event's position in the session's stored log (as `ReportFailure.index`); null when unknown. */
  index: number | null;
  requestId: string;
  agentKey: AgentKey;
  toolName: string;
  /** One line: the command, path or URL. Clipped to CLIP_LIMITS.summary. Never the tool input. */
  summary: string;
  outcome: ApprovalResolved['outcome'] | null;
  by: ApprovalResolved['by'] | null;
  policyRuleId: string | null;
  resolvedAt: number | null;
}

export interface ReportSummary {
  /** Session title (SessionStart), clipped. Null when none. */
  title: string | null;
  /** First line of the last prompt the user typed, clipped. Agent-adjacent text: render as text. */
  topic: string | null;
  cwd: string | null;
  model: string | null;
  origin: AgentOrigin;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  outcome: RunOutcome;
  /** SessionEnd reason, clipped. Null when the session has no end in the log. */
  endReason: string | null;
  agents: number;
  toolCalls: number;
  toolFailures: number;
  tasksCompleted: number;
  approvalsRequested: number;
  stuckIncidents: number;
  /** Sum over agents that have usage. Null when no agent has any. */
  tokens: TokenCounts | null;
  /** Some agent has no usage record, so `tokens` is a lower bound. */
  tokensPartial: boolean;
  /** Hidden helper and compaction requests (session title, prompt suggestion, compact), not part of `tokens`. */
  helperTokens: TokenCounts | null;
  /** Estimate (ADR-013), agents plus helper requests. Null when nothing was recorded. */
  estimatedCostUsd: number | null;
  costPartial: boolean;
}

export interface RunReport {
  version: 1;
  sessionId: string;
  summary: ReportSummary;
  /** In start order. */
  agents: ReportAgent[];
  /** Sorted by source, then path. */
  filesChanged: ReportFile[];
  worktree: ReportWorktree | null;
  /** In log order. */
  failures: ReportFailure[];
  /** In request order. */
  approvals: ReportApproval[];
}

// ---------------------------------------------------------------------------
// Scorecards (F24)
// ---------------------------------------------------------------------------

/**
 * Aggregate of agent runs with the same role and model.
 *
 * A "unit" of work is what the ETA selector paces by (`ProgressOptions.priorUnitMs`): a task when the agent kept a task
 * list, else the whole run (one subagent is one unit of its parent's work). A completed run with k completed tasks is
 * k units taking `durationMs / k` each; a completed run without tasks is one unit taking `durationMs`.
 */
export interface Scorecard {
  role: string;
  model: string | null;
  runs: number;
  /** Real tasks completed (task lists only). */
  tasksCompleted: number;
  /** Units of work in completed runs with a known duration (see above). */
  units: number;
  /** Median over completed runs of the time per unit, ms. Null when no completed run has a duration. */
  medianTaskMs: number | null;
  /** Completed runs that gave `medianTaskMs` (its sample size). */
  sampleSize: number;
  /** (input + output) tokens per unit, over completed runs with known tokens. Null when there are none. */
  tokensPerTask: number | null;
  /** Completed runs that gave `tokensPerTask`; runs with unknown tokens are left out, not counted as 0. */
  tokenSampleSize: number;
  /** Failed runs / runs with a known outcome. Null when no run has a known outcome. */
  failureRate: number | null;
  /** Failed tool calls / tool calls. Null when there were no tool calls. */
  toolFailureRate: number | null;
  approvalsRequested: number;
  stuckIncidents: number;
  firstRunAt: number;
  lastRunAt: number;
}

/**
 * Fewest completed runs before a scorecard's `medianTaskMs` is offered to the ETA as a prior. With one or two runs the
 * "median" is a single duration or the mean of two, so one outlier sets it outright; three is the smallest sample where
 * the median ignores one outlier. The ETA already shrinks the prior toward what it observes (PRIOR_STRENGTH = 2
 * pseudo-observations), so a prior from three runs is a starting point, not a verdict.
 */
export const MIN_PRIOR_SAMPLES = 3;

/** Input plus output tokens: what tokens-per-task counts (cache reads would dwarf the work itself). */
export function workTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output;
}

/**
 * The prior for `selectProgress(..., { priorUnitMs })`: typical ms per unit of work for this role on this model, or null
 * when there is none. None means any of:
 *  - the model is unknown (`null`): a "model unknown" row mixes whatever models those runs really used, so its median
 *    describes no model the ETA could be pacing;
 *  - there is no scorecard for exactly that pair (the first card of a pair is the one used);
 *  - it rests on fewer than MIN_PRIOR_SAMPLES completed runs;
 *  - its median is not a finite time above 0 ms (no unit of work takes no time; a 0 ms median comes from runs that did
 *    nothing and would make the ETA say "done now").
 * The scorecards view's "Used for estimates" reads this function, so it says "no" in exactly these cases.
 */
export function priorUnitMsFor(scorecards: readonly Scorecard[], role: string, model: string | null): number | null {
  if (model === null) return null;
  const card = scorecards.find((c) => c.role === role && c.model === model);
  if (card === undefined || card.sampleSize < MIN_PRIOR_SAMPLES) return null;
  const ms = card.medianTaskMs;
  return ms !== null && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * `HuddleState.priors` from scorecards: `priorUnitMsFor` for every (role, model) pair that has one, keyed by
 * `priorKey`. The first card of a pair wins, as in `priorUnitMsFor`. `asOf` is when the scorecards were computed
 * (passed in, never read from a clock).
 */
export function etaPriorsFrom(scorecards: readonly Scorecard[], asOf: number): EtaPriors {
  const byRoleModel: Record<string, number> = {};
  for (const card of scorecards) {
    const key = priorKey(card.role, card.model);
    if (Object.hasOwn(byRoleModel, key)) continue;
    const ms = priorUnitMsFor(scorecards, card.role, card.model);
    if (ms !== null) byRoleModel[key] = ms;
  }
  return { byRoleModel, asOf };
}
