/**
 * Report and scorecard questions on `huddle:query` (M5, F23, F24), and the report's three commands. Like
 * history-query.ts, every answer is checked here: a result of the wrong type or shape reads as `failed`, a missing
 * bridge as "unavailable in this build", and the core's `not_available` comes through as is.
 *
 * The commands go by session id only. The renderer never sends a path: main opens or copies the file the core wrote.
 */
import type {
  CommandResult,
  HuddleCommand,
  QueryResult,
  ReportAnswer,
  Scorecard,
  ScorecardsAnswer,
} from '@huddle/shared';
import { ask } from './history-query.js';
import type { QueryFn } from './query.js';
import { REPORT_WORDS, reportCommand, type ReportCommandKind } from './view/report.js';

type Failed = Extract<QueryResult, { ok: false }>;

const failed: Failed = {
  ok: false,
  code: 'failed',
  message: "Huddle couldn't get an answer from its core. Try again.",
};

type Rec = Record<string, unknown>;

function isObject(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null;
}

function isReport(v: unknown): boolean {
  if (!isObject(v) || typeof v['sessionId'] !== 'string' || !isObject(v['summary'])) return false;
  return ['agents', 'filesChanged', 'failures', 'approvals'].every((k) => Array.isArray(v[k]));
}

function isFileInfo(v: unknown): boolean {
  return isObject(v) && typeof v['path'] === 'string' && typeof v['exists'] === 'boolean';
}

export type ReportLoad = { ok: true; answer: ReportAnswer } | Failed;

/** `report.get`: ready (with the file, when one was written), not_ready while the run goes on, or none. */
export async function loadReport(query: QueryFn | null, sessionId: string): Promise<ReportLoad> {
  const a = await ask(query, { type: 'report.get', sessionId });
  if (!a.ok) return a;
  const answer = a.r['answer'];
  if (!isObject(answer)) return failed;
  switch (answer['status']) {
    case 'not_ready':
      return { ok: true, answer: { status: 'not_ready' } };
    case 'none':
      return { ok: true, answer: { status: 'none' } };
    case 'ready': {
      const file = answer['file'];
      const hasFile = file !== null && file !== undefined;
      if (!isReport(answer['report']) || (hasFile && !isFileInfo(file))) return failed;
      const ready = answer as unknown as Extract<ReportAnswer, { status: 'ready' }>;
      return { ok: true, answer: { status: 'ready', report: ready.report, file: hasFile ? ready.file : null } };
    }
    default:
      return failed;
  }
}

function isScorecard(v: unknown): v is Scorecard {
  return (
    isObject(v) &&
    typeof v['role'] === 'string' &&
    (v['model'] === null || typeof v['model'] === 'string') &&
    typeof v['runs'] === 'number' &&
    typeof v['sampleSize'] === 'number' &&
    typeof v['tokenSampleSize'] === 'number'
  );
}

export type ScorecardsLoad = { ok: true; answer: ScorecardsAnswer } | Failed;

/** `scorecards.get`: every role-and-model card over the stored history. */
export async function loadScorecards(query: QueryFn | null): Promise<ScorecardsLoad> {
  const a = await ask(query, { type: 'scorecards.get' });
  if (!a.ok) return a;
  const answer = a.r['answer'];
  if (!isObject(answer) || !Array.isArray(answer['scorecards'])) return failed;
  const cards = answer['scorecards'];
  if (!cards.every(isScorecard)) return failed;
  const days = answer['retentionDays'];
  return { ok: true, answer: { scorecards: cards, retentionDays: typeof days === 'number' ? days : NaN } };
}

export type CommandFn = (cmd: HuddleCommand) => Promise<CommandResult>;

/** Send one of the report's commands by session id; a missing sender or a throw reads as a failure in words. */
export async function sendReportCommand(
  onCommand: CommandFn | null,
  kind: ReportCommandKind,
  sessionId: string,
): Promise<CommandResult> {
  if (onCommand === null) return { ok: false, code: 'unsupported', message: REPORT_WORDS.commandsUnavailable };
  try {
    const r: unknown = await onCommand(reportCommand(kind, sessionId));
    if (isObject(r) && (r['ok'] === true || (r['ok'] === false && typeof r['message'] === 'string'))) {
      return r as unknown as CommandResult;
    }
    return { ok: false, code: 'failed', message: failed.message };
  } catch {
    return { ok: false, code: 'failed', message: failed.message };
  }
}
