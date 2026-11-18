/**
 * Progress and ETA: the "hybrid" estimator.
 *
 * Signals, in the order ADR-010 uses them:
 *   0. For an agent with subagents: each direct subagent is one unit, finished / started
 *      (`estimateSubagentProgress`). A running subagent counts as not done.
 *   1. The agent's own report (percent, minutes left). Fine-grained, but agents are
 *      optimistic and a report goes stale the moment it is sent.
 *   2. The agent's task list (TaskCreated / TaskCompleted hooks). Objective, but coarse:
 *      tasks differ in size and the list can grow while the agent works.
 *
 * How self-report and tasks are combined
 *   fraction = w * self + (1 - w) * tasks          w = MAX_SELF_WEIGHT * 0.5 ^ (age / HALF_LIFE)
 *
 *   A fresh self-report gets at most half the say; after one half-life (5 min) a quarter;
 *   it fades to nothing instead of freezing the bar at a stale number.
 *
 * ETA from units (tasks or subagents) is a throughput estimate:
 *   pace      = median gap between completions (the median resists one long unit)
 *   pace'     = (n * pace + PRIOR_STRENGTH * prior) / (n + PRIOR_STRENGTH)    shrink toward history
 *   eta       = (remaining - 1) * pace' + what is left of the current unit
 *               where the current unit never drops below OVERDUE_FLOOR * pace' while unfinished
 *   Subagents often run in parallel; the median gap is then a throughput, not a duration, which is
 *   what the formula needs.
 *
 * For subagents, the parent's wrap-up after the last one is a separate term priced by the mean subagent duration, the
 * range is asymmetric (finishes skew late), and the sequential pattern widens the upper end (see
 * `estimateSubagentProgress`; evidence: the tune runs in fixtures/runs, `ETA_GROUP=tune npm run eval:eta`).
 *
 * The range and the confidence label widen when there is little evidence, and confidence drops
 * to "low" when the current unit has run more than OVERDUE_FACTOR times the usual pace (at that point
 * the stuck detector, not the ETA, is the useful signal). Show range and confidence: a single
 * confident-looking number from two completions would be false precision.
 *
 * Everything here is a heuristic to be tuned against recorded runs (docs/ROADMAP.md, M2). The constants are
 * exported so the evaluation harness can read them; change them only with before-and-after numbers.
 */
import type { ProgressEstimate, TaskItem } from './model.js';

export const SELF_REPORT_HALF_LIFE_MS = 5 * 60_000;
export const MAX_SELF_WEIGHT = 0.5;
export const PRIOR_STRENGTH = 2;
export const OVERDUE_FLOOR = 0.25;
/** The current unit counts as overdue (confidence drops to low) after this many times the usual pace. */
export const OVERDUE_FACTOR = 2;
/** Completions (gaps) needed before the confidence label rises. */
export const HIGH_CONFIDENCE_MIN_COMPLETIONS = 5;
export const MEDIUM_CONFIDENCE_MIN_COMPLETIONS = 2;
/** Half-width of the ETA range as a fraction of the point estimate, per confidence label. */
export const ETA_SPREAD: Readonly<Record<ProgressEstimate['confidence'], number>> = {
  high: 0.25,
  medium: 0.4,
  low: 0.6,
};

/** Units counted for the parent's own wrap-up in the progress fraction while it has not ended. */
export const WRAP_UP_UNITS = 1;

/**
 * Subagent ETA only. The parent's wrap-up (after its last subagent) is expected to take this many times the mean
 * duration (start to stop) of its finished subagents. It used to cost one throughput gap, which for parallel subagents
 * is a few seconds: in the two parallel tune runs that priced the wrap-up at 2.8-5 s against a real 18-22 s. Over the
 * six parents in the tune runs the real wrap-up was 5-26 s, 0.2-1.75x the mean subagent duration (about 1x typical).
 * 1 was chosen before the sensitivity check (0.5-1.5); it also had the lowest median point error (11 s vs 13-15 s).
 */
export const WRAP_UP_DURATION_FACTOR = 1;

/**
 * Subagent ETA only. The range's upper half-width is the confidence spread times this; the lower half-width is the
 * spread itself. Finishes skew late: on the tune runs at baseline, real time left / point estimate was above 1 at 13
 * of 19 check points (median 1.76). At the chosen factor, skew 2 and 3 gave the same tune containment (14/19), 1.5 gave
 * 12/19: 2 is the narrower end of that plateau.
 */
