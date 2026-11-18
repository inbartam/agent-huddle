/**
 * Hook facts: the few pieces of a held-able hook payload the broker needs, in the broker's words (M3 WP5).
 *
 * CONTRIBUTING.md rule 2 keeps payload field names in ingest/ and normalize/. The broker decides from HuddleEvents and from
 * this small, payload-free shape: which kind of hook it was, whose it was, the tool call id, whether Claude Code is
 * already continuing because of a stop hook, and (for AskUserQuestion) the questions exactly as Claude Code sent them.
 *
 * Why the raw questions: `question.asked` carries masked, clipped text for display. Claude Code reads
 * `updatedInput.answers` keyed by the exact question text and expects the exact option labels (S5), so the reply must
 * be built from the payload, not from the event. `toolInput` is the call's own input, handed back unread inside
 * `preToolUse.answer` (hook-replies.ts). None of it is written to the log: it lives only as long as the held request.
 *
 * Tool calls (Fix for SPIKES S1, 2026-11-14): Claude Code 2.1.325 does not close a held PermissionRequest when the
 * terminal answers it, so the broker ends the hold itself when it sees the same call finish (PostToolUse,
 * PostToolUseFailure, PermissionDenied) or the turn end. PermissionRequest has no tool_use_id, so a call is recognized by
 * `ToolCallKey`: tool name + input digest (the same `inputDigest` as `tool.started`) + the one-line summary.
 *
 * Pure: no clock, no I/O. Ids and keys are built exactly as `normalizeHook` builds them (clipped the same way), so a
 * fact's `agentKey` and `toolUseId` match the events normalized from the same payload.
 */
import { z } from 'zod';
import { agentKey, CLIP_LIMITS, type AgentKey } from '@huddle/shared';
import type { AcceptedHook } from '../ingest/hook-server.js';
import { MASK_MARGIN, maskSecrets, REDACTED } from '../privacy/redact.js';
import { inputDigest, toolSummary } from './hooks.js';
import { clip } from '../text.js';

/** One AskUserQuestion question as Claude Code sent it: exact text and labels. */
export interface RawQuestion {
  question: string;
  labels: string[];
  multiSelect: boolean;
}

/** An AskUserQuestion call: its questions, and its own tool input to hand back in the answer. */
export interface RawQuestionCall {
  toolInput: Readonly<Record<string, unknown>>;
  questions: RawQuestion[];
}

/**
 * A tool call as the broker can recognize it again without keeping its input (PermissionRequest has no tool_use_id).
 * Recorded fixtures send the identical `tool_input` on PreToolUse, PermissionRequest and PostToolUse of one call.
 */
export interface ToolCallKey {
  /** Clipped like `tool.started.toolName`. */
  toolName: string;
  /** `inputDigest(tool_name, tool_input)`, as on `tool.started`. */
  digest: string;
  /** The masked one-line summary (command, path, URL); null when it says no more than the tool name. */
  summary: string | null;
}

/**
 * The raw facts approval rules match on (F18, ADR-020 §3), read from the PermissionRequest itself, never from the
 * stored `toolInput` (which is clipped and masked). In memory only, for as long as the request is decided or held;
 * never written to the log. Fields read: `tool_name`, `tool_input.command` (Bash, PowerShell), `tool_input.file_path`
 * / `notebook_path` (file tools), `tool_input.path` (Glob, Grep), `cwd`: the same ones `toolSummary` reads.
 */
export interface PolicyFacts {
  /** The tool name exactly as sent (not clipped). */
  toolName: string;
  /** Bash and PowerShell: `tool_input.command`. Null for other tools, or when it is not a string. */
  command: string | null;
  /** File tools: `file_path` / `notebook_path`; Glob and Grep: `path` when given. */
  paths: string[];
  /** The payload's `cwd`, or null when absent. */
  cwd: string | null;
  /** `tool_input` was present and an object, and the field the tool needs (command, path) was a string. */
  readable: boolean;
  /** Something the rules read is longer than the stored input keeps (`CLIP_LIMITS.message`): the log would clip it. */
  clipped: boolean;
  /** Something the rules read looks like a secret (the stored input masks it). */
  masked: boolean;
}

