/**
 * History (M5, F22): the words and shapes of the run list and the run view's head, pure (DESIGN.md "M5: Remember",
 * "History (F22)", "Run outcome", "Words for remembering (M5)"). The component (components/History.tsx) only draws
 * what these return.
 *
 * Agent text (titles, topics, folders, prompts) stays plain text here. A search match comes back from the core as text
 * plus offsets; `splitHighlight` cuts that text into plain segments and the component wraps the marked ones in
 * `<mark>` itself. Nothing here builds markup.
 */
import {
  cleanPromptTitle,
  DEFAULT_RETENTION_DAYS,
  HISTORY_PAGE_MAX,
  HISTORY_SEARCH_TEXT_MAX,
  type HistoryCursor,
  type HistoryMatch,
  type HistoryMatchField,
  type HistoryOutcome,
  type HistoryRow,
  type HistorySearchHit,
  type HistoryTokens,
  type M5Query,
  type QueryResult,
  type TextRange,
} from '@huddle/shared';
import { clockTime, duration, folderName, shortCount, shortModel, UNKNOWN } from './format.js';
import type { StatusTone } from './status.js';

export const HISTORY_WORDS = {
  title: 'History',
  tabRuns: 'Runs',
  tabScorecards: 'Scorecards',
  tabReport: 'Report',
  tabReplay: 'Replay',
  allRuns: '← All runs',
  searchLabel: 'Search runs',
  searchPlaceholder: 'Search title, folder or prompt',
  outcome: 'Outcome',
  folder: 'Folder',
  all: 'All',
  clearFilters: 'Clear filters',
  clearSearch: 'Clear search',
  showMore: `Show ${String(HISTORY_PAGE_MAX)} more`,
  untitled: 'Untitled run',
  loading: 'Loading history…',
  migrating: 'Bringing in older history…',
  noFilterMatch: 'No runs match these filters.',
  tryAgain: 'Try again',
  notAvailable: "History isn't available yet in this build.",
  notFound: 'This run is no longer in the history. The history setting may have deleted it.',
  openingRun: 'Opening the run…',
  running: 'running',
  startedInTerminal: 'started in a terminal',
  launchedByHuddle: 'launched by Huddle',
  replayLater: 'Replay is coming in a later build: step through this run event by event.',
  /** Live team, a session's main agent. */
  replayThisRun: 'Replay this run',
  openTheReport: 'Open the report',
} as const;

export type HistoryTab = 'runs' | 'scorecards';
export type RunTab = 'report' | 'replay';

/** Ask main for one of these from the outside (title bar, palette, live team). */
export interface HistoryRequest {
  tab: HistoryTab;
  /**
   * Open this run at once; `tab` null picks Report when the run has one, else Replay. `index`: open Replay at that
   * event ("Show in replay"); absent or null opens it at the last event.
   */
  run: { sessionId: string; tab: RunTab | null; index?: number | null } | null;
}

// ---------------------------------------------------------------------------
// Outcome (DESIGN "Run outcome")
// ---------------------------------------------------------------------------

export interface OutcomeLook {
  glyph: string;
  label: string;
  tone: StatusTone;
  /** The ● of a live run breathes like a working agent's. */
  breathes: boolean;
}

export const OUTCOME_LOOK: Record<HistoryOutcome, OutcomeLook> = {
  completed: { glyph: '✓', label: 'completed', tone: 'idle', breathes: false },
  failed: { glyph: '✕', label: 'failed', tone: 'failed', breathes: false },
  stopped: { glyph: '■', label: 'stopped', tone: 'idle', breathes: false },
  running: { glyph: '●', label: 'running', tone: 'working', breathes: true },
  no_end: { glyph: '◇', label: 'no end recorded', tone: 'idle', breathes: false },
};

