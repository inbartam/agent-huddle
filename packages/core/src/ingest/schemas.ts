/**
 * Runtime schemas for Claude Code hook payloads (the HTTP boundary).
 *
 * They mirror the types in `@huddle/shared/hooks` and are deliberately loose:
 *  - Every object is a `z.looseObject`, so fields Claude Code adds later are kept, not rejected.
 *  - Only the fields hooks.ts marks as required are required: `session_id`, `hook_event_name`,
 *    `tool_name` on tool events, `agent_id` on SubagentStart/SubagentStop, `task_id` on task events.
 *  - Every optional field goes through `opt()`: when it is missing it stays missing, and when it has
 *    an unexpected type (or an enum value from a newer Claude Code) it is dropped, so the event still
 *    parses and the value is treated as unknown downstream.
 *  - `tool_response` is removed before zod sees the body, for every event, so a huge response is never
 *    walked and can never reach an event. From `PostToolUse(Agent)` only the four link fields are read.
 *
 * Nothing outside ingest/ and normalize/ may import this module's payload types.
 */
import { z } from 'zod';
import { INGESTED_HOOK_EVENTS } from '@huddle/shared/hooks';
import { isIngestSessionId } from '../store/jsonl-store.js';
import type {
  CompactHook,
  IngestedHookEvent,
  InstructionsLoadedHook,
  NotificationHook,
  PermissionDeniedHook,
  PermissionRequestHook,
  PostModelSwitchHook,
  PostToolUseFailureHook,
  PostToolUseHook,
  PreToolUseHook,
  SessionEndHook,
  SessionStartHook,
  StopFailureHook,
  StopHook,
  SubagentStartHook,
  SubagentStopHook,
  TaskCompletedHook,
  TaskCreatedHook,
  TeammateIdleHook,
  UserPromptSubmitHook,
} from '@huddle/shared/hooks';

/** Optional field: absent stays absent; a value of the wrong type is dropped instead of failing the event. */
function opt<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const permissionMode = z.enum(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/** Fields every hook receives (hooks.ts `HookBase`). Only session_id is required besides the event name. */
const baseShape = {
  /** The store's rule (`isIngestSessionId`): an id it would refuse, or one of the Huddle's own sessions, never builds live state. */
  session_id: z.string().max(128).refine(isIngestSessionId, { message: 'invalid session id' }),
  transcript_path: opt(z.string()),
  cwd: opt(z.string()),
  /** Absent before the first prompt of a session (INTEGRATION.md "Fields on every event"). */
  prompt_id: opt(z.string()),
  /** Absent on SessionStart, SubagentStart, InstructionsLoaded, compaction and SessionEnd in fixtures. */
  permission_mode: opt(permissionMode),
  effort: opt(z.looseObject({ level: effortLevel })),
  /** Only when the event fires inside a subagent (or, on Subagent*, the subagent itself). */
  agent_id: opt(z.string()),
  /** May be an empty string: the hidden-helper / compaction SubagentStop (compaction.jsonl). */
  agent_type: opt(z.string()),
};

// E is used only in the parameter, but it is what keeps `z.literal(event)` typed as the event literal.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function hookSchema<E extends IngestedHookEvent, S extends z.ZodRawShape>(event: E, shape: S) {
  // `.extend` (not an object spread) so a required field in `shape` replaces the optional base one
  // in the inferred type too, e.g. `agent_id` on SubagentStart.
  return z
    .looseObject(baseShape)
    .extend({ hook_event_name: z.literal(event) })
    .extend(shape);
}

const mcpServer = z.looseObject({ name: z.string(), source: z.string() });

const toolShape = {
  tool_name: z.string(),
  tool_input: opt(z.record(z.string(), z.unknown())),
  tool_use_id: opt(z.string()),
  mcp_server: opt(mcpServer),
};

const permissionSuggestion = z.looseObject({
  type: z.string(),
  rules: opt(z.array(z.looseObject({ toolName: z.string(), ruleContent: opt(z.string()) }))),
  behavior: opt(z.enum(['allow', 'deny', 'ask'])),
  destination: opt(z.string()),
});

