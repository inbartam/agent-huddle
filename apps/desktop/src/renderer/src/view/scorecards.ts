/**
 * Scorecards (M5, F24): the words and shapes of History's Scorecards tab, pure (DESIGN.md "Scorecards (F24)", "Words
 * for remembering (M5)"). The component (components/Scorecards.tsx) only draws what these return.
 *
 * "Used for estimates" comes from `priorUnitMsFor` in `@huddle/shared`, the same function that hands the ETA its prior,
 * so the table and the estimate cannot drift apart. Unknown is `—`, never 0. Differences are in neutral words, never
 * "better" or "worse": the runs did different work.
 */
import { MIN_PRIOR_SAMPLES, priorUnitMsFor, type QueryResult, type Scorecard } from '@huddle/shared';
import { count, percent, shortCount, shortModel, UNKNOWN } from './format.js';
import { dayLabel } from './history.js';

export const SCORECARD_WORDS = {
  roleAndModel: 'Role and model',
  runs: 'Runs',
  tasks: 'Tasks',
  timePerTask: 'Time per task',
  tokensPerTask: 'Tokens per task',
  failedRuns: 'Failed runs',
  failedToolCalls: 'Failed tool calls',
  approvals: 'Approvals',
  stuck: 'Stuck',
  usedForEstimates: 'Used for estimates',
  fewRuns: 'few runs',
  yes: 'yes',
  needsRuns: `needs ${String(MIN_PRIOR_SAMPLES)} runs`,
  modelUnknown: 'model unknown',
  compare: 'Compare models',
  modelA: 'Model A',
  modelB: 'Model B',
  close: 'Close comparison',
  tooFew: `Too few finished runs to compare (needs ${String(MIN_PRIOR_SAMPLES)} each).`,
  caveat: 'These runs did different work. A difference is a hint, not a test.',
  empty: 'No finished agent runs yet. Scorecards fill in as runs finish.',
  loading: 'Working out scorecards…',
  tryAgain: 'Try again',
  // Not in DESIGN's word list (reported to the owner):
  notAvailable: "Scorecards aren't available yet in this build.",
  metric: 'Metric',
  difference: 'Difference',
  approvalsPerRun: 'Approvals per run',
  stuckPerRun: 'Stuck per run',
  firstRun: 'First run',
  lastRun: 'Last run',
} as const;

export function scorecardsIntro(retentionDays: number): string {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? Math.round(retentionDays) : null;
  const span = days === null ? 'your history' : days === 1 ? 'the last day' : `the last ${String(days)} days`;
  return (
    `From the runs in your history (${span}). Times are per task: a task from the agent's list, ` +
    'or the whole run when it kept none.'
  );
}

type Failed = Extract<QueryResult, { ok: false }>;

