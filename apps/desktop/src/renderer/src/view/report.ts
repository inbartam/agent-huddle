/**
 * Report (M5, F23): the words and shapes of a past run's report tab, pure (DESIGN.md "Report (F23)", "Words for
 * remembering (M5)"). The component (components/Report.tsx) only draws what these return.
 *
 * Built from the structured `RunReport`, never from its Markdown file. Agent text (names, titles, results, errors,
 * summaries, paths, tool names) stays plain text here; nothing builds markup, and `**` or `#` stay as typed.
 */
import {
  workTokens,
  type AgentKey,
  type HuddleCommand,
  type QueryResult,
  type ReplayMarker,
  type ReportAgent,
  type ReportApproval,
  type ReportFailure,
  type ReportFile,
  type ReportWorktree,
  type RunOutcome,
  type RunReport,
  type TokenCounts,
  type WorktreeFileStatus,
} from '@huddle/shared';
import { approxUsd, clockTimeFull, count, shortCount, UNKNOWN } from './format.js';
import { HISTORY_WORDS, PARTIAL_TOKENS } from './history.js';
import { approvalEndingWords } from './inbox.js';

export const REPORT_WORDS = {
  summary: 'Summary',
  agents: 'Agents',
  filesChanged: 'Files changed',
  failures: 'Failures',
  approvals: 'Approvals',
  openFile: 'Open Markdown file',
  copyPath: 'Copy path',
  copied: 'Copied.',
  showInReplay: 'Show in replay',
  noUsage: 'no usage recorded',
  partialCost: 'at least: some requests carried no cost',
  noAnswer: 'No answer recorded.',
  noFiles: 'No files changed.',
  noFailures: 'No failures.',
  noApprovals: 'No approvals asked.',
  notReady: 'No report yet: the run is still going. Huddle writes it when the session ends.',
  replaySoFar: 'Replay so far',
  none: 'No report for this run yet.',
  make: 'Make the report',
  writing: 'Writing the report…',
  tryAgain: 'Try again',
  fileGone: 'The file is gone: it was moved or deleted.',
  writeAgain: 'Write it again',
  noEnd: 'The log has no end for this session, so its outcome is unknown.',
  interrupted: 'interrupted by you',
  titleFromParent: 'Title from its parent',
  result: 'Result',
  toolsUsed: 'Tools used',
  showAll: 'Show all',
  showLess: 'Show less',
  // Not in DESIGN's word list (reported to the owner):
  loading: 'Loading the report…',
  notAvailable: "The report isn't available yet in this build.",
  noFile: 'No Markdown file was written for this run.',
  noReplayIndex: "This event isn't among the replay's markers, so Huddle can't jump to it.",
  commandsUnavailable: 'Unavailable in this build: this Huddle cannot send commands yet.',
} as const;

/** Result lines shown before "Show all". */
export const RESULT_LINES = 12;
/** File rows shown before "Show all". */
export const FILES_SHOWN = 50;

// ---------------------------------------------------------------------------
// Commands: by session id only; the renderer never sends a path
// ---------------------------------------------------------------------------

export type ReportCommandKind = 'make' | 'openFile' | 'copyPath';

export function reportCommand(kind: ReportCommandKind, sessionId: string): HuddleCommand {
  switch (kind) {
    case 'make':
      return { type: 'report.make', sessionId };
    case 'openFile':
      return { type: 'report.openFile', sessionId };
    case 'copyPath':
      return { type: 'report.copyPath', sessionId };
  }
}

// ---------------------------------------------------------------------------
// Failures in words
// ---------------------------------------------------------------------------

type Failed = Extract<QueryResult, { ok: false }>;

export function reportFailure(r: Failed): string {
  if (r.code === 'not_available' || r.code === 'unsupported') return REPORT_WORDS.notAvailable;
  if (r.code === 'not_found') return HISTORY_WORDS.notFound;
  return `Couldn't read the report: ${trimStop(r.message)}.`;
}

export function canRetryReport(r: Failed): boolean {
  return r.code === 'failed' || r.code === 'invalid';
}

export function makeFailure(message: string): string {
  return `Couldn't write the report: ${trimStop(message)}.`;
}

function trimStop(s: string): string {
  return s.replace(/\.\s*$/, '');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** The outcome badge's key (History's outcomes): a report's `unknown` is a run with no end recorded. */
export function reportOutcome(outcome: RunOutcome): 'completed' | 'failed' | 'stopped' | 'no_end' {
  return outcome === 'unknown' ? 'no_end' : outcome;
}

