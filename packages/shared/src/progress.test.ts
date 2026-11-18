import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ETA_PARAMS,
  ETA_LATE_SKEW,
  ETA_SPREAD,
  OVERDUE_FLOOR,
  SEQUENTIAL_EXTRA_UNITS,
  WRAP_UP_DURATION_FACTOR,
  WRAP_UP_UNITS,
  estimateProgress,
  estimateSubagentProgress,
  type SubagentUnit,
} from './progress.js';

const T0 = 1_000_000;
const MIN = 60_000;

describe('estimateSubagentProgress', () => {
  it('gives no basis for an empty list', () => {
    expect(estimateSubagentProgress([], T0)).toBeNull();
  });

  it('counts running subagents as not done and has no ETA before the first completion', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: null },
      { startedAt: T0, completedAt: null },
    ];
    const p = estimateSubagentProgress(units, T0 + 5 * MIN);
    expect(p).toMatchObject({ fraction: 0, basis: 'subagents', etaMs: null, etaLowMs: null, etaHighMs: null });
    expect(p?.confidence).toBe('low');
    expect(p?.scopeGrew).toBe(false);
  });

  it('with one completion gives a low-confidence ETA with the wide range', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + 4 * MIN },
      { startedAt: T0, completedAt: null },
    ];
    const p = estimateSubagentProgress(units, T0 + 4 * MIN);
    expect(p?.fraction).toBe(0.5);
    expect(p?.confidence).toBe('low');
    expect(p?.etaMs).toBe(4 * MIN);
    // Asymmetric: finishes skew late, so the upper half-width is ETA_LATE_SKEW times the lower one.
    expect(p?.etaLowMs).toBeCloseTo(4 * MIN * (1 - ETA_SPREAD.low));
    expect(p?.etaHighMs).toBeCloseTo(4 * MIN * (1 + ETA_SPREAD.low * ETA_LATE_SKEW));
  });

  it('rises to medium confidence with two completions', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + 2 * MIN },
      { startedAt: T0, completedAt: T0 + 4 * MIN },
      { startedAt: T0, completedAt: null },
    ];
    const p = estimateSubagentProgress(units, T0 + 4 * MIN);
    expect(p?.confidence).toBe('medium');
    expect(p?.etaMs).toBe(2 * MIN);
  });

  it('is done with ETA 0 when every subagent finished', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + MIN },
      { startedAt: T0, completedAt: T0 + 2 * MIN },
    ];
    const p = estimateSubagentProgress(units, T0 + 3 * MIN);
    expect(p?.fraction).toBe(1);
    expect(p?.etaMs).toBe(0);
  });

  it('marks scope grew when a subagent started after another finished', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + 2 * MIN },
      { startedAt: T0 + 3 * MIN, completedAt: null },
    ];
    expect(estimateSubagentProgress(units, T0 + 4 * MIN)?.scopeGrew).toBe(true);
  });

  it('keeps a floor on the running unit and drops to low confidence once overdue', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + MIN },
      { startedAt: T0, completedAt: T0 + 2 * MIN },
      { startedAt: T0, completedAt: null },
    ];
    const p = estimateSubagentProgress(units, T0 + 30 * MIN);
    expect(p?.etaMs).toBe(OVERDUE_FLOOR * MIN);
    expect(p?.confidence).toBe('low');
  });
});

