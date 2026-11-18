import { describe, expect, it } from 'vitest';
import type { EventOfType, HuddleEvent } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { withNicknameFallback } from './nicknames.js';
import { reduce, replay } from './reduce.js';

function rename(name: string): HuddleEvent {
  const event: EventOfType<'control.applied'> = {
    id: 'rename-1',
    type: 'control.applied',
    ts: Number.MAX_SAFE_INTEGER,
    sessionId: 'session-1',
    agentKey: 'session-1',
    source: 'user',
    action: 'rename',
    detail: name,
  };
  return event;
}

describe('withNicknameFallback', () => {
  const state = replay(fixtureEvents('single-agent.jsonl'));

  it('names an agent by its kept nickname when the log gives it none', () => {
    const shown = withNicknameFallback(state, { 'session-1': 'Kept', 'not-here': 'Ghost' });
    expect(shown.agents['session-1']?.name).toBe('Kept');
    expect(shown.agents['not-here']).toBeUndefined();
    // Pure: the reducer's state is untouched.
    expect(state.agents['session-1']?.name).not.toBe('Kept');
  });

  it('a nickname from the log wins, and nothing to change returns the same state', () => {
    const renamed = reduce(state, rename('From the log'));
    expect(withNicknameFallback(renamed, { 'session-1': 'Kept' }).agents['session-1']?.name).toBe('From the log');
    expect(withNicknameFallback(state, {})).toBe(state);
  });
});