const taskShape = {
  task_id: z.string(),
  task_subject: opt(z.string()),
  task_description: opt(z.string()),
  teammate_name: opt(z.string()),
  /** Docs-checked only: task hooks were not seen in spike S20. */
  team_name: opt(z.string()),
};

/** Items of Stop/SubagentStop `background_tasks`: `{id, type, status, description, agent_type}` (INTEGRATION.md). */
const backgroundTask = z.looseObject({
  id: opt(z.string()),
  type: opt(z.string()),
  status: opt(z.string()),
  description: opt(z.string()),
  agent_type: opt(z.string()),
});

const compactShape = {
  trigger: opt(z.enum(['manual', 'auto'])),
  custom_instructions: opt(z.string().nullable()),
  /** PostCompact only. Free text: clip it, never store it whole (INTEGRATION.md). */
  compact_summary: opt(z.string()),
};

export const SessionStartSchema = hookSchema('SessionStart', {
  source: opt(z.enum(['startup', 'resume', 'clear', 'compact', 'fork'])),
  model: opt(z.string()),
  session_title: opt(z.string()),
  context_tokens: opt(z.number()),
});
export const UserPromptSubmitSchema = hookSchema('UserPromptSubmit', {
  prompt: opt(z.string()),
  session_title: opt(z.string()),
});
export const PreToolUseSchema = hookSchema('PreToolUse', toolShape);
/** `tool_response` is intentionally absent: parseHookPayload removes it before parsing. */
export const PostToolUseSchema = hookSchema('PostToolUse', { ...toolShape, duration_ms: opt(z.number()) });
export const PostToolUseFailureSchema = hookSchema('PostToolUseFailure', {
  ...toolShape,
  error: opt(z.string()),
  is_interrupt: opt(z.boolean()),
  duration_ms: opt(z.number()),
});
/** No tool_use_id on this event (hooks.ts). */
export const PermissionRequestSchema = hookSchema('PermissionRequest', {
  tool_name: z.string(),
  tool_input: opt(z.record(z.string(), z.unknown())),
  permission_suggestions: opt(z.array(permissionSuggestion)),
  mcp_server: opt(mcpServer),
});
export const PermissionDeniedSchema = hookSchema('PermissionDenied', { ...toolShape, reason: opt(z.string()) });
export const NotificationSchema = hookSchema('Notification', {
  message: opt(z.string()),
  title: opt(z.string()),
  notification_type: opt(z.string()),
});
export const SubagentStartSchema = hookSchema('SubagentStart', { agent_id: z.string() });
export const SubagentStopSchema = hookSchema('SubagentStop', {
  agent_id: z.string(),
  stop_hook_active: opt(z.boolean()),
  agent_transcript_path: opt(z.string()),
  last_assistant_message: opt(z.string()),
  /** Seen on SubagentStop in fixtures too (run-checked; hooks.ts SubagentStopHook). */
  background_tasks: opt(z.array(backgroundTask)),
  session_crons: opt(z.array(z.unknown())),
});
export const TaskCreatedSchema = hookSchema('TaskCreated', taskShape);
export const TaskCompletedSchema = hookSchema('TaskCompleted', taskShape);
export const StopSchema = hookSchema('Stop', {
  stop_hook_active: opt(z.boolean()),
  last_assistant_message: opt(z.string()),
  background_tasks: opt(z.array(backgroundTask)),
  session_crons: opt(z.array(z.unknown())),
});
/** Fields not yet confirmed (INTEGRATION.md): base only, everything else passes through. */
export const StopFailureSchema = hookSchema('StopFailure', {});
/** Run-checked in S20: teammate_name, team_name, and the teammate's agent_id / agent_type in the base fields. */
export const TeammateIdleSchema = hookSchema('TeammateIdle', {
  teammate_name: opt(z.string()),
  team_name: opt(z.string()),
});
export const PreCompactSchema = hookSchema('PreCompact', compactShape);
export const PostCompactSchema = hookSchema('PostCompact', compactShape);
export const PostModelSwitchSchema = hookSchema('PostModelSwitch', {
  from_model: opt(z.string()),
  to_model: opt(z.string()),
  source: opt(z.string()),
  context_tokens: opt(z.number()),
});
/** Field list from INTEGRATION.md and fixtures (hooks.ts InstructionsLoadedHook, still open with an index signature). */
export const InstructionsLoadedSchema = hookSchema('InstructionsLoaded', {
  file_path: opt(z.string()),
  memory_type: opt(z.string()),
  load_reason: opt(z.string()),
  globs: opt(z.array(z.string())),
  trigger_file_path: opt(z.string()),
});
/** `reason` stays an open string, as in hooks.ts. */
export const SessionEndSchema = hookSchema('SessionEnd', { reason: opt(z.string()) });

