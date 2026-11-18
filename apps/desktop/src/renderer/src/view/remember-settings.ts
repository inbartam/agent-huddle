/**
 * Settings, M5 (F22, F25): the History section (retention, stats line, "Delete all history…") and the Ask the Huddle
 * switch, as words, commands and small steps. Pure, except the two flows at the end, which take the bridge's `send`
 * and `query` as arguments so tests can drive them without a DOM. Strings are DESIGN.md "Words for remembering (M5)"
 * and "Settings additions".
 *
 * The core checks everything again: `history.setRetention` days are clamped by its schema, `history.deleteAll` is
 * refused unless `confirm` is exactly `delete`, during the JSONL import and on the JSONL fallback.
 */
import {
  DELETE_ALL_CONFIRM,
  OVERALL_BUDGET_LOWERED_WORDS,
  RETENTION_DAYS_MAX,
  RETENTION_DAYS_MIN,
  type CommandResult,
  type ControlState,
  type HistoryDeleted,
  type HistoryStats,
  type HuddleCommand,
} from '@huddle/shared';
import { count, UNKNOWN } from './format.js';
import { parseWhole, type NumberField } from './settings.js';

export const HISTORY_SETTINGS_WORDS = {
  section: 'History',
  note: 'Stored on this computer',
  help: 'Runs older than this are deleted once a day, with their events and reports. Running sessions and the overall budget are never deleted.',
  deleteThem: 'Delete them',
  back: 'Back',
  migrating: 'Bringing in older history from the JSONL folder.',
  deleteAllOpen: 'Delete all history…',
  deleteAllTitle: 'Delete all history?',
  /** The confirmation, in three parts so the folder path can be drawn in mono between them. */
  deletesLead: 'This deletes from this computer: every stored event, every run report and its Markdown file',
  deletesFolder: ', and the older JSONL history folder',
  deletesFolderMaybe: ', and the older JSONL history folder if there is one.',
  keeps:
    'It keeps: settings, templates, rules, agent nicknames, and the overall budget. Sessions running now keep what they have logged so far, so the team view and budgets stay right. If an overall budget is set, its usage will count only what is left. This cannot be undone.',
  typeLabel: 'Type delete to confirm',
  deleteAllButton: 'Delete all history',
  typeFirst: 'Type delete first.',
  deleting: 'Deleting…',
  whileImporting: 'Huddle is still bringing in older history. Wait until that is done, then delete.',
} as const;

export const ASK_SETTINGS_WORDS = {
  section: 'Ask the Huddle',
  note: 'Off by default',
  label: 'Send a summary of my agents to Anthropic when I ask the Huddle a question',
  /** The help text, word for word (DESIGN "Settings additions"); `claude -p` is drawn as code between the parts. */
  helpBefore: 'When you ask, Huddle runs ',
  helpCode: 'claude -p',
  helpAfter:
    ' with Haiku on your Claude Code login and sends it your question and a summary of your agents: names, roles, models, status, current task, recent tool calls as one line each (commands and file paths), tokens and context use. It never sends file contents or tool output. Secrets are masked as best effort. The model has no tools, so it can only answer. Answers are not saved. This is the one Huddle feature that sends anything off this computer; you can read the exact text under "What will be sent" before you ask.',
} as const;

export const RETENTION_FIELD: NumberField<'retentionDays'> = {
  key: 'retentionDays',
  label: 'Keep history for',
  unit: 'days',
  min: RETENTION_DAYS_MIN,
  max: RETENTION_DAYS_MAX,
};

/** A lower value carries `confirm`: the run count the user saw (the core refuses a lower one without it, L4). */
export function retentionCommand(days: number, confirm?: number | null): HuddleCommand {
  return confirm === undefined || confirm === null
    ? { type: 'history.setRetention', days }
    : { type: 'history.setRetention', days, confirm };
}

export function askEnabledCommand(enabled: boolean): HuddleCommand {
  return { type: 'ask.setEnabled', enabled };
}

export const DELETE_ALL_COMMAND: HuddleCommand = { type: 'history.deleteAll', confirm: DELETE_ALL_CONFIRM };

/**
 * What committing the retention field does. Raising it saves at once; lowering it asks first (the core deletes the
 * older runs as soon as it saves a lower value); the same value or a bad one sends nothing.
 */
export type RetentionStep =
  | { kind: 'error'; error: string }
  | { kind: 'same' }
  | { kind: 'save'; days: number }
  | { kind: 'confirm'; days: number };

export function retentionStep(current: number, raw: string): RetentionStep {
  const parsed = parseWhole(raw, RETENTION_FIELD);
  if ('error' in parsed) return { kind: 'error', error: parsed.error };
  if (parsed.value === current) return { kind: 'same' };
  return parsed.value > current ? { kind: 'save', days: parsed.value } : { kind: 'confirm', days: parsed.value };
}

function daysWords(days: number): string {
  return days === 1 ? '1 day' : `${String(days)} days`;
}

function runsWords(runs: number | null): string {
  if (runs === null) return `${UNKNOWN} runs`;
  return runs === 1 ? '1 run' : `${count(runs)} runs`;
}

/** "Runs older than 7 days will be deleted (212 runs)."; the count is `—` when the core cannot tell. */
export function retentionPreviewWords(days: number, runs: number | null): string {
  return `Runs older than ${daysWords(days)} will be deleted (${runsWords(runs)}).`;
}

/** After a lower retention was saved: what went. Null when the answer carried nothing to say. */
export function retentionResultWords(days: number, deleted: HistoryDeleted | undefined): string | null {
  if (deleted === undefined) return null;
  if (deleted.runs === 0) return `Saved. No runs were older than ${daysWords(days)}.`;
  return `Saved. ${deleted.runs === 1 ? '1 run' : `${count(deleted.runs)} runs`} older than ${daysWords(days)} ${deleted.runs === 1 ? 'was' : 'were'} deleted.`;
}

