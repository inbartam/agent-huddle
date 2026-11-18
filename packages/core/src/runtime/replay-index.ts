/**
 * Replay index (M5 WP4b, F22): what `history.open`, `history.stateAt` and `history.events` need from one session's
 * stored log, built in one pass and kept in memory for a few sessions.
 *
 * Replay is reduce over a prefix (CONTRIBUTING.md rule 1): the state after event i is `replay(events[0..i])`, nothing else.
 * To answer that quickly for any i, the pass that reads the log also folds it and keeps the reducer state every
 * `interval` events (500, more only for a huge session; see `checkpointInterval`). `stateAt(i)` then starts from the
 * nearest checkpoint at or before i and reduces at most `interval - 1` events, read back from the database by `seq`
 * in chunks of STATE_AT_CHUNK with a yield between two chunks. Snapshots never go to disk.
 *
 * Besides the checkpoints the index keeps, per event, only small facts: its `seq`, time, type and agent (interned),
 * plus what the scrubber markers and the "Why it needs attention" facts need (tool calls and how they ended, when each
 * attention item was raised and how it ended). Event bodies stay in the database.
 *
 * Never blocking the hook server: the pass reads `READ_CHUNK` rows at a time and yields to the event loop between
 * chunks (hook answers have a 20 ms budget); `stateAt` reads and reduces at most STATE_AT_CHUNK events between two
 * yields, whatever the interval (M5 security review L2: a wide interval used to mean one long synchronous step).
 *
 * Memory bound, per cached session of n events: about 6 numbers per event in plain arrays (~50 bytes), the one-line
 * summary of every tool call, and n / interval reducer states. The states share everything a step did not change (the
 * reducer copies only what an event touches), and `checkpointInterval` keeps their number at or below
 * MAX_CHECKPOINTS. `ReplayCache` keeps at most `maxSessions` (default 3) sessions, least recently used out first.
 * A session of more than MAX_INDEXED_EVENTS events is not indexed at all (`SessionTooLargeError`, L2): its per-event
 * arrays would grow without bound, so replay says why instead.
 */
import { CLIP_LIMITS } from '@huddle/shared';
import type {
  AgentKey,
  AttentionItem,
  HuddleEvent,
  QuietGap,
  ReplayEventRef,
  ReplayLater,
  ReplayMarker,
  ReplayMarkerKind,
  ReplayToolCall,
  ReplayToolFate,
  ReplayWhy,
} from '@huddle/shared';
import { clip } from '../text.js';
import { approvalItemId, initialState, questionItemId, reduce, type ReducerState } from '../state/reduce.js';
import type { StoredRow } from '../store/history-tables.js';

/** Reducer state kept every this many events (the cache boundary the tests cross: 499, 500, 501). */
export const CHECKPOINT_EVERY = 500;
/** At most this many checkpoints per session; a longer log gets a wider interval (a multiple of CHECKPOINT_EVERY). */
export const MAX_CHECKPOINTS = 400;
/** Rows read (and folded) between two yields to the event loop. */
export const READ_CHUNK = 250;
/** Events `stateAt` reads and reduces between two yields (L2). */
export const STATE_AT_CHUNK = 500;
/** The most events one session index holds (L2); a larger session is refused for replay. */
export const MAX_INDEXED_EVENTS = 2_000_000;

/** The session has more events than replay indexes (L2). Its message is in the UI's words. */
export class SessionTooLargeError extends Error {
  constructor(
    readonly events: number,
    readonly limit: number,
  ) {
    super(`This run has more than ${limit.toLocaleString('en-US')} events, too many to replay here.`);
    this.name = 'SessionTooLargeError';
  }
}

/** Limits a test lowers; the defaults are the constants above. */
export interface IndexLimits {
  checkpointEvery?: number;
  maxCheckpoints?: number;
  maxEvents?: number;
  stateAtChunk?: number;
}
/** The most scrubber markers (and quiet gaps) one head carries. */
export const MAX_MARKERS = 5000;

/** Claude Code's own question box in older logs: an approval request that opens nothing (reducer). */
const QUESTION_TOOL = 'AskUserQuestion';

/** Kinds that mark the scrubber when raised. */
const MARKED_KINDS: ReadonlySet<string> = new Set(['stuck', 'loop', 'file_conflict', 'budget']);
/** Open items that get no "Why it needs attention" block (they never needed the user). */
const NO_WHY_KINDS: ReadonlySet<string> = new Set(['finished', 'context_high']);

/** Where the index reads rows (HistoryTables in the app). */
export interface RowSource {
  rowsAfter(sessionId: string, afterSeq: number, limit: number): StoredRow[];
  rowsBetween(sessionId: string, fromSeq: number, toSeq: number, agentKey?: string): StoredRow[];
}