/**
 * A Subagent* event with an empty `agent_id` would get the root key (`agentKey(sid, '')`) and end or start the main
 * agent (A1-02). It is accepted (a 400 shows up as a hook error in Claude Code) but becomes the hidden-helper
 * signature, an empty `agent_type`, which the normalizer and hookFacts already ignore.
 */
function dropEmptySubagentId<
  T extends { hook_event_name: string; agent_id?: string | undefined; agent_type?: string | undefined },
>(payload: T): T {
  const subagentEvent = payload.hook_event_name === 'SubagentStart' || payload.hook_event_name === 'SubagentStop';
  return subagentEvent && payload.agent_id === '' ? { ...payload, agent_type: '' } : payload;
}

/** One schema per ingested hook event, discriminated by `hook_event_name`. */
export const KnownHookPayloadSchema = z
  .discriminatedUnion('hook_event_name', [
    SessionStartSchema,
    UserPromptSubmitSchema,
    PreToolUseSchema,
    PostToolUseSchema,
    PostToolUseFailureSchema,
    PermissionRequestSchema,
    PermissionDeniedSchema,
    NotificationSchema,
    SubagentStartSchema,
    SubagentStopSchema,
    TaskCreatedSchema,
    TaskCompletedSchema,
    StopSchema,
    StopFailureSchema,
    TeammateIdleSchema,
    PreCompactSchema,
    PostCompactSchema,
    PostModelSwitchSchema,
    InstructionsLoadedSchema,
    SessionEndSchema,
  ])
  .transform(dropEmptySubagentId);

/** An event name the Huddle does not know yet: base fields only, everything else passes through. */
export const UnknownHookPayloadSchema = z.looseObject({ ...baseShape, hook_event_name: z.string() });

export type KnownHookPayload = z.infer<typeof KnownHookPayloadSchema>;
export type UnknownHookPayload = z.infer<typeof UnknownHookPayloadSchema>;

/** The parsed payload for one event name. */
export type ParsedHook<E extends IngestedHookEvent> = Extract<KnownHookPayload, { hook_event_name: E }>;

// Compile-time drift guard: each parsed payload must still satisfy the hooks.ts type it mirrors.
// If hooks.ts gains a required field or narrows a type, this stops compiling.
interface HooksTsByEvent {
  SessionStart: SessionStartHook;
  UserPromptSubmit: UserPromptSubmitHook;
  PreToolUse: PreToolUseHook;
  PostToolUse: PostToolUseHook;
  PostToolUseFailure: PostToolUseFailureHook;
  PermissionRequest: PermissionRequestHook;
  PermissionDenied: PermissionDeniedHook;
  Notification: NotificationHook;
  SubagentStart: SubagentStartHook;
  SubagentStop: SubagentStopHook;
  TaskCreated: TaskCreatedHook;
  TaskCompleted: TaskCompletedHook;
  Stop: StopHook;
  StopFailure: StopFailureHook;
  TeammateIdle: TeammateIdleHook;
  PreCompact: CompactHook<'PreCompact'>;
  PostCompact: CompactHook<'PostCompact'>;
  PostModelSwitch: PostModelSwitchHook;
  InstructionsLoaded: InstructionsLoadedHook;
  SessionEnd: SessionEndHook;
}
type MirrorsHooksTs = { [E in IngestedHookEvent]: ParsedHook<E> extends HooksTsByEvent[E] ? true : E };
/** Fails to compile (names the offending event) unless every parsed payload mirrors its hooks.ts type. */
type AssertAllTrue<T extends true> = T;
export type _HooksTsDriftGuard = AssertAllTrue<MirrorsHooksTs[IngestedHookEvent]>;

