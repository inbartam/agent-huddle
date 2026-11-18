/**
 * Hook normalizer: one parsed Claude Code hook payload -> zero or more HuddleEvents.
 *
 * Pure and stateless: no clock, no randomness, no I/O, no module-level state. The ingest edge passes the
 * receive time and an id source in `ctx`. "Was this agent ever seen?" is the reducer's question, not
 * this module's, so the same payload always gives the same events (given the same ctx).
 *
 * Privacy: `tool_response` is already removed by `parseHookPayload`; only the four Agent link fields
 * arrive here (as `agentLink`). File contents (`content`, `new_string`, `old_string`, ...) never enter
 * an event. Every free-text field is masked (`maskSecrets`) and clipped with CLIP_LIMITS; identifiers are clipped to
 * CLIP_LIMITS.id and paths to CLIP_LIMITS.path, so an oversized payload cannot bloat the log.
 *
 * Mapping (see docs/ARCHITECTURE.md §4, ADR-012, ADR-015):
 *   SessionStart        session.started (+ model.observed via session_start when `model` is present)
 *   UserPromptSubmit    prompt.submitted with kind (+ agent.linked from a <task-notification> with both ids)
 *   PreToolUse          tool.started (+ agent.spawn_requested for the Agent tool, with its name when given (M6),
 *                       + question.asked for AskUserQuestion with a valid tool_input and a tool_use_id;
 *                       expiresAt = receive time + ctx.holdTimeouts.PreToolUse, else null)
 *   PostToolUse         tool.finished (+ agent.linked and model.observed via agent_call for Agent with a link,
 *                       + task.started for TaskUpdate with tool_input.status 'in_progress' and a task id; S4b,
 *                       + progress.reported for mcp__huddle__report_progress with a usable tool_input; F27, S19,
 *                       + teammate.reported for mcp__huddle__report_teammate with a usable tool_input; M6 P5b)
 *   PostToolUseFailure  tool.failed (+ the same Agent link events when Claude Code still returned an agentId)
 *   PermissionRequest   approval.requested (sanitized tool input; requestId from ctx.nextId;
 *                       expiresAt = receive time + ctx.holdTimeouts.PermissionRequest, else null);
 *                       nothing for AskUserQuestion (Claude Code's own question box, not an approval)
 *   PermissionDenied    tool.failed (auto mode denial)
 *   Notification        notification.raised
 *   SubagentStart       agent.started (parent is provisional: the main agent; nothing for an empty agent_type;
 *                       teammateName for an agent-team teammate, see teammateNameOf; S20, M6)
 *   SubagentStop        turn.ended + agent.stopped (nothing for an empty agent_type: hidden helper / compaction)
 *   TaskCreated/Completed task.created / task.completed
 *   Stop                turn.ended with backgroundAgentIds
 *   StopFailure         turn.failed (error null: fields not confirmed)
 *   PreCompact/PostCompact context.compacted before/after
 *   PostModelSwitch     model.changed + model.observed via switch
 *   InstructionsLoaded  instructions.loaded
 *   SessionEnd          session.ended
 *   TeammateIdle        teammate.idle (S20, M6; nothing without a teammate name)
 *   unknown events      nothing
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentKey, CLIP_LIMITS } from '@huddle/shared';
import type {
  AgentKey,
  ApprovalRequest,
  AskQuestion,
  EventOfType,
  HuddleEvent,
  HuddleEventType,
  QuestionRequest,
} from '@huddle/shared';
import type { AgentLink, KnownHookPayload, ParseHookResult } from '../ingest/schemas.js';
import { MASK_MARGIN, maskSecrets } from '../privacy/redact.js';
import { HUDDLE_PROGRESS_TOOL, HUDDLE_TEAMMATE_TOOL } from '../ingest/huddle-mcp.js';
import { progressReportSummary, readProgressReport, readTeammateReport, teammateReportSummary } from './self-report.js';
import { clip } from '../text.js';

/** What the ingest edge passes in: the receive time (ISO 8601) and a source of unique, sortable ids. */
export interface NormalizeHookContext {
  receivedAt: string;
  nextId: () => string;
  /**
   * Seconds Claude Code waits for a held hook response, per hook event name (the installed hook `timeout`),
   * e.g. `{ PreToolUse: 600, PermissionRequest: 600 }`. Fills `expiresAt` as receive time + timeout.
   * Absent (or absent for that event, or not a positive finite number): `expiresAt` is null (unknown), never 0.
   */
  holdTimeouts?: Readonly<Partial<Record<string, number>>>;
}