/** An outcome this build does not know (a newer core) gets a neutral look instead of crashing. */
export function outcomeLook(outcome: string): OutcomeLook {
  return (
    (OUTCOME_LOOK as Record<string, OutcomeLook | undefined>)[outcome] ?? {
      glyph: '◇',
      label: UNKNOWN,
      tone: 'idle',
      breathes: false,
    }
  );
}

/** The Outcome filter's options, in DESIGN order after "All". */
export const OUTCOME_OPTIONS: readonly { value: HistoryOutcome; label: string }[] = [
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'running', label: 'Running' },
  { value: 'no_end', label: 'No end recorded' },
];

export function isHistoryOutcome(v: string): v is HistoryOutcome {
  return OUTCOME_OPTIONS.some((o) => o.value === v);
}

export function originWords(origin: HistoryRow['origin']): string {
  return origin === 'managed' ? HISTORY_WORDS.launchedByHuddle : HISTORY_WORDS.startedInTerminal;
}

// ---------------------------------------------------------------------------
// Row cells
// ---------------------------------------------------------------------------

/**
 * Title column: the session title, else the topic in quotes, else "Untitled run"; the topic follows a title. The topic
 * goes through `cleanPromptTitle` here too (Claude Code tag blocks stripped), so a row from an older core reads the same.
 */
export function runTitle(row: Pick<HistoryRow, 'title' | 'topic'>): { title: string; topic: string | null } {
  const title = row.title?.trim() ? row.title : null;
  const topic = cleanPromptTitle(row.topic);
  if (title !== null) return { title, topic: topic === null ? null : `“${topic}”` };
  if (topic !== null) return { title: `“${topic}”`, topic: null };
  return { title: HISTORY_WORDS.untitled, topic: null };
}

/**
 * Duration column: how long so far while live ("12 min so far"; the Outcome column already says "running", 2026-11-18),
 * `—` when unknown.
 */
export function runDuration(row: Pick<HistoryRow, 'outcome' | 'durationMs' | 'startTs'>, now?: number): string {
  if (row.outcome === 'running')
    return now !== undefined && now >= row.startTs ? `${duration(now - row.startTs)} so far` : HISTORY_WORDS.running;
  return duration(row.durationMs);
}

/** Model column: the main agent's short model, plus "+1" when subagents used another. */
export function runModel(row: Pick<HistoryRow, 'model' | 'otherModels'>): string {
  const base = shortModel(row.model);
  return row.otherModels > 0 ? `${base} +${String(row.otherModels)}` : base;
}

export const PARTIAL_TOKENS = 'at least: some agents have no usage record';

/** Tokens column: input plus output, `≥` when some agent had no usage record, `—` when none had. */
export function runTokens(tokens: HistoryTokens | null): { text: string; label: string } {
  if (tokens === null) return { text: UNKNOWN, label: 'tokens unknown' };
  const n = shortCount(tokens.value);
  return tokens.partial
    ? { text: `≥${n}`, label: `at least ${n} tokens (${PARTIAL_TOKENS})` }
    : { text: n, label: `${n} tokens` };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 86_400_000;

function localDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

/** Day header: "Today", "Yesterday", "Wed 12 Nov" within a week, then "3 Nov 2026". Local time. */
export function dayLabel(ts: number, now: number): string {
  const diff = localDay(now) - localDay(ts);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const d = new Date(ts);
  if (diff > 1 && diff < 7) return `${WEEKDAYS[d.getDay()] ?? ''} ${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''}`;
  return `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''} ${String(d.getFullYear())}`;
}

/** One line for a run's start in the run view head: "Today 17:02". */
export function startWords(ts: number, now: number): string {
  return `${dayLabel(ts, now)} ${clockTime(ts)}`;
}

/** The list, with a day header before the first run of each day. `index` is the run's place among runs only. */
export type HistoryItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'run'; key: string; index: number; day: string; hit: HistorySearchHit };

