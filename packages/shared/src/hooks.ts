/**
 * Raw Claude Code hook payloads (INPUT) and the decision bodies the Huddle may answer with (OUTPUT).
 *
 * Source: https://code.claude.com/docs/en/hooks  (checked 2026-11-13; see docs/INTEGRATION.md)
 *
 * Rules for this file
 *  - These types describe what Claude Code sends. They are not validation. Parse with a runtime
 *    schema at the HTTP boundary and keep unknown fields: Claude Code adds fields between versions.
 *  - Everything except `session_id` and `hook_event_name` is optional on purpose.
 *  - Nothing outside packages/core/src/ingest may import from this file. The rest of the app
 *    only sees normalized HuddleEvents (events.ts).
 */

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Events the Huddle registers for. Keep in sync with scripts/install-hooks.mjs. */
export const INGESTED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
  'InstructionsLoaded',
  'SessionEnd',
] as const;

export type IngestedHookEvent = (typeof INGESTED_HOOK_EVENTS)[number];

/** Fields every hook receives. */
export interface HookBase<E extends IngestedHookEvent> {
  hook_event_name: E;
  session_id: string;
  /** May lag behind the in-memory conversation. Do not parse it as a primary data source. */
  transcript_path?: string;
  cwd?: string;
  /** Links all events of one user prompt. Matches the OpenTelemetry `prompt.id` attribute. */
  prompt_id?: string;
  permission_mode?: PermissionMode;
  effort?: { level: EffortLevel };
  /** Present only when the event fires inside a subagent or in-process teammate. */
  agent_id?: string;
  /** Agent name such as "Explore". Present with `--agent` or inside a subagent. */
  agent_type?: string;
  /**
   * The session's scratchpad folder (seen on most events in run-checked logs, 2026-11-13, Claude Code 2.1.323).
   * A local path: never shown to other machines, and not needed by the Huddle today.
   */
  scratchpad_dir?: string;
}

export interface SessionStartHook extends HookBase<'SessionStart'> {
  source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
  /** May be omitted. */
  model?: string;
  session_title?: string;
  /** Only on resume or fork of a transcript that already has a response. */
  context_tokens?: number;
}

export interface UserPromptSubmitHook extends HookBase<'UserPromptSubmit'> {
  prompt?: string;
  session_title?: string;
}

export interface ToolHookFields {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  mcp_server?: { name: string; source: string };
}

export interface PreToolUseHook extends HookBase<'PreToolUse'>, ToolHookFields {}

export interface PostToolUseHook extends HookBase<'PostToolUse'>, ToolHookFields {
  /** Can be very large (file contents, command output). Never store it untruncated. */
  tool_response?: unknown;
  duration_ms?: number;
}