/** A successful parse result, for a known or an unknown hook event. */
export type NormalizableHook = Extract<ParseHookResult, { ok: true }>;

type Envelope = 'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source';
type Fields<T extends HuddleEventType> = Omit<EventOfType<T>, Envelope>;

/** Builds events for one payload. Ids are drawn in emission order, so output is deterministic. */
class Emitter {
  readonly events: HuddleEvent[] = [];
  constructor(
    private readonly ctx: NormalizeHookContext,
    readonly ts: number,
    readonly sessionId: string,
    /** False when receivedAt did not parse: ts is then a placeholder 0 and no deadline can be derived from it. */
    private readonly tsKnown: boolean,
  ) {}

  /** Epoch ms when a held response to `hookEvent` times out; null when the timeout or the receive time is unknown. */
  expiresAt(hookEvent: string): number | null {
    const seconds = this.ctx.holdTimeouts?.[hookEvent];
    if (!this.tsKnown || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
    return this.ts + seconds * 1000;
  }

  emit<T extends HuddleEventType>(type: T, key: AgentKey, fields: Fields<T>): void {
    const event = {
      id: this.ctx.nextId(),
      type,
      ts: this.ts,
      sessionId: this.sessionId,
      agentKey: key,
      source: 'hook',
      ...fields,
    } as EventOfType<T>;
    this.events.push(event);
  }

  nextId(): string {
    return this.ctx.nextId();
  }
}

/**
 * Turns one parsed hook payload into HuddleEvents. Never throws: on an unexpected failure it returns
 * what it has built so far (fail open; the hook has already been answered).
 */
export function normalizeHook(parsed: NormalizableHook, ctx: NormalizeHookContext): HuddleEvent[] {
  if (!parsed.known) return [];
  const parsedTs = Date.parse(ctx.receivedAt);
  // A bad receivedAt is an edge bug, not a reason to drop the event; 0 keeps ts a JSON-safe number.
  const tsKnown = Number.isFinite(parsedTs);
  const out = new Emitter(ctx, tsKnown ? parsedTs : 0, parsed.payload.session_id, tsKnown);
  try {
    normalizeKnown(parsed.payload, parsed.agentLink, out);
  } catch {
    // Defensive only: every branch below is total over the parsed shapes.
  }
  return out.events;
}

function normalizeKnown(p: KnownHookPayload, link: AgentLink | undefined, out: Emitter): void {
  const sid = p.session_id;
  // agent_id on most events means "inside this subagent"; on Subagent* it is the subagent itself.
  const key = agentKey(sid, idOrUndefined(p.agent_id));

  switch (p.hook_event_name) {
    case 'SessionStart': {
      out.emit('session.started', key, {
        // The normalizer only sees hooks; a Huddle-launched (managed) session is marked by the launcher.
        origin: 'attached',
        cwd: pathOrNull(p.cwd),
        title: textOrNull(p.session_title, CLIP_LIMITS.summary),
        model: idOrNull(p.model),
        // Assumption: an absent source is a fresh start ('first_seen' is for sessions seen mid-run).
        startKind: p.source ?? 'startup',
      });
      if (p.model !== undefined) out.emit('model.observed', key, { model: id(p.model), via: 'session_start' });
      return;
    }

    case 'UserPromptSubmit': {
      const prompt = p.prompt ?? '';
      const kind = promptKind(prompt);
      const cwd = pathOrNull(p.cwd);
      out.emit('prompt.submitted', key, {
        text: text(prompt, CLIP_LIMITS.prompt),
        promptId: idOrNull(p.prompt_id),
        kind,
        // A session seen mid-run had no SessionStart: its folder comes from here (see events.ts).
        ...(cwd !== null && cwd !== '' ? { cwd } : {}),
      });
      if (kind === 'task_notification') {
        // Second exact link source (S2 addendum): <task-id> is the child's agentId, <tool-use-id> the Agent call.
        const ids = taskNotificationIds(prompt);
        if (ids !== null) {
          out.emit('agent.linked', agentKey(sid, ids.agentId), {
            toolUseId: ids.toolUseId,
            childAgentId: ids.agentId,
            parentKey: key,
            link: 'exact',
          });
        }
      }
      return;
    }

    case 'PreToolUse': {
      const input = p.tool_input ?? {};
      out.emit('tool.started', key, {
        toolUseId: idOrNull(p.tool_use_id),
        toolName: id(p.tool_name),
        summary: toolSummary(p.tool_name, input),
        filePath: toolFilePath(p.tool_name, input),
        inputDigest: inputDigest(p.tool_name, input),
      });
      if (p.tool_name === 'Agent') {
        const spawnName = nonEmpty(str(input.name));
        out.emit('agent.spawn_requested', key, {
          toolUseId: idOrNull(p.tool_use_id),
          role: idOrNull(str(input.subagent_type)),
          title: textOrNull(str(input.description), CLIP_LIMITS.summary),
          brief: textOrNull(str(input.prompt), CLIP_LIMITS.brief),
          model: idOrNull(str(input.model)),
          // A named Agent call starts a teammate in an interactive agent-team session (S20).
          ...(spawnName !== undefined ? { name: id(spawnName) } : {}),
        });
      }
      if (p.tool_name === 'AskUserQuestion') {
        const request = questionRequest(p.tool_use_id, input, key, out.ts, out.expiresAt('PreToolUse'));
        if (request !== null) out.emit('question.asked', key, { request });
      }
      return;
    }

    case 'PostToolUse': {
      out.emit('tool.finished', key, {
        toolUseId: idOrNull(p.tool_use_id),
        toolName: id(p.tool_name),
        durationMs: p.duration_ms ?? null,
      });
      if (p.tool_name === 'Agent') emitAgentLink(link, p.tool_use_id, key, out);
      if (p.tool_name === 'TaskUpdate') {
        // PostToolUse, not PreToolUse: it fires only when the update succeeded. Reads tool_input only.
        const taskId = startedTaskId(p.tool_input ?? {});
        if (taskId !== null) out.emit('task.started', key, { taskId });
      }
      if (p.tool_name === HUDDLE_PROGRESS_TOOL) {
        // F27 (S19): the report is the call's tool_input, on the calling agent's key (agent_id present = a subagent,
        // reporting its own task). PostToolUse: the call went through (a denied call has none). Exact name only.
        const report = readProgressReport(p.tool_input ?? {});
        if (report !== null) out.emit('progress.reported', key, report);
      }
      if (p.tool_name === HUDDLE_TEAMMATE_TOOL) {
        // M6 P5b (ADR-027): the lead's answer about an idle teammate, on the CALLER's key (the lead: no agent_id). The
        // teammate is named in tool_input; the reducer finds it in this session. Exact name only; tool_response unread.
        const report = readTeammateReport(p.tool_input ?? {});
        if (report !== null) out.emit('teammate.reported', key, report);
      }
      return;
    }

    case 'PostToolUseFailure': {
      out.emit('tool.failed', key, {
        toolUseId: idOrNull(p.tool_use_id),
        toolName: id(p.tool_name),
        // Unknown error text stays empty rather than invented.
        error: text(p.error ?? '', CLIP_LIMITS.error),
        interrupted: p.is_interrupt ?? false,
      });
      if (p.tool_name === 'Agent') emitAgentLink(link, p.tool_use_id, key, out);
      return;
    }

    case 'PermissionRequest': {
      // AskUserQuestion: Claude Code is about to show its own question box (2.1.325 sends this right after a held
      // question was passed to the terminal). The question already has its own events; this is not an approval.
      if (p.tool_name === 'AskUserQuestion') return;
      const input = p.tool_input ?? {};
      const shown = shownSummary(p.tool_name, input);
      const request: ApprovalRequest = {
        requestId: out.nextId(),
        agentKey: key,
        toolName: id(p.tool_name),
        toolInput: sanitizeToolInput(input),
        summary: shown.summary,
        receivedAt: out.ts,
        expiresAt: out.expiresAt('PermissionRequest'),
        channel: 'hook',
        // Only when set, so plain requests (and the fixture snapshots) are unchanged (AX-01).
        ...(shown.hidden ? { hidden: true } : {}),
      };
      out.emit('approval.requested', key, { request });
      return;
    }

    case 'PermissionDenied': {
      out.emit('tool.failed', key, {
        toolUseId: idOrNull(p.tool_use_id),
        toolName: id(p.tool_name),
        error: text(p.reason ?? 'permission denied', CLIP_LIMITS.error),
        interrupted: false,
      });
      return;
    }

    case 'Notification': {
      out.emit('notification.raised', key, {
        notificationType: idOrNull(p.notification_type),
        message: text(p.message ?? p.title ?? '', CLIP_LIMITS.message),
      });
      return;
    }

    case 'SubagentStart': {
      // An empty agent_type is the hidden-helper signature (INTEGRATION.md §0): never a tree node.
      if (p.agent_type === '') return;
      // A resumed subagent sends a second SubagentStart with the same agent_id. We emit the same event
      // again; the reducer reopens the existing node instead of adding one (S2 addendum). A teammate also sends one
      // each time it handles a new message.
      const mate = teammateNameOf(p.agent_id, p.agent_type);
      out.emit('agent.started', key, {
        agentId: id(p.agent_id),
        role: p.agent_type !== undefined ? id(p.agent_type) : 'unknown',
        // SubagentStart does not name its parent. This is a provisional placement under the main agent;
        // the reducer may refine it by order (heuristic) and agent.linked makes it exact (ADR-012).
        parentKey: agentKey(sid),
        ...(mate !== null ? { teammateName: id(mate) } : {}),
      });
      return;
    }

    case 'SubagentStop': {
      // Compaction and hidden helpers: SubagentStop with an empty agent_type and no SubagentStart.
      if (p.agent_type === '') return;
      const result = textOrNull(p.last_assistant_message, CLIP_LIMITS.result);
      out.emit('turn.ended', key, {
        lastMessage: result,
        // Session-wide list: it can include this subagent itself (run-checked). Not this agent's idle signal.
        backgroundAgentIds: backgroundAgentIds(p.background_tasks),
      });
      out.emit('agent.stopped', key, { agentId: id(p.agent_id), result });
      return;
    }

    case 'TaskCreated': {
      out.emit('task.created', key, {
        taskId: id(p.task_id),
        subject: text(p.task_subject ?? '', CLIP_LIMITS.summary),
        description: textOrNull(p.task_description, CLIP_LIMITS.description),
      });
      return;
    }

    case 'TaskCompleted': {
      out.emit('task.completed', key, { taskId: id(p.task_id) });
      return;
    }

    case 'Stop': {
      out.emit('turn.ended', key, {
        lastMessage: textOrNull(p.last_assistant_message, CLIP_LIMITS.result),
        backgroundAgentIds: backgroundAgentIds(p.background_tasks),
      });
      return;
    }

    case 'StopFailure': {
      // StopFailure's fields are not confirmed (INTEGRATION.md); do not guess an error field name.
      out.emit('turn.failed', key, { error: null });
      return;
    }

    case 'PreCompact':
    case 'PostCompact': {
      // compact_summary (PostCompact) is free text with no event field; it is not stored.
      out.emit('context.compacted', key, {
        phase: p.hook_event_name === 'PreCompact' ? 'before' : 'after',
        trigger: p.trigger ?? 'unknown',
      });
      return;
    }

    case 'PostModelSwitch': {
      if (p.to_model === undefined) return;
      // Both: model.changed is the timeline fact, model.observed{switch} is what model precedence reads.
      out.emit('model.changed', key, { from: idOrNull(p.from_model), to: id(p.to_model) });
      out.emit('model.observed', key, { model: id(p.to_model), via: 'switch' });
      return;
    }

    case 'InstructionsLoaded': {
      out.emit('instructions.loaded', key, { filePath: pathOrNull(p.file_path) });
      return;
    }

    case 'SessionEnd': {
      out.emit('session.ended', key, { reason: text(p.reason ?? 'unknown', CLIP_LIMITS.summary) });
      return;
    }

    case 'TeammateIdle': {
      // S20: teammate_name, team_name, agent_id and agent_type (= the name). agent_id is optional in the docs: without
      // it the key is the session root's and the reducer finds the teammate by name.
      const name = nonEmpty(p.teammate_name) ?? nonEmpty(p.agent_type);
      if (name === undefined) return;
      out.emit('teammate.idle', key, {
        agentId: idOrNull(nonEmpty(p.agent_id)),
        teammateName: id(name),
        teamName: idOrNull(nonEmpty(p.team_name)),
      });
      return;
    }
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** The 16-hex tail of a teammate's agent id, after `a<name>` (S20). */
const TEAMMATE_ID_TAIL = /^-[0-9a-f]{16}$/i;

/**
 * The teammate's name when a SubagentStart is an agent-team teammate, else null (S20, 2.1.325).
 *
 * Rule: the agent_id is exactly `a` + agent_type + `-` + 16 hex digits. A teammate's id is `a<name>-<16 hex>` and its
 * agent_type is its name; a plain subagent's id is `a<16 hex>` (no dash) and its agent_type a type such as
 * general-purpose. Tying the id to the agent_type (rather than matching any `a<word>-<hex>`) means a plain subagent
 * can only match if Claude Code changed its id format to embed the type, and an empty agent_type (hidden helpers)
 * never matches. TeammateIdle is the second, independent signal: the reducer marks a node a teammate on that too.
 */
export function teammateNameOf(agentId: string, agentType: string | undefined): string | null {
  if (agentType === undefined || agentType === '') return null;
  const prefix = `a${agentType}`;
  if (!agentId.startsWith(prefix)) return null;
  return TEAMMATE_ID_TAIL.test(agentId.slice(prefix.length)) ? agentType : null;
}

/** PostToolUse(Agent): the caller is the parent, tool_response.agentId the child (ADR-012). */
function emitAgentLink(
  link: AgentLink | undefined,
  toolUseId: string | undefined,
  callerKey: AgentKey,
  out: Emitter,
): void {
  if (link === undefined) return;
  const childAgentId = id(link.agentId);
  const childKey = agentKey(out.sessionId, childAgentId);
  // agent.linked needs the Agent call id; without it only the model can be attributed.
  if (toolUseId !== undefined) {
    out.emit('agent.linked', childKey, {
      toolUseId: id(toolUseId),
      childAgentId,
      parentKey: callerKey,
      link: 'exact',
    });
  }
  if (link.resolvedModel !== undefined) {
    out.emit('model.observed', childKey, { model: id(link.resolvedModel), via: 'agent_call' });
  }
}

// --- TaskUpdate (F4, spike S4b) ----------------------------------------------------------

/**
 * The task a TaskUpdate call put in progress, or null. S4b recorded `{taskId: "1", status: "in_progress"}`; the id
 * is also read from `task_id` or `id` and from a number, in case another Claude Code version names or types it
 * differently. A missing or empty id gives null: a task.started that no task could match would only be noise.
 */
function startedTaskId(input: Record<string, unknown>): string | null {
  if (input.status !== 'in_progress') return null;
  for (const raw of [input.taskId, input.task_id, input.id]) {
    const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : str(raw);
    if (value !== undefined && value !== '') return id(value);
  }
  return null;
}

// --- AskUserQuestion (F11) ------------------------------------------------------------

/**
 * The parts of AskUserQuestion's tool_input a question card needs (INTEGRATION.md, S5). Loose objects:
 * unknown fields are allowed, just not read. The array caps keep an oversized payload from bloating the log;
 * Claude Code asks 1-4 questions with 2-4 options, so they leave headroom.
 */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 16;
const askOptionSchema = z.looseObject({ label: z.string(), description: z.string().optional() });
const askQuestionSchema = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(askOptionSchema).max(MAX_OPTIONS),
  multiSelect: z.boolean().optional(),
});
const askInputSchema = z.looseObject({ questions: z.array(askQuestionSchema).min(1).max(MAX_QUESTIONS) });

/**
 * PreToolUse(AskUserQuestion) -> the question as the Huddle may show it, or null (no question.asked) when
 * tool_input has an unexpected shape or the call has no tool_use_id. tool.started is emitted either way.
 *
 * requestId is the tool_use_id: deterministic, and the broker can read it from the held PreToolUse payload to
 * match its hold to this event (and the later PostToolUse) without extra state. Without a tool_use_id the Huddle
 * could not tie an answer to the held request, so it shows nothing and Claude Code's own question box stays the
 * way to answer (fail open; no inbox item that could never resolve).
 *
 * Text here is masked and clipped for display only. The broker must build `answers` from the raw held payload:
 * Claude Code keys answers by the exact question text and expects the exact option labels.
 */
function questionRequest(
  toolUseId: string | undefined,
  input: Record<string, unknown>,
  key: AgentKey,
  receivedAt: number,
  expiresAt: number | null,
): QuestionRequest | null {
  if (toolUseId === undefined || toolUseId === '') return null;
  const parsed = askInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const questions = parsed.data.questions.map((q): AskQuestion => ({
    question: text(q.question, CLIP_LIMITS.message),
    ...(q.header !== undefined ? { header: text(q.header, CLIP_LIMITS.summary) } : {}),
    options: q.options.map((o) => ({
      label: text(o.label, CLIP_LIMITS.summary),
      ...(o.description !== undefined ? { description: text(o.description, CLIP_LIMITS.description) } : {}),
    })),
    multiSelect: q.multiSelect ?? false,
  }));
  return { requestId: id(toolUseId), agentKey: key, questions, receivedAt, expiresAt };
}

// --- prompts -----------------------------------------------------------------------

/** Classifies by the opening tag only: closing tags are often missing (S2 addendum). */
export function promptKind(prompt: string): 'user' | 'task_notification' | 'agent_message' {
  const head = prompt.slice(0, 64).trimStart();
  if (/^<task-notification[\s>]/.test(head)) return 'task_notification';
  if (/^<agent-message[\s>]/.test(head)) return 'agent_message';
  return 'user';
}

const ID_PATTERN = '([A-Za-z0-9_-]{1,256})';
const TASK_ID = new RegExp(`<task-id>\\s*${ID_PATTERN}`);
const TOOL_USE_ID = new RegExp(`<tool-use-id>\\s*${ID_PATTERN}`);

/** Reads <task-id> and <tool-use-id> near the start of a task notification. Both are needed for a link. */
function taskNotificationIds(prompt: string): { agentId: string; toolUseId: string } | null {
  const head = prompt.slice(0, 2000);
  const agentId = TASK_ID.exec(head)?.[1];
  const toolUseId = TOOL_USE_ID.exec(head)?.[1];
  return agentId !== undefined && toolUseId !== undefined ? { agentId, toolUseId } : null;
}

// --- Stop / SubagentStop --------------------------------------------------------------

/** Ids of background subagents. null when the field is absent (unknown, not "none"). */
function backgroundAgentIds(tasks: readonly { id?: string; type?: string }[] | undefined): string[] | null {
  if (tasks === undefined) return null;
  const ids: string[] = [];
  for (const task of tasks) {
    // Only subagents (or entries without a type); other background work is not an agent.
    if (task.id !== undefined && (task.type === undefined || task.type === 'subagent')) ids.push(id(task.id));
  }
  return ids;
}

// --- tools --------------------------------------------------------------------------

/** How much of a summary source is read before masking (A1-01): what oneLine keeps, plus the mask margin. */
const SUMMARY_READ_LIMIT = CLIP_LIMITS.summary * 4 + MASK_MARGIN;

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Absolute path for file tools (feeds file-conflict detection later); null for everything else. */
function toolFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  return pathOrNull(str(input.file_path) ?? str(input.notebook_path));
}

