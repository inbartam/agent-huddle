/**
 * Words for managed runs, worktrees and budgets (M4: F13, F19, F20). Pure. Numbers come from the node and the shared
 * budget selectors; this file only decides what to say. Unknown is `—`, estimates carry `~` and "est.".
 */
import {
  isRunAlive,
  type AgentRun,
  type Budget,
  type BudgetLevel,
  type BudgetLimitView,
  type BudgetView,
  type HuddleCommand,
  type RunWorktree,
  type WorktreeFile,
  type WorktreeFileStatus,
} from '@huddle/shared';
import { approxUsd, duration, shortCount, UNKNOWN } from './format.js';
import { BUDGET_WARN_AT, numberField } from './launch.js';

export const BUDGET_NOTE = 'estimate; can overshoot by about one tool call';

export const SCOPE_WORDS: Record<BudgetView['scope'], string> = {
  agent: 'this agent',
  session: 'this session',
  overall: 'all sessions',
};

export const EXCEED_WORDS: Record<BudgetView['budget']['onExceed'], string> = {
  notify: 'then tells you',
  pause: 'then pauses',
  stop: 'then stops the run',
};

/** Shape and words for a budget level, never colour alone. */
export const LEVEL_LOOK: Record<BudgetLevel, { glyph: string; label: string; tone: 'idle' | 'needs-you' | 'failed' }> =
  {
    unknown: { glyph: '○', label: 'not measured yet', tone: 'idle' },
    ok: { glyph: '○', label: 'under the warning line', tone: 'idle' },
    warning: { glyph: '▲', label: 'near the cap', tone: 'needs-you' },
    over: { glyph: '■', label: 'cap reached', tone: 'failed' },
  };

function minutes(n: number): string {
  return `${String(Math.round(n))} min`;
}

/** "41k / 100k tokens", "~$0.58 / $2.00 est.", "12 min / 30 min"; the used side is `—` when unknown, never 0. */
export function limitWords(l: BudgetLimitView): string {
  switch (l.kind) {
    case 'tokens':
      return `${l.used === null ? UNKNOWN : shortCount(l.used)} / ${shortCount(l.cap)} tokens`;
    case 'cost':
      return `${l.used === null ? UNKNOWN : approxUsd(l.used)} / $${l.cap.toFixed(2)} est.`;
    case 'minutes':
      return `${l.used === null ? UNKNOWN : minutes(l.used)} / ${minutes(l.cap)}`;
  }
}

export const LIMIT_LABEL: Record<BudgetLimitView['kind'], string> = {
  tokens: 'Tokens',
  cost: 'Cost',
  minutes: 'Time',
};