export const ETA_LATE_SKEW = 2;

/**
 * Subagent ETA only. When every subagent started so far has finished, none ever ran alongside another (a sequential
 * pattern), and the parent still works, nothing tells whether it will start another one. The upper end then allows
 * this many more subagents of the mean duration. In both sequential tune runs more followed after the first and second
 * completions (real time left 2.2-6.5x the mean duration). 1 ("maybe one more") is the honest minimum; 2 gained no
 * tune check point at the chosen factor and skew.
 */
export const SEQUENTIAL_EXTRA_UNITS = 1;

/** The tunable constants of the subagent estimator, so an evaluation harness can try other values. */
export interface EtaParams {
  overdueFloor: number;
  overdueFactor: number;
  highConfidenceMinCompletions: number;
  mediumConfidenceMinCompletions: number;
  etaSpread: Readonly<Record<ProgressEstimate['confidence'], number>>;
  wrapUpUnits: number;
  /** See WRAP_UP_DURATION_FACTOR. */
  wrapUpDurationFactor: number;
  /** See ETA_LATE_SKEW. */
  lateSkew: number;
  /** See SEQUENTIAL_EXTRA_UNITS. */
  sequentialExtraUnits: number;
}

/** The exported constants as one object: what every caller gets when it passes no params. */
export const DEFAULT_ETA_PARAMS: EtaParams = {
  overdueFloor: OVERDUE_FLOOR,
  overdueFactor: OVERDUE_FACTOR,
  highConfidenceMinCompletions: HIGH_CONFIDENCE_MIN_COMPLETIONS,
  mediumConfidenceMinCompletions: MEDIUM_CONFIDENCE_MIN_COMPLETIONS,
  etaSpread: ETA_SPREAD,
  wrapUpUnits: WRAP_UP_UNITS,
  wrapUpDurationFactor: WRAP_UP_DURATION_FACTOR,
  lateSkew: ETA_LATE_SKEW,
  sequentialExtraUnits: SEQUENTIAL_EXTRA_UNITS,
};

export interface SelfReport {
  /** 0..1, or null when the report gave only minutes left (F27: every field of the tool is optional). */
  fraction: number | null;
  etaMinutes: number | null;
  reportedAt: number;
}

export interface ProgressInput {
  tasks: readonly Pick<TaskItem, 'status' | 'createdAt' | 'completedAt'>[];
  selfReport: SelfReport | null;
  now: number;
  /** When the agent started working; anchors the first completion gap. */
  startedAt: number;
  /** Median time per task for this role and model from past runs, if known. */
  priorTaskMs: number | null;
}

/** One direct subagent as a unit of work (ADR-010). `completedAt` is null while it runs. */
export interface SubagentUnit {
  startedAt: number;
  completedAt: number | null;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  if (sorted.length % 2 === 1) return hi;
  return ((sorted[mid - 1] as number) + hi) / 2;
}

/** Weight of the self-report: MAX_SELF_WEIGHT when brand new, halving every half-life. */
export function selfReportWeight(ageMs: number): number {
  if (ageMs < 0) return MAX_SELF_WEIGHT;
  return MAX_SELF_WEIGHT * Math.pow(0.5, ageMs / SELF_REPORT_HALF_LIFE_MS);
}

interface PaceEta {
  etaMs: number | null;
  gaps: number;
  overdue: boolean;
}

/** Throughput ETA over `total` units of which `completions` (sorted ascending) are done. */
function paceAndEta(
  completions: readonly number[],
  total: number,
  startedAt: number,
  now: number,
  priorMs: number | null,
  params: EtaParams = DEFAULT_ETA_PARAMS,
): PaceEta {
  const remaining = total - completions.length;
  const gaps: number[] = [];
  let previous = startedAt;
  for (const c of completions) {
    gaps.push(Math.max(0, c - previous));
    previous = c;
  }
  const observedPace = median(gaps);
  let pace: number | null;
  if (observedPace !== null && priorMs !== null) {
    pace = (gaps.length * observedPace + PRIOR_STRENGTH * priorMs) / (gaps.length + PRIOR_STRENGTH);
  } else {
    pace = observedPace ?? priorMs;
  }

  let etaMs: number | null = null;
  let overdue = false;
  if (total > 0 && remaining === 0) {
    etaMs = 0;
  } else if (pace !== null && remaining > 0) {
    const elapsedOnCurrent = Math.max(0, now - previous);
    // An unfinished unit is never "0 minutes left": once it runs past the usual pace,
    // keep a floor instead of counting down to zero and sitting there.
    const currentLeft = Math.max(pace - elapsedOnCurrent, params.overdueFloor * pace);
    etaMs = (remaining - 1) * pace + currentLeft;
    overdue = elapsedOnCurrent > params.overdueFactor * pace;
  }
  return { etaMs, gaps: gaps.length, overdue };
}