export function historyItems(hits: readonly HistorySearchHit[], now: number): HistoryItem[] {
  const out: HistoryItem[] = [];
  let last: string | null = null;
  hits.forEach((hit, index) => {
    const day = dayLabel(hit.row.startTs, now);
    if (day !== last) {
      out.push({ kind: 'day', key: `day:${String(index)}:${day}`, label: day });
      last = day;
    }
    out.push({ kind: 'run', key: `run:${hit.row.sessionId}`, index, day, hit });
  });
  return out;
}

/** What a screen reader hears for a row: every column with its unit, and the match line. */
export function runAccessibleName(hit: HistorySearchHit, day: string): string {
  const r = hit.row;
  const t = runTitle(r);
  const parts = [
    t.topic === null ? t.title : `${t.title} ${t.topic}`,
    outcomeLook(r.outcome).label,
    `folder ${folderName(r.folder)}`,
    `started ${day} ${clockTime(r.startTs)}`,
    r.outcome === 'running' ? 'running' : `took ${runDuration(r)}`,
    `model ${runModel(r)}`,
    runTokens(r.tokens).label,
    `${String(r.agentCount)} ${r.agentCount === 1 ? 'agent' : 'agents'}`,
  ];
  if (hit.match) parts.push(`matched in ${matchLabel(hit.match.field)} ${matchText(hit.match)}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Search matches
// ---------------------------------------------------------------------------

export interface TextSegment {
  text: string;
  mark: boolean;
}

/**
 * Cut `text` at the core's ranges into plain and marked segments. Defensive: ranges are clamped to the text, sorted,
 * and an empty or overlapping one is dropped, so a bad answer can only mark less, never break the row.
 */
export function splitHighlight(text: string, ranges: readonly TextRange[]): TextSegment[] {
  const valid = ranges
    .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end))
    .map((r) => ({
      start: Math.max(0, Math.min(text.length, r.start)),
      end: Math.max(0, Math.min(text.length, r.end)),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: TextSegment[] = [];
  let at = 0;
  for (const r of valid) {
    if (r.start < at) continue;
    if (r.start > at) out.push({ text: text.slice(at, r.start), mark: false });
    out.push({ text: text.slice(r.start, r.end), mark: true });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/**
 * A row's cells as segments, and the match line under the row (DESIGN "History (F22)", Search):
 * - a title match is marked inside the title cell;
 * - a folder match is marked inside the folder cell when the marked words are in the folder name the cell shows;
 * - anything else (topic, prompt, a snippet that does not line up with the cell, or a folder match in the parent path)
 *   gets the `--muted` match line under the row, so the mark is never lost behind a cell's ellipsis.
 */
export interface RowParts {
  title: TextSegment[];
  /** The topic after a title, plain; null when there is none (or it is the title). */
  topic: TextSegment[] | null;
  /** The folder cell: the folder's last segment. */
  folder: TextSegment[];
  /** The match line under the row; null when the match is marked in a cell, or there is no match. */
  line: HistoryMatch | null;
}

const plain = (text: string): TextSegment[] => [{ text, mark: false }];
const hasMark = (segs: readonly TextSegment[]): boolean => segs.some((s) => s.mark);

/** The core's ranges over a full folder path, moved onto the folder name the cell shows; marks outside it drop. */
function folderNameSegments(folder: string, ranges: readonly TextRange[]): TextSegment[] {
  const name = folderName(folder);
  const at = folder.lastIndexOf(name);
  if (at < 0) return plain(name);
  const moved = ranges
    .map((r) => ({ start: Math.max(r.start - at, 0), end: Math.min(r.end - at, name.length) }))
    .filter((r) => r.end > r.start);
  return splitHighlight(name, moved);
}

export function rowParts(hit: HistorySearchHit): RowParts {
  const r = hit.row;
  const m = hit.match;
  const title = r.title?.trim() ? r.title : null;
  const topic = cleanPromptTitle(r.topic);
  let titleSegs = plain(title ?? (topic !== null ? `“${topic}”` : HISTORY_WORDS.untitled));
  const topicSegs = title !== null && topic !== null ? plain(`“${topic}”`) : null;
  let folderSegs = plain(folderName(r.folder));
  let line: HistoryMatch | null = m;
  if (m !== null && !m.cutStart && !m.cutEnd) {
    if (m.field === 'title' && title !== null && m.text === title) {
      const segs = splitHighlight(title, m.ranges);
      if (hasMark(segs)) {
        titleSegs = segs;
        line = null;
      }
    } else if (m.field === 'folder' && r.folder !== null && m.text === r.folder) {
      const segs = folderNameSegments(r.folder, m.ranges);
      if (hasMark(segs)) {
        folderSegs = segs;
        line = null;
      }
    }
  }
  return { title: titleSegs, topic: topicSegs, folder: folderSegs, line };
}

/** The match line's label: the topic is the first line of a prompt, so it reads "prompt:" too. */
export function matchLabel(field: HistoryMatchField): string {
  return field === 'title' ? 'title' : field === 'folder' ? 'folder' : 'prompt';
}

/** The match line's segments with "…" where the snippet was cut. */
export function matchSegments(match: HistoryMatch): TextSegment[] {
  const segs = splitHighlight(match.text, match.ranges);
  if (match.cutStart) segs.unshift({ text: '…', mark: false });
  if (match.cutEnd) segs.push({ text: '…', mark: false });
  return segs;
}

export function matchText(match: HistoryMatch): string {
  return matchSegments(match)
    .map((s) => s.text)
    .join('');
}

/** "<n> runs match"; `—` when the core could not count. */
export function matchCount(total: number | null): string {
  if (total === null) return `${UNKNOWN} runs match`;
  return total === 1 ? '1 run matches' : `${total.toLocaleString('en-US')} runs match`;
}

export function noMatchWords(text: string): string {
  return `No runs match “${text.trim()}”.`;
}

// ---------------------------------------------------------------------------
// Queries and pages
// ---------------------------------------------------------------------------

export interface HistoryFilters {
  /** The search text as the debounce last let through. */
  text: string;
  outcome: HistoryOutcome | null;
  /** Full path, as `history.folders` gave it. */
  folder: string | null;
}

export const NO_FILTERS: HistoryFilters = { text: '', outcome: null, folder: null };

export function searchText(filters: HistoryFilters): string {
  return filters.text.trim().slice(0, HISTORY_SEARCH_TEXT_MAX);
}

export function hasFilters(filters: HistoryFilters): boolean {
  return filters.outcome !== null || filters.folder !== null;
}

/** The page query for these filters: `history.search` while there is search text, else `history.list`. */
export function runsQuery(filters: HistoryFilters, before?: HistoryCursor): M5Query {
  const text = searchText(filters);
  const common = {
    limit: HISTORY_PAGE_MAX,
    ...(before ? { before } : {}),
    ...(filters.outcome !== null ? { outcome: filters.outcome } : {}),
    ...(filters.folder !== null ? { folder: filters.folder } : {}),
  };
  return text === '' ? { type: 'history.list', ...common } : { type: 'history.search', text, ...common };
}

/** One page in the list's terms: a list page's rows carry no match. */
export interface RunsPage {
  hits: HistorySearchHit[];
  total: number | null;
  next: HistoryCursor | null;
  migrating: boolean;
}

export interface RunsList extends RunsPage {
  /** The filters the hits belong to. */
  filters: HistoryFilters;
}

/** "Show 200 more": the new page goes after the rows already shown; a row already there is not shown twice. */
export function appendPage(list: RunsList, page: RunsPage): RunsList {
  const seen = new Set(list.hits.map((h) => h.row.sessionId));
  return {
    filters: list.filters,
    hits: [...list.hits, ...page.hits.filter((h) => !seen.has(h.row.sessionId))],
    total: page.total ?? list.total,
    next: page.next,
    migrating: page.migrating,
  };
}

/**
 * A fresh first page while older history is still coming in: its rows replace the first page, and rows the user
 * already paged in after it stay (no row twice). When the fresh page is the whole list (`next` null), it is the list.
 */
export function refreshList(list: RunsList, page: RunsPage): RunsList {
  if (page.next === null) return { filters: list.filters, ...page };
  const seen = new Set(page.hits.map((h) => h.row.sessionId));
  const tail = list.hits.slice(page.hits.length).filter((h) => !seen.has(h.row.sessionId));
  return {
    filters: list.filters,
    hits: [...page.hits, ...tail],
    total: page.total ?? list.total,
    next: tail.length > 0 ? list.next : page.next,
    migrating: page.migrating,
  };
}

/** The selected row after a refresh: the same run where it is now, else the same position (clamped). */
export function followActive(
  before: readonly HistorySearchHit[],
  after: readonly HistorySearchHit[],
  active: number,
): number {
  const id = before[active]?.row.sessionId;
  const at = id === undefined ? -1 : after.findIndex((h) => h.row.sessionId === id);
  if (at >= 0) return at;
  return Math.max(0, Math.min(active, after.length - 1));
}

type Failed = Extract<QueryResult, { ok: false }>;

/** A failed answer in plain words. `not_available` and an older preload both mean this build cannot ask yet. */
export function historyFailure(r: Failed): string {
  if (r.code === 'not_available' || r.code === 'unsupported') return HISTORY_WORDS.notAvailable;
  return `Couldn't read the history: ${r.message.replace(/\.\s*$/, '')}. The live team is not affected.`;
}

export function runFailure(r: Failed): string {
  if (r.code === 'not_found') return HISTORY_WORDS.notFound;
  return historyFailure(r);
}

function daysWords(days: number | null | undefined): string {
  const n = typeof days === 'number' && Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS;
  return n === 1 ? '1 day' : `${String(n)} days`;
}

/** The empty list names the retention the user set. */
export function emptyWords(days: number | null | undefined): string {
  return `No runs stored yet. Every session that reports to Huddle is kept here for ${daysWords(days)}.`;
}

export function retentionFooter(days: number | null | undefined): string {
  const words = daysWords(days);
  return `Runs older than ${words} ${words === '1 day' ? 'is' : 'are'} deleted. Change this in Settings.`;
}

// ---------------------------------------------------------------------------
// Keyboard (DESIGN "History", Keyboard)
// ---------------------------------------------------------------------------

export type ListKeyResult =
  | { kind: 'move'; index: number }
  | { kind: 'open'; index: number }
  /** Up from the first row goes back to the search field. */
  | { kind: 'search' }
  | { kind: 'none' };

/** Up and Down move, Home and End jump, PageUp and PageDown jump by `pageSize`, Enter opens. No wrap. */
export function listKey(key: string, index: number, n: number, pageSize = 10): ListKeyResult {
  if (n === 0) return key === 'ArrowUp' ? { kind: 'search' } : { kind: 'none' };
  const i = Math.min(Math.max(0, index), n - 1);
  const page = Math.max(1, pageSize);
  switch (key) {
    case 'ArrowDown':
      return { kind: 'move', index: Math.min(n - 1, i + 1) };
    case 'ArrowUp':
      return i === 0 ? { kind: 'search' } : { kind: 'move', index: i - 1 };
    case 'Home':
      return { kind: 'move', index: 0 };
    case 'End':
      return { kind: 'move', index: n - 1 };
    case 'PageDown':
      return { kind: 'move', index: Math.min(n - 1, i + page) };
    case 'PageUp':
      return { kind: 'move', index: Math.max(0, i - page) };
    case 'Enter':
      return { kind: 'open', index: i };
    default:
      return { kind: 'none' };
  }
}

/** Ctrl+F always, `/` only when focus is not in a text field, focus the search. */
export function isSearchShortcut(
  e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  inTextField: boolean,
): boolean {
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'f') return true;
  return e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey && !inTextField;
}
