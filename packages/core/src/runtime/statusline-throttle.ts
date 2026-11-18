/**
 * Status line throttle (F9, ADR-018): keeps status line readings from flooding the event log.
 *
 * Claude Code refreshes the status line after every assistant message and on its own refresh interval (debounced at
 * 300 ms), so one busy session can post several readings a second, most of them identical. Every accepted event is
 * written to the log, so without this the log grows without bound while nothing changes.
 *
 * This lives at the edge (HuddleCore), not in the normalizer: the normalizer stays pure and stateless, and the
 * throttle decides only which already-normalized events are worth storing. It reads the time from each event's `ts`
 * (the receive time HuddleCore stamped), never from a clock.
 *
 * Rule, per session and separately for `context.measured` and `limits.measured`:
 *   1. a reading equal to the last stored one is dropped (context: usedTokens, windowTokens; limits: the four
 *      rate-limit fields, `measuredAt` ignored). usedPct is derived from used/window, so it is covered;
 *   2. a changed reading is stored at once when it is significant: the context window size changed, the context
 *      used share moved by >= SIGNIFICANT_PCT_POINTS, a rate-limit window reset/appeared/disappeared
 *      (a `resetsAt` or a null-ness changed) or a rate-limit share moved by >= SIGNIFICANT_PCT_POINTS;
 *   3. any other change is stored only if MIN_STORE_INTERVAL_MS has passed since the last stored reading of that kind.
 * A small change dropped by rule 3 is at most 1 percentage point; the next reading after the interval carries it.
 *
 * Memory is bounded: at most MAX_TRACKED_SESSIONS sessions are remembered, least recently updated dropped first
 * (a dropped session just stores its next reading).
 */
import type { ContextMeasured, HuddleEvent, LimitsMeasured, RateLimits } from '@huddle/shared';

/** At most one stored non-significant reading per session and kind in this window. */
export const MIN_STORE_INTERVAL_MS = 5_000;
/** A change of this many percentage points (context used share or a rate-limit share) is stored at once. */
export const SIGNIFICANT_PCT_POINTS = 1;
/** Sessions whose last reading is remembered; the least recently updated one is forgotten first. */
export const MAX_TRACKED_SESSIONS = 200;

interface Stored<T> {
  value: T;
  ts: number;
}

interface SessionReadings {
  context?: Stored<Pick<ContextMeasured, 'usedTokens' | 'windowTokens'>>;
  limits?: Stored<Omit<RateLimits, 'measuredAt'>>;
}

function pctOf(c: Pick<ContextMeasured, 'usedTokens' | 'windowTokens'>): number | null {
  return c.windowTokens !== null && c.windowTokens > 0 ? (c.usedTokens / c.windowTokens) * 100 : null;
}

function movedBy(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) >= SIGNIFICANT_PCT_POINTS;
}

export class StatuslineThrottle {
  private readonly sessions = new Map<string, SessionReadings>();

  constructor(private readonly maxSessions = MAX_TRACKED_SESSIONS) {}

  /** The events worth storing, in order. Events other than status line readings pass through untouched. */
  admit(events: readonly HuddleEvent[]): HuddleEvent[] {
    return events.filter((event) => {
      if (event.source !== 'statusline') return true;
      if (event.type === 'context.measured') return this.admitContext(event);
      if (event.type === 'limits.measured') return this.admitLimits(event);
      return true;
    });
  }

  /** Number of sessions remembered (for tests). */
  get size(): number {
    return this.sessions.size;
  }

  private admitContext(event: ContextMeasured): boolean {
    const readings = this.readings(event.sessionId);
    const value = { usedTokens: event.usedTokens, windowTokens: event.windowTokens };
    const last = readings.context;
    if (last) {
      if (last.value.usedTokens === value.usedTokens && last.value.windowTokens === value.windowTokens) return false;
      const significant = last.value.windowTokens !== value.windowTokens || movedBy(pctOf(last.value), pctOf(value));
      if (!significant && event.ts - last.ts < MIN_STORE_INTERVAL_MS) return false;
    }
    readings.context = { value, ts: event.ts };
    this.touch(event.sessionId, readings);
    return true;
  }

  private admitLimits(event: LimitsMeasured): boolean {
    const readings = this.readings(event.sessionId);
    const { measuredAt: _measuredAt, ...value } = event.limits;
    const last = readings.limits;
    if (last) {
      const prev = last.value;
      if (
        prev.fiveHourUsedPct === value.fiveHourUsedPct &&
        prev.fiveHourResetsAt === value.fiveHourResetsAt &&
        prev.sevenDayUsedPct === value.sevenDayUsedPct &&
        prev.sevenDayResetsAt === value.sevenDayResetsAt
      ) {
        return false;
      }
      const significant =
        prev.fiveHourResetsAt !== value.fiveHourResetsAt ||
        prev.sevenDayResetsAt !== value.sevenDayResetsAt ||
        movedBy(prev.fiveHourUsedPct, value.fiveHourUsedPct) ||
        movedBy(prev.sevenDayUsedPct, value.sevenDayUsedPct);
      if (!significant && event.ts - last.ts < MIN_STORE_INTERVAL_MS) return false;
    }
    readings.limits = { value, ts: event.ts };
    this.touch(event.sessionId, readings);
    return true;
  }

  private readings(sessionId: string): SessionReadings {
    return this.sessions.get(sessionId) ?? {};
  }

  /** Re-inserts the session as the most recent one and forgets the oldest beyond the bound. */
  private touch(sessionId: string, readings: SessionReadings): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, readings);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
  }
}
