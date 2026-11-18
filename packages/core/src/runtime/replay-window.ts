/**
 * Which stored sessions the start-up replay loads into the live state (M5, F22; owner's decisions 2026-11-14).
 *
 * Loaded: every session that has not ended, every session whose last event is less than 24 hours old, the sessions
 * named in `always` (the overall-budget pseudo session, runs still listed in runs.json), and, while an overall budget
 * is in force, every session active since it was set (`activeSince`). The overall budget counts every session summed
 * (shared/manage.ts `selectBudgetUsed`), so a restart must not drop the sessions it has been counting. Everything else
 * stays in the database for the history view and is not in the tree. Pure: the time and the budget events are passed in.
 */
import type { HuddleEvent } from '@huddle/shared';

/** How far back an ended session is still loaded at start-up. */
export const REPLAY_RECENT_MS = 24 * 60 * 60 * 1000;

/** The fields the choice reads (a `StoredSession` has them all). */
export interface ReplayCandidate {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  ended: boolean;
}

export interface ReplayWindowOptions {
  /** Epoch ms of this start. */
  now: number;
  /** Default `REPLAY_RECENT_MS`. */
  recentMs?: number;
  /** Session ids loaded whatever their age (compared without case: run ids are UUIDs). */
  always?: Iterable<string>;
  /** Also load every session whose last event is at or after this time (`activeOverallBudgetSince`). */
  activeSince?: number | null;
}

/**
 * `setAt` of the overall budget in force after these events (the overall-budget pseudo session's log, in order), or
 * null when none is.
 *
 * "In force" follows the reducer (state/reduce.ts `onBudgetSet`): budgets are keyed by scope and target, and the
 * overall budget has no target, so at most one overall budget exists at a time. A `budget.set` with scope `overall`
 * and at least one limit replaces it, with that event's `ts` as the new `setAt` (the detector checks a new setting
 * afresh); one with no limit clears it. So the "earliest still-active" overall budget is the one left after the last
 * such event, and its `setAt` is the event time of the setting that made it.
 */
export function activeOverallBudgetSince(events: Iterable<HuddleEvent>): number | null {
  let since: number | null = null;
  for (const event of events) {
    if (event.type !== 'budget.set' || event.scope !== 'overall') continue;
    const { maxTokens, maxEstimatedCostUsd, maxMinutes } = event.budget;
    const hasLimit = maxTokens !== undefined || maxEstimatedCostUsd !== undefined || maxMinutes !== undefined;
    since = hasLimit ? event.ts : null;
  }
  return since;
}

/**
 * The sessions to replay, oldest first (by first event, then session id), so the state is built in the order the
 * sessions began, as the JSONL replay did.
 */
export function selectReplaySessions<T extends ReplayCandidate>(
  records: readonly T[],
  options: ReplayWindowOptions,
): T[] {
  const cutoff = options.now - (options.recentMs ?? REPLAY_RECENT_MS);
  const always = new Set([...(options.always ?? [])].map((id) => id.toLowerCase()));
  const since = options.activeSince ?? null;
  return records
    .filter(
      (r) =>
        !r.ended ||
        r.lastTs >= cutoff ||
        (since !== null && r.lastTs >= since) ||
        always.has(r.sessionId.toLowerCase()),
    )
    .sort((a, b) => a.firstTs - b.firstTs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}
