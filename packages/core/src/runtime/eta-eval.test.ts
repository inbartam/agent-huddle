/**
 * ETA evaluation harness (M2 WP4, F4). Hand-built timelines check the harness itself; the recorded runs in
 * fixtures/runs are then evaluated and printed as a table (`npm run eval:eta`). Both skip when there is nothing to
 * evaluate.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, DEFAULT_ETA_PARAMS, priorKey, type EventOfType, type HuddleEvent } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import {
  evaluateLeaveOneOut,
  evaluateRun,
  formatEtaReport,
  formatLeaveOneOut,
  leaveOneOutPriors,
  parseEtaGroup,
  type EtaReportRow,
} from './eta-eval.js';
import { agentRunRows, scorecardRows } from '../report/agent-runs.js';

const S = 'session-a';
const MAIN = agentKey(S);

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

function builder() {
  let n = 0;
  return function ev<T extends HuddleEvent['type']>(type: T, key: string, ts: number, fields: Fields<T>): HuddleEvent {
    n += 1;
    return {
      id: `e${String(n)}`,
      type,
      ts,
      sessionId: S,
      agentKey: key,
      source: 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  };
}

/** Three subagents one after another, each 10 s, the parent's turn ends at `endAt` (seconds). */
function sequentialRun(endAt: number): HuddleEvent[] {
  const ev = builder();
  const out: HuddleEvent[] = [
    ev('session.started', MAIN, 0, { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
  ];
  for (const i of [1, 2, 3]) {
    const key = agentKey(S, `a${String(i)}`);
    out.push(
      ev('agent.started', key, (i - 1) * 10_000, { agentId: `a${String(i)}`, role: 'Explore', parentKey: MAIN }),
    );
    out.push(ev('agent.stopped', key, i * 10_000, { agentId: `a${String(i)}`, result: null }));
  }
  out.push(ev('turn.ended', MAIN, endAt * 1000, { lastMessage: null }));
  return out;
}

describe('evaluateRun on a hand-built sequential run', () => {
  it('takes one check point per subagent completion, with absolute times and the real finish', () => {
    const result = evaluateRun(sequentialRun(35));
    expect(result.checkpoints.map((c) => c.at)).toEqual([10_000, 20_000, 30_000]);
    expect(result.checkpoints.map((c) => c.finishedSubagents)).toEqual([1, 2, 3]);
    for (const c of result.checkpoints) {
      expect(c.actualFinishAt).toBe(35_000);
      expect(c.etaLowAt).not.toBeNull();
      expect(c.etaHighAt).not.toBeNull();
    }
  });

  it('says the range contains a finish near the pace, and reports the point error', () => {
    const result = evaluateRun(sequentialRun(35));
    expect(result.verdict).toBe('contains');
    // The first check point sees one subagent started and none overlapping (sequential pattern), so its upper end
    // allows one more subagent: it contains the finish at 35 s like the others.
    expect(result.checkpoints.map((c) => c.contained)).toEqual([true, true, true]);
    // After the last subagent, a wrap-up of one mean subagent duration (10 s) was expected: ETA 40 s against 35 s.
    expect(result.checkpoints[2]?.absErrorMs).toBeCloseTo(5000, 6);
  });

  it('says the range misses when the parent finishes far later than the pace suggests', () => {
    const result = evaluateRun(sequentialRun(300));
    expect(result.verdict).toBe('misses');
    expect(result.contained).toBe(0);
    expect(result.medianAbsErrorMs).toBeGreaterThan(200_000);
  });

  it('constant overrides change the result; default params change nothing', () => {
    const base = evaluateRun(sequentialRun(35));
    expect(evaluateRun(sequentialRun(35), { params: DEFAULT_ETA_PARAMS })).toEqual(base);
    const noSpread = evaluateRun(sequentialRun(35), {
      params: { ...DEFAULT_ETA_PARAMS, etaSpread: { low: 0, medium: 0, high: 0 } },
    });
    expect(noSpread.verdict).toBe('misses');
    const wide = evaluateRun(sequentialRun(300), {
      params: { ...DEFAULT_ETA_PARAMS, etaSpread: { low: 50, medium: 50, high: 50 } },
    });
    expect(wide.verdict).toBe('contains');
  });

  it('adds check points at subagent starts after the first when asked', () => {
    const without = evaluateRun(sequentialRun(35));
    const withStarts = evaluateRun(sequentialRun(35), { includeStarts: true });
    expect(withStarts.checkpoints.filter((c) => c.trigger === 'subagent_started')).toHaveLength(2);
    expect(withStarts.checkpoints.length).toBe(without.checkpoints.length + 2);
  });

  it('a run with no subagents, or no end of work, has no verdict', () => {
    const ev = builder();
    const none = evaluateRun([
      ev('session.started', MAIN, 0, { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('turn.ended', MAIN, 5000, { lastMessage: null }),
    ]);
    expect(none.checkpoints).toEqual([]);
    expect(none.verdict).toBe('no data');
    expect(evaluateRun(sequentialRun(35).slice(0, -1)).checkpoints).toEqual([]);
  });
});

describe('formatEtaReport', () => {
  it('prints one line per run and totals for tune and judge', () => {
    const rows: EtaReportRow[] = [
      { run: 'a', group: 'tune', result: evaluateRun(sequentialRun(35)) },
      { run: 'b', group: 'judge', result: evaluateRun(sequentialRun(300)) },
    ];
    const text = formatEtaReport(rows);
    expect(text).toContain('total tune: 1/1 runs contain the finish');
    expect(text).toContain('total judge: 0/1 runs contain the finish');
    expect(text).toContain('coverage 3/3 ranged');
    expect(text.split('\n')).toHaveLength(2 + rows.length + 2);
  });

  it('prints totals only for the groups present', () => {
    const text = formatEtaReport([{ run: 'a', group: 'tune', result: evaluateRun(sequentialRun(35)) }]);
    expect(text).toContain('total tune:');
    expect(text).not.toContain('total judge:');
  });
});

describe('parseEtaGroup', () => {
  it('accepts tune and judge; anything else means both', () => {
    expect(parseEtaGroup('tune')).toBe('tune');
    expect(parseEtaGroup('judge')).toBe('judge');
    expect(parseEtaGroup(undefined)).toBeNull();
    expect(parseEtaGroup('all')).toBeNull();
  });
});

describe('ETA over recorded runs (fixtures/runs)', () => {
  // ETA_GROUP=tune while tuning, ETA_GROUP=judge once at the end; unset evaluates both.
  const only = parseEtaGroup(process.env.ETA_GROUP);
  const runs = listRunFixtures().filter((r) => only === null || r.group === only);

  it.skipIf(runs.length === 0)('replays every run and prints the table', () => {
    const rows: EtaReportRow[] = runs.map((r) => ({
      run: r.id,
      group: r.group,
      result: evaluateRun(fixtureEvents(r.file)),
    }));
    console.log(`\n${formatEtaReport(rows)}\n`);
    for (const row of rows) {
      expect(row.group, `${row.run} is not in scripts/lib/run-prompts.mjs`).not.toBe('unknown');
      expect(row.result.checkpoints.length, `${row.run}: no check points`).toBeGreaterThan(0);
      for (const c of row.result.checkpoints) expect(c.actualFinishAt).toBeGreaterThan(c.at);
    }
  });
});

describe('leave-one-out priors (M5 WP7)', () => {
  /**
   * sequentialRun in its own session, with subagents of `unitMs` each and the parent ending 5 s after the last. Each
   * subagent has a known model (an unknown model never gives a prior) and ends with its SubagentStop turn, as a real
   * one does (an agent with no tool call, task or turn is not a scorecard run).
   */
  function runIn(sessionId: string, unitMs: number): HuddleEvent[] {
    const main = agentKey(sessionId);
    return sequentialRun(35).flatMap((e): HuddleEvent[] => {
      const scale = (ts: number): number => (ts / 10_000) * unitMs;
      const moved = {
        ...e,
        sessionId,
        agentKey: e.agentKey === MAIN ? main : agentKey(sessionId, e.agentKey.split('::').pop() ?? ''),
      };
      const envelope = { sessionId, agentKey: moved.agentKey, source: moved.source, ts: scale(e.ts) };
      if (moved.type === 'agent.started') {
        return [
          { ...moved, parentKey: main, ts: scale(e.ts) },
          { ...envelope, id: `${e.id}-m`, type: 'model.observed', model: 'claude-haiku-5-5', via: 'agent_call' },
        ];
      }
      if (moved.type === 'agent.stopped') {
        return [
          { ...envelope, id: `${e.id}-t`, type: 'turn.ended', lastMessage: null },
          { ...moved, ts: scale(e.ts) },
        ];
      }
      if (moved.type === 'turn.ended') return [{ ...moved, ts: 3 * unitMs + 5000 }];
      return [moved];
    });
  }

  it("never uses a run's own rows: its priors come from the other runs only", () => {
    const rows = [runIn('r1', 100_000), runIn('r2', 10_000)].map((events) => agentRunRows(events));
    const explore = rows[1]?.find((r) => r.role === 'Explore');
    expect(explore?.durationMs).toBe(10_000);
    const key = priorKey('Explore', explore?.model ?? null);
    // Each run alone has 3 completed Explore runs (MIN_PRIOR_SAMPLES): run 1 is scored with run 2's 10 s, and back.
    expect(leaveOneOutPriors(rows, 0).byRoleModel[key]).toBe(10_000);
    expect(leaveOneOutPriors(rows, 1).byRoleModel[key]).toBe(100_000);
    expect(leaveOneOutPriors(rows.slice(0, 1), 0).byRoleModel).toEqual({});
  });

  it('scores each run without and with priors', () => {
    const runs = [
      { run: 'r1', group: 'tune', events: runIn('r1', 10_000) },
      { run: 'r2', group: 'tune', events: runIn('r2', 10_000) },
    ];
    const out = evaluateLeaveOneOut(runs);
    expect(out).toHaveLength(2);
    out.forEach((row, i) => {
      expect(row.without).toEqual(evaluateRun(runs[i]?.events ?? []));
      expect(row.priorPairs).toBe(1);
      expect(row.result.checkpoints).toHaveLength(3);
    });
    // A prior equal to the run's own pace changes no ETA.
    expect(out[0]?.result.checkpoints.map((c) => c.etaPointAt)).toEqual(
      out[0]?.without.checkpoints.map((c) => c.etaPointAt),
    );
    expect(formatLeaveOneOut(out)).toContain('leave-one-out tune: without priors 2/2 runs');
  });
});

describe('ETA over recorded runs with leave-one-out priors (fixtures/runs)', () => {
  const only = parseEtaGroup(process.env.ETA_GROUP);
  const runs = listRunFixtures().filter((r) => only === null || r.group === only);

  it.skipIf(runs.length < 2)('replays every run with the priors of the other runs and prints both totals', () => {
    const rows = evaluateLeaveOneOut(runs.map((r) => ({ run: r.id, group: r.group, events: fixtureEvents(r.file) })));
    console.log(`\nwith leave-one-out priors:\n${formatEtaReport(rows)}\n${formatLeaveOneOut(rows)}\n`);
    // Leaving out index -1 leaves out nothing: the priors the app would hold with every run in the history.
    const all = leaveOneOutPriors(
      runs.map((r) => {
        const events = fixtureEvents(r.file);
        return scorecardRows(agentRunRows(events), events);
      }),
      -1,
    );
    console.log(`prior pairs over all runs (ms per unit): ${JSON.stringify(all.byRoleModel)}`);
    console.log(rows.map((r) => `${r.run}: ${String(r.priorPairs)} prior pairs`).join('\n'));
    for (const row of rows) expect(row.result.checkpoints.length).toBe(row.without.checkpoints.length);
  });
});
