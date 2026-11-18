/**
 * The M5 "Remember" contract (F22 history and replay, F23 report, F24 scorecards, F25 Ask the Huddle): what the
 * renderer may ask main over the existing `huddle:query` channel, and what comes back. Types and constants only, so
 * the renderer can import them (ADR-016). The query variants themselves are in `HuddleQuery` (control.ts); the zod
 * schemas that check them at the IPC boundary are in core (`packages/core/src/contracts/m5-schemas.ts`).
 *
 * Same rules as history.ts: unknown is `null`, never 0; everything survives `JSON.parse(JSON.stringify(x))`; agent text
 * (titles, topics, folders, prompts, summaries, errors, the Ask answer) is clipped by the core and still rendered as
 * text. Search matches come back as plain text plus offsets, never markup: the renderer builds `<mark>` itself.
 */
import type { ApprovalResolved, HuddleEvent, QuestionClosed } from './events.js';
import type { RunReport, Scorecard } from './history.js';
import type { AgentKey, AgentOrigin, AttentionKind, HuddleState } from './model.js';

// ---------------------------------------------------------------------------
// Limits (the IPC schemas clamp to these)
// ---------------------------------------------------------------------------

/** Most rows one `history.list` or `history.search` page returns (DESIGN: "the first 200 rows, then Show 200 more"). */
export const HISTORY_PAGE_MAX = 200;
/** Longest search text accepted. */
export const HISTORY_SEARCH_TEXT_MAX = 200;
/** Most entries one `history.events` page returns. */
export const HISTORY_EVENTS_MAX = 2000;
/** History retention (Settings, History): whole days, 1 to 365, default 30. */
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 365;
export const DEFAULT_RETENTION_DAYS = 30;
/** What `history.deleteAll` must carry in `confirm` (the user typed it; the renderer trims and lower-cases it). */
export const DELETE_ALL_CONFIRM = 'delete';
/** Longest Ask question (DESIGN: "it holds at most 500 characters"). */
export const ASK_QUESTION_MAX = 500;
/** An ask that has not answered after this long ends with `timeout` (owner decision). */
export const ASK_TIMEOUT_MS = 30_000;
/** About how large the text sent to the model may get before the core cuts the agent summary. */
export const ASK_PREVIEW_MAX_BYTES = 50_000;
/** Most earlier turns a follow-up question carries (`huddle.ask` and `ask.preview` `history`); older ones are dropped. */
export const ASK_HISTORY_TURNS_MAX = 3;
/** Longest earlier answer kept in a follow-up's history, in characters (CLIP_LIMITS.result). */
export const ASK_HISTORY_ANSWER_MAX = 4000;
/** Most UTF-8 bytes the history part of a follow-up may take; the oldest turns go first (the summary keeps its room). */
export const ASK_HISTORY_MAX_BYTES = 12_000;

// ---------------------------------------------------------------------------
// History list and search (F22)
// ---------------------------------------------------------------------------

/**
 * A run's outcome as History shows it (DESIGN "Run outcome"). `running` and `no_end` split RunOutcome's `unknown`:
 *   running: the session is live in this Huddle now
 *   no_end:  no end in the log and not live (the Huddle was closed, or the log was cut)
 */
export type HistoryOutcome = 'completed' | 'failed' | 'stopped' | 'running' | 'no_end';

/** Input plus output tokens (`workTokens`) summed over the run's agents. `partial`: some agent had no usage record. */
export interface HistoryTokens {
  value: number;
  partial: boolean;
}

/** One run in the History list. */
export interface HistoryRow {
  sessionId: string;
  /** Session title, clipped. Null when none. */
  title: string | null;
  /**
   * First line of the last prompt the user typed, Claude Code tag blocks stripped (`cleanPromptTitle`), clipped; the
   * first prompt when the last is only tags. Null when none.
   */
  topic: string | null;
  /** The session's working folder (full path; the renderer shows its last segment). Null when unknown. */
  folder: string | null;
  /** First event of the session, epoch ms. */
  startTs: number;
  /** Null while running or when the log has no end. */
  durationMs: number | null;
  outcome: HistoryOutcome;
  origin: AgentOrigin;
  /** The main agent's model; null when never seen. */
  model: string | null;
  /** How many other models the run's subagents used ("+1"). */
  otherModels: number;
  /** Null when no agent in the run has a usage record. */
  tokens: HistoryTokens | null;
  agentCount: number;
}

/** Where the next page starts: after this row (rows are sorted by `startTs` descending, then `sessionId`). */
export interface HistoryCursor {
  startTs: number;
  sessionId: string;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Null when there are no more rows. */
  next: HistoryCursor | null;
  /** The JSONL import is still running, so older runs may still arrive ("Bringing in older history…"). */
  migrating: boolean;
}

export type HistoryMatchField = 'title' | 'topic' | 'folder' | 'prompt';

/** UTF-16 offsets into `HistoryMatch.text`, `start` inclusive, `end` exclusive. Sorted, never overlapping. */
export interface TextRange {
  start: number;
  end: number;
}