function confidenceFor(
  gaps: number,
  overdue: boolean,
  params: EtaParams = DEFAULT_ETA_PARAMS,
): ProgressEstimate['confidence'] {
  const evidence = overdue ? 0 : gaps;
  if (evidence >= params.highConfidenceMinCompletions) return 'high';
  if (evidence >= params.mediumConfidenceMinCompletions) return 'medium';
  return 'low';
}

function withRange(
  etaMs: number | null,
  confidence: ProgressEstimate['confidence'],
  params: EtaParams = DEFAULT_ETA_PARAMS,
): Pick<ProgressEstimate, 'etaMs' | 'etaLowMs' | 'etaHighMs'> {
  const spread = params.etaSpread[confidence];
  return {
    etaMs,
    etaLowMs: etaMs === null ? null : etaMs * (1 - spread),
    etaHighMs: etaMs === null ? null : etaMs * (1 + spread),
  };
}

/**
 * Progress over direct subagents (ADR-010, first basis): finished / started. `scopeGrew` is true when a subagent
 * started after another had finished, so the bar may have moved back. Null for an empty list (no basis).
 *
 * With `parentWrapUp` (the parent itself has not ended), the parent's own wrap-up (synthesizing the results)
 * counts as WRAP_UP_UNITS more units: fraction = finished / (started + 1), so the bar never reaches 1 while the
 * parent works. Its ETA is priced by duration, not by pace (see `estimateSubagentProgress`); once every subagent is
 * done and only the wrap-up is left, the ETA keeps the OVERDUE_FLOOR instead of 0 and confidence is 'low'.
 */
export interface SubagentProgressOptions {
  /** Typical time per subagent from past runs, if known (null today). */
  priorUnitMs?: number | null;
  /** The parent has not ended: count its wrap-up as one more unit still to do. */
  parentWrapUp?: boolean;
  /** Constants to use instead of the exported ones (evaluation harness only). */
  params?: EtaParams;
}

/** True when no two units ever ran at the same time (a unit still running runs until further notice). */
function neverOverlapped(units: readonly SubagentUnit[]): boolean {
  const sorted = [...units].sort((a, b) => a.startedAt - b.startedAt);
  for (let i = 1; i < sorted.length; i += 1) {
    const previousEnd = (sorted[i - 1] as SubagentUnit).completedAt ?? Number.POSITIVE_INFINITY;
    if ((sorted[i] as SubagentUnit).startedAt < previousEnd) return false;
  }
  return true;
}

/**
 * ETA over subagents (ADR-010), in two parts:
 *   subagents  the throughput estimate above over the subagents started so far (0 once they have all finished)
 *   wrap-up    while the parent works: WRAP_UP_DURATION_FACTOR x the mean duration of its finished subagents, counted
 *              down from the last completion once all have finished, never below OVERDUE_FLOOR of itself
 * Range: [eta x (1 - spread), eta x (1 + spread x ETA_LATE_SKEW)], plus SEQUENTIAL_EXTRA_UNITS mean durations on the
 * upper end in the sequential pattern (all started have finished, none overlapped, the parent still works).
 * No finished subagent and no prior: no basis, ETA null.
 */