/**
 * One line a person can read for the timeline (F8): a path, a command, a pattern, a URL.
 * Never file contents: Write/Edit are summarized by their path only.
 */
export function toolSummary(toolName: string, input: Record<string, unknown>): string {
  return shownSummary(toolName, input).summary;
}

/**
 * The summary and whether it hides part of the text (AX-01): a secret was masked, or the line was cut at the summary
 * limit. Measured on the pre-clipped text against CLIP_LIMITS.summary, the length the card shows.
 */
function shownSummary(toolName: string, input: Record<string, unknown>): { summary: string; hidden: boolean } {
  const raw = summaryText(toolName, input);
  const full = raw !== undefined && raw.trim() !== '' ? raw : toolName;
  const source = full.slice(0, SUMMARY_READ_LIMIT);
  // Masked before the one-line cut, so the cut never leaves half a secret that no pattern recognizes. Pre-clipped
  // first (A1-01), with a margin so a secret near the cut is still whole when it is masked.
  const masked = maskSecrets(source);
  const line = oneLine(masked);
  return {
    summary: clip(line, CLIP_LIMITS.summary),
    hidden: masked !== source || line.length > CLIP_LIMITS.summary || full.length > source.length,
  };
}

function summaryText(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path) ?? str(input.notebook_path);
    case 'Bash':
    case 'PowerShell':
      return str(input.command);
    case 'Glob':
    case 'Grep': {
      const pattern = str(input.pattern);
      const path = str(input.path);
      return pattern !== undefined && path !== undefined ? `${pattern} in ${path}` : (pattern ?? path);
    }
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
    case 'ToolSearch':
      return str(input.query);
    case 'Agent': {
      const role = str(input.subagent_type);
      const description = str(input.description);
      return role !== undefined && description !== undefined ? `${role}: ${description}` : (description ?? role);
    }
    case 'Skill':
      return str(input.skill);
    case HUDDLE_PROGRESS_TOOL:
      return progressReportSummary(input);
    case HUDDLE_TEAMMATE_TOOL:
      return teammateReportSummary(input);
    case 'AskUserQuestion': {
      const questions = input.questions;
      const first: unknown = Array.isArray(questions) ? questions[0] : undefined;
      return isRecord(first) ? str(first.question) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Keys of a tool input whose values are summaries (a command, a path, a URL, a pattern, a query, a subagent's role and
 * brief, a few flags and numbers): the only values an `approval.requested` stores (M5 security review L5; it was a
 * denylist of content keys before). Exactly what the code reads back from a stored input: `toolSummary` (command,
 * file_path, notebook_path, path, pattern, url, query, subagent_type, description, skill) and `storedPolicyFacts` (the
 * rule preview: command, file_path, notebook_path, path), plus the small fields the review named (glob, prompt,
 * model, run_in_background, timeout, offset, limit).
 */
export const STORED_TOOL_INPUT_KEYS: ReadonlySet<string> = new Set([
  'command',
  'description',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'glob',
  'url',
  'query',
  'subagent_type',
  'skill',
  'prompt',
  'model',
  'run_in_background',
  'timeout',
  'offset',
  'limit',
]);

/**
 * Keys whose values are file contents or edit text (and `tool_response`): left out entirely, the name too, as before
 * the allowlist (the fixture tests check that no event carries these key names).
 */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'new_string',
  'old_string',
  'edits',
  'new_source',
  'old_source',
  'tool_response',
]);

