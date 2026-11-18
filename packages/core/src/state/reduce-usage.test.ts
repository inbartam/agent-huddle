/** Usage and context metering in the reducer (M2 WP2, F5, F6). */
import { describe, expect, it } from 'vitest';
import { agentKey, type AgentNode, type EventOfType, type HuddleEvent, type TokenUsage } from '@huddle/shared';
import { listTelemetryFixtureFiles } from '../test/fixtures.js';
import { rawApiRequests, sumRaw, type RawApiRequest, type RawUsageTotals } from '../test/raw-usage.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import {
  MAX_PENDING,
  MAX_SEEN_REQUEST_IDS,
  replay,
  STATUSLINE_CONTEXT_PRIORITY_MS,
  type ReducerState,
} from './reduce.js';

// --- helpers -------------------------------------------------------------------------

const S = 'session-a';
const MAIN = agentKey(S);
const A1 = agentKey(S, 'a1');

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

function builder(sessionId = S) {
  let n = 0;
  return function ev<T extends HuddleEvent['type']>(type: T, key: string, fields: Fields<T>, ts?: number): HuddleEvent {
    n += 1;
    return {
      id: `e${String(n).padStart(4, '0')}`,
      type,
      ts: ts ?? 1000 + n * 10,
      sessionId,
      agentKey: key,
      source: type === 'usage.recorded' || type === 'context.measured' ? 'telemetry' : 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  };
}

function usage(
  requestId: string | null,
  costUsd: number | null,
  /** null: absent, as in a log written before M2. */
  querySourceKind: NonNullable<EventOfType<'usage.recorded'>['querySourceKind']> | null = 'main',
): Fields<'usage.recorded'> {
  return {
    model: 'claude-opus-5-5',
    inputTokens: 1,
    outputTokens: 10,
    cacheReadTokens: 100,
    cacheCreationTokens: 1000,
    estimatedCostUsd: costUsd ?? 0,
    requestId,
    ...(querySourceKind !== null ? { querySourceKind } : {}),
    ...(costUsd === null ? { costMissing: true } : {}),
  };
}

function node(state: ReducerState, key: string): AgentNode {
  const found = state.agents[key];
  if (found === undefined) throw new Error(`no node ${key}`);
  return found;
}

const MAIN_SOURCES = new Set(['sdk', 'repl_main_thread']);

/** Where a raw record must be counted: the agent's own usage, or the root's helperUsage. */
function expectedBucket(r: RawApiRequest): { key: string; helper: boolean } {
  const own =
    (r.querySource !== null && MAIN_SOURCES.has(r.querySource)) ||
    (r.querySource?.startsWith('agent:') === true && r.agentId !== null);
  return own ? { key: agentKey(r.sessionId, r.agentId), helper: false } : { key: agentKey(r.sessionId), helper: true };
}

function expectUsageEquals(actual: TokenUsage | undefined, raw: RawUsageTotals): void {
  expect(actual).toBeDefined();
  if (actual === undefined) return;
  expect(actual.requests).toBe(raw.records);
  expect(actual.inputTokens).toBe(raw.inputTokens);
  expect(actual.outputTokens).toBe(raw.outputTokens);
  expect(actual.cacheReadTokens).toBe(raw.cacheReadTokens);
  expect(actual.cacheCreationTokens).toBe(raw.cacheCreationTokens);
  expect(actual.estimatedCostUsd).toBeCloseTo(raw.costUsd, 9);
  expect(actual.requestsWithoutId).toBeUndefined();
  expect(actual.requestsWithoutCost).toBeUndefined();
}

function sessionCost(state: ReducerState): number {
  return Object.values(state.agents).reduce(
    (sum, n) => sum + n.usage.estimatedCostUsd + (n.helperUsage?.estimatedCostUsd ?? 0),
    0,
  );
}

/** Each usage.recorded is sent again 2 s later with a new event id: what an OTLP retry produces. */
function withResentUsage(events: readonly HuddleEvent[]): HuddleEvent[] {
  return events.flatMap<HuddleEvent>((e) =>
    e.type === 'usage.recorded' ? [e, { ...e, id: `${e.id}-again`, ts: e.ts + 2000 }] : [e],
  );
}

// --- fixtures --------------------------------------------------------------------------

describe('usage over recorded fixtures', () => {
  describe.each(listTelemetryFixtureFiles())('%s', (name) => {
    const raw = rawApiRequests(name);
    const state = replay(fixtureEvents(name));

    it('M2 exit criterion 1: each agent usage total equals the sum of its raw api_request records', () => {
      const groups = new Map<string, { own: RawApiRequest[]; helper: RawApiRequest[] }>();
      for (const r of raw) {
        const { key, helper } = expectedBucket(r);
        const group = groups.get(key) ?? { own: [], helper: [] };
        (helper ? group.helper : group.own).push(r);
        groups.set(key, group);
      }
      for (const [key, group] of groups) {
        const n = node(state, key);
        if (group.own.length > 0) expectUsageEquals(n.usage, sumRaw(group.own));
        if (group.helper.length > 0) expectUsageEquals(n.helperUsage, sumRaw(group.helper));
        else expect(n.helperUsage).toBeUndefined();
      }
      // Agents without records stay at zero requests (unknown), and nothing is left waiting.
      for (const n of Object.values(state.agents)) {
        if (!groups.has(n.key)) expect(n.usage.requests).toBe(0);
      }
      expect(state.book.pendingUsage).toEqual({});
    });

    it('session total (agents + helperUsage) equals summed cost_usd within 2%', () => {
      const expected = sumRaw(raw).costUsd;
      expect(expected).toBeGreaterThan(0);
      expect(Math.abs(sessionCost(state) - expected) / expected).toBeLessThan(0.02);
    });

    it('a re-sent batch is counted once', () => {
      const twice = replay(withResentUsage(fixtureEvents(name)));
      for (const n of Object.values(state.agents)) {
        expect(twice.agents[n.key]?.usage).toEqual(n.usage);
        expect(twice.agents[n.key]?.helperUsage).toEqual(n.helperUsage);
      }
    });
  });

  it('interactive-helpers: title and prompt-suggestion requests sit in helperUsage, not in main usage', () => {
    const state = replay(fixtureEvents('interactive-helpers.jsonl'));
    const root = Object.values(state.agents).find((n) => n.kind === 'main');
    expect(root?.helperUsage?.requests).toBe(2);
    expect(root?.usage.requests).toBe(4);
  });

  it('compaction: the compact request sits in helperUsage', () => {
    const state = replay(fixtureEvents('compaction.jsonl'));
    const root = Object.values(state.agents).find((n) => n.kind === 'main');
    expect(root?.helperUsage?.requests).toBe(1);
  });

  it('nested-subagents: telemetry context lands on each agent, window from the model table', () => {
    const state = replay(fixtureEvents('nested-subagents.jsonl'));
    for (const n of Object.values(state.agents)) {
      expect(n.context.measuredBy).toBe('telemetry');
      expect(n.context.usedTokens).toBeGreaterThan(0);
      expect(n.context.windowTokens).toBe(1_000_000);
      expect(n.context.usedPct).toBeGreaterThan(0);
      expect(n.context.usedPct).toBeLessThan(100);
    }
  });
});

// --- hand-built scenarios ----------------------------------------------------------------

describe('usage accumulation', () => {
  const start = (ev: ReturnType<typeof builder>): HuddleEvent[] => [
    ev('session.started', MAIN, { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
    ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
  ];

  it('unknown stays unknown: an agent with no records has requests 0 and no helperUsage', () => {
    const state = replay(start(builder()));
    for (const key of [MAIN, A1]) {
      const n = node(state, key);
      expect(n.usage.requests).toBe(0);
      expect(n.usage.estimatedCostUsd).toBe(0);
      expect(n.helperUsage).toBeUndefined();
    }
  });

  it('adds per agent and keeps subagent usage off the main agent', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('usage.recorded', MAIN, usage('r1', 0.5)),
      ev('usage.recorded', A1, usage('r2', 0.25, 'subagent')),
      ev('usage.recorded', A1, usage('r3', 0.25, 'subagent')),
    ]);
    expect(node(state, MAIN).usage).toEqual({
      inputTokens: 1,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheCreationTokens: 1000,
      requests: 1,
      estimatedCostUsd: 0.5,
    });
    expect(node(state, A1).usage.requests).toBe(2);
    expect(node(state, A1).usage.estimatedCostUsd).toBeCloseTo(0.5, 12);
  });

  it('a duplicated request id is counted once; records without an id are each counted and flagged', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('usage.recorded', MAIN, usage('r1', 0.5)),
      ev('usage.recorded', MAIN, usage('r1', 0.5)),
      ev('usage.recorded', MAIN, usage(null, 0.5)),
      ev('usage.recorded', MAIN, usage(null, 0.5)),
    ]);
    expect(node(state, MAIN).usage.requests).toBe(3);
    expect(node(state, MAIN).usage.requestsWithoutId).toBe(2);
  });

  it('the same request id in another session is a different request', () => {
    const a = builder('s1');
    const b = builder('s2');
    const state = replay([a('usage.recorded', 's1', usage('r1', 1)), b('usage.recorded', 's2', usage('r1', 1))]);
    expect(state.book.pendingUsage.s1?.own?.requests).toBe(1);
    expect(state.book.pendingUsage.s2?.own?.requests).toBe(1);
  });

  it('missing cost adds nothing and is counted in requestsWithoutCost', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('usage.recorded', MAIN, usage('r1', null)),
      ev('usage.recorded', MAIN, usage('r2', 1)),
    ]);
    expect(node(state, MAIN).usage.estimatedCostUsd).toBe(1);
    expect(node(state, MAIN).usage.requestsWithoutCost).toBe(1);
    expect(node(state, MAIN).usage.requests).toBe(2);
  });

  it.each(['helper', 'compact', 'other'] as const)('%s requests go to the root helperUsage', (kind) => {
    const ev = builder();
    const state = replay([...start(ev), ev('usage.recorded', MAIN, usage('r1', 0.1, kind))]);
    expect(node(state, MAIN).usage.requests).toBe(0);
    expect(node(state, MAIN).helperUsage?.requests).toBe(1);
  });

  it('a subagent-sourced request without an agent id goes to helperUsage, not to the main agent', () => {
    const ev = builder();
    const state = replay([...start(ev), ev('usage.recorded', MAIN, usage('r1', 0.1, 'subagent'))]);
    expect(node(state, MAIN).usage.requests).toBe(0);
    expect(node(state, MAIN).helperUsage?.requests).toBe(1);
  });

  it('a helper request carrying a subagent key still goes to the root', () => {
    const ev = builder();
    const state = replay([...start(ev), ev('usage.recorded', A1, usage('r1', 0.1, 'compact'))]);
    expect(node(state, A1).usage.requests).toBe(0);
    expect(node(state, MAIN).helperUsage?.requests).toBe(1);
  });

  it('a record from an older log (no querySourceKind) counts on its agentKey', () => {
    const ev = builder();
    const state = replay([...start(ev), ev('usage.recorded', A1, usage('r1', 0.1, null))]);
    expect(node(state, A1).usage.requests).toBe(1);
  });

  it('usage before its agent starts waits and is applied on agent.started; telemetry creates no session', () => {
    const ev = builder();
    const early = replay([
      ev('usage.recorded', MAIN, usage('r0', 0.1)),
      ev('usage.recorded', MAIN, usage('r9', 0.1, 'helper')),
      ev('usage.recorded', A1, usage('r1', 0.2, 'subagent')),
    ]);
    expect(early.agents).toEqual({});
    expect(early.rootKeys).toEqual([]);
    const state = replay(start(ev), early);
    expect(node(state, MAIN).usage.requests).toBe(1);
    expect(node(state, MAIN).helperUsage?.requests).toBe(1);
    expect(node(state, A1).usage.requests).toBe(1);
    expect(node(state, A1).usage.estimatedCostUsd).toBe(0.2);
    expect(state.book.pendingUsage).toEqual({});
    expect(state.book.pendingUsageOrder).toEqual([]);
  });

  it('pending usage is bounded', () => {
    const ev = builder();
    const events = Array.from({ length: MAX_PENDING + 5 }, (_, i) =>
      ev('usage.recorded', agentKey(S, `x${String(i)}`), usage(`r${String(i)}`, 0.1, 'subagent')),
    );
    const state = replay(events);
    expect(state.book.pendingUsageOrder).toHaveLength(MAX_PENDING);
    expect(Object.keys(state.book.pendingUsage)).toHaveLength(MAX_PENDING);
  });

  it(`the seen request ids are bounded at ${String(MAX_SEEN_REQUEST_IDS)} per session, oldest forgotten first`, () => {
    const ev = builder();
    const events = [
      ...start(ev),
      ...Array.from({ length: MAX_SEEN_REQUEST_IDS + 1 }, (_, i) =>
        ev('usage.recorded', MAIN, usage(`r${String(i)}`, 0)),
      ),
    ];
    let state = replay(events);
    const seen = state.book.sessions[S]?.seenRequestIds ?? [];
    expect(seen).toHaveLength(MAX_SEEN_REQUEST_IDS);
    expect(seen[0]).toBe('r1');
    // r0 fell out of the window: a re-send that late is counted again (documented bound). r1 is still deduplicated.
    state = replay([ev('usage.recorded', MAIN, usage('r1', 0)), ev('usage.recorded', MAIN, usage('r0', 0))], state);
    expect(node(state, MAIN).usage.requests).toBe(MAX_SEEN_REQUEST_IDS + 2);
  });
});

