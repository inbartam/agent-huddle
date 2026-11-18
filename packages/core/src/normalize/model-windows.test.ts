import { describe, expect, it } from 'vitest';
import { baseModelId, modelWindowTokens } from './model-windows.js';

describe('modelWindowTokens', () => {
  it.each([
    ['claude-sonnet-4-5', 200_000],
    ['claude-sonnet-4-5-20250929', 200_000],
    ['claude-sonnet-4-5[1m]', 1_000_000],
    ['claude-opus-5-5[1m]', 1_000_000],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 200_000],
    ['claude-opus-4-1@20250805', 200_000],
    ['claude-opus-5-5', 1_000_000],
    ['claude-opus-4-6', 200_000],
    ['claude-opus-4-6[1m]', 1_000_000],
    ['claude-fable-5-2', 1_000_000],
    ['claude-haiku-5-5', 1_000_000],
    ['claude-opus-9-9', null],
    ['gpt-whatever', null],
    ['', null],
    [null, null],
    ['constructor', null],
    ['__proto__', null],
  ] as const)('%s -> %s', (model, expected) => {
    expect(modelWindowTokens(model)).toBe(expected);
  });

  it('baseModelId strips provider prefixes and date suffixes', () => {
    expect(baseModelId('anthropic.claude-3-5-haiku-20241022-v1:0')).toBe('claude-3-5-haiku');
    expect(baseModelId('Claude-Sonnet-4-5[1m]')).toBe('claude-sonnet-4-5');
  });
});
