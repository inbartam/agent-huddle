import { describe, expect, it } from 'vitest';
import { duration, shortCount } from './view/format.js';

describe('format (A5-05)', () => {
  it('never shows 60 s next to a minute', () => {
    expect(duration(119_700)).toBe('2 min');
    expect(duration(3_599_800)).toBe('1 h 0 min');
    expect(duration(59_950)).toBe('1 min');
    expect(duration(90_000)).toBe('1 min 30 s');
    expect(duration(9_000)).toBe('9.0 s');
  });

  it('rolls 999,600 over to millions', () => {
    expect(shortCount(999_600)).toBe('1.0M');
    expect(shortCount(999_400)).toBe('999k');
    expect(shortCount(1_000_000)).toBe('1.0M');
  });
});
