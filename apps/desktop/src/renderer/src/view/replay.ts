/**
 * Replay (M5, F22): the words and shapes of the Replay tab, pure (DESIGN.md "Replay (F22)", "Words for remembering
 * (M5)"). The component (components/Replay.tsx) only draws what these return.
 *
 * Replay is not live. Nothing here builds a command: the only things a replay can do are move the position, pick an
 * agent and expand a row. Agent text (titles, details, summaries, errors) stays plain text.
 */
import type {
  AgentKey,
  AttentionItem,
  AttentionKind,
  HuddleEvent,
  HuddleState,
  QueryResult,
  QuietGap,
  ReplayEventRef,
  ReplayLater,
  ReplayMarker,
  ReplayMarkerKind,
  ReplayToolFate,
  ReplayWhy,
} from '@huddle/shared';
import { clockTime, clockTimeFull, count, duration } from './format.js';
import { approvalEndingWords, kindWords, QUESTION_CLOSED_WORDS } from './inbox.js';
import type { StatusTone } from './status.js';
import { timelineRows, type TimelineRow } from './timeline.js';

export const REPLAY_WORDS = {
  band: 'Replay · not live',
  bandNote: 'Nothing here can be approved or sent.',
  position: 'Replay position',
  first: 'First event',
  back: 'Back one event',
  forward: 'Forward one event',
  last: 'Last event',
  prevAttention: 'Previous attention',
  nextAttention: 'Next attention',
  jumpBetween: 'Jump between',
  follow: 'Follow the event',
  why: 'Why it needs attention',
  alsoNeeds: 'Also needs attention at this point:',
  lastTool: 'Last tool call',
  later: 'Later:',
  noEta: "Time left isn't shown in a replay.",
  eventsHere: 'Events up to here',
  showEarlier: 'Show earlier',
  /** Said after the highlighted row when the event at the position is not a row itself. */
  nearest: 'nearest row to this point',
  loadNewer: 'Load newer events',
  showLive: 'Show live',
  empty: 'This run has no stored events.',
  deleted: 'This run was deleted by the history setting.',
  notAvailable: "Replay isn't available yet in this build.",
  tryAgain: 'Try again',
  noMoreAfter: 'No more of these after this point.',
  noMoreBefore: 'No more of these before this point.',
  noAttention: 'Nothing in this run needed you.',
  markersCut: 'Not every attention point fits on the track: the oldest ones are marked, the rest are left off.',
  notStarted: "This agent hasn't started at this point.",
  noEventsHere: 'Nothing from this agent up to this point.',
  noKindHere: 'Nothing of this kind up to this point.',
  pending: '…',
} as const;

// ---------------------------------------------------------------------------
// Position and stepping
// ---------------------------------------------------------------------------

export function clampIndex(index: number, eventCount: number): number {
  if (eventCount <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(eventCount - 1, Math.max(0, Math.round(index)));
}

/**
 * The slider's keys (they work while it has focus): Left/Down and Right/Up step one event, with Shift ten; Home and
 * End jump to the ends; PageUp and PageDown step ten. Null: not a stepping key.
 */
export function scrubKey(key: string, shift: boolean, index: number, eventCount: number): number | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clampIndex(index + step, eventCount);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampIndex(index - step, eventCount);
    case 'PageUp':
      return clampIndex(index + 10, eventCount);
    case 'PageDown':
      return clampIndex(index - 10, eventCount);
    case 'Home':
      return 0;
    case 'End':
      return clampIndex(eventCount - 1, eventCount);
    default:
      return null;
  }
}

/** Where index sits along the track, 0..100. */
export function trackPct(index: number, eventCount: number): number {
  if (eventCount <= 1) return 0;
  return (clampIndex(index, eventCount) / (eventCount - 1)) * 100;
}

/** "event 412 of 1,280" (1-based for people). */
export function positionWords(index: number, eventCount: number): string {
  return `event ${count(index + 1)} of ${count(eventCount)}`;
}

// ---------------------------------------------------------------------------
// Attention points ("Jump between")
// ---------------------------------------------------------------------------