export type HookFacts =
  | {
      kind: 'permission_request';
      sessionId: string;
      agentKey: AgentKey;
      call: ToolCallKey;
      /** For the approval rules; raw, in memory only. */
      policy: PolicyFacts;
      /**
       * The request is for AskUserQuestion: Claude Code is about to show its own question box (seen on 2.1.325 right
       * after a question was passed to the terminal). Never held, never an approval card.
       */
      askUserQuestion: boolean;
    }
  | {
      kind: 'pre_tool_use';
      sessionId: string;
      agentKey: AgentKey;
      /** The tool call id, clipped like `tool.started.toolUseId`; null when the payload had none. */
      toolUseId: string | null;
      /** The call is AskUserQuestion (whether or not its input could be read). */
      askUserQuestion: boolean;
      /** The questions, when the call is AskUserQuestion with a readable input; else null. */
      question: RawQuestionCall | null;
    }
  | {
      kind: 'stop';
      sessionId: string;
      agentKey: AgentKey;
      /** Claude Code is already continuing because of a stop hook (`stop_hook_active`): never block again. */
      continuing: boolean;
    }
  /** A tool call ended: PostToolUse, PostToolUseFailure, or PermissionDenied (auto mode). */
  | { kind: 'tool_ended'; sessionId: string; agentKey: AgentKey; call: ToolCallKey }
  /** The agent's turn is over without a Stop of the main agent: SubagentStop (the subagent), UserPromptSubmit (main). */
  | { kind: 'turn_over'; sessionId: string; agentKey: AgentKey }
  /** SessionEnd: nothing in this session can still be waiting on a prompt. */
  | { kind: 'session_over'; sessionId: string }
  | { kind: 'other' };

