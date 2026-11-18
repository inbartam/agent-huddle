import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS, type EventOfType, type HuddleEvent } from '@huddle/shared';
import { parseOtlpLogs, type OtlpLogRecord } from '../ingest/otlp-schemas.js';
import { listTelemetryFixtureFiles, readFixture } from '../test/fixtures.js';
import { rawApiRequestTotals } from '../test/raw-usage.js';
import { classifyQuerySource, normalizeTelemetry, type TelemetryContext } from './telemetry.js';

function context(): TelemetryContext {
  let n = 0;
  return {
    receivedAt: '2026-11-13T19:18:00.884Z',
    nextId: () => {
      n += 1;
      return `id-${String(n)}`;
    },
  };
}

/** Replays every otlp-logs line of a fixture through parse + normalize, like the server will. */
function replay(file: string): HuddleEvent[] {
  const events: HuddleEvent[] = [];
  const ctx = context();
  for (const line of readFixture(file)) {
    if (line.kind !== 'otlp-logs') continue;
    const parsed = parseOtlpLogs(line.payload);
    if (!parsed.ok) throw new Error(parsed.error);
    events.push(...normalizeTelemetry(parsed.records, { ...ctx, receivedAt: line.t }));
  }
  return events;
}

function apiRequest(attributes: Record<string, string | number | boolean>): OtlpLogRecord {
  return { name: 'api_request', timeUnixNano: null, attributes, resource: {} };
}

function ofType<T extends HuddleEvent['type']>(events: readonly HuddleEvent[], type: T): EventOfType<T>[] {
  return events.filter((e): e is EventOfType<T> => e.type === type);
}

describe('normalizeTelemetry on recorded fixtures', () => {
  it('interactive-helpers: the main agent gets opus from repl_main_thread and never haiku', () => {
    const models = ofType(replay('interactive-helpers.jsonl'), 'model.observed');
    expect(models.length).toBeGreaterThan(0);
    for (const event of models) {
      expect(event.via).toBe('telemetry');
      expect(event.agentKey).toBe(event.sessionId);
      expect(event.model).not.toMatch(/haiku/);
    }
    expect(models.some((e) => e.model === 'claude-opus-5-5')).toBe(true);
  });

  it('interactive-helpers: helper requests are usage on the main key, kind helper, with no context reading', () => {
    const events = replay('interactive-helpers.jsonl');
    const helpers = ofType(events, 'usage.recorded').filter((e) => e.querySourceKind === 'helper');
    expect(helpers).toHaveLength(2); // generate_session_title + prompt_suggestion
    for (const e of helpers) expect(e.agentKey).toBe(e.sessionId);
    expect(ofType(events, 'context.measured')).toHaveLength(4); // the 4 repl_main_thread requests
  });

  it('agent-messages (headless sdk): model.observed for the main agent only; Explore usage on its own key', () => {
    const events = replay('agent-messages.jsonl');
    for (const e of ofType(events, 'model.observed')) {
      expect(e.agentKey).toBe(e.sessionId);
      expect(e.model).toBe('claude-opus-5-5');
    }
    const sub = ofType(events, 'usage.recorded').filter((e) => e.querySourceKind === 'subagent');
    expect(sub).toHaveLength(10);
    for (const e of sub) expect(e.agentKey).not.toBe(e.sessionId);
  });

  it('nested-subagents: the nested Explore carries parentAgentId', () => {
    const explore = ofType(replay('nested-subagents.jsonl'), 'usage.recorded').filter(
      (e) => e.parentAgentId !== undefined,
    );
    expect(explore).toHaveLength(2);
    for (const e of explore) expect(e.agentKey).toBe(`${e.sessionId}::agent-2`);
  });

  it('compaction: the compact request is usage of kind compact with no context reading', () => {
    const events = replay('compaction.jsonl');
    expect(ofType(events, 'usage.recorded').filter((e) => e.querySourceKind === 'compact')).toHaveLength(1);
    expect(ofType(events, 'context.measured')).toHaveLength(3);
  });

  describe.each(listTelemetryFixtureFiles())('%s', (file) => {
    const events = replay(file);

    it('matches the golden normalized telemetry', async () => {
      await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot(
        `./__snapshots__/telemetry/${file.replace(/\.jsonl$/, '.json')}`,
      );
    });

    it('usage.recorded: one per api_request; summed tokens and cost equal the raw records', () => {
      const raw = rawApiRequestTotals(file);
      const usage = ofType(events, 'usage.recorded');
      expect(raw.records).toBeGreaterThan(0);
      expect(usage).toHaveLength(raw.records);
      const sum = (pick: (e: EventOfType<'usage.recorded'>) => number): number =>
        usage.reduce((acc, e) => acc + pick(e), 0);
      expect(sum((e) => e.inputTokens)).toBe(raw.inputTokens);
      expect(sum((e) => e.outputTokens)).toBe(raw.outputTokens);
      expect(sum((e) => e.cacheReadTokens)).toBe(raw.cacheReadTokens);
      expect(sum((e) => e.cacheCreationTokens)).toBe(raw.cacheCreationTokens);
      expect(sum((e) => e.estimatedCostUsd)).toBeCloseTo(raw.costUsd, 9);
      for (const e of usage) {
        expect(e.requestId).toMatch(/^req_/);
        expect(e.costMissing).toBeUndefined();
      }
    });

    it('emits only model.observed, usage.recorded and context.measured, with ts from receipt', () => {
      for (const event of events) {
        expect(['model.observed', 'usage.recorded', 'context.measured']).toContain(event.type);
        expect(event.source).toBe('telemetry');
        expect(Number.isFinite(event.ts)).toBe(true);
        if (event.type === 'model.observed') expect(event.model).not.toMatch(/haiku/);
        if (event.type === 'context.measured') expect(event.measuredBy).toBe('telemetry');
      }
    });

    it('never carries prompt text or account identity', () => {
      const text = JSON.stringify(events);
      expect(text).not.toContain('(scrubbed text)');
      expect(text).not.toContain('<REDACTED>');
      expect(text).not.toMatch(/user\.|organization|email|account/);
    });
  });
});

