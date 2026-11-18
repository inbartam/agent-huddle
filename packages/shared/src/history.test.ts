import { describe, expect, it } from 'vitest';
import { etaPriorsFrom, MIN_PRIOR_SAMPLES, priorUnitMsFor, workTokens, type Scorecard } from './history.js';
import { priorKey } from './model.js';

function card(over: Partial<Scorecard>): Scorecard {
  return {
    role: 'Explore',
    model: 'claude-haiku-5-5',
    runs: 5,
    tasksCompleted: 0,
    units: 5,
    medianTaskMs: 12_000,
    sampleSize: 5,
    tokensPerTask: null,
    tokenSampleSize: 0,
    failureRate: 0,
    toolFailureRate: null,
    approvalsRequested: 0,
    stuckIncidents: 0,
    firstRunAt: 0,
    lastRunAt: 0,
    ...over,
  };
}

describe('priorUnitMsFor', () => {
  it('returns the median ms per unit for the exact role and model', () => {
    const cards = [card({}), card({ model: 'claude-opus-5-5', medianTaskMs: 40_000 })];
    expect(priorUnitMsFor(cards, 'Explore', 'claude-opus-5-5')).toBe(40_000);
    expect(priorUnitMsFor(cards, 'Explore', 'claude-haiku-5-5')).toBe(12_000);
  });

  it('is null below MIN_PRIOR_SAMPLES, for an unknown pair, and for an empty list', () => {
    expect(priorUnitMsFor([card({ sampleSize: MIN_PRIOR_SAMPLES - 1 })], 'Explore', 'claude-haiku-5-5')).toBeNull();
    expect(priorUnitMsFor([card({ sampleSize: MIN_PRIOR_SAMPLES })], 'Explore', 'claude-haiku-5-5')).toBe(12_000);
    expect(priorUnitMsFor([card({})], 'Explore', null)).toBeNull();
    expect(priorUnitMsFor([], 'Explore', 'claude-haiku-5-5')).toBeNull();
  });

  it('never gives a prior for an unknown model, however many runs it has', () => {
    expect(priorUnitMsFor([card({ model: null, medianTaskMs: 7_000 })], 'Explore', null)).toBeNull();
    expect(priorUnitMsFor([card({ model: null, sampleSize: 50 })], 'Explore', null)).toBeNull();
    // Nor is one borrowed from a known model.
    expect(priorUnitMsFor([card({})], 'Explore', null)).toBeNull();
  });

  it('never gives a 0 ms (or negative, or not finite) unit time as a prior', () => {
    expect(priorUnitMsFor([card({ medianTaskMs: 0 })], 'Explore', 'claude-haiku-5-5')).toBeNull();
    expect(priorUnitMsFor([card({ medianTaskMs: -5 })], 'Explore', 'claude-haiku-5-5')).toBeNull();
    expect(priorUnitMsFor([card({ medianTaskMs: Number.NaN })], 'Explore', 'claude-haiku-5-5')).toBeNull();
    expect(priorUnitMsFor([card({ medianTaskMs: null })], 'Explore', 'claude-haiku-5-5')).toBeNull();
    expect(priorUnitMsFor([card({ medianTaskMs: 1 })], 'Explore', 'claude-haiku-5-5')).toBe(1);
  });
});

describe('etaPriorsFrom', () => {
  it('keeps the pairs priorUnitMsFor gives a prior for, keyed by priorKey (no unknown model, no 0 ms)', () => {
    const cards = [
      card({}),
      card({ model: 'claude-opus-5-5', medianTaskMs: 40_000 }),
      card({ role: 'Plan', sampleSize: MIN_PRIOR_SAMPLES - 1 }),
      card({ role: 'Lazy', medianTaskMs: null }),
      card({ role: 'Zero', medianTaskMs: 0 }),
      card({ model: null, medianTaskMs: 9_000 }),
    ];
    expect(etaPriorsFrom(cards, 123)).toEqual({
      byRoleModel: {
        [priorKey('Explore', 'claude-haiku-5-5')]: 12_000,
        [priorKey('Explore', 'claude-opus-5-5')]: 40_000,
      },
      asOf: 123,
    });
    expect(etaPriorsFrom([], 0)).toEqual({ byRoleModel: {}, asOf: 0 });
  });
});

describe('workTokens', () => {
  it('counts input and output, not cache', () => {
    expect(workTokens({ input: 10, output: 5, cacheRead: 1000, cacheCreation: 50, requests: 1 })).toBe(15);
  });
});
