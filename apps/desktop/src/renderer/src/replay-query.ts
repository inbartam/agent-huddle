/**
 * Replay questions on `huddle:query` (M5, F22): the run's state at an event index (`history.stateAt`) and a page of
 * one agent's events up to it (`history.events`). Like history-query.ts, the answer is checked here: a result of the
 * wrong type or shape reads as `failed`, and a missing bridge as "unavailable in this build".
 *
 * `LatestLoader` keeps only the newest question's answer: moving the scrubber asks again, and an answer that comes
 * back for an older position is dropped, so the screen never jumps back.
 */
import {
  HISTORY_EVENTS_MAX,
  type AgentKey,
  type HuddleQuery,
  type QueryResult,
  type ReplayEventsPage,
  type ReplayMoment,
} from '@huddle/shared';
import { QUERY_FAILED, QUERY_UNAVAILABLE, type QueryFn } from './query.js';

type Failed = Extract<QueryResult, { ok: false }>;

const unavailable: Failed = { ok: false, code: 'unsupported', message: QUERY_UNAVAILABLE };
const failed: Failed = { ok: false, code: 'failed', message: QUERY_FAILED };

type Rec = Record<string, unknown>;

function isObject(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null;
}

async function ask(query: QueryFn | null, q: HuddleQuery): Promise<{ ok: true; r: Rec } | Failed> {
  if (query === null) return unavailable;
  try {
    const r: unknown = await query(q);
    if (!isObject(r)) return failed;
    if (r['ok'] === false) {
      return typeof r['message'] === 'string' && typeof r['code'] === 'string' ? (r as unknown as Failed) : failed;
    }
    return r['ok'] === true && r['type'] === q.type ? { ok: true, r } : failed;
  } catch {
    return failed;
  }
}

function isRef(v: unknown): boolean {
  return (
    isObject(v) &&
    typeof v['index'] === 'number' &&
    typeof v['ts'] === 'number' &&
    typeof v['type'] === 'string' &&
    typeof v['agentKey'] === 'string'
  );
}

function isState(v: unknown): boolean {
  return isObject(v) && isObject(v['agents']) && Array.isArray(v['rootKeys']) && Array.isArray(v['inbox']);
}

export type MomentAnswer = { ok: true; moment: ReplayMoment } | Failed;

/** The run just after event `index`; the core clamps the index to the last event. */
export async function loadMoment(query: QueryFn | null, sessionId: string, index: number): Promise<MomentAnswer> {
  const a = await ask(query, { type: 'history.stateAt', sessionId, index: Math.max(0, Math.round(index)) });
  if (!a.ok) return a;
  const m = a.r['moment'];
  if (
    !isObject(m) ||
    typeof m['index'] !== 'number' ||
    typeof m['eventCount'] !== 'number' ||
    !isRef(m['event']) ||
    !isState(m['state']) ||
    !Array.isArray(m['why'])
  ) {
    return failed;
  }
  const why = (m['why'] as unknown[]).filter(
    (w) => isObject(w) && typeof w['itemId'] === 'string' && typeof w['title'] === 'string' && isObject(w['later']),
  );
  return { ok: true, moment: { ...(m as unknown as ReplayMoment), why: why as ReplayMoment['why'] } };
}

export interface EventsAsk {
  sessionId: string;
  /** Newest event to include (the replay position). */
  index: number;
  agentKey: AgentKey;
  limit: number;
}

export type EventsAnswer = { ok: true; page: ReplayEventsPage } | Failed;

/** One agent's events from `index` back, newest first, whole (for the timeline rows). */
export async function loadEventsUpTo(query: QueryFn | null, e: EventsAsk): Promise<EventsAnswer> {
  const a = await ask(query, {
    type: 'history.events',
    sessionId: e.sessionId,
    fromIndex: Math.max(0, e.index),
    limit: Math.min(HISTORY_EVENTS_MAX, Math.max(1, e.limit)),
    backward: true,
    agentKey: e.agentKey,
    full: true,
  });
  if (!a.ok) return a;
  const page = a.r['page'];
  if (!isObject(page) || !Array.isArray(page['entries']) || typeof page['eventCount'] !== 'number') return failed;
  const entries = (page['entries'] as unknown[]).filter(isRef) as ReplayEventsPage['entries'];
  return { ok: true, page: { entries, eventCount: page['eventCount'], more: page['more'] === true } };
}

// ---------------------------------------------------------------------------
// Only the newest answer counts
// ---------------------------------------------------------------------------

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/** While dragging, the question waits this long after the last move. */
export const DRAG_DEBOUNCE_MS = 120;

/**
 * Asks `load(key)` and hands the answer to `onAnswer`, but only for the newest `go`. `now` asks at once (a key, a
 * button, a marker); `later` waits `delayMs` after the last call (dragging the thumb). Answers to older questions,
 * and answers after `dispose`, are dropped.
 */
export class LatestLoader<K, A> {
  private seq = 0;
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly load: (key: K) => Promise<A>,
    private readonly onAnswer: (answer: A, key: K) => void,
    private readonly delayMs = DRAG_DEBOUNCE_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  go(key: K, how: 'now' | 'later' = 'now'): void {
    if (this.disposed) return;
    const n = ++this.seq;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    if (how === 'now') {
      this.fire(n, key);
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.fire(n, key);
    }, this.delayMs);
  }

  private fire(n: number, key: K): void {
    void this.load(key).then((answer) => {
      if (this.disposed || n !== this.seq) return; // a newer question is on its way
      this.onAnswer(answer, key);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