/** The link between an Agent tool call and the subagent it started, from `PostToolUse(Agent).tool_response`. */
export interface AgentLink {
  /** The subagent's `agent_id` (matches SubagentStart/SubagentStop). */
  agentId: string;
  /** True for a background (async) launch; absent on foreground calls. */
  isAsync?: boolean;
  /** For example `async_launched` or `completed`. */
  status?: string;
  /** The model the subagent actually ran on. */
  resolvedModel?: string;
}

export type ParseHookResult =
  | { ok: true; known: true; payload: KnownHookPayload; agentLink?: AgentLink }
  | { ok: true; known: false; payload: UnknownHookPayload }
  | { ok: false; error: string };

/** Ids and model names are short. Anything longer is not what we expect, so it is ignored. */
const MAX_LINK_FIELD_LENGTH = 256;

const knownEvents: ReadonlySet<string> = new Set(INGESTED_HOOK_EVENTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LINK_FIELD_LENGTH ? value : undefined;
}

/** Reads exactly four fields from an Agent tool_response, checking each type. Never walks the rest. */
function extractAgentLink(response: unknown): AgentLink | undefined {
  if (!isRecord(response)) return undefined;
  const agentId = shortString(response.agentId);
  if (agentId === undefined) return undefined;
  const link: AgentLink = { agentId };
  const isAsync = response.isAsync;
  if (typeof isAsync === 'boolean') link.isAsync = isAsync;
  const status = shortString(response.status);
  if (status !== undefined) link.status = status;
  const resolvedModel = shortString(response.resolvedModel);
  if (resolvedModel !== undefined) link.resolvedModel = resolvedModel;
  return link;
}

/** Error text built from issue paths and codes only, so no body value can leak into logs. */
function describeIssues(event: string, error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`)
    .join('; ');
  return `invalid ${event} payload: ${issues}`;
}

/**
 * Validates one hook body. Never throws and never mutates `body`.
 *
 * - Known event: `{ok: true, known: true, payload}`, plus `agentLink` for `PostToolUse(Agent)`.
 * - Unknown event name: `{ok: true, known: false, payload}` with the base fields.
 * - Anything else: `{ok: false, error}`. The error never contains values from the body.
 */
export function parseHookPayload(body: unknown): ParseHookResult {
  try {
    if (!isRecord(body)) return { ok: false, error: 'body is not a JSON object' };
    const eventName = body.hook_event_name;
    if (typeof eventName !== 'string') return { ok: false, error: 'hook_event_name is missing or not a string' };

    // Shallow copy without tool_response: zod never sees it, and the input is left untouched.
    const { tool_response: toolResponse, ...rest } = body;

    if (!knownEvents.has(eventName)) {
      const parsed = UnknownHookPayloadSchema.safeParse(rest);
      return parsed.success
        ? { ok: true, known: false, payload: parsed.data }
        : { ok: false, error: describeIssues('unknown-event', parsed.error) };
    }

    const parsed = KnownHookPayloadSchema.safeParse(rest);
    if (!parsed.success) return { ok: false, error: describeIssues(eventName, parsed.error) };

    const payload = parsed.data;
    if (
      (payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'PostToolUseFailure') &&
      payload.tool_name === 'Agent'
    ) {
      const agentLink = extractAgentLink(toolResponse);
      if (agentLink !== undefined) return { ok: true, known: true, payload, agentLink };
    }
    return { ok: true, known: true, payload };
  } catch {
    // Defensive: a hostile object (getters, proxies) must not crash ingest.
    return { ok: false, error: 'payload could not be read' };
  }
}