describe('normalizeTelemetry on hand-built records', () => {
  const main = { 'session.id': 's1', model: 'claude-opus-5-5' };
  const ts = Date.parse('2026-11-13T19:18:00.884Z');

  it('turns a main-loop api_request into model.observed, usage.recorded and context.measured', () => {
    const events = normalizeTelemetry(
      [
        apiRequest({
          ...main,
          model: 'claude-sonnet-4-5',
          query_source: 'repl_main_thread',
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 300,
          cache_creation_tokens: 4000,
          cost_usd: 0.5,
          request_id: 'req_1',
        }),
      ],
      context(),
    );
    const envelope = { ts, sessionId: 's1', agentKey: 's1', source: 'telemetry' };
    expect(events).toEqual([
      { ...envelope, id: 'id-1', type: 'model.observed', model: 'claude-sonnet-4-5', via: 'telemetry' },
      {
        ...envelope,
        id: 'id-2',
        type: 'usage.recorded',
        model: 'claude-sonnet-4-5',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheCreationTokens: 4000,
        estimatedCostUsd: 0.5,
        requestId: 'req_1',
        querySourceKind: 'main',
      },
      {
        ...envelope,
        id: 'id-3',
        type: 'context.measured',
        usedTokens: 4310,
        windowTokens: 200_000,
        measuredBy: 'telemetry',
      },
    ]);
  });

  it('a subagent request goes to the subagent key, with parentAgentId, and no model.observed', () => {
    const rec = apiRequest({
      ...main,
      query_source: 'agent:builtin:Explore',
      agent_id: 'a2',
      parent_agent_id: 'a1',
      request_id: 'r',
      cost_usd: 0.1,
    });
    const events = normalizeTelemetry([rec], context());
    expect(events.map((e) => [e.type, e.agentKey])).toEqual([
      ['usage.recorded', 's1::a2'],
      ['context.measured', 's1::a2'],
    ]);
    const usage = ofType(events, 'usage.recorded')[0];
    expect(usage?.querySourceKind).toBe('subagent');
    expect(usage?.parentAgentId).toBe('a1');
  });

  it('missing cost is flagged, not a real zero; cost_usd_micros is the fallback', () => {
    const [noCost] = ofType(
      normalizeTelemetry([apiRequest({ ...main, query_source: 'sdk' })], context()),
      'usage.recorded',
    );
    expect(noCost?.estimatedCostUsd).toBe(0);
    expect(noCost?.costMissing).toBe(true);
    expect(noCost?.requestId).toBeNull();
    const [micros] = ofType(
      normalizeTelemetry([apiRequest({ ...main, query_source: 'sdk', cost_usd_micros: 1500 })], context()),
      'usage.recorded',
    );
    expect(micros?.estimatedCostUsd).toBeCloseTo(0.0015, 12);
    expect(micros?.costMissing).toBeUndefined();
  });

  it('unknown model: window null, never guessed', () => {
    const [ctx] = ofType(
      normalizeTelemetry(
        [apiRequest({ ...main, model: 'claude-opus-9-9', query_source: 'sdk', input_tokens: 5 })],
        context(),
      ),
      'context.measured',
    );
    expect(ctx?.windowTokens).toBeNull();
    expect(ctx?.usedTokens).toBe(5);
  });

  it.each([
    ['generate_session_title', 'helper'],
    ['prompt_suggestion', 'helper'],
    ['away_summary', 'helper'],
    ['compact', 'compact'],
    ['something_new', 'other'],
  ] as const)('query_source %s: usage of kind %s on the main key, no model, no context', (querySource, kind) => {
    const events = normalizeTelemetry([apiRequest({ ...main, query_source: querySource })], context());
    expect(events.map((e) => e.type)).toEqual(['usage.recorded']);
    expect(ofType(events, 'usage.recorded')[0]?.querySourceKind).toBe(kind);
    expect(events[0]?.agentKey).toBe('s1');
  });

  it('a subagent query_source without agent_id: usage only, no context on the main agent', () => {
    const events = normalizeTelemetry([apiRequest({ ...main, query_source: 'agent:builtin:Explore' })], context());
    expect(events.map((e) => e.type)).toEqual(['usage.recorded']);
  });

  it('a main-loop query_source with agent_id: no model.observed for the main agent', () => {
    const events = normalizeTelemetry([apiRequest({ ...main, query_source: 'sdk', agent_id: 'a1' })], context());
    expect(events.some((e) => e.type === 'model.observed')).toBe(false);
    expect(events.every((e) => e.agentKey === 's1::a1')).toBe(true);
  });

  it('drops records without session.id and non-api_request records', () => {
    expect(normalizeTelemetry([apiRequest({ model: 'm', query_source: 'sdk' })], context())).toEqual([]);
    const other: OtlpLogRecord = { ...apiRequest({ ...main, query_source: 'sdk' }), name: 'user_prompt' };
    expect(normalizeTelemetry([other], context())).toEqual([]);
  });

  it('refuses records whose session.id, agent_id, parent_agent_id or request_id exceed CLIP_LIMITS.id', () => {
    const long = 'x'.repeat(CLIP_LIMITS.id + 1);
    const fits = 'y'.repeat(CLIP_LIMITS.id);
    const ok = apiRequest({ ...main, query_source: 'sdk', request_id: fits });
    for (const attrs of [
      { ...main, 'session.id': long, query_source: 'sdk' },
      { ...main, query_source: 'agent:builtin:Explore', agent_id: long },
      { ...main, query_source: 'agent:builtin:Explore', agent_id: 'a1', parent_agent_id: long },
      { ...main, query_source: 'sdk', request_id: long },
    ]) {
      // The bad record is dropped; the good one in the same batch still counts.
      const events = normalizeTelemetry([apiRequest(attrs), ok], context());
      expect(ofType(events, 'usage.recorded').map((e) => e.requestId)).toEqual([fits]);
    }
  });

  it('refuses a session.id the store would refuse, and the Huddle own session ids (A1-04, A1-05)', () => {
    for (const id of ['a b', 'x'.repeat(200), 'huddle-tasks', 'huddle-budgets', 'huddle-history', 'huddle-phone']) {
      expect(normalizeTelemetry([apiRequest({ ...main, 'session.id': id, query_source: 'sdk' })], context())).toEqual(
        [],
      );
    }
  });

  it('a non-string model: usage with model null, no model.observed', () => {
    const events = normalizeTelemetry([apiRequest({ ...main, query_source: 'sdk', model: 42 })], context());
    expect(events.some((e) => e.type === 'model.observed')).toBe(false);
    expect(ofType(events, 'usage.recorded')[0]?.model).toBeNull();
  });

  it('collapses repeats of the same model for a session within one batch', () => {
    const rec = apiRequest({ ...main, query_source: 'sdk' });
    const other = apiRequest({ 'session.id': 's2', model: 'claude-opus-5-5', query_source: 'sdk' });
    const switched = apiRequest({ ...main, model: 'claude-sonnet-5', query_source: 'sdk' });
    const events = ofType(normalizeTelemetry([rec, rec, other, switched, rec], context()), 'model.observed');
    expect(events.map((e) => [e.sessionId, e.model])).toEqual([
      ['s1', 'claude-opus-5-5'],
      ['s2', 'claude-opus-5-5'],
      ['s1', 'claude-sonnet-5'],
      ['s1', 'claude-opus-5-5'],
    ]);
  });

  it('is pure: same input, same output', () => {
    const records = [apiRequest({ ...main, query_source: 'sdk', cost_usd: 1 })];
    expect(normalizeTelemetry(records, context())).toEqual(normalizeTelemetry(records, context()));
  });
});

describe('classifyQuerySource', () => {
  it.each([
    ['repl_main_thread', 'main'],
    ['sdk', 'main'],
    ['generate_session_title', 'helper'],
    ['prompt_suggestion', 'helper'],
    ['away_summary', 'helper'],
    ['agent:builtin:Explore', 'subagent'],
    ['agent:custom:core-engineer', 'subagent'],
    ['compact', 'compact'],
    ['something_new', 'other'],
    [undefined, 'other'],
  ] as const)('%s -> %s', (querySource, expected) => {
    expect(classifyQuerySource(querySource)).toBe(expected);
  });
});