export type JumpFilter = 'everything' | 'stuck' | 'failures' | 'approvals';

export const JUMP_OPTIONS: readonly { value: JumpFilter; label: string }[] = [
  { value: 'everything', label: 'Everything that needed you' },
  { value: 'stuck', label: 'Stuck or looping' },
  { value: 'failures', label: 'Failures' },
  { value: 'approvals', label: 'Approvals and questions' },
];

export function isJumpFilter(v: string): v is JumpFilter {
  return JUMP_OPTIONS.some((o) => o.value === v);
}

/** Markers are already only the kinds that needed the user (no `finished`, no `context_high`). */
export function markerCounts(kind: ReplayMarkerKind, filter: JumpFilter): boolean {
  switch (filter) {
    case 'everything':
      return true;
    case 'stuck':
      return kind === 'stuck' || kind === 'loop';
    case 'failures':
      return kind === 'failure';
    case 'approvals':
      return kind === 'approval' || kind === 'question';
  }
}

/** The next (dir 1) or previous (dir -1) attention point strictly after or before `index`; null when none. */
export function nextAttention(
  markers: readonly ReplayMarker[],
  index: number,
  filter: JumpFilter,
  dir: 1 | -1,
): ReplayMarker | null {
  const ok = markers.filter((m) => markerCounts(m.kind, filter));
  if (dir === 1) return ok.find((m) => m.index > index) ?? null;
  for (let i = ok.length - 1; i >= 0; i -= 1) {
    const m = ok[i];
    if (m !== undefined && m.index < index) return m;
  }
  return null;
}

/**
 * N and Shift+N anywhere in the replay frame, except in a text field: the attention point to go to, null when there
 * is none that way, undefined when the key is not this shortcut.
 */
export function attentionKey(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  inTextField: boolean,
  markers: readonly ReplayMarker[],
  index: number,
  filter: JumpFilter,
): ReplayMarker | null | undefined {
  if (e.key.toLowerCase() !== 'n' || e.ctrlKey || e.altKey || e.metaKey || inTextField) return undefined;
  return nextAttention(markers, index, filter, e.shiftKey ? -1 : 1);
}

// ---------------------------------------------------------------------------
// Markers on the track
// ---------------------------------------------------------------------------

export interface MarkerLook {
  glyph: string;
  tone: StatusTone;
  words: string;
  /** Which glyph a merged marker shows: the highest. */
  urgency: number;
}

const NEEDS_YOU: StatusTone = 'needs-you';

export const MARKER_LOOK: Record<ReplayMarkerKind, MarkerLook> = {
  approval: { glyph: '▲', tone: NEEDS_YOU, words: 'Approval requested', urgency: 3 },
  question: { glyph: '▲', tone: NEEDS_YOU, words: 'Question asked', urgency: 3 },
  stuck: { glyph: '!', tone: NEEDS_YOU, words: 'looks stuck', urgency: 2 },
  loop: { glyph: '!', tone: NEEDS_YOU, words: 'may be in a loop', urgency: 2 },
  file_conflict: { glyph: '!', tone: NEEDS_YOU, words: 'file conflict', urgency: 2 },
  budget: { glyph: '!', tone: NEEDS_YOU, words: 'budget', urgency: 2 },
  failure: { glyph: '✕', tone: 'failed', words: 'failed', urgency: 1 },
};

/** A marker kind this build does not know (a newer core) gets a neutral look. */
export function markerLook(kind: string): MarkerLook {
  return (
    (MARKER_LOOK as Record<string, MarkerLook | undefined>)[kind] ?? {
      glyph: '!',
      tone: NEEDS_YOU,
      words: 'needed attention',
      urgency: 0,
    }
  );
}

export interface MarkerGroup {
  key: string;
  /** Where a click jumps: the group's first event. */
  index: number;
  leftPct: number;
  glyph: string;
  tone: StatusTone;
  count: number;
  title: string;
}

/** Markers closer than this on screen merge into one. */
export const MARKER_MERGE_PX = 6;