/** 212 MB, 4.2 MB, 940 KB, 1.3 GB; `—` when unknown. Binary units, as Windows shows file sizes. */
export function storageSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return UNKNOWN;
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < MB) return `${String(Math.max(1, Math.round(bytes / KB)))} KB`;
  if (bytes < 10 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes < GB) return `${String(Math.round(bytes / MB))} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "15 Oct" this year, "15 Oct 2025" another year. Local time. */
export function shortDate(ts: number, now: number): string {
  const d = new Date(ts);
  const day = `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${String(d.getFullYear())}`;
}

/** "1,284 runs · 212 MB · oldest 15 Oct"; each part `—` when unknown, all of them when the stats are. */
export function statsLine(stats: HistoryStats | null, now: number): string {
  if (stats === null) return `${UNKNOWN} runs · ${UNKNOWN} · oldest ${UNKNOWN}`;
  const oldest = stats.oldestTs === null ? UNKNOWN : shortDate(stats.oldestTs, now);
  return `${runsWords(stats.runs)} · ${storageSize(stats.bytes)} · oldest ${oldest}`;
}

/** The typed confirmation holds `delete` (trimmed, any case). */
export function deleteConfirmed(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_ALL_CONFIRM;
}

/** The group's "Delete all history" button: off until `delete` is typed, and while the import runs. */
export function deleteAllControl(typed: string, migrating: boolean): ControlState {
  if (migrating) return { enabled: false, reason: HISTORY_SETTINGS_WORDS.whileImporting };
  if (!deleteConfirmed(typed)) return { enabled: false, reason: HISTORY_SETTINGS_WORDS.typeFirst };
  return { enabled: true, reason: null };
}

/** The outcome of a delete all, in words: `status` lines on success, one `alert` line on failure. */
export type DeleteAllOutcome = { ok: true; lines: string[] } | { ok: false; error: string };

function deletedWords(d: HistoryDeleted): string {
  const parts = [d.runs === 1 ? '1 run' : `${count(d.runs)} runs`];
  parts.push(d.reports === 1 ? '1 report' : `${count(d.reports)} reports`);
  if (d.folders > 0)
    parts.push(d.folders === 1 ? '1 older history folder' : `${count(d.folders)} older history folders`);
  return `History deleted: ${parts.join(', ')}.`;
}

export function deleteAllOutcome(result: CommandResult): DeleteAllOutcome {
  if (!result.ok) return { ok: false, error: result.message };
  if (result.deleted === undefined) return { ok: true, lines: [result.detail ?? 'History deleted.'] };
  const lines = [deletedWords(result.deleted)];
  if (result.deleted.overallBudgetLowered === true) lines.push(OVERALL_BUDGET_LOWERED_WORDS);
  return { ok: true, lines };
}

// ---------------------------------------------------------------------------------------------------------------------
// Flows (the component holds the phase; these do the I/O)
// ---------------------------------------------------------------------------------------------------------------------

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;
type Preview = (days: number) => Promise<{ ok: true; runs: number | null } | { ok: false; message: string }>;

/** Where the retention field is. `confirm.runs` is null when the count is unknown (or could not be asked). */
export type RetentionPhase =
  | { phase: 'idle' }
  | { phase: 'counting'; days: number }
  | { phase: 'confirm'; days: number; runs: number | null }
  | { phase: 'saving'; days: number }
  | { phase: 'saved'; days: number; words: string | null }
  | { phase: 'error'; error: string };

/**
 * Commit a typed retention. Lowering it only asks for the preview (nothing is sent); raising it sends at once.
 * `onPhase` sees each step, so the field can show "counting" before the preview answers.
 */
export async function commitRetention(
  io: { send: Send; preview: Preview },
  current: number,
  raw: string,
  onPhase: (p: RetentionPhase) => void,
): Promise<RetentionPhase> {
  const step = retentionStep(current, raw);
  let next: RetentionPhase;
  if (step.kind === 'error') next = { phase: 'error', error: step.error };
  else if (step.kind === 'same') next = { phase: 'idle' };
  else if (step.kind === 'save') return saveRetention(io.send, step.days, onPhase);
  else {
    onPhase({ phase: 'counting', days: step.days });
    const preview = await io.preview(step.days);
    next = { phase: 'confirm', days: step.days, runs: preview.ok ? preview.runs : null };
  }
  onPhase(next);
  return next;
}

/** "Delete them" (with the count the preview showed as `confirm`) or a raise: send `history.setRetention`. */
export async function saveRetention(
  send: Send,
  days: number,
  onPhase: (p: RetentionPhase) => void,
  confirm?: number | null,
): Promise<RetentionPhase> {
  onPhase({ phase: 'saving', days });
  let result: CommandResult;
  try {
    result = await send(retentionCommand(days, confirm));
  } catch {
    result = { ok: false, code: 'failed', message: "Huddle couldn't save the setting. Try again." };
  }
  const next: RetentionPhase = result.ok
    ? { phase: 'saved', days, words: retentionResultWords(days, result.deleted) }
    : { phase: 'error', error: result.message };
  onPhase(next);
  return next;
}

/** Send delete all, only when the typed text says `delete`. */
export async function runDeleteAll(send: Send, typed: string): Promise<DeleteAllOutcome> {
  if (!deleteConfirmed(typed)) return { ok: false, error: HISTORY_SETTINGS_WORDS.typeFirst };
  try {
    return deleteAllOutcome(await send(DELETE_ALL_COMMAND));
  } catch {
    return { ok: false, error: "Huddle couldn't get an answer from its core. Check the line above, then try again." };
  }
}
