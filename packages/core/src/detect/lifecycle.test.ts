import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { builder, T0 } from '../test/detect-events.js';
import { emptyLife, MAX_ENDED_AGENTS, stepLife, type LifeState } from './lifecycle.js';

function fold(state: LifeState, events: readonly HuddleEvent[]): LifeState {
  let next = state;
  for (const e of events) next = stepLife(next, e).state;
  return next;
}

describe('lifecycle memory stays bounded (security review S1)', () => {
  it('forgets the per-session maps of sessions whose agents were all forgotten', () => {
    const ev = builder();
    // A session that stays live the whole time, with a long ended history around it.
    const keep = 'live-session';
    let state = fold(emptyLife(), [
      ev(
        'session.started',
        { ts: T0, session: keep },
        {
          origin: 'attached',
          cwd: 'C:/live',
          title: null,
          model: null,
          startKind: 'startup',
        },
      ),
      ev('prompt.submitted', { ts: T0, session: keep }, { text: 'go', promptId: null }),
    ]);
    const total = MAX_ENDED_AGENTS + 50;
    for (let i = 0; i < total; i++) {
      const session = `s-${String(i)}`;
      const ts = T0 + i + 1;
      state = fold(state, [
        ev(
          'session.started',
          { ts, session },
          {
            origin: 'attached',
            cwd: `C:/p${String(i)}`,
            title: null,
            model: null,
            startKind: 'startup',
          },
        ),
        ev('session.ended', { ts, session }, { reason: 'other' }),
      ]);
    }
    expect(state.endedOrder).toHaveLength(MAX_ENDED_AGENTS);
    expect(Object.keys(state.agents)).toHaveLength(MAX_ENDED_AGENTS + 1);
    // Bounded like the agents: one entry per remembered session.
    expect(Object.keys(state.sessionCwd)).toHaveLength(MAX_ENDED_AGENTS + 1);
    expect(Object.keys(state.sessionLastSeen)).toHaveLength(MAX_ENDED_AGENTS + 1);
    expect(state.sessionCwd['s-0']).toBeUndefined();
    expect(state.sessionLastSeen['s-0']).toBeUndefined();
    const last = `s-${String(total - 1)}`;
    expect(state.sessionCwd[last]).toBe(`C:/p${String(total - 1)}`);
    // The live session is never forgotten.
    expect(state.sessionCwd[keep]).toBe('C:/live');
    expect(state.sessionLastSeen[keep]).toBe(T0);
    expect(state.agents[agentKey(keep)]?.phase).toBe('working');
    // Slow by nature (2050 sessions through a copy-on-write fold), so it gets more than the 5 s default.
  }, 30_000);
});