function markerTitle(m: ReplayMarker): string {
  return `${markerLook(m.kind).words} at ${clockTimeFull(m.ts)}`;
}

/**
 * Markers laid out on a track `trackPx` wide. Markers closer than 6 px merge: the group shows the most urgent glyph
 * (▲ over ! over ✕) and its tooltip counts them.
 */
export function layoutMarkers(markers: readonly ReplayMarker[], eventCount: number, trackPx: number): MarkerGroup[] {
  const sorted = [...markers]
    .filter((m) => Number.isInteger(m.index) && m.index >= 0 && m.index < eventCount)
    .sort((a, b) => a.index - b.index);
  const px = Math.max(1, trackPx);
  const out: MarkerGroup[] = [];
  let group: ReplayMarker[] = [];
  const flush = () => {
    const [first] = group;
    if (first === undefined) return;
    const top = group.reduce((best, m) => (markerLook(m.kind).urgency > markerLook(best.kind).urgency ? m : best));
    const look = markerLook(top.kind);
    out.push({
      key: `m${String(first.index)}`,
      index: first.index,
      leftPct: trackPct(first.index, eventCount),
      glyph: look.glyph,
      tone: look.tone,
      count: group.length,
      title:
        group.length === 1
          ? markerTitle(first)
          : `${String(group.length)} attention points here: ${group.map(markerTitle).join('; ')}`,
    });
    group = [];
  };
  for (const m of sorted) {
    const first = group[0];
    if (
      first !== undefined &&
      ((trackPct(m.index, eventCount) - trackPct(first.index, eventCount)) / 100) * px >= MARKER_MERGE_PX
    ) {
      flush();
    }
    group.push(m);
  }
  flush();
  return out;
}