export type YieldNow = () => Promise<void>;

export const yieldToEventLoop: YieldNow = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The checkpoint interval for a log of about `expectedEvents`: 500, or the next multiple keeping MAX_CHECKPOINTS. */
export function checkpointInterval(
  expectedEvents: number,
  every: number = CHECKPOINT_EVERY,
  maxCheckpoints: number = MAX_CHECKPOINTS,
): number {
  const n = Number.isFinite(expectedEvents) ? Math.max(0, expectedEvents) : 0;
  return every * Math.max(1, Math.ceil(n / (every * maxCheckpoints)));
}

interface ToolStart {
  index: number;
  toolUseId: string | null;
  toolName: string;
  summary: string;
}

interface ToolEnd {
  index: number;
  fate: Exclude<ReplayToolFate, { state: 'open' }>;
}

interface ItemEnd {
  index: number;
  later: Exclude<ReplayLater, { kind: 'still_open' }>;
}

/** Largest position in sorted `list` whose value is <= x, or -1. */
function lastAtOrBefore(list: readonly number[], x: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as number) <= x) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

export class SessionIndex {
  readonly interval: number;
  /** The most events this index takes (MAX_INDEXED_EVENTS unless a test lowers it). */
  readonly maxEvents: number;
  /** Events `stateAt` reduces between two yields. */
  readonly stateAtChunk: number;
  /** Events indexed (rows whose JSON was not an event are skipped, as `readSession` skips them). */
  count = 0;
  /** `seq` of the last row read, parsed or not. */
  lastSeq = 0;
  /** Rows read, parsed or not (what `sessions.event_count` counts). */
  rowsRead = 0;
  readonly seq: number[] = [];
  readonly ts: number[] = [];
  private readonly agentOf: number[] = [];
  private readonly typeOf: number[] = [];
  private readonly agents: string[] = [];
  private readonly agentIds = new Map<string, number>();
  private readonly types: HuddleEvent['type'][] = [];
  private readonly typeIds = new Map<string, number>();
  /** Per agent, the indexes of its own events (source not 'huddle': detector output is not the agent reporting). */
  private readonly ownEvents = new Map<number, number[]>();
  private readonly toolStarts = new Map<number, ToolStart[]>();
  private readonly toolEnds = new Map<string, ToolEnd[]>();
  private readonly raises = new Map<string, number[]>();
  private readonly ends = new Map<string, ItemEnd[]>();
  private readonly openRaised = new Set<string>();
  /** `checkpoints[k]`: the state after the first k * interval events. */
  private readonly checkpoints: ReducerState[] = [initialState()];
  /** The state after every indexed event. */
  last: ReducerState = initialState();
  readonly markers: ReplayMarker[] = [];
  markersTruncated = false;

  constructor(
    readonly sessionId: string,
    readonly expectedEvents = 0,
    limits: IndexLimits = {},
  ) {
    this.interval = checkpointInterval(expectedEvents, limits.checkpointEvery, limits.maxCheckpoints);
    this.maxEvents = Math.max(1, limits.maxEvents ?? MAX_INDEXED_EVENTS);
    this.stateAtChunk = Math.max(1, limits.stateAtChunk ?? STATE_AT_CHUNK);
  }

  private intern(map: Map<string, number>, list: string[], value: string): number {
    let id = map.get(value);
    if (id === undefined) {
      id = list.length;
      list.push(value);
      map.set(value, id);
    }
    return id;
  }

  agentIndex(agentKey: string): number | undefined {
    return this.agentIds.get(agentKey);
  }

  agentAt(i: number): AgentKey {
    return this.agents[this.agentOf[i] ?? -1] ?? '';
  }

  typeAt(i: number): HuddleEvent['type'] {
    return this.types[this.typeOf[i] ?? -1] ?? 'notification.raised';
  }

  ref(i: number): ReplayEventRef {
    return { index: i, ts: this.ts[i] ?? 0, type: this.typeAt(i), agentKey: this.agentAt(i) };
  }

  private mark(index: number, e: HuddleEvent, kind: ReplayMarkerKind, itemId: string | null): void {
    if (this.markers.length >= MAX_MARKERS) {
      this.markersTruncated = true;
      return;
    }
    this.markers.push({ index, ts: e.ts, kind, agentKey: e.agentKey, itemId });
  }

  private raise(index: number, itemId: string): void {
    push(this.raises, itemId, index);
  }

  private end(itemId: string, end: ItemEnd): void {
    push(this.ends, itemId, end);
  }

