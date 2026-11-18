/**
 * Runtime schema for the status line JSON (F9, M2 WP6), the body of `POST /huddle/statusline`.
 *
 * Claude Code pipes this JSON to the user's `statusLine` command; the bridge wrapper
 * (scripts/huddle-statusline.mjs) forwards it here unchanged. Field list: docs/INTEGRATION.md "Status line data"
 * (docs-verified 2026-11-14; not yet run-checked, spike S12).
 *
 * Rules:
 *  - Tolerant: every field is optional; a value of the wrong type is dropped (treated as unknown), never an error.
 *    Only a body that is not a JSON object is rejected.
 *  - Minimal: `parseStatuslinePayload` returns a new object with only the fields the Huddle uses. The rest of the
 *    payload (transcript_path, session_name, worktree, prompt_cache, ...) is dropped here and never reaches an event.
 *  - Never throws.
 */
import { z } from 'zod';

/** Optional field: absent stays absent; a value of the wrong type is dropped instead of failing the payload. */
function opt<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const count = z.number().nonnegative();
const percent = z.number().min(0).max(100);
/** `used_percentage` and `remaining_percentage` "may be null early" (docs). */
const nullablePercent = z.union([z.null(), percent]);

const currentUsageSchema = z.looseObject({
  input_tokens: opt(count),
  output_tokens: opt(count),
  cache_creation_input_tokens: opt(count),
  cache_read_input_tokens: opt(count),
});

const rateWindowSchema = z.looseObject({
  used_percentage: opt(percent),
  /** Unix epoch SECONDS (docs). */
  resets_at: opt(count),
});

export const StatuslinePayloadSchema = z.looseObject({
  session_id: opt(z.string().min(1)),
  cwd: opt(z.string()),
  workspace: opt(z.looseObject({ current_dir: opt(z.string()), project_dir: opt(z.string()) })),
  model: opt(z.looseObject({ id: opt(z.string().min(1)) })),
  context_window: opt(
    z.looseObject({
      context_window_size: opt(count),
      used_percentage: opt(nullablePercent),
      remaining_percentage: opt(nullablePercent),
      /** null before the first API call and after /compact until the next call (docs). */
      current_usage: opt(z.union([z.null(), currentUsageSchema])),
    }),
  ),
  rate_limits: opt(z.looseObject({ five_hour: opt(rateWindowSchema), seven_day: opt(rateWindowSchema) })),
  cost: opt(z.looseObject({ total_cost_usd: opt(count) })),
});

/** The fields the Huddle keeps. Absent means "not in the payload or not usable". */
export interface StatuslinePayload {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string; project_dir?: string };
  model?: { id?: string };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  cost?: { total_cost_usd?: number };
}

export type ParseStatuslineResult = { ok: true; payload: StatuslinePayload } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copies only defined keys, so absent stays absent (no `undefined` values in the result). */
function defined<T extends object>(value: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

type Parsed = z.infer<typeof StatuslinePayloadSchema>;

function pickWindow(w: { used_percentage?: number | undefined; resets_at?: number | undefined } | undefined) {
  return w === undefined ? undefined : defined({ used_percentage: w.used_percentage, resets_at: w.resets_at });
}

function pick(p: Parsed): StatuslinePayload {
  const cw = p.context_window;
  const usage = cw?.current_usage;
  const out = defined<StatuslinePayload>({
    session_id: p.session_id,
    cwd: p.cwd,
    workspace:
      p.workspace === undefined
        ? undefined
        : defined({ current_dir: p.workspace.current_dir, project_dir: p.workspace.project_dir }),
    model: p.model === undefined ? undefined : defined({ id: p.model.id }),
    context_window:
      cw === undefined
        ? undefined
        : defined({
            context_window_size: cw.context_window_size,
            used_percentage: cw.used_percentage,
            remaining_percentage: cw.remaining_percentage,
            current_usage:
              usage === undefined || usage === null
                ? usage
                : (defined({
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens,
                    cache_read_input_tokens: usage.cache_read_input_tokens,
                  }) ?? {}),
          }),
    rate_limits:
      p.rate_limits === undefined
        ? undefined
        : defined({ five_hour: pickWindow(p.rate_limits.five_hour), seven_day: pickWindow(p.rate_limits.seven_day) }),
    cost: p.cost === undefined ? undefined : defined({ total_cost_usd: p.cost.total_cost_usd }),
  });
  return out ?? {};
}

/** Validates a status line body and keeps only the fields the Huddle uses. Never throws. */
export function parseStatuslinePayload(body: unknown): ParseStatuslineResult {
  try {
    if (!isRecord(body)) return { ok: false, error: 'body is not a JSON object' };
    const parsed = StatuslinePayloadSchema.safeParse(body);
    // Every field is optional and catches its own type errors, so this branch is defensive only.
    if (!parsed.success) return { ok: false, error: 'status line payload could not be read' };
    return { ok: true, payload: pick(parsed.data) };
  } catch {
    // A hostile object (getters, proxies) must not crash ingest.
    return { ok: false, error: 'status line payload could not be read' };
  }
}