/** "12 min with no events" (whole minutes; an hour or more reads "1 h 5 min"). */
export function gapWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${duration(minutes * 60_000)} with no events`;
}

export interface GapMark {
  key: string;
  leftPct: number;
  title: string;
}

/** A ⋯ between the two events of each quiet stretch. */
export function gapMarks(gaps: readonly QuietGap[], eventCount: number): GapMark[] {
  if (eventCount <= 1) return [];
  return gaps
    .filter((g) => Number.isInteger(g.afterIndex) && g.afterIndex >= 0 && g.afterIndex < eventCount - 1)
    .map((g) => ({
      key: `g${String(g.afterIndex)}`,
      leftPct: ((g.afterIndex + 0.5) / (eventCount - 1)) * 100,
      title: gapWords(g.ms),
    }));
}

// ---------------------------------------------------------------------------
// The thumb label
// ---------------------------------------------------------------------------

/** A stopwatch reading: "12:04", "1:12", "1:02:03". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${ss}` : `${String(m)}:${ss}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Clock time with seconds, plus the date when it is not the run's first day ("15 Nov 00:12:03"). */
export function momentTime(ts: number, firstTs: number): string {
  if (sameLocalDay(ts, firstTs)) return clockTimeFull(ts);
  const d = new Date(ts);
  return `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''} ${clockTimeFull(ts)}`;
}

/** The timeline's words for an event type (the thumb label and the screen reader). */
export const EVENT_WORDS: Record<HuddleEvent['type'], string> = {
  'session.started': 'Session started',
  'session.ended': 'Session ended',
  'prompt.submitted': 'Prompt',
  'agent.spawn_requested': 'Subagent requested',
  'agent.started': 'Agent started',
  'agent.stopped': 'Finished',
  'agent.linked': 'Agent linked',
  'teammate.idle': 'Teammate idle',
  'teammate.reported': 'Teammate reported',
  'role.described': 'Role described',
  'turn.ended': 'Turn ended',
  'turn.failed': 'Turn failed',
  'tool.started': 'Tool started',
  'tool.finished': 'Tool finished',
  'tool.failed': 'Tool failed',
  'approval.requested': 'Approval requested',
  'approval.resolved': 'Approval answered',
  'question.asked': 'Question asked',
  'question.answered': 'Question answered',
  'question.closed': 'Question closed',
  'hold.started': 'Pause started',
  'hold.ended': 'Pause ended',
  'task.created': 'Task created',
  'task.started': 'Task started',
  'task.completed': 'Task completed',
  'progress.reported': 'Progress reported',
  'usage.recorded': 'Usage recorded',
  'context.measured': 'Context measured',
  'context.compacted': 'Compaction',
  'model.changed': 'Model changed',
  'model.observed': 'Model seen',
  'instructions.loaded': 'Instructions loaded',
  'limits.measured': 'Limits measured',
  'notification.raised': 'Notification',
  'message.queued': 'Message queued',
  'message.delivered': 'Message delivered',
  'message.dropped': 'Message dropped',
  'control.applied': 'Control applied',
  'attention.raised': 'Needs attention',
  'attention.resolved': 'Attention cleared',
  'run.launched': 'Run launched',
  'run.exited': 'Run exited',
  'run.result': 'Run result',
  'worktree.created': 'Worktree created',
  'worktree.summarized': 'Worktree summarized',
  'worktree.closed': 'Worktree closed',
  'budget.set': 'Budget set',
  'history.pruned': 'History deleted',
  'phone.access_changed': 'Phone access changed',
  'phone.device_changed': 'Phone changed',
  'huddle_task.created': 'Huddle task made',
  'huddle_task.updated': 'Huddle task changed',
  'huddle_task.deleted': 'Huddle task deleted',
};

/** What the event at the position was: an attention marker's words when it carries one ("looks stuck"). */
export function eventWords(ref: Pick<ReplayEventRef, 'index' | 'type'>, markers: readonly ReplayMarker[]): string {
  const m = markers.find((x) => x.index === ref.index);
  if (m !== undefined && m.kind !== 'failure') return markerLook(m.kind).words;
  return (EVENT_WORDS as Record<string, string | undefined>)[ref.type] ?? ref.type;
}

/** The quiet stretch that ends at `index`, if one does. */
export function quietBefore(index: number, gaps: readonly QuietGap[]): QuietGap | null {
  return gaps.find((g) => g.afterIndex === index - 1) ?? null;
}

export interface ThumbLabel {
  time: string;
  what: string;
  agent: string;
  /** "(+12:04 quiet)" after a stretch longer than the stuck threshold; null otherwise. */
  quiet: string | null;
}

export function thumbLabel(
  ref: ReplayEventRef,
  firstTs: number,
  markers: readonly ReplayMarker[],
  gaps: readonly QuietGap[],
  gapBeforeMs: number | null,
  agentName: string,
): ThumbLabel {
  const gap = quietBefore(ref.index, gaps);
  const ms = gap === null ? null : (gapBeforeMs ?? gap.ms);
  return {
    time: momentTime(ref.ts, firstTs),
    what: eventWords(ref, markers),
    agent: agentName,
    quiet: ms === null ? null : `(+${clock(ms)} quiet)`,
  };
}

/** The slider's `aria-valuetext`: "Event 412 of 1,280, 17:14:05, looks stuck, core-engineer #1". */
export function valueText(index: number, eventCount: number, label: ThumbLabel | null): string {
  const at = `Event ${count(index + 1)} of ${count(eventCount)}`;
  if (label === null) return at;
  return [at, label.time, label.what, label.agent, label.quiet === null ? null : label.quiet.slice(1, -1)]
    .filter((p) => p !== null)
    .join(', ');
}

// ---------------------------------------------------------------------------
// "Why it needs attention"
// ---------------------------------------------------------------------------

/** The inbox glyph and kind words ("! looks stuck"). The item in the state at i gives the budget's severity. */
export function whyKind(why: ReplayWhy, state: HuddleState): { glyph: string; words: string } {
  const item: AttentionItem = state.inbox.find((i) => i.id === why.itemId) ?? {
    id: why.itemId,
    kind: why.kind,
    severity: 'warning',
    agentKey: why.agentKey,
    title: why.title,
    detail: why.detail,
    createdAt: why.raisedTs,
    resolvedAt: null,
  };
  const glyph = why.kind === 'approval' || why.kind === 'question' ? '▲' : '!';
  return { glyph, words: kindWords(item) };
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
}

/** What had become of the last tool call by the position. */
export function fateWords(fate: ReplayToolFate, startedTs: number): string {
  switch (fate.state) {
    case 'open':
      return `started ${clockTimeFull(startedTs)}, no result by this point`;
    case 'finished':
      return fate.durationMs === null
        ? `finished at ${clockTimeFull(fate.endedTs)}`
        : `finished in ${duration(fate.durationMs)}`;
    case 'failed': {
      const err = fate.error === null ? '' : firstLine(fate.error);
      if (err !== '') return `failed: ${err}`;
      return fate.interrupted ? 'failed: interrupted' : 'failed';
    }
  }
}

export function quietWords(ms: number): string {
  return `Quiet for ${clock(ms)} since this agent's last event`;
}

