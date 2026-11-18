/**
 * zod schemas for the M5 contracts (F22-F25): the history, replay, report, scorecard and Ask questions on
 * `huddle:query`, and the commands M5 adds. Types are in `@huddle/shared` (control.ts, remember.ts).
 *
 * Same rules as m3-schemas.ts and m4-schemas.ts: in core because `@huddle/shared` has no runtime dependencies; desktop
 * main joins them into its unions (`validate.ts`), and the renderer never imports them. `z.looseObject` keeps unknown
 * fields, a wrong shape fails `safeParse` (the `parse*` helpers return null, never throw).
 *
 * Page sizes and indexes are clamped rather than refused (a renderer asking for 10 000 rows gets 200); anything that
 * picks what to delete or which run to touch is refused when out of range (retention days, the delete-all word, a
 * session id the store would not accept).
 */
import { z } from 'zod';
import {
  ASK_HISTORY_ANSWER_MAX,
  ASK_HISTORY_TURNS_MAX,
  ASK_QUESTION_MAX,
  CLIP_LIMITS,
  DELETE_ALL_CONFIRM,
  HISTORY_EVENTS_MAX,
  HISTORY_PAGE_MAX,
  HISTORY_SEARCH_TEXT_MAX,
  type HuddleCommand,
  type M5Query,
  type M5QueryType,
  type QueryResult,
} from '@huddle/shared';
import { retentionDaysSchema } from '../runtime/huddle-settings.js';
import { isValidSessionId } from '../store/index.js';
import { maskSecrets } from '../privacy/redact.js';
import { agentKeyText, command } from './schema-parts.js';

/** The same rule as the event stores' file and row keys (`isValidSessionId`): letters, digits, `.`, `_`, `-`. */
export const sessionIdSchema = z.string().max(128).refine(isValidSessionId, { message: 'invalid session id' });

/** An integer clamped into [min, max]. Non-integers and non-numbers are refused. */
const clampedInt = (min: number, max: number) =>
  z
    .number()
    .int()
    .transform((n) => Math.min(max, Math.max(min, n)));

/** A non-negative event index; larger than the log is clamped by the core to the last event. */
const eventIndex = z
  .number()
  .int()
  .transform((n) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, n)));

const historyOutcome = z.enum(['completed', 'failed', 'stopped', 'running', 'no_end']);
const cursor = z.looseObject({ startTs: z.number().int().nonnegative(), sessionId: sessionIdSchema });
const folder = z.string().min(1).max(CLIP_LIMITS.path);
const pageLimit = clampedInt(1, HISTORY_PAGE_MAX);

/** Search text: trimmed; empty after trimming is refused (use `history.list`). Over-long text is cut, not refused. */
const searchText = z
  .string()
  .transform((s) => s.trim().slice(0, HISTORY_SEARCH_TEXT_MAX))
  .refine((s) => s.length > 0, { message: 'empty search' });

/** An Ask question: trimmed, 1..ASK_QUESTION_MAX characters. */
export const askQuestionSchema = z
  .string()
  .max(ASK_QUESTION_MAX * 4)
  .transform((s) => s.trim())
  .refine((s) => s.length > 0 && s.length <= ASK_QUESTION_MAX, { message: 'question empty or too long' });

/**
 * Earlier turns of an Ask conversation (Home Ask card): absurdly long text refused (over 4× its cap: question
 * ASK_QUESTION_MAX, answer ASK_HISTORY_ANSWER_MAX), at most 20 turns accepted and only the newest
 * ASK_HISTORY_TURNS_MAX kept. Secrets are masked here; the text is not clipped here on purpose: the core masks again
 * with the ingest token and only then clips (`cleanText` in ask-context.ts), so no secret or token is ever cut at the
 * limit before it was masked (security review of the branch, L2).
 */
const masked = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((s) => maskSecrets(s));

export const askHistorySchema = z
  .array(
    z.looseObject({
      question: masked(ASK_QUESTION_MAX),
      answer: masked(ASK_HISTORY_ANSWER_MAX),
    }),
  )
  .max(20)
  .transform((turns) => turns.slice(-ASK_HISTORY_TURNS_MAX).map((t) => ({ question: t.question, answer: t.answer })));

const filters = { outcome: historyOutcome.optional(), folder: folder.optional() };