export function scorecardsFailure(r: Failed): string {
  if (r.code === 'not_available' || r.code === 'unsupported') return SCORECARD_WORDS.notAvailable;
  return `Couldn't work out the scorecards: ${r.message.replace(/\.\s*$/, '')}.`;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A measured median per task: "45 s", "4.2 min", "1.3 h". No `~`: it is a measurement, not an estimate. */
export function perTaskTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${String(Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function rateWords(rate: number | null): string {
  return rate === null ? UNKNOWN : percent(rate * 100);
}

export function tokensPerTaskWords(n: number | null): string {
  return n === null ? UNKNOWN : shortCount(n);
}

export function modelLabel(model: string | null): string {
  return model === null ? SCORECARD_WORDS.modelUnknown : shortModel(model);
}

export function sampleWords(n: number): string {
  return `n=${count(n)}`;
}

export function isSmall(n: number): boolean {
  return n < MIN_PRIOR_SAMPLES;
}

/** The tooltip on a value resting on fewer than MIN_PRIOR_SAMPLES finished runs; null when there are enough or none. */
export function smallSampleTitle(n: number): string | null {
  if (!isSmall(n) || n <= 0) return null;
  return `Only ${count(n)} finished ${n === 1 ? 'run' : 'runs'}: one long run can set this number alone.`;
}

/**
 * "yes" exactly when `priorUnitMsFor` would hand the ETA this card's median. It looks up the first card for the pair,
 * so a second card for the same role and model (a core bug) says "no" rather than claiming to be used.
 */
export function usedForEstimates(all: readonly Scorecard[], card: Scorecard): 'yes' | 'needs_runs' | 'no' {
  const prior = priorUnitMsFor(all, card.role, card.model);
  const first = all.find((c) => c.role === card.role && c.model === card.model);
  if (prior !== null && first === card) return 'yes';
  return isSmall(card.sampleSize) ? 'needs_runs' : 'no';
}

export function usedWords(used: 'yes' | 'needs_runs' | 'no'): string {
  return used === 'yes' ? SCORECARD_WORDS.yes : used === 'needs_runs' ? SCORECARD_WORDS.needsRuns : UNKNOWN;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface ScoreRow {
  card: Scorecard;
  model: string;
  /** Fewer than MIN_PRIOR_SAMPLES finished runs gave the time per task: the row says "few runs". */
  few: boolean;
  used: 'yes' | 'needs_runs' | 'no';
}

export interface RoleGroup {
  role: string;
  runs: number;
  rows: ScoreRow[];
}

/** Roles by runs (most first), and models by runs within a role; ties by name so the order is stable. */
export function groupScorecards(cards: readonly Scorecard[]): RoleGroup[] {
  const byRole = new Map<string, Scorecard[]>();
  for (const c of cards) {
    const list = byRole.get(c.role) ?? [];
    list.push(c);
    byRole.set(c.role, list);
  }
  const groups: RoleGroup[] = [...byRole].map(([role, list]) => ({
    role,
    runs: list.reduce((n, c) => n + c.runs, 0),
    rows: list
      .map((card) => ({
        card,
        model: modelLabel(card.model),
        few: isSmall(card.sampleSize),
        used: usedForEstimates(cards, card),
      }))
      .sort((a, b) => b.card.runs - a.card.runs || a.model.localeCompare(b.model)),
  }));
  return groups.sort((a, b) => b.runs - a.runs || a.role.localeCompare(b.role));
}

export function modelCountWords(n: number): string {
  return n === 1 ? '1 model' : `${count(n)} models`;
}

// ---------------------------------------------------------------------------
// Compare two models on one role
// ---------------------------------------------------------------------------

export interface CompareRow {
  metric: string;
  a: string;
  b: string;
  /** Null: no difference cell for this metric (counts and dates). */
  diff: string | null;
  /** The difference rests on too few finished runs. */
  tooFew: boolean;
}

function perRun(n: number, runs: number): number | null {
  return runs > 0 ? n / runs : null;
}

function oneDecimal(n: number | null): string {
  return n === null ? UNKNOWN : n.toFixed(1);
}

/** "<B> takes 2.1 min less per task" / "more"; about the same when they round to the same value. */
export function timeDiff(aName: string, bName: string, a: number | null, b: number | null): string {
  if (a === null || b === null) return UNKNOWN;
  const d = b - a;
  if (perTaskTime(a) === perTaskTime(b)) return `${bName} and ${aName} take about the same time per task`;
  return `${bName} takes ${perTaskTime(Math.abs(d))} ${d < 0 ? 'less' : 'more'} per task`;
}

/** "<B> uses 9k fewer tokens per task" / "more". */
export function tokensDiff(aName: string, bName: string, a: number | null, b: number | null): string {
  if (a === null || b === null) return UNKNOWN;
  const d = b - a;
  if (shortCount(a) === shortCount(b)) return `${bName} and ${aName} use about the same tokens per task`;
  return `${bName} uses ${shortCount(Math.abs(d))} ${d < 0 ? 'fewer' : 'more'} tokens per task`;
}

/** "8% vs 0%": A then B, no verdict. */
function versus(a: string, b: string): string {
  return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : `${a} vs ${b}`;
}

/**
 * The comparison table: metric | A | B | difference. When either side rests on fewer than MIN_PRIOR_SAMPLES finished
 * runs, the values still show and the difference cell says "Too few finished runs to compare".
 */
export function compareRows(a: Scorecard, b: Scorecard, now: number): CompareRow[] {
  const aName = modelLabel(a.model);
  const bName = modelLabel(b.model);
  const fewTime = isSmall(a.sampleSize) || isSmall(b.sampleSize);
  const fewTokens = isSmall(a.tokenSampleSize) || isSmall(b.tokenSampleSize);
  const gated = (few: boolean, diff: string): Pick<CompareRow, 'diff' | 'tooFew'> =>
    few ? { diff: SCORECARD_WORDS.tooFew, tooFew: true } : { diff, tooFew: false };
  const row = (metric: string, av: string, bv: string, diff: Pick<CompareRow, 'diff' | 'tooFew'>): CompareRow => ({
    metric,
    a: av,
    b: bv,
    ...diff,
  });
  const fr = [rateWords(a.failureRate), rateWords(b.failureRate)] as const;
  const tf = [rateWords(a.toolFailureRate), rateWords(b.toolFailureRate)] as const;
  const ap = [
    oneDecimal(perRun(a.approvalsRequested, a.runs)),
    oneDecimal(perRun(b.approvalsRequested, b.runs)),
  ] as const;
  const st = [oneDecimal(perRun(a.stuckIncidents, a.runs)), oneDecimal(perRun(b.stuckIncidents, b.runs))] as const;
  const none = { diff: null, tooFew: false };
  return [
    row(
      SCORECARD_WORDS.timePerTask,
      `${perTaskTime(a.medianTaskMs)} ${sampleWords(a.sampleSize)}`,
      `${perTaskTime(b.medianTaskMs)} ${sampleWords(b.sampleSize)}`,
      gated(fewTime, timeDiff(aName, bName, a.medianTaskMs, b.medianTaskMs)),
    ),
    row(
      SCORECARD_WORDS.tokensPerTask,
      `${tokensPerTaskWords(a.tokensPerTask)} ${sampleWords(a.tokenSampleSize)}`,
      `${tokensPerTaskWords(b.tokensPerTask)} ${sampleWords(b.tokenSampleSize)}`,
      gated(fewTokens, tokensDiff(aName, bName, a.tokensPerTask, b.tokensPerTask)),
    ),
    row(SCORECARD_WORDS.failedRuns, fr[0], fr[1], gated(fewTime, versus(fr[0], fr[1]))),
    row(SCORECARD_WORDS.failedToolCalls, tf[0], tf[1], gated(fewTime, versus(tf[0], tf[1]))),
    row(SCORECARD_WORDS.approvalsPerRun, ap[0], ap[1], gated(fewTime, versus(ap[0], ap[1]))),
    row(SCORECARD_WORDS.stuckPerRun, st[0], st[1], gated(fewTime, versus(st[0], st[1]))),
    row(SCORECARD_WORDS.runs, count(a.runs), count(b.runs), none),
    row(SCORECARD_WORDS.firstRun, dayLabel(a.firstRunAt, now), dayLabel(b.firstRunAt, now), none),
    row(SCORECARD_WORDS.lastRun, dayLabel(a.lastRunAt, now), dayLabel(b.lastRunAt, now), none),
  ];
}

/**
 * The two models a comparison opens on: the two known models with the most runs (rows are already sorted that way).
 * A row whose model is unknown is never picked by itself; it can still be chosen by hand. Null: fewer than two known.
 */
export function defaultPair(group: RoleGroup): [number, number] | null {
  const known = group.rows.flatMap((r, i) => (r.card.model !== null ? [i] : []));
  const [a, b] = known;
  return a !== undefined && b !== undefined ? [a, b] : null;
}

/** Where Model A starts when there is no default pair: the one known model, if there is one; else nothing chosen. */
export function soleKnownModel(group: RoleGroup): number | null {
  const i = group.rows.findIndex((r) => r.card.model !== null);
  return i >= 0 ? i : null;
}