/** One short line for the widget: the budget's worst limit, e.g. "budget 86%". Null when nothing to say. */
export function budgetLine(view: BudgetView): { text: string; level: BudgetLevel } | null {
  const measured = view.limits.filter((l) => l.fraction !== null);
  if (measured.length === 0) return view.limits.length === 0 ? null : { text: `budget ${UNKNOWN}`, level: 'unknown' };
  const worst = measured.reduce((a, b) => ((b.fraction ?? 0) > (a.fraction ?? 0) ? b : a));
  const pct = Math.round((worst.fraction ?? 0) * 100);
  // The kind (tokens, cost, time) is in the tooltip, so the card line stays short at 340 px.
  return { text: `budget ${String(pct)}%`, level: view.level };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** How the run stands: "running", "finished", "stopped from Huddle", "failed, exit code 1", "couldn't start". */
export function runStateWords(run: AgentRun): string {
  if (isRunAlive(run)) return 'running';
  const exit = run.exited;
  if (!exit) return 'running';
  switch (exit.how) {
    case 'completed':
      return 'finished';
    case 'stopped':
      return 'stopped from Huddle';
    case 'failed':
      return exit.exitCode === null ? 'failed' : `failed, exit code ${String(exit.exitCode)}`;
    case 'spawn_failed':
      return "couldn't start";
  }
}

export interface ResultFacts {
  duration: string;
  turns: string;
  cost: string;
  denials: string;
  isError: boolean;
}

/** The latest turn's result, or null before the first one. Cost is Claude Code's own estimate. */
export function resultFacts(run: AgentRun): ResultFacts | null {
  const r = run.result;
  if (!r) return null;
  return {
    duration: duration(r.durationMs),
    turns: r.numTurns === null ? UNKNOWN : String(r.numTurns),
    cost: r.totalCostUsd === null ? UNKNOWN : `${approxUsd(r.totalCostUsd)} est.`,
    denials: String(r.permissionDenials),
    isError: r.isError,
  };
}

export function worktreeStateWords(wt: RunWorktree, alive: boolean): string {
  switch (wt.state) {
    case 'kept':
      return 'kept: the branch stays';
    case 'discarded':
      return 'discarded: worktree and branch removed';
    default:
      return alive ? 'in use by the run' : 'waiting for you: keep or discard';
  }
}

/** A git-like letter and a word for each file, so status is never colour alone. */
export const FILE_STATUS: Record<WorktreeFileStatus, { mark: string; word: string }> = {
  added: { mark: 'A', word: 'added' },
  modified: { mark: 'M', word: 'modified' },
  deleted: { mark: 'D', word: 'deleted' },
  renamed: { mark: 'R', word: 'renamed' },
  copied: { mark: 'C', word: 'copied' },
  type_changed: { mark: 'T', word: 'type changed' },
  unmerged: { mark: 'U', word: 'unmerged' },
  untracked: { mark: '?', word: 'untracked' },
  unknown: { mark: '·', word: 'changed' },
};

export function fileStatus(status: string): { mark: string; word: string } {
  return Object.hasOwn(FILE_STATUS, status) ? FILE_STATUS[status as WorktreeFileStatus] : FILE_STATUS.unknown;
}

// ---------------------------------------------------------------------------
// Worktree files, grouped (M4 runbook: tool state is not the agents' work)
// ---------------------------------------------------------------------------

/**
 * Top folders that tools write their own state into while they run (Claude Code's `.claude/`, the owner's plugin
 * hooks' `.omc/`). Their files are not hidden: they are grouped and shown collapsed, labeled "tool state".
 */
export const TOOL_STATE_FOLDERS: readonly string[] = ['.omc', '.claude'];

export interface FileGroup {
  /** The top folder, or null for files at the worktree root. */
  folder: string | null;
  toolState: boolean;
  files: WorktreeFile[];
}

export interface GroupedFiles {
  /** Tracked changes (added, modified, deleted, …), listed one by one. */
  changed: WorktreeFile[];
  /** Untracked files by top folder: other folders first (in the order seen), root files, tool state last. */
  untracked: FileGroup[];
  /** How many of the listed untracked files sit in tool-state folders. */
  toolStateCount: number;
}

function topFolder(p: string): string | null {
  const cut = p.search(/[\\/]/);
  return cut <= 0 ? null : p.slice(0, cut);
}

export function isToolStateFolder(folder: string | null): boolean {
  return folder !== null && TOOL_STATE_FOLDERS.includes(folder.toLowerCase());
}

/** Pure. The core's facts stay as they are; this only decides how the panel lists them. */
export function groupWorktreeFiles(files: readonly WorktreeFile[]): GroupedFiles {
  const changed: WorktreeFile[] = [];
  const groups = new Map<string, FileGroup>();
  const root: WorktreeFile[] = [];
  for (const f of files) {
    if (f.status !== 'untracked') {
      changed.push(f);
      continue;
    }
    const folder = topFolder(f.path);
    if (folder === null) {
      root.push(f);
      continue;
    }
    const group = groups.get(folder) ?? { folder, toolState: isToolStateFolder(folder), files: [] };
    group.files.push(f);
    groups.set(folder, group);
  }
  const all = [...groups.values()];
  const untracked = [
    ...all.filter((g) => !g.toolState),
    ...(root.length > 0 ? [{ folder: null, toolState: false, files: root }] : []),
    ...all.filter((g) => g.toolState),
  ];
  const toolStateCount = all.filter((g) => g.toolState).reduce((n, g) => n + g.files.length, 0);
  return { changed, untracked, toolStateCount };
}

// ---------------------------------------------------------------------------
// Budget editing after launch (M4 runbook: raise or change a budget)
// ---------------------------------------------------------------------------

export interface BudgetDraft {
  maxTokens: string;
  maxCostUsd: string;
  maxMinutes: string;
  /** Whole percent, 1 to 99. */
  warnPercent: string;
  onExceed: Budget['onExceed'];
}

export const BUDGET_EDIT_WORDS = {
  needOne: 'Set at least one limit: tokens, cost or minutes.',
  warn: 'Enter a whole percent from 1 to 99.',
  stillOver: 'This is not above what is already used, so it trips again at once.',
  raised: 'Raising a cap does not resume agents the budget paused; resume them here or from the inbox.',
} as const;

function numText(n: number | undefined): string {
  return n === undefined ? '' : String(n);
}

export function budgetDraftOf(b: Budget): BudgetDraft {
  return {
    maxTokens: numText(b.maxTokens),
    maxCostUsd: numText(b.maxEstimatedCostUsd),
    maxMinutes: numText(b.maxMinutes),
    warnPercent: String(Math.round((Number.isFinite(b.warnAtFraction) ? b.warnAtFraction : BUDGET_WARN_AT) * 100)),
    onExceed: b.onExceed,
  };
}

export const NEW_BUDGET_DRAFT: BudgetDraft = {
  maxTokens: '',
  maxCostUsd: '',
  maxMinutes: '',
  warnPercent: String(Math.round(BUDGET_WARN_AT * 100)),
  onExceed: 'pause',
};

/** Problems by field (maxTokens, maxCostUsd, maxMinutes, warnPercent, limits); empty: the draft can be sent. */
export function validateBudgetDraft(d: BudgetDraft): Record<string, string> {
  const e: Record<string, string> = {};
  const tokens = numberField(d.maxTokens, true);
  if ('error' in tokens) e['maxTokens'] = tokens.error;
  const cost = numberField(d.maxCostUsd, false);
  if ('error' in cost) e['maxCostUsd'] = cost.error;
  const minutes = numberField(d.maxMinutes, true);
  if ('error' in minutes) e['maxMinutes'] = minutes.error;
  const warn = d.warnPercent.trim();
  if (!/^\d+$/.test(warn) || Number(warn) < 1 || Number(warn) > 99) e['warnPercent'] = BUDGET_EDIT_WORDS.warn;
  const none = [d.maxTokens, d.maxCostUsd, d.maxMinutes].every((t) => t.trim() === '');
  if (none) e['limits'] = BUDGET_EDIT_WORDS.needOne;
  return e;
}

/**
 * The `budget.set` for an edited budget, or null while the draft has problems. `targetKey`: the agent (agent scope),
 * the session's root (session scope), null (overall). Setting it again resets the detector for it: the old items
 * close and the new limits are checked afresh (detect/budget.ts).
 */
export function budgetSetCommand(
  scope: BudgetView['scope'],
  targetKey: string | null,
  d: BudgetDraft,
): HuddleCommand | null {
  if (Object.keys(validateBudgetDraft(d)).length > 0) return null;
  const budget: Budget = { scope, warnAtFraction: Number(d.warnPercent.trim()) / 100, onExceed: d.onExceed };
  if (d.maxTokens.trim() !== '') budget.maxTokens = Number(d.maxTokens.trim());
  if (d.maxCostUsd.trim() !== '') budget.maxEstimatedCostUsd = Number(d.maxCostUsd.trim());
  if (d.maxMinutes.trim() !== '') budget.maxMinutes = Number(d.maxMinutes.trim());
  return { type: 'budget.set', agentKey: scope === 'overall' ? null : targetKey, budget };
}

/** The limits of a draft that would be at or under what is used now (they would trip again at once). */
export function stillOverWith(view: BudgetView, d: BudgetDraft): BudgetLimitView['kind'][] {
  const caps: Record<BudgetLimitView['kind'], string> = {
    tokens: d.maxTokens,
    cost: d.maxCostUsd,
    minutes: d.maxMinutes,
  };
  return view.limits
    .filter((l) => {
      const raw = caps[l.kind].trim();
      if (raw === '' || l.used === null) return false;
      const cap = Number(raw);
      return Number.isFinite(cap) && cap <= l.used;
    })
    .map((l) => l.kind);
}

/** One `agent.resume` per agent, in order (Resume all for the agents a budget paused). */
export function resumeAllCommands(keys: readonly string[]): HuddleCommand[] {
  return keys.map((agentKey) => ({ type: 'agent.resume', agentKey }));
}

/** How many agents a budget still holds paused, as a sentence. */
export function pausedByWords(n: number): string {
  return n === 1 ? 'This budget still holds 1 agent paused.' : `This budget still holds ${String(n)} agents paused.`;
}

/** Caps in a template row: "Budget: 200k tokens, $2.00 est., 30 min; then pauses"; null without a budget. */
export function templateBudgetWords(budgets: readonly Budget[] | undefined): string | null {
  const b = budgets?.find((x) => x.scope === 'session') ?? budgets?.[0];
  if (b === undefined) return null;
  const parts: string[] = [];
  if (b.maxTokens !== undefined) parts.push(`${shortCount(b.maxTokens)} tokens`);
  if (b.maxEstimatedCostUsd !== undefined) parts.push(`$${b.maxEstimatedCostUsd.toFixed(2)} est.`);
  if (b.maxMinutes !== undefined) parts.push(minutes(b.maxMinutes));
  if (parts.length === 0) return null;
  const more = (budgets?.length ?? 0) > 1 ? ` (+${String((budgets?.length ?? 1) - 1)} more)` : '';
  return `Budget: ${parts.join(', ')}; ${EXCEED_WORDS[b.onExceed]}${more}`;
}

export const runCommand = {
  stop: (runId: string): HuddleCommand => ({ type: 'run.stop', runId }),
  end: (runId: string): HuddleCommand => ({ type: 'run.end', runId }),
  keep: (runId: string): HuddleCommand => ({ type: 'run.keepWorktree', runId }),
  discard: (runId: string): HuddleCommand => ({ type: 'run.discardWorktree', runId }),
  open: (runId: string): HuddleCommand => ({ type: 'run.openWorktree', runId }),
};