export function waitedWords(ms: number): string {
  return `Waited ${clock(ms)} for an answer so far`;
}

/**
 * Why Huddle cleared an item of this kind by itself (`condition_cleared`), from each detector's clear condition in
 * packages/core/src/detect: stuck (stuck.ts), loop (loop.ts), file conflict (conflict.ts), budget (budget.ts).
 */
export const CLEARED_WHEN: Partial<Record<AttentionKind, string>> = {
  stuck: 'when the agent reported again',
  loop: 'when the agent moved on: a different or successful tool call, a new prompt, or the end of its turn',
  file_conflict: 'when the conflict window passed with no new edit, or fewer than two of the agents were still running',
  budget: 'when usage was no longer over the budget, or the budget was set again or removed',
  role_drift: 'when the agent ended',
};

/** How the item ended later in the log, in the inbox's words. The item's kind picks why a clear happened. */
export function laterWords(later: ReplayLater, kind: AttentionKind): string {
  switch (later.kind) {
    case 'still_open':
      return 'Still open when the log ends.';
    case 'approval':
      return approvalEndingWords(later.outcome, later.by);
    case 'question_answered':
      return `Huddle answered at ${clockTime(later.ts)}.`;
    case 'question_closed':
      return QUESTION_CLOSED_WORDS[later.outcome];
    case 'cleared': {
      if (later.reason === 'dismissed') return `Dismissed at ${clockTime(later.ts)}.`;
      const when = CLEARED_WHEN[kind];
      return when === undefined
        ? `Cleared at ${clockTime(later.ts)} by Huddle.`
        : `Cleared at ${clockTime(later.ts)} ${when}.`;
    }
  }
}