/** A count that is a lower bound reads "≥182k", with the reason in the tooltip and accessible name. */
export interface Shown {
  text: string;
  /** Tooltip and accessible name; null when the text says it all. */
  label: string | null;
}

/** "in 41k · out 6k · cache read 310k · cache written 12k · 88 requests"; "no usage recorded" when null. */
export function tokensLine(tokens: TokenCounts | null, partial: boolean): Shown {
  if (tokens === null) return { text: REPORT_WORDS.noUsage, label: null };
  const p = partial ? '≥' : '';
  const text = [
    `in ${p}${shortCount(tokens.input)}`,
    `out ${p}${shortCount(tokens.output)}`,
    `cache read ${p}${shortCount(tokens.cacheRead)}`,
    `cache written ${p}${shortCount(tokens.cacheCreation)}`,
    `${p}${count(tokens.requests)} ${tokens.requests === 1 ? 'request' : 'requests'}`,
  ].join(' · ');
  return { text, label: partial ? `${text} (${PARTIAL_TOKENS})` : null };
}

/** "Helper requests (titles, compaction): 2.1k tokens, not counted above"; null when there were none. */
export function helperLine(helper: TokenCounts | null): string | null {
  if (helper === null) return null;
  return `Helper requests (titles, compaction): ${shortCount(workTokens(helper))} tokens, not counted above`;
}

/** "~$0.91 est."; `—` when unknown; a lower bound says so in the label. */
export function costWords(usd: number | null, partial: boolean): Shown {
  if (usd === null || !Number.isFinite(usd)) return { text: UNKNOWN, label: 'cost unknown' };
  const text = `${approxUsd(usd)} est.`;
  return { text, label: partial ? `${text} (${REPORT_WORDS.partialCost})` : null };
}

/** "Tool calls 212 (3 failed) · Approvals 5 · Stuck 1". */
export function activityLine(s: RunReport['summary']): string {
  const failed = s.toolFailures > 0 ? ` (${count(s.toolFailures)} failed)` : '';
  return `Tool calls ${count(s.toolCalls)}${failed} · Approvals ${count(s.approvalsRequested)} · Stuck ${count(s.stuckIncidents)}`;
}

/** How a session ended, in words (Claude Code's SessionEnd reasons); an unknown reason is shown as given. */
const END_REASON_WORDS: Readonly<Record<string, string>> = {
  prompt_input_exit: 'you exited Claude Code',
  clear: 'cleared with /clear',
  logout: 'logged out',
  resume: 'resumed in another session',
  other: 'other reason',
};

export function endedWords(reason: string | null): string {
  const r = reason?.trim() ?? '';
  if (r === '') return `ended: ${UNKNOWN}`;
  return `ended: ${Object.hasOwn(END_REASON_WORDS, r) ? (END_REASON_WORDS[r] ?? r) : r}`;
}

export function agentsWords(n: number): string {
  return `${count(n)} ${n === 1 ? 'agent' : 'agents'}`;
}

export function tasksDoneWords(n: number): string {
  return `${count(n)} ${n === 1 ? 'task' : 'tasks'} done`;
}

// ---------------------------------------------------------------------------
// Agents table
// ---------------------------------------------------------------------------

export interface AgentLine {
  agent: ReportAgent;
  depth: number;
  /** Elbow glyphs before the name ("│ └ "), plain characters, not rails. Empty for a root. */
  prefix: string;
}

/**
 * Agents indented under who started them, children in start order. An agent whose parent is not in the report is a
 * root. Each agent appears exactly once, so a broken parent link (a cycle) cannot loop.
 */
export function agentLines(agents: readonly ReportAgent[]): AgentLine[] {
  const keys = new Set(agents.map((a) => a.row.agentKey));
  const children = new Map<AgentKey, ReportAgent[]>();
  const roots: ReportAgent[] = [];
  for (const a of agents) {
    const parent = a.row.parentKey;
    if (parent !== null && keys.has(parent) && parent !== a.row.agentKey) {
      const list = children.get(parent) ?? [];
      list.push(a);
      children.set(parent, list);
    } else {
      roots.push(a);
    }
  }
  const out: AgentLine[] = [];
  const seen = new Set<AgentKey>();
  const walk = (a: ReportAgent, depth: number, lead: string, last: boolean) => {
    if (seen.has(a.row.agentKey)) return;
    seen.add(a.row.agentKey);
    out.push({ agent: a, depth, prefix: depth === 0 ? '' : `${lead}${last ? '└ ' : '├ '}` });
    const kids = (children.get(a.row.agentKey) ?? []).filter((k) => !seen.has(k.row.agentKey));
    const nextLead = depth === 0 ? '' : `${lead}${last ? '  ' : '│ '}`;
    kids.forEach((k, i) => {
      walk(k, depth + 1, nextLead, i === kids.length - 1);
    });
  };
  roots.forEach((r) => {
    walk(r, 0, '', true);
  });
  // Anything left (only possible with a parent cycle) still shows, at the top level.
  for (const a of agents) if (!seen.has(a.row.agentKey)) walk(a, 0, '', true);
  return out;
}

