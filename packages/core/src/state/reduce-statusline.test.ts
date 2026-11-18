/** Status line readings in the reducer (F9, M2 WP6): priority over telemetry and rate limits. */
import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent, type RateLimits } from '@huddle/shared';
import { normalizeStreamLine } from '../normalize/stream.js';
import { readFixture } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { replay, STATUSLINE_CONTEXT_PRIORITY_MS } from './reduce.js';

const S = 'session-s';
const MAIN = agentKey(S);

let n = 0;
function context(measuredBy: 'statusline' | 'telemetry', usedTokens: number, ts: number): HuddleEvent {
  n += 1;
  return {
    id: `c${String(n).padStart(4, '0')}`,
    type: 'context.measured',
    ts,
    sessionId: S,
    agentKey: MAIN,
    source: measuredBy,
    usedTokens,
    windowTokens: 200000,
    measuredBy,
  };
}

function started(ts: number): HuddleEvent {
  return {
    id: 'start',
    type: 'session.started',
    ts,
    sessionId: S,
    agentKey: MAIN,
    source: 'hook',
    origin: 'attached',
    cwd: null,
    title: null,
    model: null,
    startKind: 'startup',
  };
}

function mainContext(events: HuddleEvent[]) {
  const node = replay(events).agents[MAIN];
  if (node === undefined) throw new Error('no main node');
  return node.context;
}

describe('status line context priority (STATUSLINE_CONTEXT_PRIORITY_MS)', () => {
  it('is 30 s', () => {
    expect(STATUSLINE_CONTEXT_PRIORITY_MS).toBe(30_000);
  });

  it('a telemetry reading within 30 s does not overwrite the status line value', () => {
    const ctx = mainContext([
      started(1000),
      context('statusline', 50_000, 2000),
      context('telemetry', 90_000, 2000 + STATUSLINE_CONTEXT_PRIORITY_MS - 1),
    ]);
    expect(ctx).toMatchObject({ usedTokens: 50_000, measuredBy: 'statusline', usedPct: 25 });
  });

  it('a telemetry reading 30 s or later overwrites it', () => {
    const ctx = mainContext([
      started(1000),
      context('statusline', 50_000, 2000),
      context('telemetry', 90_000, 2000 + STATUSLINE_CONTEXT_PRIORITY_MS),
    ]);
    expect(ctx).toMatchObject({ usedTokens: 90_000, measuredBy: 'telemetry' });
  });

  it('a newer status line reading always wins over telemetry', () => {
    const ctx = mainContext([started(1000), context('telemetry', 90_000, 2000), context('statusline', 40_000, 2500)]);
    expect(ctx).toMatchObject({ usedTokens: 40_000, measuredBy: 'statusline' });
  });
});

describe('docs-derived status line fixture through the reducer', () => {
  it('ends with the last reading (null-usage lines do not reset it); an omitted window keeps its earlier value', () => {
    const state = replay(fixtureEvents('statusline-docs-sample.jsonl'));
    const roots = Object.values(state.agents);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.context).toMatchObject({
      usedTokens: 12000,
      windowTokens: 200000,
      usedPct: 6,
      measuredBy: 'statusline',
    });
    expect(state.rateLimits).toEqual({
      fiveHourUsedPct: 26,
      fiveHourResetsAt: Date.parse('2026-11-14T15:00:00Z'),
      // The last line omits seven_day; since M4 WP6 a reading replaces only the windows it carries.
      sevenDayUsedPct: 41.5,
      sevenDayResetsAt: 1794960000000,
      measuredAt: Date.parse('2026-11-14T10:03:00.000Z'),
    });
  });
});

describe('limits.measured merges windows (M4 WP6)', () => {
  /** The stream fixture's events, through the real stream normalizer (its only limits reading is seven-day). */
  function streamLimits(name: string): HuddleEvent[] {
    let k = 0;
    const out: HuddleEvent[] = [];
    for (const line of readFixture(name)) {
      const normalized = normalizeStreamLine(JSON.stringify(line.payload), {
        runId: 'run-1',
        sessionId: '00000000-0000-4000-8000-0000000000a2',
        receivedAt: Date.parse('2026-11-14T10:05:00.000Z'),
        nextId: () => `stream-${String(++k)}`,
      });
      if (normalized !== null) out.push(...normalized.events.filter((e) => e.type === 'limits.measured'));
    }
    return out;
  }

  it('a stream reading with only seven_day keeps the five-hour window the status line reported', () => {
    const fromStream = streamLimits('stream-s16-team.jsonl');
    expect(fromStream).toHaveLength(1);
    const state = replay([...fixtureEvents('statusline-docs-sample.jsonl'), ...fromStream]);
    expect(state.rateLimits).toEqual({
      fiveHourUsedPct: 26,
      fiveHourResetsAt: Date.parse('2026-11-14T15:00:00Z'),
      sevenDayUsedPct: 67,
      sevenDayResetsAt: 1794772800 * 1000,
      measuredAt: Date.parse('2026-11-14T10:05:00.000Z'),
    });
  });

  it('a reading that carries a window replaces both of its fields; the first reading is taken as is', () => {
    const limits = (over: Partial<RateLimits>): RateLimits => ({
      fiveHourUsedPct: null,
      fiveHourResetsAt: null,
      sevenDayUsedPct: null,
      sevenDayResetsAt: null,
      measuredAt: 0,
      ...over,
    });
    const ev = (id: string, l: RateLimits): HuddleEvent => ({
      id,
      type: 'limits.measured',
      ts: l.measuredAt,
      sessionId: S,
      agentKey: MAIN,
      source: 'statusline',
      limits: l,
    });
    const first = limits({ fiveHourUsedPct: 10, fiveHourResetsAt: 5000, measuredAt: 1 });
    expect(replay([ev('l1', first)]).rateLimits).toEqual(first);
    const state = replay([
      ev('l1', first),
      ev('l2', limits({ fiveHourResetsAt: 9000, sevenDayUsedPct: 40, measuredAt: 2 })),
    ]);
    expect(state.rateLimits).toEqual({
      fiveHourUsedPct: null,
      fiveHourResetsAt: 9000,
      sevenDayUsedPct: 40,
      sevenDayResetsAt: null,
      measuredAt: 2,
    });
  });
});
