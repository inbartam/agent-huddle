/** Scorecards (F24): grouping by role and model, medians, tokens per task, rates, and the ETA prior. */
import { describe, expect, it } from 'vitest';
import type { AgentRunRow, TokenCounts } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import { agentRunRows } from './agent-runs.js';
import { computeScorecards, MIN_PRIOR_SAMPLES, priorUnitMsFor } from './scorecards.js';

let n = 0;
function row(over: Partial<AgentRunRow> = {}): AgentRunRow {
  n += 1;
  return {
    sessionId: `s${String(n)}`,
    agentKey: `s${String(n)}::a`,
    parentKey: `s${String(n)}`,
    kind: 'subagent',
    role: 'Explore',
    model: 'claude-haiku-5-5',
    startedAt: 1000 * n,
    endedAt: 1000 * n + 10_000,
    durationMs: 10_000,
    outcome: 'completed',
    tasksCreated: 0,
    tasksCompleted: 0,
    toolCalls: 4,
    toolFailures: 0,
    approvals: { requested: 0, byUser: 0, byPolicy: 0, other: 0, unresolved: 0 },
    stuckIncidents: 0,
    tokens: null,
    estimatedCostUsd: null,
    costPartial: false,
    ...over,
  };
}

const tokens = (input: number, output: number): TokenCounts => ({
  input,
  output,
  cacheRead: 99_999,
  cacheCreation: 0,
  requests: 1,
});

describe('computeScorecards', () => {
  it('gives two rows with different numbers for two models on the same role', () => {
    const cards = computeScorecards([
      row({ model: 'claude-haiku-5-5', durationMs: 10_000, tokens: tokens(100, 10) }),
      row({ model: 'claude-haiku-5-5', durationMs: 20_000, tokens: tokens(300, 30) }),
      row({ model: 'claude-opus-5-5', durationMs: 60_000, tokens: tokens(1000, 500), toolFailures: 1 }),
    ]);
    expect(cards.map((c) => [c.role, c.model, c.runs])).toEqual([
      ['Explore', 'claude-haiku-5-5', 2],
      ['Explore', 'claude-opus-5-5', 1],
    ]);
    const [haiku, opus] = cards;
    expect(haiku?.medianTaskMs).toBe(15_000);
    expect(opus?.medianTaskMs).toBe(60_000);
    expect(haiku?.tokensPerTask).toBe(220); // (110 + 330) / 2, cache reads not counted
    expect(opus?.tokensPerTask).toBe(1500);
    expect(haiku?.toolFailureRate).toBe(0);
    expect(opus?.toolFailureRate).toBe(0.25);
  });

  it('takes the median of odd and even counts', () => {
    const odd = computeScorecards([30_000, 10_000, 20_000].map((d) => row({ durationMs: d })));
    expect(odd[0]?.medianTaskMs).toBe(20_000);
    expect(odd[0]?.sampleSize).toBe(3);
    const even = computeScorecards([40_000, 10_000, 20_000, 30_000].map((d) => row({ durationMs: d })));
    expect(even[0]?.medianTaskMs).toBe(25_000);
    expect(even[0]?.sampleSize).toBe(4);
  });

  it('leaves unknown tokens out of tokens per task instead of counting them as 0', () => {
    const cards = computeScorecards([row({ tokens: tokens(400, 100) }), row({ tokens: null }), row({ tokens: null })]);
    expect(cards[0]?.tokensPerTask).toBe(500);
    expect(cards[0]?.tokenSampleSize).toBe(1);
    expect(computeScorecards([row({ tokens: null })])[0]?.tokensPerTask).toBeNull();
  });

  it('counts a task-list run as one unit per completed task', () => {
    const cards = computeScorecards([
      row({
        role: 'main',
        kind: 'main',
        tasksCreated: 4,
        tasksCompleted: 4,
        durationMs: 40_000,
        tokens: tokens(800, 0),
      }),
    ]);
    expect(cards[0]).toMatchObject({ tasksCompleted: 4, units: 4, medianTaskMs: 10_000, tokensPerTask: 200 });
  });

  it('times only completed runs and rates failures over known outcomes', () => {
    const cards = computeScorecards([
      row({ durationMs: 10_000 }),
      row({ outcome: 'failed', durationMs: 1_000 }),
      row({ outcome: 'stopped', durationMs: 2_000 }),
      row({ outcome: 'unknown', endedAt: null, durationMs: null }),
    ]);
    expect(cards[0]).toMatchObject({ runs: 4, sampleSize: 1, medianTaskMs: 10_000 });
    expect(cards[0]?.failureRate).toBeCloseTo(1 / 3, 10);
    const none = computeScorecards([row({ outcome: 'unknown', durationMs: null, toolCalls: 0 })]);
    expect(none[0]).toMatchObject({ failureRate: null, medianTaskMs: null, sampleSize: 0, toolFailureRate: null });
  });

  it('adds approvals and stuck incidents, and sorts an unknown model last', () => {
    const cards = computeScorecards([
      row({ model: null, stuckIncidents: 2 }),
      row({ model: 'b', approvals: { requested: 3, byUser: 1, byPolicy: 1, other: 0, unresolved: 1 } }),
      row({ model: 'a' }),
      row({ role: 'Alpha', model: 'z' }),
    ]);
    expect(cards.map((c) => [c.role, c.model])).toEqual([
      ['Alpha', 'z'],
      ['Explore', 'a'],
      ['Explore', 'b'],
      ['Explore', null],
    ]);
    expect(cards[2]?.approvalsRequested).toBe(3);
    expect(cards[3]?.stuckIncidents).toBe(2);
  });

  it('builds cards from recorded runs with one Explore card per model', () => {
    const rows = listRunFixtures().flatMap((r) => agentRunRows(fixtureEvents(r.file)));
    const cards = computeScorecards(rows);
    expect(cards.reduce((s, c) => s + c.runs, 0)).toBe(rows.length);
    const explore = cards.filter((c) => c.role === 'Explore');
    expect(explore.length).toBeGreaterThan(0);
    for (const c of explore) expect(c.medianTaskMs).not.toBeNull();
    expect(JSON.parse(JSON.stringify(cards))).toEqual(cards);
  });
});

describe('priorUnitMsFor', () => {
  it('is null below the minimum sample size, the median from there on', () => {
    const under = computeScorecards(Array.from({ length: MIN_PRIOR_SAMPLES - 1 }, () => row({ durationMs: 5_000 })));
    expect(priorUnitMsFor(under, 'Explore', 'claude-haiku-5-5')).toBeNull();
    const enough = computeScorecards(
      [4_000, 5_000, 90_000].slice(0, MIN_PRIOR_SAMPLES).map((d) => row({ durationMs: d })),
    );
    expect(priorUnitMsFor(enough, 'Explore', 'claude-haiku-5-5')).toBe(5_000);
  });

  it('matches role and model exactly', () => {
    const cards = computeScorecards([1, 2, 3].map(() => row({ durationMs: 8_000 })));
    expect(priorUnitMsFor(cards, 'Explore', 'claude-opus-5-5')).toBeNull();
    expect(priorUnitMsFor(cards, 'Plan', 'claude-haiku-5-5')).toBeNull();
    expect(priorUnitMsFor(cards, 'Explore', null)).toBeNull();
  });
});
