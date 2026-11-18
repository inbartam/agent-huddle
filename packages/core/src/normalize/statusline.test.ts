/** Status line normalizer (F9, M2 WP6). The fixture is docs-derived, not recorded (fixtures/README.md, S12). */
import { describe, expect, it } from 'vitest';
import { agentKey, type EventOfType, type HuddleEvent } from '@huddle/shared';
import { parseStatuslinePayload, type StatuslinePayload } from '../ingest/statusline-schema.js';
import { listStatuslineFixtureFiles, readFixture } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { normalizeStatusline } from './statusline.js';

const FIXTURE = 'statusline-docs-sample.jsonl';
const T0 = '2026-11-14T10:00:00.000Z';

function ctx(receivedAt = T0) {
  let n = 0;
  return {
    receivedAt,
    nextId: () => {
      n += 1;
      return `id-${String(n)}`;
    },
  };
}

function parse(body: unknown): StatuslinePayload {
  const result = parseStatuslinePayload(body);
  if (!result.ok) throw new Error(result.error);
  return result.payload;
}

function ofType<T extends HuddleEvent['type']>(events: readonly HuddleEvent[], type: T): EventOfType<T>[] {
  return events.filter((e): e is EventOfType<T> => e.type === type);
}

describe('parseStatuslinePayload', () => {
  it('keeps only the fields the Huddle uses (transcript_path, session_name, version are dropped)', () => {
    for (const line of readFixture(FIXTURE)) {
      const payload = parse(line.payload);
      const text = JSON.stringify(payload);
      expect(text).not.toContain('transcript_path');
      expect(text).not.toContain('session_name');
      expect(text).not.toContain('total_duration_ms');
      expect(text).not.toContain('display_name');
      expect(payload.session_id).toBeDefined();
    }
  });

  it('rejects only a body that is not a JSON object', () => {
    expect(parseStatuslinePayload(null).ok).toBe(false);
    expect(parseStatuslinePayload([]).ok).toBe(false);
    expect(parseStatuslinePayload('x').ok).toBe(false);
    expect(parseStatuslinePayload({})).toEqual({ ok: true, payload: {} });
  });

  it('drops values of the wrong type instead of failing', () => {
    const result = parseStatuslinePayload({
      session_id: 42,
      model: 'opus',
      context_window: { context_window_size: '200000', used_percentage: 250, current_usage: { input_tokens: -5 } },
      rate_limits: { five_hour: { used_percentage: 'x', resets_at: 1 }, seven_day: 7 },
      extra: { deep: true },
    });
    expect(result).toEqual({
      ok: true,
      payload: { context_window: { current_usage: {} }, rate_limits: { five_hour: { resets_at: 1 } } },
    });
  });

  it('never throws on a hostile object', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom');
        },
        get: () => {
          throw new Error('boom');
        },
      },
    );
    expect(parseStatuslinePayload(hostile).ok).toBe(false);
  });
});

describe('normalizeStatusline', () => {
  it('finds the docs-derived fixture', () => {
    expect(listStatuslineFixtureFiles()).toContain(FIXTURE);
  });

  it('matches the golden events for the docs-derived fixture', async () => {
    const events = fixtureEvents(FIXTURE);
    await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot(
      `./__snapshots__/statusline/${FIXTURE.replace(/\.jsonl$/, '.json')}`,
    );
  });

  it('fixture: context only when current_usage is present, for the main agent, from the statusline source', () => {
    const events = fixtureEvents(FIXTURE);
    const context = ofType(events, 'context.measured');
    // Lines 1 and 4 have current_usage null (session start, after /compact): no reading, not 0.
    expect(context.map((e) => e.usedTokens)).toEqual([15500, 48200, 12000]);
    for (const e of context) {
      expect(e.measuredBy).toBe('statusline');
      expect(e.windowTokens).toBe(200000);
      expect(e.source).toBe('statusline');
      expect(e.agentKey).toBe(agentKey(e.sessionId));
    }
    expect(events.every((e) => e.type === 'context.measured' || e.type === 'limits.measured')).toBe(true);
  });

  it('fixture: limits converted from epoch seconds to ms; an absent window is null, never 0', () => {
    const limits = ofType(fixtureEvents(FIXTURE), 'limits.measured').map((e) => e.limits);
    // Line 1 has no rate_limits at all: no event.
    expect(limits).toHaveLength(4);
    expect(limits[0]).toEqual({
      fiveHourUsedPct: 23.5,
      fiveHourResetsAt: Date.parse('2026-11-14T15:00:00Z'),
      sevenDayUsedPct: 41.2,
      sevenDayResetsAt: Date.parse('2026-11-18T00:00:00Z'),
      measuredAt: Date.parse('2026-11-14T10:00:20.000Z'),
    });
    expect(limits[3]).toMatchObject({ fiveHourUsedPct: 26, sevenDayUsedPct: null, sevenDayResetsAt: null });
  });

  it('emits nothing without a session id', () => {
    expect(normalizeStatusline(parse({ context_window: { current_usage: { input_tokens: 1 } } }), ctx())).toEqual([]);
  });

  it('refuses a session id the store would refuse, and the Huddle own session ids (A1-04, A1-05)', () => {
    for (const id of ['a b', 'x'.repeat(200), 'huddle-tasks', 'huddle-budgets', 'huddle-history', 'huddle-phone']) {
      const payload = parse({ session_id: id, context_window: { current_usage: { input_tokens: 1 } } });
      expect(normalizeStatusline(payload, ctx())).toEqual([]);
    }
  });

  it('window size unknown -> windowTokens null; empty current_usage -> no reading', () => {
    const one = normalizeStatusline(
      parse({ session_id: 's', context_window: { current_usage: { input_tokens: 7 } } }),
      ctx(),
    );
    expect(one).toEqual([
      {
        id: 'id-1',
        type: 'context.measured',
        ts: Date.parse(T0),
        sessionId: 's',
        agentKey: agentKey('s'),
        source: 'statusline',
        usedTokens: 7,
        windowTokens: null,
        measuredBy: 'statusline',
      },
    ]);
    expect(normalizeStatusline(parse({ session_id: 's', context_window: { current_usage: {} } }), ctx())).toEqual([]);
  });

  it('rate_limits present but empty -> no limits event', () => {
    expect(normalizeStatusline(parse({ session_id: 's', rate_limits: {} }), ctx())).toEqual([]);
  });

  it('is deterministic and does not mutate its input', () => {
    const payload = parse(readFixture(FIXTURE)[1]?.payload);
    const copy = structuredClone(payload);
    expect(normalizeStatusline(payload, ctx())).toEqual(normalizeStatusline(payload, ctx()));
    expect(payload).toEqual(copy);
  });
});
