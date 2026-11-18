/**
 * Stream normalizer (M4, ADR-020 §1): one parsed stdout line of a managed stream-json run -> HuddleEvents.
 *
 * What becomes an event (envelope `source: 'stream'`, the run's session root as `agentKey`):
 *  - `result` -> `run.result`. isError is `is_error`, or `subtype !== 'success'` when the line has no `is_error`.
 *    permissionDenials is the length of `permission_denials` (0 when absent). The answer text is not stored.
 *  - `rate_limit_event` -> `limits.measured`, when it carries a seven_day or five_hour window.
 *
 * What does not, on purpose:
 *  - Tool calls and token usage: hooks and telemetry already report them for every session, managed or not
 *    (ADR-009, ADR-013). Counting them from the stream too would double count.
 *  - `system/init`: its facts (model, permission mode, capabilities, tool count) go back to the driver as data.
 *    `model.observed` has no stream `via`, so the model stays with hooks (SessionStart) and telemetry.
 *  - Message text, thinking, tool input and tool results: never stored.
 *  - `control_response`: the driver matches it to the control_request it wrote; the caller records the outcome.
 *
 * `rate_limit_event.unifiedWindows.<window>.utilization`: S8/S16 saw `0.67`; the unit is not documented. It is read
 * as a fraction of the window (0.67 = 67 %), the convention of Anthropic's unified rate-limit headers, and turned into
 * a percentage. **Assumption, not run-checked**: compare against the status line `used_percentage` when S12 runs.
 *
 * Pure and stateless: ids and the receive time come from `ctx`.
 */
import { agentKey, type HuddleEvent, type RateLimits } from '@huddle/shared';
import { parseStreamLine, type StreamMessage, type StreamRateWindow } from '../ingest/stream-schema.js';

export interface StreamContext {
  /** The Huddle's id for this launch. */
  runId: string;
  /** The run's Claude Code session id (`--session-id`, which S16 showed equals init's and every hook's). */
  sessionId: string;
  /** Epoch ms the Huddle read the line; becomes each event's `ts` (and `measuredAt`). */
  receivedAt: number;
  nextId: () => string;
}

/** A parsed line and the events it makes. */
export interface StreamNormalized {
  message: StreamMessage;
  events: HuddleEvent[];
}

/** `utilization` (read as a 0..1 fraction) -> a 0..100 percentage; null when unknown. */
function percentOf(utilization: number | null): number | null {
  if (utilization === null) return null;
  return Math.min(100, utilization * 100);
}

function resetsAtMs(window: StreamRateWindow | null): number | null {
  return window?.resetsAt === null || window?.resetsAt === undefined ? null : Math.round(window.resetsAt * 1000);
}

/** Turns one parsed stream message into events. Pure: no clock, no randomness, no I/O. */
export function normalizeStreamMessage(message: StreamMessage, ctx: StreamContext): HuddleEvent[] {
  const base = {
    ts: ctx.receivedAt,
    sessionId: ctx.sessionId,
    agentKey: agentKey(ctx.sessionId),
    source: 'stream' as const,
  };
  switch (message.kind) {
    case 'result':
      return [
        {
          id: ctx.nextId(),
          type: 'run.result',
          ...base,
          runId: ctx.runId,
          isError: message.isError ?? message.subtype !== 'success',
          durationMs: message.durationMs,
          numTurns: message.numTurns,
          totalCostUsd: message.totalCostUsd,
          permissionDenials: message.permissionDenials ?? 0,
        },
      ];
    case 'rate_limit': {
      const { fiveHour, sevenDay } = message;
      if (fiveHour === null && sevenDay === null) return [];
      const limits: RateLimits = {
        fiveHourUsedPct: percentOf(fiveHour?.utilization ?? null),
        fiveHourResetsAt: resetsAtMs(fiveHour),
        sevenDayUsedPct: percentOf(sevenDay?.utilization ?? null),
        sevenDayResetsAt: resetsAtMs(sevenDay),
        measuredAt: ctx.receivedAt,
      };
      return [{ id: ctx.nextId(), type: 'limits.measured', ...base, limits }];
    }
    case 'init':
    case 'system':
    case 'message':
    case 'control_response':
      return [];
  }
}

/** Parses and normalizes one stdout line. Returns null for a line that is not usable (never throws). */
export function normalizeStreamLine(line: string, ctx: StreamContext): StreamNormalized | null {
  const message = parseStreamLine(line);
  if (message === null) return null;
  return { message, events: normalizeStreamMessage(message, ctx) };
}