/** What a key outside STORED_TOOL_INPUT_KEYS stores instead of its value: the key is shown to exist, nothing more. */
export const OMITTED_INPUT_VALUE = '<omitted>';

/** Most keys one stored tool input keeps (a hostile input could have thousands); key names longer than this go. */
const MAX_STORED_INPUT_KEYS = 64;
const MAX_INPUT_KEY_LENGTH = 64;

/**
 * The tool input an approval card may show (stored with the event): an allowlist (STORED_TOOL_INPUT_KEYS) of
 * top-level scalars, strings masked and clipped; the content keys (CONTENT_KEYS) are left out as before; any other
 * key keeps its name with OMITTED_INPUT_VALUE as its value;
 * a nested value under an allowed key is dropped, as before. File contents and edit text are never copied. The hook's
 * raw input is still what the rules read in memory (hook-facts.ts) and what `inputDigest` hashes.
 */
function sanitizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  let kept = 0;
  for (const [name, value] of Object.entries(input)) {
    if (kept >= MAX_STORED_INPUT_KEYS) break;
    if (name.length > MAX_INPUT_KEY_LENGTH || CONTENT_KEYS.has(name)) continue;
    if (!STORED_TOOL_INPUT_KEYS.has(name)) {
      safe[name] = OMITTED_INPUT_VALUE;
      kept += 1;
      continue;
    }
    if (typeof value === 'string') safe[name] = text(value, CLIP_LIMITS.message);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) safe[name] = value;
    else continue;
    kept += 1;
  }
  return safe;
}