  /** Folds one event into the index (rows in log order). */
  add(event: HuddleEvent, seq: number): void {
    if (this.count >= this.maxEvents) throw new SessionTooLargeError(this.count + 1, this.maxEvents);
    const i = this.count;
    const agent = this.intern(this.agentIds, this.agents, event.agentKey);
    this.seq.push(seq);
    this.ts.push(event.ts);
    this.agentOf.push(agent);
    this.typeOf.push(this.intern(this.typeIds, this.types, event.type));
    if (event.source !== 'huddle') push(this.ownEvents, agent, i);

    switch (event.type) {
      case 'tool.started':
        push(this.toolStarts, agent, {
          index: i,
          toolUseId: event.toolUseId,
          toolName: clip(event.toolName, CLIP_LIMITS.id),
          summary: clip(event.summary, CLIP_LIMITS.summary),
        });
        break;
      case 'tool.finished':
        if (event.toolUseId !== null) {
          push(this.toolEnds, event.toolUseId, {
            index: i,
            fate: { state: 'finished', endedTs: event.ts, durationMs: event.durationMs },
          });
          // PostToolUse(AskUserQuestion): the question was answered, here or in the terminal (reducer).
          const questionId = questionItemId(event.toolUseId);
          if (this.raises.has(questionId)) {
            this.end(questionId, { index: i, later: { kind: 'question_answered', index: i, ts: event.ts } });
          }
        }
        break;
      case 'tool.failed':
        if (event.toolUseId !== null) {
          push(this.toolEnds, event.toolUseId, {
            index: i,
            fate: {
              state: 'failed',
              endedTs: event.ts,
              error: clip(event.error, CLIP_LIMITS.error),
              interrupted: event.interrupted,
            },
          });
        }
        this.mark(i, event, 'failure', null);
        break;
      case 'turn.failed':
        this.mark(i, event, 'failure', null);
        break;
      case 'run.exited':
        if (event.how === 'failed' || event.how === 'spawn_failed') this.mark(i, event, 'failure', null);
        break;
      case 'approval.requested': {
        if (event.request.toolName === QUESTION_TOOL) break;
        const itemId = approvalItemId(event.request.requestId);
        this.raise(i, itemId);
        this.mark(i, event, 'approval', itemId);
        break;
      }
      case 'approval.resolved':
        this.end(approvalItemId(event.requestId), {
          index: i,
          later: { kind: 'approval', index: i, ts: event.ts, outcome: event.outcome, by: event.by },
        });
        break;
      case 'question.asked': {
        const itemId = questionItemId(event.request.requestId);
        this.raise(i, itemId);
        this.mark(i, event, 'question', itemId);
        break;
      }
      case 'question.answered':
        this.end(questionItemId(event.requestId), {
          index: i,
          later: { kind: 'question_answered', index: i, ts: event.ts },
        });
        break;
      case 'question.closed':
        this.end(questionItemId(event.requestId), {
          index: i,
          later: { kind: 'question_closed', index: i, ts: event.ts, outcome: event.outcome },
        });
        break;
      case 'attention.raised': {
        const item = event.item;
        this.raise(i, item.id);
        // A re-raise while the item is still open is the same incident: one marker.
        if (!this.openRaised.has(item.id)) {
          this.openRaised.add(item.id);
          if (MARKED_KINDS.has(item.kind)) this.mark(i, event, item.kind as ReplayMarkerKind, item.id);
        }
        break;
      }
      case 'attention.resolved':
        this.openRaised.delete(event.itemId);
        this.end(event.itemId, {
          index: i,
          later: {
            kind: 'cleared',
            index: i,
            ts: event.ts,
            reason: event.reason === 'dismissed' ? 'dismissed' : 'condition_cleared',
          },
        });
        break;
      default:
        break;
    }

    this.last = reduce(this.last, event);
    this.count += 1;
    if (this.count % this.interval === 0) this.checkpoints.push(this.last);
  }

  /**
   * False when the log does not begin with the session's start: the first event that is not the Huddle's own
   * bookkeeping (a run's launch and worktree, role descriptions, budgets) is something other than `session.started`.
   */
  startsWithSession(): boolean {
    for (let i = 0; i < this.count; i++) {
      const type = this.typeAt(i);
      if (type.startsWith('run.') || type.startsWith('worktree.') || type === 'role.described') continue;
      if (type === 'budget.set') continue;
      return type === 'session.started';
    }
    return false;
  }