export const m5QuerySchemas = [
  command('history.list', { limit: pageLimit, before: cursor.optional(), ...filters }),
  command('history.search', { text: searchText, limit: pageLimit, before: cursor.optional(), ...filters }),
  command('history.folders', {}),
  command('history.open', { sessionId: sessionIdSchema }),
  command('history.stateAt', { sessionId: sessionIdSchema, index: eventIndex }),
  command('history.events', {
    sessionId: sessionIdSchema,
    fromIndex: eventIndex,
    limit: clampedInt(1, HISTORY_EVENTS_MAX),
    backward: z.boolean().optional(),
    agentKey: agentKeyText.optional(),
    full: z.boolean().optional(),
  }),
  command('history.stats', {}),
  command('history.retentionPreview', { days: retentionDaysSchema }),
  command('report.get', { sessionId: sessionIdSchema }),
  command('scorecards.get', {}),
  command('ask.preview', { question: askQuestionSchema, history: askHistorySchema.optional() }),
] as const;

/** Every query type M5 adds. */
export const M5_QUERY_TYPES = [
  'history.list',
  'history.search',
  'history.folders',
  'history.open',
  'history.stateAt',
  'history.events',
  'history.stats',
  'history.retentionPreview',
  'report.get',
  'scorecards.get',
  'ask.preview',
] as const satisfies readonly M5QueryType[];

/** Compile-time check that the list above names every M5 query type (fails to compile otherwise). */
type AssertTrue<T extends true> = T;
export type M5QueriesAllListed = AssertTrue<
  [Exclude<M5QueryType, (typeof M5_QUERY_TYPES)[number]>] extends [never] ? true : false
>;

const M5_QUERY_TYPE_SET: ReadonlySet<string> = new Set(M5_QUERY_TYPES);

export function isM5Query(q: { type: string }): q is M5Query {
  return M5_QUERY_TYPE_SET.has(q.type);
}

/** Parse an untrusted M5 query. Returns null instead of throwing. */
export function parseM5Query(input: unknown): M5Query | null {
  const result = z.discriminatedUnion('type', [...m5QuerySchemas]).safeParse(input);
  const parsed: M5Query | null = result.success ? result.data : null;
  return parsed;
}

/** The typed answer for an M5 question this core does not answer yet. */
export function m5QueryNotAvailable(type: M5QueryType): QueryResult {
  return {
    ok: false,
    code: 'not_available',
    message: `This version of Agent Huddle cannot answer "${type}" yet.`,
  };
}

// --- commands -------------------------------------------------------------------------------------------------------

export const m5CommandSchemas = [
  command('ask.cancel', {}),
  command('ask.setEnabled', { enabled: z.boolean() }),
  // L4 (M5 security review): `confirm` is the run count `history.retentionPreview` answered; the core needs it to lower.
  command('history.setRetention', {
    days: retentionDaysSchema,
    confirm: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  command('history.deleteAll', { confirm: z.literal(DELETE_ALL_CONFIRM) }),
  command('report.make', { sessionId: sessionIdSchema }),
  command('report.openFile', { sessionId: sessionIdSchema }),
  command('report.copyPath', { sessionId: sessionIdSchema }),
] as const;

/** `huddle.ask` with the M5 question rule (trimmed, 1..ASK_QUESTION_MAX); replaces the M1 placeholder schema. */
export const huddleAskCommandSchema = command('huddle.ask', {
  question: askQuestionSchema,
  history: askHistorySchema.optional(),
});

/** Every command type M5 adds (plus `huddle.ask`, whose schema M5 tightens). */
export const M5_COMMAND_TYPES = [
  'ask.cancel',
  'ask.setEnabled',
  'history.setRetention',
  'history.deleteAll',
  'report.make',
  'report.openFile',
  'report.copyPath',
] as const satisfies readonly HuddleCommand['type'][];

export type M5CommandType = (typeof M5_COMMAND_TYPES)[number];
type M5Command = Extract<HuddleCommand, { type: M5CommandType | 'huddle.ask' }>;

/** Parse an untrusted M5 command (or `huddle.ask`). Returns null instead of throwing. */
export function parseM5Command(input: unknown): M5Command | null {
  const result = z.discriminatedUnion('type', [...m5CommandSchemas, huddleAskCommandSchema]).safeParse(input);
  const parsed: M5Command | null = result.success ? result.data : null;
  return parsed;
}
