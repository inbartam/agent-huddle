import { describe, expect, it } from 'vitest';
import type { HuddleEvent } from '@huddle/shared';
import { normalizeStatusline } from '../normalize/statusline.js';
import { readFixture } from '../test/fixtures.js';
import type { StatuslinePayload } from '../ingest/statusline-schema.js';
import { MIN_STORE_INTERVAL_MS, StatuslineThrottle } from './statusline-throttle.js';

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
let counter = 0;
const nextId = (): string => `id-${String(++counter).padStart(6, '0')}`;

/** A recorded docs sample line with both a context reading and both rate-limit windows. */
const BASE = readFixture('statusline-docs-sample.jsonl')[1]?.payload as StatuslinePayload;

function reading(at: number, patch: (p: StatuslinePayload) => StatuslinePayload = (p) => p): HuddleEvent[] {
  return normalizeStatusline(patch(structuredClone(BASE)), { receivedAt: new Date(at).toISOString(), nextId });
}

function withInput(tokens: number) {
  return (p: StatuslinePayload): StatuslinePayload => ({
    ...p,
    context_window: {
      ...p.context_window,
      context_window_size: 200_000,
      current_usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

describe('StatuslineThrottle', () => {
  it('stores 100 identical posts (300 ms apart, ~30 s) as one reading of each kind', () => {
    const throttle = new StatuslineThrottle();
    const first = reading(T0);
    expect(first.map((e) => e.type)).toEqual(['context.measured', 'limits.measured']);
    const stored: HuddleEvent[] = [];
    for (let i = 0; i < 100; i++) stored.push(...throttle.admit(reading(T0 + i * 300)));
    expect(stored.map((e) => e.type)).toEqual(['context.measured', 'limits.measured']);
  });

  it('stores a significant change at once, and a small change only after the interval', () => {
    const throttle = new StatuslineThrottle();
    expect(throttle.admit(reading(T0, withInput(100_000)))).toHaveLength(2);
    // +4,000 of 200,000 = 2 points: stored at once (limits unchanged, so only the context event).
    const big = throttle.admit(reading(T0 + 300, withInput(104_000)));
    expect(big.map((e) => e.type)).toEqual(['context.measured']);
    // +200 tokens = 0.1 point: dropped inside the interval...
    expect(throttle.admit(reading(T0 + 600, withInput(104_200)))).toEqual([]);
    // ...and stored once the interval since the last stored reading has passed.
    expect(throttle.admit(reading(T0 + 300 + MIN_STORE_INTERVAL_MS, withInput(104_200)))).toHaveLength(1);
  });

  it('stores a rate-limit window reset or a 1-point move at once; a sub-point move waits', () => {
    const throttle = new StatuslineThrottle();
    throttle.admit(reading(T0));
    const limits = (patch: Partial<NonNullable<StatuslinePayload['rate_limits']>>) => (p: StatuslinePayload) => ({
      ...p,
      rate_limits: { ...p.rate_limits, ...patch },
    });
    const five = BASE.rate_limits?.five_hour ?? {};
    const pct = five.used_percentage ?? 0;
    const tiny = throttle.admit(reading(T0 + 300, limits({ five_hour: { ...five, used_percentage: pct + 0.5 } })));
    expect(tiny).toEqual([]);
    const moved = throttle.admit(reading(T0 + 600, limits({ five_hour: { ...five, used_percentage: pct + 1 } })));
    expect(moved.map((e) => e.type)).toEqual(['limits.measured']);
    const reset = throttle.admit(
      reading(T0 + 900, limits({ five_hour: { used_percentage: pct + 1, resets_at: (five.resets_at ?? 0) + 18_000 } })),
    );
    expect(reset.map((e) => e.type)).toEqual(['limits.measured']);
  });

  it('keeps sessions apart and forgets the least recently updated beyond the bound', () => {
    const throttle = new StatuslineThrottle(3);
    const session = (id: string) => (p: StatuslinePayload) => ({ ...p, session_id: id });
    for (const id of ['a', 'b', 'c', 'd']) expect(throttle.admit(reading(T0, session(id)))).toHaveLength(2);
    expect(throttle.size).toBe(3);
    // 'a' was forgotten, so its identical reading is stored again; 'd' is remembered and dropped.
    expect(throttle.admit(reading(T0 + 300, session('a')))).toHaveLength(2);
    expect(throttle.admit(reading(T0 + 300, session('d')))).toEqual([]);
  });

  it('passes events from other sources through untouched', () => {
    const throttle = new StatuslineThrottle();
    const events = reading(T0).map((e) => ({ ...e, source: 'telemetry' as const }));
    expect(throttle.admit(events)).toEqual(events);
    expect(throttle.admit(events)).toEqual(events);
  });
});