/** "3/5", or `—` when the agent kept no task list. */
export function tasksCell(row: ReportAgent['row']): string {
  return row.tasksCreated === 0 ? UNKNOWN : `${count(row.tasksCompleted)}/${count(row.tasksCreated)}`;
}

/** "120 (2)": calls, with failures in brackets when there were any. */
export function toolsCell(row: ReportAgent['row']): Shown {
  const calls = `${count(row.toolCalls)} ${row.toolCalls === 1 ? 'tool call' : 'tool calls'}`;
  if (row.toolFailures === 0) return { text: count(row.toolCalls), label: calls };
  return {
    text: `${count(row.toolCalls)} (${count(row.toolFailures)})`,
    label: `${calls}, ${count(row.toolFailures)} failed`,
  };
}

/** Input plus output tokens, `—` when the agent has no usage record. */
export function agentTokens(row: ReportAgent['row']): string {
  return row.tokens === null ? UNKNOWN : shortCount(workTokens(row.tokens));
}

/** "Bash 40 (2 failed) · Edit 12 · Read 30"; `—` when it made no tool calls. */
export function toolsUsedLine(agent: ReportAgent): string {
  if (agent.tools.length === 0) return UNKNOWN;
  return agent.tools
    .map((t) => `${t.toolName} ${count(t.calls)}${t.failures > 0 ? ` (${count(t.failures)} failed)` : ''}`)
    .join(' · ');
}

/** Whether a result is long enough to clip at RESULT_LINES (by line breaks, or about 80 characters a line). */
export function resultIsLong(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length > RESULT_LINES) return true;
  const wrapped = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 80)), 0);
  return wrapped > RESULT_LINES;
}

