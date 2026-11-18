/**
 * Status line normalizer (F9, M2 WP6): the parsed status line JSON -> `context.measured` and `limits.measured`.
 *
 * - `context.measured` (`measuredBy: 'statusline'`, main agent only: the status line has no per-subagent data).
 *   usedTokens = input + cache_read + cache_creation of `current_usage` (the docs' definition of used_percentage; output
 *   is not counted). windowTokens = `context_window_size`, else null. When `current_usage` is null or absent (before the
 *   first API call, after /compact until the next call) nothing is emitted: unknown is not 0.
 *   The reducer derives usedPct from used/window, which is the same formula as Claude Code's `used_percentage`, so
 *   that field is not copied (ContextMeasured has no field for it and none is needed).
 * - `limits.measured`: only when at least one of `rate_limits.five_hour` / `seven_day` is present. A window that is
 *   absent is null, never 0. `resets_at` is Unix epoch seconds in the payload and epoch milliseconds in the event.
 *
 * Pure and stateless: ids and the receive time come from `ctx`.
 */
import { agentKey, type HuddleEvent, type RateLimits } from '@huddle/shared';
import type { StatuslinePayload } from '../ingest/statusline-schema.js';
import { isIngestSessionId } from '../store/jsonl-store.js';

export interface StatuslineContext {
  /** ISO time the Huddle received the post; becomes each event's `ts` and `measuredAt`. */
  receivedAt: string;
  nextId: () => string;
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

type Window = NonNullable<StatuslinePayload['rate_limits']>['five_hour'];

function windowOf(w: Window): { pct: number | null; resetsAt: number | null } | null {
  if (w === undefined) return null;
  const seconds = finite(w.resets_at);
  return { pct: finite(w.used_percentage), resetsAt: seconds === null ? null : Math.round(seconds * 1000) };
}

/** Turns one status line payload into events. Pure: no clock, no randomness, no I/O. */
export function normalizeStatusline(payload: StatuslinePayload, ctx: StatuslineContext): HuddleEvent[] {
  // Unclipped like the other normalizers, so the key matches the session's hook events; but an absurdly long id is
  // not a Claude Code session id, so it is refused rather than stored.
  const sessionId = payload.session_id;
  if (!isIngestSessionId(sessionId)) return [];
  const ts = Date.parse(ctx.receivedAt);
  const base = { ts, sessionId, agentKey: agentKey(sessionId), source: 'statusline' as const };
  const events: HuddleEvent[] = [];

  const cw = payload.context_window;
  const usage = cw?.current_usage;
  if (usage !== undefined && usage !== null) {
    const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
    // All three missing is "no reading", not 0 tokens.
    if (parts.some((p) => p !== undefined)) {
      const usedTokens = parts.reduce<number>((sum, p) => sum + (finite(p) ?? 0), 0);
      const size = finite(cw?.context_window_size);
      events.push({
        id: ctx.nextId(),
        type: 'context.measured',
        ...base,
        usedTokens,
        windowTokens: size !== null && size > 0 ? size : null,
        measuredBy: 'statusline',
      });
    }
  }

  const five = windowOf(payload.rate_limits?.five_hour);
  const seven = windowOf(payload.rate_limits?.seven_day);
  if (five !== null || seven !== null) {
    const limits: RateLimits = {
      fiveHourUsedPct: five?.pct ?? null,
      fiveHourResetsAt: five?.resetsAt ?? null,
      sevenDayUsedPct: seven?.pct ?? null,
      sevenDayResetsAt: seven?.resetsAt ?? null,
      measuredAt: ts,
    };
    events.push({ id: ctx.nextId(), type: 'limits.measured', ...base, limits });
  }
  return events;
}
