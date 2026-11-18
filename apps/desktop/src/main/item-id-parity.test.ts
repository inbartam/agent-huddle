/** The item-id limit and format are written twice (main/toasts.ts, renderer/view/deep-link.ts); this keeps them equal (A4-06). */
import { describe, expect, it } from 'vitest';
import { ITEM_ID_MAX as RENDERER_MAX, isItemIdFormat as rendererOk } from '../renderer/src/view/deep-link.js';
import { ITEM_ID_MAX as MAIN_MAX, isItemIdFormat as mainOk } from './toasts.js';

describe('item id format', () => {
  it('has the same limit in main and the renderer', () => {
    expect(MAIN_MAX).toBe(2100);
    expect(RENDERER_MAX).toBe(MAIN_MAX);
  });

  it.each([
    ['empty', '', false],
    ['one character', 'a', true],
    ['at the limit', 'x'.repeat(2100), true],
    ['over the limit', 'x'.repeat(2101), false],
    ['a newline', 'a\nb', false],
    ['a NUL', 'a\u0000b', false],
    ['a right-to-left override', 'a\u202Eb', false],
    ['an isolate', 'a\u2066b', false],
    ['a zero-width space', 'a\u200Bb', false],
    ['a path with a colon', 'conflict:C:/proj:src/a.ts', true],
    ['not a string', 42, false],
  ])('%s', (_name, value, expected) => {
    expect(mainOk(value)).toBe(expected);
    expect(rendererOk(value)).toBe(expected);
  });
});