/** Why a row matched: a plain-text snippet of one field and where the matched words are in it. */
export interface HistoryMatch {
  field: HistoryMatchField;
  /**
   * Plain text. Title and folder: the whole field exactly as the row holds it (`HistoryRow.title` / `.folder`, already
   * clipped), never cut. Topic and prompt: a snippet of at most CLIP_LIMITS.summary units that may start or end inside
   * the field ("…the matched words…").
   */
  text: string;
  /** Leading/trailing ellipses are not in `text`; these say whether the snippet was cut. */
  cutStart: boolean;
  cutEnd: boolean;
  ranges: TextRange[];
}

export interface HistorySearchHit {
  row: HistoryRow;
  /** Null when no stored field holds a search word by the core's check (the row still matched the index). */
  match: HistoryMatch | null;
}

export interface HistorySearchPage {
  hits: HistorySearchHit[];
  /** Runs that match in all ("<n> runs match"); null when the core cannot count cheaply. */
  total: number | null;
  next: HistoryCursor | null;
  migrating: boolean;
}

/** Settings, History: what is stored. */
export interface HistoryStats {
  runs: number;
  /** Size of the database on disk; null when unknown. */
  bytes: number | null;
  /** Start of the oldest stored run; null when there is none. */
  oldestTs: number | null;
  retentionDays: number;
  migrating: boolean;
  /** The older JSONL history folder that delete-all also removes; null when there is none. */
  legacyFolder: string | null;
}

/** What lowering the retention to `days` would delete ("Runs older than 7 days will be deleted (212 runs)."). */
export interface RetentionPreview {
  days: number;
  /** Null when the core cannot tell. Running sessions and the overall budget are never counted. */
  runs: number | null;
}

// ---------------------------------------------------------------------------
// Replay (F22)
// ---------------------------------------------------------------------------

/**
 * A scrubber marker. `approval` / `question`: one was asked. `stuck` / `loop` / `file_conflict` / `budget`: an item of
 * that kind was raised (re-raises while still open count once). `failure`: a tool, turn or run failed.
 */
export type ReplayMarkerKind = 'approval' | 'question' | 'stuck' | 'loop' | 'file_conflict' | 'budget' | 'failure';

export interface ReplayMarker {
  /** Event index in the session's log, 0-based. */
  index: number;
  ts: number;
  kind: ReplayMarkerKind;
  agentKey: AgentKey;
  /** The attention item, for raised items and requests; null for failures. */
  itemId: string | null;
}

/** A silence longer than the stuck threshold (Settings, Detectors) between event `afterIndex` and the next one. */
export interface QuietGap {
  afterIndex: number;
  ms: number;
}

/** `history.open`: what the run view needs before any moment is loaded. */
export interface RunHead {
  row: HistoryRow;
  eventCount: number;
  /** False: "The log starts after the session began". */
  startsWithSession: boolean;
  /** A report can be shown now (`report.get` answers `ready`). */
  hasReport: boolean;
  /** In index order. */
  markers: ReplayMarker[];
  /** The core keeps at most a few thousand markers; true when some were left out. */
  markersTruncated: boolean;
  quietGaps: QuietGap[];
  /** The last event's time. For a live session this is the snapshot ("Showing events up to 17:40"). */
  lastTs: number;
}

/** The event at a replay position, in the words the scrubber label needs. */
export interface ReplayEventRef {
  index: number;
  ts: number;
  type: HuddleEvent['type'];
  agentKey: AgentKey;
}

/** What had become of a tool call by the replay position. */
export type ReplayToolFate =
  | { state: 'open' }
  | { state: 'finished'; endedTs: number; durationMs: number | null }
  | { state: 'failed'; endedTs: number; error: string | null; interrupted: boolean };

export interface ReplayToolCall {
  toolName: string;
  /** The stored one-line summary (command, path, URL), clipped. */
  summary: string;
  startedTs: number;
  fate: ReplayToolFate;
}

/** How an item open at the replay position ended later in the log. */
export type ReplayLater =
  | { kind: 'still_open' }
  | { kind: 'approval'; index: number; ts: number; outcome: ApprovalResolved['outcome']; by: ApprovalResolved['by'] }
  | { kind: 'question_answered'; index: number; ts: number }
  | { kind: 'question_closed'; index: number; ts: number; outcome: QuestionClosed['outcome'] }
  /** condition_cleared: the detector cleared it (the agent reported again). dismissed: the user dismissed it. */
  | { kind: 'cleared'; index: number; ts: number; reason: 'condition_cleared' | 'dismissed' };

/** "Why it needs attention": facts for one item open at the replay position. */
export interface ReplayWhy {
  itemId: string;
  kind: AttentionKind;
  agentKey: AgentKey;
  /** The item's own title and detail (core text, clipped). */
  title: string;
  detail: string;
  raisedIndex: number;
  raisedTs: number;
  /** The agent's last tool call at or before the position; null when it made none. */
  lastToolCall: ReplayToolCall | null;
  /** From the agent's last event before the position to the event at the position; null when it has none before. */
  quietMs: number | null;
  /** For an approval or question: its one-line summary and how long it had waited by the position. */
  request: { summary: string; waitedMs: number } | null;
  later: ReplayLater;
}