describe('context sources', () => {
  const ctx = (usedTokens: number, measuredBy: EventOfType<'context.measured'>['measuredBy']) => ({
    usedTokens,
    windowTokens: 200_000,
    measuredBy,
  });

  it('telemetry does not overwrite a status line reading less than 30 s old (by event ts)', () => {
    const ev = builder();
    const t0 = 50_000;
    const base = replay([
      ev(
        'session.started',
        MAIN,
        { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' },
        t0,
      ),
      ev('context.measured', MAIN, ctx(1000, 'statusline'), t0),
    ]);
    const young = replay(
      [ev('context.measured', MAIN, ctx(5000, 'telemetry'), t0 + STATUSLINE_CONTEXT_PRIORITY_MS - 1)],
      base,
    );
    expect(node(young, MAIN).context).toMatchObject({ usedTokens: 1000, measuredBy: 'statusline' });
    const old = replay(
      [ev('context.measured', MAIN, ctx(5000, 'telemetry'), t0 + STATUSLINE_CONTEXT_PRIORITY_MS)],
      base,
    );
    expect(node(old, MAIN).context).toMatchObject({ usedTokens: 5000, measuredBy: 'telemetry', usedPct: 2.5 });
  });

  it('a newer status line reading replaces telemetry at once', () => {
    const ev = builder();
    const state = replay([
      ev('session.started', MAIN, { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('context.measured', MAIN, ctx(5000, 'telemetry')),
      ev('context.measured', MAIN, ctx(1000, 'statusline')),
    ]);
    expect(node(state, MAIN).context).toMatchObject({ usedTokens: 1000, measuredBy: 'statusline' });
  });

  it('telemetry context for an agent not seen yet creates nothing', () => {
    const ev = builder();
    const state = replay([ev('context.measured', MAIN, ctx(5000, 'telemetry'))]);
    expect(state.agents).toEqual({});
  });
});