export function estimateSubagentProgress(
  units: readonly SubagentUnit[],
  now: number,
  opts: SubagentProgressOptions = {},
): ProgressEstimate | null {
  if (units.length === 0) return null;
  const priorUnitMs = opts.priorUnitMs ?? null;
  const params = opts.params ?? DEFAULT_ETA_PARAMS;
  const parentWorking = opts.parentWrapUp === true;
  const total = units.length + (parentWorking ? params.wrapUpUnits : 0);
  const completions = units
    .map((u) => u.completedAt)
    .filter((c): c is number => c !== null)
    .sort((a, b) => a - b);
  const firstStart = Math.min(...units.map((u) => u.startedAt));
  const firstFinish = completions[0];
  const lastFinish = completions[completions.length - 1];
  const scopeGrew = firstFinish !== undefined && units.some((u) => u.startedAt > firstFinish);
  const allDone = completions.length === units.length;

  const durations = units.flatMap((u) => (u.completedAt === null ? [] : [Math.max(0, u.completedAt - u.startedAt)]));
  const meanDuration = durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : priorUnitMs;

  const subagents = paceAndEta(completions, units.length, firstStart, now, priorUnitMs, params);
  let wrapUpMs: number | null = 0;
  if (parentWorking) {
    if (meanDuration === null) {
      wrapUpMs = null;
    } else {
      const expected = params.wrapUpDurationFactor * meanDuration;
      const spent = allDone && lastFinish !== undefined ? Math.max(0, now - lastFinish) : 0;
      wrapUpMs = Math.max(expected - spent, params.overdueFloor * expected);
    }
  }
  const etaMs = subagents.etaMs === null || wrapUpMs === null ? null : subagents.etaMs + wrapUpMs;

  const onlyWrapUpLeft = parentWorking && allDone;
  const confidence = onlyWrapUpLeft ? 'low' : confidenceFor(subagents.gaps, subagents.overdue, params);
  const sequential = onlyWrapUpLeft && neverOverlapped(units);
  const extraHighMs = sequential && meanDuration !== null ? params.sequentialExtraUnits * meanDuration : 0;
  const spread = params.etaSpread[confidence];
  return {
    fraction: completions.length / total,
    completedTasks: 0,
    totalTasks: 0,
    etaMs,
    etaLowMs: etaMs === null ? null : etaMs * (1 - spread),
    etaHighMs: etaMs === null ? null : etaMs * (1 + spread * params.lateSkew) + extraHighMs,
    basis: 'subagents',
    confidence,
    scopeGrew,
  };
}

export function estimateProgress(input: ProgressInput): ProgressEstimate {
  const { tasks, selfReport, now, startedAt, priorTaskMs } = input;
  const total = tasks.length;
  const completions = tasks
    .filter((t) => t.status === 'completed' && typeof t.completedAt === 'number')
    .map((t) => t.completedAt as number)
    .sort((a, b) => a - b);
  const completed = completions.length;

  // --- fraction -------------------------------------------------------------
  const taskFraction = total > 0 ? completed / total : null;
  const selfAge = selfReport ? now - selfReport.reportedAt : Number.POSITIVE_INFINITY;
  const w = selfReport ? selfReportWeight(selfAge) : 0;
  const selfFraction =
    selfReport && selfReport.fraction !== null && Number.isFinite(selfReport.fraction)
      ? clamp01(selfReport.fraction)
      : null;
  const selfEta =
    selfReport && selfReport.etaMinutes !== null
      ? Math.max(0, selfReport.etaMinutes * 60_000 - Math.max(0, selfAge))
      : null;

  let fraction: number | null;
  let basis: ProgressEstimate['basis'];
  if (taskFraction !== null && selfFraction !== null && w > 0.01) {
    fraction = clamp01(w * selfFraction + (1 - w) * taskFraction);
    basis = 'hybrid';
  } else if (taskFraction !== null) {
    fraction = taskFraction;
    basis = 'tasks';
  } else if (selfFraction !== null) {
    fraction = selfFraction;
    basis = 'self_report';
  } else if (selfEta !== null && w > 0.01) {
    // Only minutes left: the fraction stays unknown (never shown as 0); the ETA below comes from the report.
    fraction = null;
    basis = 'self_report';
  } else {
    fraction = null;
    basis = 'none';
  }

  // --- pace and ETA from tasks, then blended with the self-report -----------
  const { etaMs: taskEta, gaps, overdue } = paceAndEta(completions, total, startedAt, now, priorTaskMs);

  let etaMs: number | null;
  if (taskEta !== null && selfEta !== null && w > 0.01) etaMs = w * selfEta + (1 - w) * taskEta;
  else etaMs = taskEta ?? (w > 0.01 ? selfEta : null);

  // --- how much to trust it ---------------------------------------------------
  const confidence = confidenceFor(gaps, overdue);

  return {
    fraction,
    completedTasks: completed,
    totalTasks: total,
    ...withRange(etaMs, confidence),
    basis,
    confidence,
  };
}
