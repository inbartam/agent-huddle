/**
 * Runtime schema for one stdout line of a managed `claude -p --output-format stream-json --verbose` run (M4, ADR-020 §1).
 *
 * Shapes come from spikes S8 and S16 (run-checked on Claude Code 2.1.325; docs/INTEGRATION.md §3):
 *  - `system/init` (one per turn): session_id, model, permissionMode, tools[], agents[], capabilities[] (array of names),
 *    claude_code_version, cwd, and many more keys the Huddle does not read.
 *  - `assistant` / `user`: `message.{role, content[]}` and `parent_tool_use_id` (null on the main loop; on a subagent's
 *    messages it is the parent's `Agent` tool_use id).
 *  - `result` (ends one turn): subtype (`success`, `error_during_execution`, ...), is_error, duration_ms, num_turns,
 *    total_cost_usd, permission_denials[] and the answer text in `result`.
 *  - `rate_limit_event`: `rate_limit_info.unifiedWindows.<window>.{utilization, resetsAt}` (resetsAt in epoch seconds).
 *  - `control_response`: `response.{subtype, request_id, response | error}`, the answer to a control_request we wrote.
 *
 * Rules (same as the hook and status line schemas):
 *  - Tolerant: every field is optional and a value of the wrong type is dropped (unknown), never an error.
 *  - Minimal: `parseStreamLine` returns a new object with only the facts the Huddle uses. Message text, thinking,
 *    tool input, tool results, `tool_use_result` and the `result` answer text are never copied out.
 *  - Never throws. Bad JSON, a non-object, a line over MAX_STREAM_LINE_CHARS or an unknown `type` returns null.
 */
import { z } from 'zod';
import { CLIP_LIMITS } from '@huddle/shared';

/** A stdout line longer than this (characters) is dropped unread. Real init lines are tens of kilobytes. */
export const MAX_STREAM_LINE_CHARS = 1_000_000;
/** Most capability names, tool names or agent names kept from one init. */
const MAX_LIST = 500;
/** A capability name as Claude Code writes them (`interrupt_cancel_queued_v1`). */
const CAPABILITY_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Optional field: absent stays absent; a value of the wrong type is dropped instead of failing the line. */
function opt<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const text = z.string();
const finiteNumber = z.number().refine(Number.isFinite);

const initSchema = z.looseObject({
  session_id: opt(text),
  model: opt(text),
  permissionMode: opt(text),
  claude_code_version: opt(text),
  cwd: opt(text),
  tools: opt(z.array(z.unknown())),
  agents: opt(z.array(z.unknown())),
  capabilities: opt(z.array(z.unknown())),
});

const messageSchema = z.looseObject({
  parent_tool_use_id: opt(z.union([z.null(), text])),
  message: opt(z.looseObject({ role: opt(text) })),
});

const resultSchema = z.looseObject({
  subtype: opt(text),
  is_error: opt(z.boolean()),
  duration_ms: opt(finiteNumber),
  num_turns: opt(finiteNumber),
  total_cost_usd: opt(finiteNumber),
  permission_denials: opt(z.array(z.unknown())),
  session_id: opt(text),
});

const windowSchema = z.looseObject({ utilization: opt(finiteNumber), resetsAt: opt(finiteNumber) });

const rateLimitSchema = z.looseObject({
  rate_limit_info: opt(
    z.looseObject({
      unifiedWindows: opt(z.looseObject({ five_hour: opt(windowSchema), seven_day: opt(windowSchema) })),
    }),
  ),
});

const controlResponseSchema = z.looseObject({
  response: opt(z.looseObject({ subtype: opt(text), request_id: opt(text), error: opt(text) })),
});

/** One rate-limit window as the stream reports it; null fields were absent or unusable. */
export interface StreamRateWindow {
  /** As reported (`utilization`); the unit is not documented, see normalize/stream.ts. */
  utilization: number | null;
  /** Epoch seconds, as reported. */
  resetsAt: number | null;
}