  /** Silences longer than `thresholdMs` between consecutive events (at most MAX_MARKERS). */
  quietGaps(thresholdMs: number): QuietGap[] {
    const gaps: QuietGap[] = [];
    for (let i = 0; i + 1 < this.count && gaps.length < MAX_MARKERS; i++) {
      const ms = (this.ts[i + 1] ?? 0) - (this.ts[i] ?? 0);
      if (ms > thresholdMs) gaps.push({ afterIndex: i, ms });
    }
    return gaps;
  }

  /**
   * The state just after event `i` (0 <= i < count): the nearest checkpoint at or before it, then the events after it
   * read back from `source`, `stateAtChunk` events per read with a yield between two reads, so no synchronous step
   * grows with the interval (L2). Equal to `replay(events[0..i])`. The caller keeps the index from changing meanwhile
   * (`ReplayCache.use` runs the work on its queue).
   */
  async stateAt(i: number, source: RowSource, yieldNow: YieldNow = yieldToEventLoop): Promise<ReducerState> {
    const n = i + 1;
    if (n >= this.count) return this.last;
    const k = Math.floor(n / this.interval);
    const base = this.checkpoints[k];
    const from = k * this.interval;
    if (base === undefined) throw new Error('replay index: missing checkpoint');
    if (from === n) return base;
    let state = base;
    for (let start = from; start <= i; start += this.stateAtChunk) {
      const end = Math.min(i, start + this.stateAtChunk - 1);
      for (const row of source.rowsBetween(this.sessionId, this.seq[start] ?? 0, this.seq[end] ?? 0)) {
        if (row.event !== null) state = reduce(state, row.event);
      }
      if (end < i) await yieldNow();
    }
    return state;
  }

  /** The agent's last tool call at or before `i`, and what had become of it by then. */
  private lastToolCall(agentKey: AgentKey, i: number): ReplayToolCall | null {
    const agent = this.agentIds.get(agentKey);
    const starts = agent === undefined ? undefined : this.toolStarts.get(agent);
    if (starts === undefined) return null;
    const at = lastAtOrBefore(
      starts.map((s) => s.index),
      i,
    );
    const start = at < 0 ? undefined : starts[at];
    if (start === undefined) return null;
    let fate: ReplayToolFate = { state: 'open' };
    if (start.toolUseId !== null) {
      for (const end of this.toolEnds.get(start.toolUseId) ?? []) {
        if (end.index > start.index && end.index <= i && this.agentOf[end.index] === agent) {
          fate = end.fate;
          break;
        }
      }
    }
    return { toolName: start.toolName, summary: start.summary, startedTs: this.ts[start.index] ?? 0, fate };
  }

  /** From the agent's last own event before `i` to the event at `i`; null when it has none before. */
  private quietMs(agentKey: AgentKey, i: number): number | null {
    const agent = this.agentIds.get(agentKey);
    const own = agent === undefined ? undefined : this.ownEvents.get(agent);
    if (own === undefined) return null;
    const at = lastAtOrBefore(own, i - 1);
    if (at < 0) return null;
    return (this.ts[i] ?? 0) - (this.ts[own[at] ?? 0] ?? 0);
  }

  /** Where the item's current episode began: the first raise after its last ending at or before `i`. */
  private raisedIndex(itemId: string, i: number): number {
    const raises = this.raises.get(itemId) ?? [];
    const ends = (this.ends.get(itemId) ?? []).map((e) => e.index);
    const lastEnd = ends[lastAtOrBefore(ends, i)] ?? -1;
    for (const r of raises) if (r > lastEnd && r <= i) return r;
    const last = raises[lastAtOrBefore(raises, i)];
    return last ?? i;
  }

  private later(itemId: string, i: number): ReplayLater {
    for (const end of this.ends.get(itemId) ?? []) if (end.index > i) return end.later;
    return { kind: 'still_open' };
  }

  /** "Why it needs attention" for every item open in `state` (the state at `i`), any agent of the run. */
  whyAt(state: ReducerState, i: number): ReplayWhy[] {
    const atTs = this.ts[i] ?? 0;
    return state.inbox
      .filter((item) => item.resolvedAt === null && !NO_WHY_KINDS.has(item.kind))
      .map((item): ReplayWhy => {
        const raisedIndex = this.raisedIndex(item.id, i);
        const raisedTs = this.ts[raisedIndex] ?? atTs;
        return {
          itemId: item.id,
          kind: item.kind,
          agentKey: item.agentKey,
          title: clip(item.title, CLIP_LIMITS.summary),
          detail: clip(item.detail, CLIP_LIMITS.summary),
          raisedIndex,
          raisedTs,
          lastToolCall: this.lastToolCall(item.agentKey, i),
          quietMs: this.quietMs(item.agentKey, i),
          request: requestOf(item, Math.max(0, atTs - raisedTs)),
          later: this.later(item.id, i),
        };
      });
  }

