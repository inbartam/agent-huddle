import { describe, expect, it } from 'vitest';
import { createIdGenerator } from './ids.js';

describe('createIdGenerator', () => {
  it('makes fixed-width ids that sort in creation order', () => {
    const times = [1_000, 1_000, 1_001, 5_000_000_000_000];
    let i = 0;
    const next = createIdGenerator({ now: () => times[i++] ?? 0 });
    const ids = times.map(() => next());
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays monotonic when the clock steps back', () => {
    const times = [2_000, 1_000, 1_500];
    let i = 0;
    const next = createIdGenerator({ now: () => times[i++] ?? 0 });
    const ids = [next(), next(), next()];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it('is unique over many ids within one millisecond', () => {
    const next = createIdGenerator({ now: () => 42 });
    const ids = Array.from({ length: 10_000 }, () => next());
    expect(new Set(ids).size).toBe(10_000);
    expect([...ids].sort()).toEqual(ids);
  });

  it('treats a non-finite clock value as time zero instead of producing NaN', () => {
    const next = createIdGenerator({ now: () => Number.NaN });
    expect(next()).toMatch(/^[0-9a-z]+$/);
  });
});