/** `history.stateAt`: the run as it stood just after event `index`. */
export interface ReplayMoment {
  sessionId: string;
  index: number;
  eventCount: number;
  event: ReplayEventRef;
  /** Time since the previous event; null at index 0. */
  gapBeforeMs: number | null;
  /**
   * The reducer's state after events 0..index of this session only (`toHuddleState`, so no bookkeeping). Main-filled
   * fields (`connection`, `settings`, `priors`, …) are absent.
   */
  state: HuddleState;
  /** One entry per item open at the position (raised at or before it, not resolved by it), any agent of the run. */
  why: ReplayWhy[];
}

/** One entry of `history.events`. `event` only when the query asked for `full`. */
export interface ReplayEventEntry extends ReplayEventRef {
  event?: HuddleEvent;
}

export interface ReplayEventsPage {
  /** Forward: ascending index. Backward: descending index. */
  entries: ReplayEventEntry[];
  eventCount: number;
  /** More entries exist beyond this page in the same direction. */
  more: boolean;
}

// ---------------------------------------------------------------------------
// Report (F23) and scorecards (F24)
// ---------------------------------------------------------------------------

/** The Markdown file the core wrote for a run. Shown as text; the renderer never sends it back (open/copy go by id). */
export interface ReportFileInfo {
  path: string;
  exists: boolean;
  writtenAt: number | null;
}

/**
 * `report.get`.
 *   ready:     the report, built from the stored events, and its file when one was written
 *   not_ready: the session is still running ("No report yet…")
 *   none:      the session has ended but no report was made ("Make the report")
 */
export type ReportAnswer =
  { status: 'ready'; report: RunReport; file: ReportFileInfo | null } | { status: 'not_ready' } | { status: 'none' };

export interface ScorecardsAnswer {
  scorecards: Scorecard[];
  /** The history they come from ("the last 30 days"). */
  retentionDays: number;
}

// ---------------------------------------------------------------------------
// Ask the Huddle (F25)
// ---------------------------------------------------------------------------

/** 'history' (added for the Home Ask card): the earlier turns of a follow-up; absent from a first question. */
export type AskPreviewPart = 'instructions' | 'history' | 'question' | 'summary';

/**
 * One earlier question and its answer, sent with a follow-up so the model sees the conversation. Kept in renderer
 * memory only; the core masks and clips it again, puts it in the text it sends, and stores none of it.
 */
export interface AskTurn {
  question: string;
  answer: string;
}

/** `ask.preview`: the exact text the core would put on `claude -p`'s stdin now. */
export interface AskPreview {
  text: string;
  /** UTF-8 bytes of `text`. */
  bytes: number;
  /** A rough token estimate (labelled "est." in the UI). */
  estTokens: number;
  /** When it was built, epoch ms ("as of 17:04:10"). */
  asOf: number;
  /** The agent summary was cut to stay under ASK_PREVIEW_MAX_BYTES. */
  truncated: boolean;
  /** The labelled parts, as UTF-16 offsets into `text`, in order (`history` only for a follow-up). */
  parts: Array<{ part: AskPreviewPart; start: number; end: number }>;
  /**
   * The fixed system prompt, passed to claude as `--system-prompt` (not on stdin, so not in `text`). Added in M5 WP6;
   * absent from an older core.
   */
  systemPrompt?: string;
}

/** A model answer (`huddle.ask` succeeded). Kept in renderer memory only; the core never stores it. */
export interface AskAnswer {
  /** Plain text, clipped (CLIP_LIMITS.result). */
  text: string;
  /** The model id from the result; null when it lacked one. */
  model: string | null;
  askedAt: number;
  wallMs: number;
  /** API time from the result; null when it lacked one. */
  apiMs: number | null;
  tokens: { input: number; output: number } | null;
  /** Claude Code's own estimate (ADR-013); null when the result lacked one. */
  costUsd: number | null;
  /** Exactly what went on stdin ("Show what was sent"). */
  sent: string;
}

/**
 * Why an ask failed (`CommandResult.askError`).
 *   disabled:         Ask is off in Settings (also when it was switched off mid-ask)
 *   api_key_set:      ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is in the environment, so `claude -p` would bill
 *                     that credential; refused. Also when the same names are in the `env` block of Claude Code's
 *                     user settings.json, or it sets `apiKeyHelper` (M5 security review L1)
 *   other_provider:   ANTHROPIC_BASE_URL or CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY is set (environment, or a key
 *                     of settings.json's `env` block), so the summary would not go to Anthropic; refused (added in M5)
 *   claude_not_found: no `claude` executable
 *   not_logged_in:    Claude Code is not logged in
 *   timeout:          no answer within ASK_TIMEOUT_MS
 *   model_error:      the run failed or returned an error result
 *   cancelled:        the user pressed Cancel (`ask.cancel`)
 *   busy:             another ask is still running (one at a time)
 */
export type AskErrorKind =
  | 'disabled'
  | 'api_key_set'
  | 'other_provider'
  | 'claude_not_found'
  | 'not_logged_in'
  | 'timeout'
  | 'model_error'
  | 'cancelled'
  | 'busy';