/** The first RESULT_LINES lines (a long line counts as several), for the clipped view. */
export function resultHead(text: string): string {
  const out: string[] = [];
  let budget = RESULT_LINES;
  for (const line of text.split('\n')) {
    if (budget <= 0) break;
    const need = Math.max(1, Math.ceil(line.length / 80));
    if (need <= budget) {
      out.push(line);
      budget -= need;
    } else {
      out.push(`${line.slice(0, budget * 80)}…`);
      budget = 0;
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Files changed
// ---------------------------------------------------------------------------

const sameSeps = (p: string) => p.replace(/\//g, '\\').toLowerCase();

/**
 * A tool path relative to the run folder when it is under it, else as given. Windows paths compare without case and
 * with either separator; the rest keeps the agent's own spelling. A worktree path is already relative to the worktree.
 */
export function shownPath(file: Pick<ReportFile, 'path' | 'source'>, cwd: string | null): string {
  if (file.source !== 'tool' || cwd === null) return file.path;
  const base = cwd.replace(/[\\/]+$/, '');
  if (base === '') return file.path;
  const sep = file.path[base.length];
  if ((sep !== '\\' && sep !== '/') || sameSeps(file.path.slice(0, base.length)) !== sameSeps(base)) return file.path;
  const rest = file.path.slice(base.length).replace(/^[\\/]+/, '');
  return rest === '' ? file.path : rest;
}

export const GIT_STATE_WORDS: Record<WorktreeFileStatus, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'untracked',
  // Not in DESIGN's word list (git reports them rarely):
  copied: 'copied',
  type_changed: 'type changed',
  unmerged: 'unmerged',
  unknown: UNKNOWN,
};

export function gitStateWords(status: string | null): string {
  if (status === null) return UNKNOWN;
  return (GIT_STATE_WORDS as Record<string, string | undefined>)[status] ?? UNKNOWN;
}

/** What a file line says after its path: "Edit ×3 · core-engineer #1", or the git state of a worktree file. */
export function fileDetail(file: ReportFile, names: ReadonlyMap<AgentKey, string>): string {
  if (file.source === 'worktree') return gitStateWords(file.worktreeStatus);
  const tools = file.tools.length > 0 ? file.tools.join(', ') : UNKNOWN;
  const who = file.agentKeys.map((k) => names.get(k) ?? UNKNOWN);
  return [`${tools} ×${count(file.writes)}`, ...(who.length > 0 ? [who.join(', ')] : [])].join(' · ');
}

const CLOSED_WORDS = { kept: 'kept', discarded: 'discarded' } as const;

/** "Worktree huddle/run-1a2b · 9 files · +120 −40 · 2 untracked · kept". */
export function worktreeLine(w: ReportWorktree): string {
  const name = w.branch ?? w.path ?? UNKNOWN;
  return [
    `Worktree ${name}`,
    `${count(w.filesChanged)} ${w.filesChanged === 1 ? 'file' : 'files'}`,
    `+${count(w.insertions)} −${count(w.deletions)}`,
    `${count(w.untracked)} untracked`,
    w.closed === null ? 'still there' : CLOSED_WORDS[w.closed],
  ].join(' · ');
}

/** "Showing 50 of 120 files (Huddle keeps the first 50)." when the worktree summary listed fewer than changed. */
export function worktreeCutWords(w: ReportWorktree): string | null {
  if (w.listed >= w.filesChanged) return null;
  return `Showing ${count(w.listed)} of ${count(w.filesChanged)} files (Huddle keeps the first ${count(w.listed)}).`;
}

// ---------------------------------------------------------------------------
// Failures and approvals
// ---------------------------------------------------------------------------

export const FAILURE_KIND_WORDS: Record<ReportFailure['kind'], string> = {
  tool: 'tool failed',
  turn: 'turn failed',
  run: 'run failed',
};

export function failureKindWords(kind: string): string {
  return (FAILURE_KIND_WORDS as Record<string, string | undefined>)[kind] ?? UNKNOWN;
}

/** The error's first line, and whether there is more to expand. */
export function errorHead(error: string | null): { first: string; more: boolean } {
  if (error === null || error.trim() === '') return { first: UNKNOWN, more: false };
  const lines = error.split('\n');
  return { first: lines[0] ?? '', more: lines.length > 1 };
}

/** How an approval ended, in the inbox's words; "No answer recorded." when unresolved. */
export function approvalEnding(a: Pick<ReportApproval, 'outcome' | 'by'>): string {
  if (a.outcome === null || a.by === null) return REPORT_WORDS.noAnswer;
  return approvalEndingWords(a.outcome, a.by);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function localDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}

/**
 * A failure's or approval's time: the clock with seconds, and a day before it when the event is on a later local day
 * than the run's start ("Sat 00:05:05"; "22 Nov 00:05:05" a week or more after), as History names other days.
 */
export function eventTime(ts: number, runStartTs: number): string {
  const clock = clockTimeFull(ts);
  const days = localDay(ts) - localDay(runStartTs);
  if (days === 0) return clock;
  const d = new Date(ts);
  if (days > 0 && days < 7) return `${WEEKDAYS[d.getDay()] ?? ''} ${clock}`;
  return `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''} ${clock}`;
}

// ---------------------------------------------------------------------------
// "Show in replay": where a report row is in the event log
// ---------------------------------------------------------------------------

/**
 * Where each report row is in the replay. A row carries its event's log index (`ReportFailure.index`,
 * `ReportApproval.index`, M5 WP7), the index `history.stateAt` takes; it is used when it is a number. Otherwise (a
 * report built before the index existed, or an event outside this session's log) the row is found among the run head's
 * scrubber markers: the marker of the same kind (`failure`, `approval`), agent and time. When several rows share an
 * agent and a millisecond, the n-th row takes the n-th such marker. A row with neither (the head left markers out,
 * `markersTruncated`) gets null, and its button is off with a reason. Nothing is guessed from times alone.
 */
export function replayIndexes(
  rows: readonly (Pick<ReportFailure, 'ts' | 'agentKey'> & { index?: number | null })[],
  kind: 'failure' | 'approval',
  markers: readonly ReplayMarker[],
): (number | null)[] {
  const pools = new Map<string, number[]>();
  for (const m of markers) {
    if (m.kind !== kind) continue;
    const k = `${m.agentKey}\u0000${String(m.ts)}`;
    const list = pools.get(k) ?? [];
    list.push(m.index);
    pools.set(k, list);
  }
  return rows.map((r) =>
    typeof r.index === 'number' ? r.index : (pools.get(`${r.agentKey}\u0000${String(r.ts)}`)?.shift() ?? null),
  );
}

/** Agent display names by key (the report's own names), for file and failure lines. */
export function agentNames(report: RunReport): Map<AgentKey, string> {
  return new Map(report.agents.map((a) => [a.row.agentKey, a.name]));
}