describe('estimateSubagentProgress with parentWrapUp', () => {
  it('counts the wrap-up as one more unit and keeps a non-zero, low-confidence ETA when only it is left', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + 2 * MIN },
      { startedAt: T0, completedAt: T0 + 4 * MIN },
      { startedAt: T0, completedAt: T0 + 6 * MIN },
    ];
    const p = estimateSubagentProgress(units, T0 + 6 * MIN, { parentWrapUp: true });
    expect(p?.fraction).toBe(3 / (3 + WRAP_UP_UNITS));
    // The wrap-up costs the mean subagent duration (2, 4, 6 min: 4 min), not the 2 min gap between completions.
    expect(p?.etaMs).toBe(WRAP_UP_DURATION_FACTOR * 4 * MIN);
    expect(p?.confidence).toBe('low');
    // It counts down from the last completion and keeps a floor once overdue.
    expect(estimateSubagentProgress(units, T0 + 7 * MIN, { parentWrapUp: true })?.etaMs).toBe(3 * MIN);
    const stuck = estimateSubagentProgress(units, T0 + 60 * MIN, { parentWrapUp: true });
    expect(stuck?.etaMs).toBe(OVERDUE_FLOOR * 4 * MIN);
  });

  it('prices the wrap-up of parallel subagents by their duration, not by their (short) throughput gap', () => {
    // Four parallel subagents of about 10 min that finish 30 s apart.
    const units: SubagentUnit[] = [0, 1, 2, 3].map((i) => ({
      startedAt: T0 + i * 30_000,
      completedAt: T0 + 10 * MIN + i * 30_000,
    }));
    const last = T0 + 10 * MIN + 90_000;
    const p = estimateSubagentProgress(units, last, { parentWrapUp: true });
    expect(p?.etaMs).toBe(10 * MIN);
    // They overlapped, so this is not the sequential pattern: no extra on the upper end.
    expect(p?.etaHighMs).toBeCloseTo(10 * MIN * (1 + ETA_SPREAD.low * ETA_LATE_SKEW));
  });

  it('adds the wrap-up to the time left on running subagents', () => {
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + 2 * MIN },
      { startedAt: T0, completedAt: T0 + 4 * MIN },
      { startedAt: T0, completedAt: null },
    ];
    // Throughput: 2 min left on the running one; wrap-up: mean duration 3 min.
    const p = estimateSubagentProgress(units, T0 + 4 * MIN, { parentWrapUp: true });
    expect(p?.etaMs).toBe(2 * MIN + WRAP_UP_DURATION_FACTOR * 3 * MIN);
    expect(p?.confidence).toBe('medium');
  });

  it('in the sequential pattern, allows more subagents on the upper end only', () => {
    // One at a time, all finished, the parent still works: another one may or may not follow.
    const units: SubagentUnit[] = [
      { startedAt: T0, completedAt: T0 + 2 * MIN },
      { startedAt: T0 + 3 * MIN, completedAt: T0 + 5 * MIN },
    ];
    const p = estimateSubagentProgress(units, T0 + 5 * MIN, { parentWrapUp: true });
    const wrap = WRAP_UP_DURATION_FACTOR * 2 * MIN;
    expect(p?.etaMs).toBe(wrap);
    expect(p?.confidence).toBe('low');
    expect(p?.etaLowMs).toBeCloseTo(wrap * (1 - ETA_SPREAD.low));
    expect(p?.etaHighMs).toBeCloseTo(wrap * (1 + ETA_SPREAD.low * ETA_LATE_SKEW) + SEQUENTIAL_EXTRA_UNITS * 2 * MIN);
    // A single started subagent is the same case: nothing says whether it was the only one.
    const one = estimateSubagentProgress([units[0] as SubagentUnit], T0 + 2 * MIN, { parentWrapUp: true });
    expect(one?.etaHighMs).toBeCloseTo(wrap * (1 + ETA_SPREAD.low * ETA_LATE_SKEW) + SEQUENTIAL_EXTRA_UNITS * 2 * MIN);
  });

  it('has no ETA without a finished subagent or a prior (no basis), and uses the prior when given', () => {
    const units: SubagentUnit[] = [{ startedAt: T0, completedAt: null }];
    expect(estimateSubagentProgress(units, T0 + MIN, { parentWrapUp: true })).toMatchObject({
      fraction: 0,
      etaMs: null,
      etaLowMs: null,
      etaHighMs: null,
    });
    const withPrior = estimateSubagentProgress(units, T0 + MIN, { parentWrapUp: true, priorUnitMs: 4 * MIN });
    // 3 min left on the running one, then a wrap-up of one prior duration.
    expect(withPrior?.etaMs).toBe(3 * MIN + WRAP_UP_DURATION_FACTOR * 4 * MIN);
  });

  it('parameters change the new terms; the defaults are the exported constants', () => {
    const units: SubagentUnit[] = [{ startedAt: T0, completedAt: T0 + 2 * MIN }];
    const base = estimateSubagentProgress(units, T0 + 2 * MIN, { parentWrapUp: true });
    expect(estimateSubagentProgress(units, T0 + 2 * MIN, { parentWrapUp: true, params: DEFAULT_ETA_PARAMS })).toEqual(
      base,
    );
    const plain = estimateSubagentProgress(units, T0 + 2 * MIN, {
      parentWrapUp: true,
      params: { ...DEFAULT_ETA_PARAMS, wrapUpDurationFactor: 0.5, lateSkew: 1, sequentialExtraUnits: 0 },
    });
    expect(plain?.etaMs).toBe(MIN);
    expect(plain?.etaHighMs).toBeCloseTo(MIN * (1 + ETA_SPREAD.low));
  });

  it('without the option, all done is fraction 1 and ETA 0', () => {
    const units: SubagentUnit[] = [{ startedAt: T0, completedAt: T0 + MIN }];
    expect(estimateSubagentProgress(units, T0 + 2 * MIN, { parentWrapUp: false })).toMatchObject({
      fraction: 1,
      etaMs: 0,
    });
  });
});