  /**
   * Event indexes for a `history.events` page: from `fromIndex` forward (ascending) or backward (descending), one
   * agent's only when `agentKey` is given. `more`: entries exist beyond the page in that direction.
   */
  page(
    fromIndex: number,
    limit: number,
    options: { backward?: boolean; agentKey?: AgentKey } = {},
  ): { indexes: number[]; more: boolean } {
    const out: number[] = [];
    if (this.count === 0) return { indexes: out, more: false };
    const start = Math.min(Math.max(0, fromIndex), this.count - 1);
    const agent = options.agentKey === undefined ? undefined : this.agentIds.get(options.agentKey);
    if (options.agentKey !== undefined && agent === undefined) return { indexes: out, more: false };
    const step = options.backward === true ? -1 : 1;
    for (let i = start; i >= 0 && i < this.count; i += step) {
      if (agent !== undefined && this.agentOf[i] !== agent) continue;
      if (out.length === limit) return { indexes: out, more: true };
      out.push(i);
    }
    return { indexes: out, more: false };
  }
}

function requestOf(item: AttentionItem, waitedMs: number): ReplayWhy['request'] {
  if (item.approval !== undefined) return { summary: clip(item.approval.summary, CLIP_LIMITS.summary), waitedMs };
  if (item.question !== undefined) {
    const text = item.question.questions[0]?.question ?? item.title;
    return { summary: clip(text, CLIP_LIMITS.summary), waitedMs };
  }
  return null;
}

/** Reads every row after the index's last one into it, `READ_CHUNK` at a time, yielding between chunks. */
export async function extendIndex(index: SessionIndex, source: RowSource, yieldNow: YieldNow): Promise<void> {
  // Refused before reading anything when the stored count already says it is too large (L2).
  if (index.count === 0 && index.expectedEvents > index.maxEvents) {
    throw new SessionTooLargeError(index.expectedEvents, index.maxEvents);
  }
  for (;;) {
    const rows = source.rowsAfter(index.sessionId, index.lastSeq, READ_CHUNK);
    for (const row of rows) {
      index.lastSeq = row.seq;
      index.rowsRead += 1;
      if (row.event !== null) index.add(row.event, row.seq);
    }
    if (rows.length < READ_CHUNK) return;
    await yieldNow();
  }
}

export interface ReplayCacheOptions {
  /** Sessions kept (least recently used out first). Default 3. */
  maxSessions?: number;
  yieldNow?: YieldNow;
  /** About how many events the session has (picks the checkpoint interval). */
  expectedEvents?: (sessionId: string) => number;
  /** Tests only: lower limits (see `IndexLimits`). */
  limits?: IndexLimits;
}

interface CacheEntry {
  index: SessionIndex;
  /** Work on this entry runs one after another (a build or an extension, then the readers). */
  queue: Promise<unknown>;
}

/** The replay indexes of the last few sessions looked at, each brought up to date (new rows folded in) on access. */
export class ReplayCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxSessions: number;
  private readonly yieldNow: YieldNow;

  constructor(
    private readonly source: RowSource,
    private readonly options: ReplayCacheOptions = {},
  ) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 3);
    this.yieldNow = options.yieldNow ?? yieldToEventLoop;
  }

  /** The session's index with every stored row folded in; `work` runs on it before anything else may extend it. */
  async use<T>(sessionId: string, work: (index: SessionIndex) => T | Promise<T>): Promise<T> {
    let entry = this.entries.get(sessionId);
    if (entry === undefined) {
      entry = {
        index: new SessionIndex(sessionId, this.options.expectedEvents?.(sessionId) ?? 0, this.options.limits),
        queue: Promise.resolve(),
      };
      this.entries.set(sessionId, entry);
      while (this.entries.size > this.maxSessions) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    } else {
      // Most recently used last.
      this.entries.delete(sessionId);
      this.entries.set(sessionId, entry);
    }
    const current = entry;
    const run = current.queue.then(async () => {
      await extendIndex(current.index, this.source, this.yieldNow);
      return work(current.index);
    });
    current.queue = run.catch(() => undefined);
    try {
      return await run;
    } catch (error) {
      // A failed read (or a session too large to index) leaves the index half built: drop it and its memory; the next
      // access starts again.
      if (this.entries.get(sessionId) === current) this.entries.delete(sessionId);
      throw error;
    }
  }

  /** Forget one session (it was deleted) or all. */
  clear(sessionId?: string): void {
    if (sessionId === undefined) this.entries.clear();
    else this.entries.delete(sessionId);
  }

  size(): number {
    return this.entries.size;
  }
}