/** The facts the Huddle keeps from one stdout line. `kind` follows the line's `type` (and `subtype` for system). */
export type StreamMessage =
  | {
      kind: 'init';
      sessionId: string | null;
      model: string | null;
      permissionMode: string | null;
      claudeCodeVersion: string | null;
      /** Clipped to CLIP_LIMITS.path. */
      cwd: string | null;
      /** Capability names, e.g. `interrupt_cancel_queued_v1`. Empty when absent. */
      capabilities: string[];
      /** How many tools the session has; null when absent. Names are not kept (MCP tool names say what the user installed). */
      toolCount: number | null;
      /** Agent names the session knows (built-in, file and `--agents`). */
      agents: string[];
    }
  | { kind: 'system'; subtype: string | null }
  | { kind: 'message'; role: 'assistant' | 'user'; parentToolUseId: string | null }
  | {
      kind: 'result';
      subtype: string | null;
      /** null when the line did not say; the normalizer falls back on `subtype`. */
      isError: boolean | null;
      durationMs: number | null;
      numTurns: number | null;
      totalCostUsd: number | null;
      /** Length of `permission_denials`; null when absent. */
      permissionDenials: number | null;
      sessionId: string | null;
    }
  | { kind: 'rate_limit'; fiveHour: StreamRateWindow | null; sevenDay: StreamRateWindow | null }
  | {
      kind: 'control_response';
      requestId: string | null;
      /** `success` or `error` as reported. */
      subtype: string | null;
      /** Clipped to CLIP_LIMITS.error. */
      error: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clipTo(value: string | undefined, max: number): string | null {
  if (value === undefined || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

const idOf = (value: string | undefined) => clipTo(value, CLIP_LIMITS.id);

function nonNegative(value: number | undefined): number | null {
  return value !== undefined && value >= 0 ? value : null;
}

/** Names from an array of strings or of `{name}` objects, clipped, at most MAX_LIST. */
function names(list: unknown[] | undefined): string[] {
  if (list === undefined) return [];
  const out: string[] = [];
  for (const item of list) {
    if (out.length >= MAX_LIST) break;
    const name = typeof item === 'string' ? item : isRecord(item) && typeof item.name === 'string' ? item.name : null;
    if (name !== null && name.length > 0) out.push(name.length > CLIP_LIMITS.id ? name.slice(0, CLIP_LIMITS.id) : name);
  }
  return out;
}

function windowOf(
  w: { utilization?: number | undefined; resetsAt?: number | undefined } | undefined,
): StreamRateWindow | null {
  if (w === undefined) return null;
  const utilization = nonNegative(w.utilization);
  const resetsAt = nonNegative(w.resetsAt);
  return utilization === null && resetsAt === null ? null : { utilization, resetsAt };
}

function readInit(raw: Record<string, unknown>): StreamMessage | null {
  const p = initSchema.safeParse(raw);
  if (!p.success) return null;
  const d = p.data;
  return {
    kind: 'init',
    sessionId: idOf(d.session_id),
    model: idOf(d.model),
    permissionMode: idOf(d.permissionMode),
    claudeCodeVersion: idOf(d.claude_code_version),
    cwd: clipTo(d.cwd, CLIP_LIMITS.path),
    capabilities: names(d.capabilities).filter((c) => CAPABILITY_NAME.test(c)),
    toolCount: d.tools === undefined ? null : d.tools.length,
    agents: names(d.agents),
  };
}

function readMessage(raw: Record<string, unknown>, role: 'assistant' | 'user'): StreamMessage | null {
  const p = messageSchema.safeParse(raw);
  if (!p.success) return null;
  return { kind: 'message', role, parentToolUseId: idOf(p.data.parent_tool_use_id ?? undefined) };
}

function readResult(raw: Record<string, unknown>): StreamMessage | null {
  const p = resultSchema.safeParse(raw);
  if (!p.success) return null;
  const d = p.data;
  const turns = nonNegative(d.num_turns);
  return {
    kind: 'result',
    subtype: idOf(d.subtype),
    isError: d.is_error ?? null,
    durationMs: nonNegative(d.duration_ms),
    numTurns: turns === null ? null : Math.floor(turns),
    totalCostUsd: nonNegative(d.total_cost_usd),
    permissionDenials: d.permission_denials === undefined ? null : d.permission_denials.length,
    sessionId: idOf(d.session_id),
  };
}

function readRateLimit(raw: Record<string, unknown>): StreamMessage | null {
  const p = rateLimitSchema.safeParse(raw);
  if (!p.success) return null;
  const windows = p.data.rate_limit_info?.unifiedWindows;
  return { kind: 'rate_limit', fiveHour: windowOf(windows?.five_hour), sevenDay: windowOf(windows?.seven_day) };
}

function readControlResponse(raw: Record<string, unknown>): StreamMessage | null {
  const p = controlResponseSchema.safeParse(raw);
  if (!p.success) return null;
  const r = p.data.response;
  return {
    kind: 'control_response',
    requestId: idOf(r?.request_id),
    subtype: idOf(r?.subtype),
    error: clipTo(r?.error, CLIP_LIMITS.error),
  };
}

/** Reads an already parsed stream-json object. Never throws; an unknown `type` returns null. */
export function readStreamObject(raw: unknown): StreamMessage | null {
  try {
    if (!isRecord(raw) || typeof raw.type !== 'string') return null;
    switch (raw.type) {
      case 'system': {
        const subtype = typeof raw.subtype === 'string' ? raw.subtype : null;
        if (subtype === 'init') return readInit(raw);
        return { kind: 'system', subtype: idOf(subtype ?? undefined) };
      }
      case 'assistant':
      case 'user':
        return readMessage(raw, raw.type);
      case 'result':
        return readResult(raw);
      case 'rate_limit_event':
        return readRateLimit(raw);
      case 'control_response':
        return readControlResponse(raw);
      default:
        return null;
    }
  } catch {
    // A hostile object (getters, proxies) must not crash ingest.
    return null;
  }
}

/** Parses one stdout line. Never throws: bad JSON, an oversized line or an unknown type returns null. */
export function parseStreamLine(line: string): StreamMessage | null {
  if (line.length === 0 || line.length > MAX_STREAM_LINE_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  return readStreamObject(raw);
}

/**
 * For a line too long to parse: is it a turn's `result`? Claude Code writes `type` first, so the start of the line
 * says. The driver uses this so one huge answer cannot leave it thinking the turn is still running.
 */
export function oversizedLineIsResult(head: string): boolean {
  return /^\s*\{\s*"type"\s*:\s*"result"/.test(head);
}