describe('estimateProgress with a partial self-report (F27: every field optional)', () => {
  const tasks = [
    { status: 'completed' as const, createdAt: T0, completedAt: T0 + MIN },
    { status: 'pending' as const, createdAt: T0 },
  ];

  it('fraction null and no tasks: fraction unknown (never 0), ETA from minutes left', () => {
    const p = estimateProgress({
      tasks: [],
      selfReport: { fraction: null, etaMinutes: 4, reportedAt: T0 },
      now: T0 + MIN,
      startedAt: T0,
      priorTaskMs: null,
    });
    expect(p).toMatchObject({ fraction: null, basis: 'self_report', etaMs: 3 * MIN });
  });

  it('fraction null with tasks: the fraction is the task fraction (no hybrid)', () => {
    const p = estimateProgress({
      tasks,
      selfReport: { fraction: null, etaMinutes: null, reportedAt: T0 + MIN },
      now: T0 + MIN,
      startedAt: T0,
      priorTaskMs: null,
    });
    expect(p).toMatchObject({ fraction: 0.5, basis: 'tasks' });
  });

  it('nothing usable: basis none', () => {
    const p = estimateProgress({
      tasks: [],
      selfReport: { fraction: null, etaMinutes: null, reportedAt: T0 },
      now: T0,
      startedAt: T0,
      priorTaskMs: null,
    });
    expect(p).toMatchObject({ fraction: null, basis: 'none', etaMs: null });
  });

  it('a non-finite fraction is treated as none', () => {
    const p = estimateProgress({
      tasks: [],
      selfReport: { fraction: Number.NaN, etaMinutes: null, reportedAt: T0 },
      now: T0,
      startedAt: T0,
      priorTaskMs: null,
    });
    expect(p).toMatchObject({ fraction: null, basis: 'none' });
  });
});

describe('estimateProgress (tasks and self-report, unchanged behaviour)', () => {
  it('no basis gives fraction null and no ETA', () => {
    const p = estimateProgress({ tasks: [], selfReport: null, now: T0, startedAt: T0, priorTaskMs: null });
    expect(p).toMatchObject({ fraction: null, etaMs: null, etaLowMs: null, etaHighMs: null, basis: 'none' });
  });

  it('uses tasks when there are tasks', () => {
    const p = estimateProgress({
      tasks: [
        { status: 'completed', createdAt: T0, completedAt: T0 + MIN },
        { status: 'pending', createdAt: T0 },
      ],
      selfReport: null,
      now: T0 + MIN,
      startedAt: T0,
      priorTaskMs: null,
    });
    expect(p).toMatchObject({ fraction: 0.5, basis: 'tasks', completedTasks: 1, totalTasks: 2, etaMs: MIN });
    expect(p.scopeGrew).toBeUndefined();
  });

  it('uses a fresh self-report alone when there are no tasks', () => {
    const p = estimateProgress({
      tasks: [],
      selfReport: { fraction: 0.3, etaMinutes: 10, reportedAt: T0 },
      now: T0,
      startedAt: T0,
      priorTaskMs: null,
    });
    expect(p).toMatchObject({ fraction: 0.3, basis: 'self_report', etaMs: 10 * MIN });
  });
});
