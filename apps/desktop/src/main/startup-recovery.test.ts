import { describe, expect, it } from 'vitest';
import { RELOAD_MIN_GAP_MS, shouldReload, startFailureText } from './startup-recovery.js';

describe('startFailureText', () => {
  it('is the message only, never the stack', () => {
    const err = new Error('The event store is locked.');
    err.stack = 'Error: The event store is locked.\n    at C:/secret/place.js:1:1';
    expect(startFailureText(err)).toBe('The event store is locked.');
  });

  it('clips a long message', () => {
    const text = startFailureText(new Error('x'.repeat(1000)));
    expect(text.length).toBe(300);
    expect(text.endsWith('…')).toBe(true);
  });

  it('uses a fixed sentence for anything that is not an Error, or an empty message', () => {
    for (const v of ['boom', null, { message: 'x' }, new Error('  ')]) {
      expect(startFailureText(v)).toMatch(/^Something went wrong while starting/);
    }
  });
});

describe('shouldReload', () => {
  it('reloads a first crash, and one a minute after the last reload, but not a quick repeat', () => {
    expect(shouldReload(null, 5)).toBe(true);
    expect(shouldReload(1000, 1000 + RELOAD_MIN_GAP_MS)).toBe(true);
    expect(shouldReload(1000, 1000 + RELOAD_MIN_GAP_MS - 1)).toBe(false);
  });
});