export interface PostToolUseFailureHook extends HookBase<'PostToolUseFailure'>, ToolHookFields {
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

/** A ready-made permission rule Claude Code proposes, to echo back for "allow and remember". */
export interface PermissionSuggestion {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: 'allow' | 'deny' | 'ask';
  destination?: string;
  [key: string]: unknown;
}

/** Note: no tool_use_id on this event. */
export interface PermissionRequestHook extends HookBase<'PermissionRequest'> {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  permission_suggestions?: PermissionSuggestion[];
  mcp_server?: { name: string; source: string };
}

/** Fires only in auto mode. */
export interface PermissionDeniedHook extends HookBase<'PermissionDenied'>, ToolHookFields {
  reason?: string;
}

export interface NotificationHook extends HookBase<'Notification'> {
  message?: string;
  title?: string;
  /** For example permission_prompt, idle_prompt, agent_needs_input, agent_completed. */
  notification_type?: string;
}

/** `agent_id` and `agent_type` here describe the subagent that is starting. */
export interface SubagentStartHook extends HookBase<'SubagentStart'> {
  agent_id: string;
}

export interface SubagentStopHook extends HookBase<'SubagentStop'> {
  agent_id: string;
  stop_hook_active?: boolean;
  /** The subagent's own transcript, in a `subagents/` folder next to the session transcript. */
  agent_transcript_path?: string;
  /** The subagent's final answer: the "result" half of a handoff. */
  last_assistant_message?: string;
  /**
   * Run-checked: the same session-wide list as on Stop (it can include the stopping subagent itself).
   * Items look like `{id, type: "subagent", status, description, agent_type}`.
   */
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

export interface TaskHookFields {
  task_id: string;
  task_subject?: string;
  task_description?: string;
  teammate_name?: string;
  /** Docs-checked only (2026-11-16): TaskCreated/TaskCompleted were not seen in spike S20. Deprecated in the docs. */
  team_name?: string;
}
export interface TaskCreatedHook extends HookBase<'TaskCreated'>, TaskHookFields {}
export interface TaskCompletedHook extends HookBase<'TaskCompleted'>, TaskHookFields {}

export interface StopHook extends HookBase<'Stop'> {
  /** True when Claude Code is already continuing because of a stop hook. Check it to avoid loops. */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

export interface StopFailureHook extends HookBase<'StopFailure'> {
  [key: string]: unknown;
}

/**
 * Run-checked (S20, 2.1.325, interactive in-process team): carries `teammate_name`, `team_name`
 * (`session-<first 8 of the lead's session id>`), and the teammate's `agent_id` / `agent_type` (its `agent_type` is its
 * name). Follows the teammate's SubagentStop by about 20 ms. A teammate shares the lead's `session_id`.
 */
export interface TeammateIdleHook extends HookBase<'TeammateIdle'> {
  teammate_name?: string;
  /** Deprecated in the docs; S20 saw it on every TeammateIdle. */
  team_name?: string;
}

export interface CompactHook<E extends 'PreCompact' | 'PostCompact'> extends HookBase<E> {
  trigger?: 'manual' | 'auto';
  custom_instructions?: string | null;
  /** PostCompact only (run-checked). Free text: clip it, never store it whole. */
  compact_summary?: string;
}

export interface PostModelSwitchHook extends HookBase<'PostModelSwitch'> {
  from_model?: string;
  to_model?: string;
  source?: string;
  context_tokens?: number;
}

/** Fields run-checked 2026-11-13 (Claude Code 2.1.323); the index signature keeps the event open for more. */
export interface InstructionsLoadedHook extends HookBase<'InstructionsLoaded'> {
  file_path?: string;
  memory_type?: string;
  load_reason?: string;
  globs?: string[];
  trigger_file_path?: string;
  [key: string]: unknown;
}

export interface SessionEndHook extends HookBase<'SessionEnd'> {
  reason?: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | (string & {});
}

export type HookPayload =
  | SessionStartHook
  | UserPromptSubmitHook
  | PreToolUseHook
  | PostToolUseHook
  | PostToolUseFailureHook
  | PermissionRequestHook
  | PermissionDeniedHook
  | NotificationHook
  | SubagentStartHook
  | SubagentStopHook
  | TaskCreatedHook
  | TaskCompletedHook
  | StopHook
  | StopFailureHook
  | TeammateIdleHook
  | CompactHook<'PreCompact'>
  | CompactHook<'PostCompact'>
  | PostModelSwitchHook
  | InstructionsLoadedHook
  | SessionEndHook;

// ---------------------------------------------------------------------------
// OUTPUT: bodies an HTTP hook may return with a 2xx status.
// An empty 2xx body means "no decision": Claude Code continues as if the hook did not exist.
// ---------------------------------------------------------------------------

/** Answer to PermissionRequest. This is how the Huddle approves or denies for attached sessions. */
export interface PermissionRequestOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision:
      | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionSuggestion[] }
      | { behavior: 'deny'; message?: string; interrupt?: boolean };
  };
}

/**
 * Answer to PreToolUse. Used by the policy engine (auto-approve rules) and to attach a nudge.
 * Deny and ask rules in the user's Claude Code settings still win over an "allow" from a hook.
 */
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    /** Text added to the agent's context. The Huddle uses it to deliver a queued nudge mid-run. */
    additionalContext?: string;
  };
}

/** Answer to Stop or SubagentStop: keep the agent going, with `reason` as its next instruction. */
export interface StopOutput {
  decision: 'block';
  reason: string;
}

export type HookResponseBody = PermissionRequestOutput | PreToolUseOutput | StopOutput | null;
