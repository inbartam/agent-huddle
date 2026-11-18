/**
 * Presentation of the activity timeline (F8). The rows themselves come from the shared
 * `selectTimeline` selector (ADR-016); this file only orders them newest first, groups their kinds
 * into the filter buttons, and decides which details are code-like.
 */
import {
  selectTimeline,
  TIMELINE_LIMIT,
  type AgentKey,
  type HuddleEvent,
  type TimelineEntry,
  type TimelineKind,
} from '@huddle/shared';
import { plainLine } from './markdown.js';

export const TIMELINE_CAP = TIMELINE_LIMIT;

export type TimelineFilter = 'all' | 'tool' | 'prompt' | 'failure' | 'approval' | 'task' | 'context' | 'agent';

export const TIMELINE_FILTERS: readonly { id: TimelineFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tool', label: 'Tools' },
  { id: 'prompt', label: 'Prompts' },
  { id: 'failure', label: 'Failures' },
  { id: 'approval', label: 'Approvals' },
  { id: 'task', label: 'Tasks' },
  { id: 'context', label: 'Context' },
  { id: 'agent', label: 'Agent' },
];

const FILTER_OF: Record<TimelineKind, Exclude<TimelineFilter, 'all'>> = {
  tool: 'tool',
  prompt: 'prompt',
  failure: 'failure',
  approval: 'approval',
  question: 'approval',
  task: 'task',
  compaction: 'context',
  model: 'context',
  agent: 'agent',
  turn: 'agent',
  session: 'agent',
  notification: 'agent',
  rename: 'agent',
};

/** Kinds whose detail is a command, a path or a model id: shown in the code face. */
const CODE_KINDS: ReadonlySet<TimelineKind> = new Set(['tool', 'approval', 'model']);

export interface TimelineRow extends TimelineEntry {
  filter: Exclude<TimelineFilter, 'all'>;
  /** The detail's first non-empty line (prompts and results can be long and multi-line). */
  line: string;
  code: boolean;
}

function firstLine(text: string | null): string {
  if (!text) return '';
  return (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
}

/** Rows for one agent, newest first, at most 500 (the most recent). */
export function timelineRows(events: readonly HuddleEvent[], agentKey: AgentKey): TimelineRow[] {
  return selectTimeline(events, agentKey, TIMELINE_CAP)
    .map((e) => {
      // An approval request's detail is the command; an approval result's detail is a message.
      const code = CODE_KINDS.has(e.kind) && (e.kind !== 'approval' || e.title.startsWith('Approval requested'));
      return {
        ...e,
        filter: (FILTER_OF as Record<string, TimelineRow['filter'] | undefined>)[e.kind] ?? 'agent',
        // Prose (replies, prompts, results) loses its Markdown marks in the one-line row; commands stay as typed.
        line: code ? firstLine(e.detail) : plainLine(e.detail),
        code,
      };
    })
    .reverse();
}

/** About how many characters fit in a timeline row's summary column before it is cut. */
const ROW_LINE_FITS = 60;

/** The row holds more than its one line shows: it opens in the timeline's reader. */
export function hasMore(row: TimelineRow): boolean {
  if (row.detail == null || row.detail.trim() === '') return false;
  // More lines than the row shows, or one line long enough to be cut with "…" in the row (a one-line reply could not
  // be opened, so its end was unreadable; owner, 2026-11-18).
  return row.detail.trim() !== row.line || row.line.length > ROW_LINE_FITS;
}

/** The filters the Simple view offers: everything, what failed, and what asked the user. */
export const SIMPLE_FILTERS: ReadonlySet<TimelineFilter> = new Set(['all', 'failure', 'approval']);

/**
 * The filter buttons to draw: All, then only the kinds this agent's rows have (a filter that is always empty is noise),
 * and in the Simple view only Failures and Approvals among those. The chosen filter always stays, so it can be undone.
 */
export function visibleFilters(
  rows: readonly TimelineRow[],
  chosen: TimelineFilter,
  simple: boolean,
): readonly { id: TimelineFilter; label: string }[] {
  const present = new Set<TimelineFilter>(rows.map((r) => r.filter));
  return TIMELINE_FILTERS.filter(
    (f) => f.id === 'all' || f.id === chosen || (present.has(f.id) && (!simple || SIMPLE_FILTERS.has(f.id))),
  );
}

/** The filter in effect: a filter the Simple view does not offer reads as All there. */
export function effectiveFilter(filter: TimelineFilter, simple: boolean): TimelineFilter {
  return simple && !SIMPLE_FILTERS.has(filter) ? 'all' : filter;
}

/**
 * Flags that make a command destructive (force, hard reset, recursive delete, branch delete, skipped hooks): the Simple
 * view never hides them. A short-flag cluster counts when it holds f, r, R or D (`-f`, `-rf`, `-fd`, `-D`).
 */
const DESTRUCTIVE_FLAG =
  /^(?:--(?:force|force-with-lease|force-if-includes|hard|delete|mirror|prune|no-verify|recursive)(?:=.*)?|-[a-zA-Z]*[frRD][a-zA-Z]*)$/;

/**
 * A command line shortened for the Simple view: option flags are dropped and each run of dropped words reads "…"
 * ("npm test -- --run parser" → "npm test … parser"), but destructive flags always stay ("git push … --force").
 * The full line stays in the tooltip and the reader.
 */
export function withoutFlags(line: string): string {
  const out: string[] = [];
  let plain = 0;
  for (const w of line.split(/\s+/)) {
    if (w === '') continue;
    if (!w.startsWith('-')) {
      out.push(w);
      plain += 1;
    } else if (DESTRUCTIVE_FLAG.test(w)) out.push(w);
    else if (out[out.length - 1] !== '…') out.push('…');
  }
  return plain === 0 ? line : out.join(' ');
}

export function filterTimeline(rows: readonly TimelineRow[], filter: TimelineFilter): readonly TimelineRow[] {
  return filter === 'all' ? rows : rows.filter((r) => r.filter === filter);
}