/**
 * Hash of tool name + input (keys sorted), for loop detection without storing the input. `hookFacts` uses it too, to
 * tie a PermissionRequest (which has no tool_use_id) to the PostToolUse of the same call.
 */
export function inputDigest(toolName: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(toolName).update('\0').update(stableJson(input, 0)).digest('hex').slice(0, 32);
}

const MAX_DIGEST_DEPTH = 32;

function stableJson(value: unknown, depth: number): string {
  if (depth > MAX_DIGEST_DEPTH) return '"…"';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k], depth + 1)}`).join(',')}}`;
  }
  // JSON.stringify returns undefined for undefined (an absent array slot), which its type does not admit.
  const json = JSON.stringify(value) as string | undefined;
  return json ?? 'null';
}

// --- text helpers --------------------------------------------------------------------

/** Free text as it may enter an event: secrets masked first (so a cut never leaves half a secret), then clipped. */
function text(value: string, limit: number): string {
  // Pre-clipped (A1-01): masking megabytes would stall the event loop, and the margin keeps a secret at the cut whole.
  return clip(maskSecrets(value.slice(0, limit + MASK_MARGIN)), limit);
}

function textOrNull(value: string | undefined, limit: number): string | null {
  return value === undefined ? null : text(value, limit);
}

/** Identifiers (ids, models, roles, tool names) are not masked, only bounded. */
function id(value: string): string {
  return clip(value, CLIP_LIMITS.id);
}

function idOrNull(value: string | undefined): string | null {
  return value === undefined ? null : id(value);
}

function idOrUndefined(value: string | undefined): string | undefined {
  return value === undefined ? undefined : id(value);
}

function pathOrNull(value: string | undefined): string | null {
  return value === undefined ? null : clip(value, CLIP_LIMITS.path);
}

/** Collapses whitespace so a summary is one line. Bounded work on huge input. */
function oneLine(text: string): string {
  return text
    .slice(0, CLIP_LIMITS.summary * 4)
    .replace(/\s+/g, ' ')
    .trim();
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