/** Same caps as the normalizer's display schema (Claude Code asks 1-4 questions with 2-4 options). */
const rawInputSchema = z.looseObject({
  questions: z
    .array(
      z.looseObject({
        question: z.string(),
        options: z.array(z.looseObject({ label: z.string() })).max(16),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(8),
});

const ASK_USER_QUESTION = 'AskUserQuestion';

function idOf(value: string): string {
  return clip(value, CLIP_LIMITS.id);
}

function keyOf(sessionId: string, agentId: string | undefined): AgentKey {
  return agentKey(sessionId, agentId === undefined ? undefined : idOf(agentId));
}

function rawQuestions(input: Record<string, unknown> | undefined): RawQuestionCall | null {
  if (input === undefined) return null;
  const parsed = rawInputSchema.safeParse(input);
  if (!parsed.success) return null;
  return {
    toolInput: input,
    questions: parsed.data.questions.map((q) => ({
      question: q.question,
      labels: q.options.map((o) => o.label),
      multiSelect: q.multiSelect ?? false,
    })),
  };
}

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
const PATH_FIELDS: Readonly<Partial<Record<string, readonly string[]>>> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Glob: ['path'],
  Grep: ['path'],
};
/** Glob and Grep may leave `path` out (they search the cwd); the file tools always name one. */
const PATH_OPTIONAL: ReadonlySet<string> = new Set(['Glob', 'Grep']);

/** The raw facts for the approval rules. Pure; never throws on an odd shape (it reports `readable: false`). */
export function policyFactsOf(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | undefined,
): PolicyFacts {
  const base = { toolName, cwd: cwd === undefined || cwd === '' ? null : cwd };
  if (input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return { ...base, command: null, paths: [], readable: false, clipped: false, masked: false };
  }
  let command: string | null = null;
  const paths: string[] = [];
  let readable = true;
  if (SHELL_TOOLS.has(toolName)) {
    const raw = input.command;
    if (typeof raw === 'string') command = raw;
    else readable = false;
  }
  const fields = PATH_FIELDS[toolName];
  if (fields !== undefined) {
    const found = fields.map((f) => input[f]).find((v) => v !== undefined);
    if (typeof found === 'string') paths.push(found);
    else if (found !== undefined || !PATH_OPTIONAL.has(toolName)) readable = false;
  }
  const texts = command === null ? paths : [command, ...paths];
  return {
    ...base,
    command,
    paths,
    readable,
    clipped: texts.some((t) => t.length > CLIP_LIMITS.message),
    // Only the head is tested (A1-01): longer text is clipped, which refuses an allow anyway.
    masked: texts.some((t) => {
      const head = t.slice(0, CLIP_LIMITS.message + MASK_MARGIN);
      return maskSecrets(head) !== head;
    }),
  };
}

/**
 * The same facts read back from a stored `approval.requested` (`request.toolInput`, which `normalizeHook` clipped and
 * masked). Used only by the rule preview, so it errs towards "clipped" and "masked": a string ending in the clip
 * ellipsis counts as clipped, one holding the redaction marker as masked. The stored input has no cwd: pass the
 * agent's. Pure.
 */
export function storedPolicyFacts(
  toolName: string,
  storedInput: Readonly<Record<string, unknown>>,
  cwd: string | null,
): PolicyFacts {
  const facts = policyFactsOf(toolName, { ...storedInput }, cwd ?? undefined);
  const texts = facts.command === null ? facts.paths : [facts.command, ...facts.paths];
  return {
    ...facts,
    clipped: facts.clipped || texts.some((t) => t.endsWith('…')),
    masked: facts.masked || texts.some((t) => t.includes(REDACTED)),
  };
}

function callOf(toolName: string, input: Record<string, unknown> | undefined): ToolCallKey {
  const name = idOf(toolName);
  const toolInput = input ?? {};
  const summary = toolSummary(toolName, toolInput);
  return {
    toolName: name,
    digest: inputDigest(toolName, toolInput),
    summary: summary === '' || summary === toolName || summary === name ? null : summary,
  };
}

/** The facts the broker reads from one accepted hook. Never throws. */
export function hookFacts(result: AcceptedHook): HookFacts {
  if (!result.known) return { kind: 'other' };
  const p = result.payload;
  try {
    switch (p.hook_event_name) {
      case 'PermissionRequest':
        return {
          kind: 'permission_request',
          sessionId: p.session_id,
          agentKey: keyOf(p.session_id, p.agent_id),
          call: callOf(p.tool_name, p.tool_input),
          policy: policyFactsOf(p.tool_name, p.tool_input, p.cwd),
          askUserQuestion: p.tool_name === ASK_USER_QUESTION,
        };
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        return {
          kind: 'tool_ended',
          sessionId: p.session_id,
          agentKey: keyOf(p.session_id, p.agent_id),
          call: callOf(p.tool_name, p.tool_input),
        };
      case 'SubagentStop':
      case 'UserPromptSubmit':
        // An empty agent_id would key the root: it must not end the main agent's turn (A1-02).
        if (p.hook_event_name === 'SubagentStop' && p.agent_id === '') return { kind: 'other' };
        return { kind: 'turn_over', sessionId: p.session_id, agentKey: keyOf(p.session_id, p.agent_id) };
      case 'SessionEnd':
        return { kind: 'session_over', sessionId: p.session_id };
      case 'PreToolUse': {
        const ask = p.tool_name === ASK_USER_QUESTION;
        const toolUseId = p.tool_use_id === undefined || p.tool_use_id === '' ? null : idOf(p.tool_use_id);
        return {
          kind: 'pre_tool_use',
          sessionId: p.session_id,
          agentKey: keyOf(p.session_id, p.agent_id),
          toolUseId,
          askUserQuestion: ask,
          question: ask ? rawQuestions(p.tool_input) : null,
        };
      }
      case 'Stop':
        return {
          kind: 'stop',
          sessionId: p.session_id,
          agentKey: keyOf(p.session_id, p.agent_id),
          continuing: p.stop_hook_active === true,
        };
      default:
        return { kind: 'other' };
    }
  } catch {
    return { kind: 'other' };
  }
}