/** The selected agent's items first, then the others, each in the order they were raised. */
export function orderWhy(why: readonly ReplayWhy[], selected: AgentKey | null): ReplayWhy[] {
  return [...why].sort(
    (a, b) =>
      Number(b.agentKey === selected) - Number(a.agentKey === selected) ||
      a.raisedIndex - b.raisedIndex ||
      (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
  );
}

/**
 * The moment pane's split (DESIGN "The moment pane" 2): the selected agent's open items in full, in the order they were
 * raised, and the other agents with open items, one entry per agent in the order its first item was raised, for the
 * compact "Also needs attention at this point:" line.
 */
export function splitWhy(
  why: readonly ReplayWhy[],
  selected: AgentKey | null,
): { mine: ReplayWhy[]; others: { agentKey: AgentKey; items: ReplayWhy[] }[] } {
  const ordered = orderWhy(why, null);
  const mine = ordered.filter((w) => w.agentKey === selected);
  const others: { agentKey: AgentKey; items: ReplayWhy[] }[] = [];
  for (const w of ordered) {
    if (w.agentKey === selected) continue;
    const entry = others.find((o) => o.agentKey === w.agentKey);
    if (entry) entry.items.push(w);
    else others.push({ agentKey: w.agentKey, items: [w] });
  }
  return { mine, others };
}

/** With no open item: what the agent was doing and how old its last event was at the position. */
export function calmLine(activity: string | null, lastEventAt: number, atTs: number): string {
  const doing = activity !== null && activity.trim() !== '' ? `Doing: ${firstLine(activity)}` : 'No activity recorded';
  const age = atTs - lastEventAt;
  return age <= 0 ? `${doing} · its last event is this one` : `${doing} · its last event was ${clock(age)} before this`;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function loadingWords(eventCount: number): string {
  return `Loading ${count(eventCount)} events…`;
}

export function snapshotWords(lastTs: number): string {
  return `Still running. Showing events up to ${clockTime(lastTs)}.`;
}

export function lateStartWords(firstTs: number): string {
  return `The log starts after the session began: Huddle wasn't running before ${clockTime(firstTs)}.`;
}

export function teamAt(ts: number): string {
  return `Team at ${clockTime(ts)}`;
}

type Failed = Extract<QueryResult, { ok: false }>;

/** A failed replay answer in words. `not_available` and an older preload both mean this build cannot replay yet. */
export function replayFailure(r: Failed): string {
  if (r.code === 'not_available' || r.code === 'unsupported') return REPLAY_WORDS.notAvailable;
  if (r.code === 'not_found') return REPLAY_WORDS.deleted;
  return `Couldn't read this run's events: ${r.message.replace(/\.\s*$/, '')}.`;
}

/** Whether "Try again" helps: not for a deleted run or a build that cannot replay. */
export function canRetry(r: Failed): boolean {
  return r.code === 'failed' || r.code === 'invalid';
}

/** Replay's own expansion default: every row open, an ended session too (the live tree closes those). */
export function replayToggles(
  endedRoots: readonly AgentKey[],
  userToggled: ReadonlySet<AgentKey>,
): ReadonlySet<AgentKey> {
  const out = new Set(userToggled);
  for (const k of endedRoots) {
    if (out.has(k)) out.delete(k);
    else out.add(k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Events up to here"
// ---------------------------------------------------------------------------

/** Raised items that are a row in "Events up to here" (DESIGN sketch: "17:14:05  looks stuck  No activity for 12 min"). */
const ATTENTION_ROW_KINDS: ReadonlySet<AttentionItem['kind']> = new Set(['stuck', 'loop', 'file_conflict', 'budget']);

/**
 * The replay's rows for one agent: the timeline's rows plus one row per stuck, loop, file conflict or budget item it
 * raised, newest first by event index. These items are not timeline rows live (the inbox shows them there), but in a
 * replay they are the moments N lands on, so they get a row. `indexOf` maps an event id to its index in the run.
 */
export function replayEventRows(
  events: readonly HuddleEvent[],
  agentKey: AgentKey,
  indexOf: ReadonlyMap<string, number>,
): TimelineRow[] {
  const raised: TimelineRow[] = [];
  for (const e of events) {
    if (e.type !== 'attention.raised' || e.agentKey !== agentKey || !ATTENTION_ROW_KINDS.has(e.item.kind)) continue;
    const detail = e.item.detail.trim() !== '' ? e.item.detail : e.item.title;
    raised.push({
      id: e.id,
      ts: e.ts,
      kind: 'notification',
      title: kindWords(e.item),
      detail,
      durationMs: null,
      filter: 'agent',
      line: (detail.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim(),
      code: false,
    });
  }
  const at = (r: TimelineRow) => indexOf.get(r.id) ?? -1;
  return [...timelineRows(events, agentKey), ...raised].sort((a, b) => at(b) - at(a));
}

/**
 * The row to highlight at index `at`: the row of that event, else the nearest row before it (the event at `at` is not
 * a row: a tool finished, an item cleared, usage recorded). `exact` is false for the nearest. Null: no row at or before.
 */
export function currentRow(
  rows: readonly { id: string }[],
  indexOf: ReadonlyMap<string, number>,
  at: number,
): { id: string; exact: boolean } | null {
  let best: { id: string; index: number } | null = null;
  for (const r of rows) {
    const i = indexOf.get(r.id);
    if (i === undefined || i > at) continue;
    if (best === null || i > best.index) best = { id: r.id, index: i };
  }
  return best === null ? null : { id: best.id, exact: best.index === at };
}
