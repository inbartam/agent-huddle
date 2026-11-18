/**
 * The lead's answer about a teammate in the tree (M6 P5b, ADR-027): `teammate.reported` finished makes an idle teammate
 * done (endedAt = the event time), waiting changes nothing; a done teammate that acts again is working again. Also:
 * a message the Huddle queued itself is marked `author: 'huddle'` in the outbox.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type AgentNode, type EventOfType, type HuddleEvent } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { initialState, reduce, replay, type ReducerState } from './reduce.js';

const S = 's';
const MAIN = agentKey(S);
const ID = 'amate-0123456789abcdef';
const T = agentKey(S, ID);

function node(state: ReducerState, key: string): AgentNode {
  const found = state.agents[key];
  if (found === undefined) throw new Error(`no node ${key}`);
  return found;
}

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

function builder(sessionId = S) {
  let n = 0;
  return function ev<T extends HuddleEvent['type']>(
    type: T,
    key: string,
    fields: Fields<T>,
    source: HuddleEvent['source'] = 'hook',
  ): HuddleEvent {
    n += 1;
    return {
      id: `e${String(n).padStart(3, '0')}`,
      type,
      ts: 1000 + n * 10,
      sessionId,
      agentKey: key,
      source,
      ...fields,
    } as unknown as HuddleEvent;
  };
}

function run(events: readonly HuddleEvent[]): ReducerState {
  return events.reduce(reduce, initialState());
}

/** A teammate that started, stopped and went idle (S20 order). */
function idleTeammate(ev: ReturnType<typeof builder>): HuddleEvent[] {
  return [
    ev('prompt.submitted', MAIN, { text: 'go', promptId: null, kind: 'user' }),
    ev('agent.started', T, { agentId: ID, role: 'mate', parentKey: MAIN, teammateName: 'mate' }),
    ev('agent.stopped', T, { agentId: ID, result: null }),
    ev('teammate.idle', T, { agentId: ID, teammateName: 'mate', teamName: 'session-s' }),
  ];
}

const tool = (ev: ReturnType<typeof builder>, key: string) =>
  ev('tool.started', key, { toolUseId: 'x', toolName: 'Read', summary: 'f', filePath: null, inputDigest: 'd' });

describe('agent-team-report.jsonl (derived from S20 b)', () => {
  const SID = '00000000-0000-4000-8000-000000000002';
  const state = replay(fixtureEvents('agent-team-report.jsonl'));

  it('makes alpha (reported finished) done at the report time, and leaves beta (waiting) idle', () => {
    const alpha = node(state, agentKey(SID, 'aalpha-0000000000000001'));
    const beta = node(state, agentKey(SID, 'abeta-0000000000000002'));
    expect(alpha.status).toBe('done');
    expect(alpha.endedAt).toBe(Date.parse('2026-11-16T12:30:29.934Z'));
    expect(beta.status).toBe('idle');
    expect(beta.endedAt).toBeNull();
  });
});

describe('teammate.reported', () => {
  it('finished: an idle teammate becomes done with endedAt = the event time', () => {
    const ev = builder();
    const report = ev('teammate.reported', MAIN, { teammateName: 'mate', status: 'finished', note: null });
    const state = run([...idleTeammate(ev), report]);
    expect(node(state, T).status).toBe('done');
    expect(node(state, T).endedAt).toBe(report.ts);
    expect(node(state, T).currentActivity).toBeNull();
  });

  it('waiting: nothing changes (the idle teammate stays idle, not ended)', () => {
    const ev = builder();
    const before = run(idleTeammate(ev));
    const after = reduce(before, ev('teammate.reported', MAIN, { teammateName: 'mate', status: 'waiting', note: 'x' }));
    expect(node(after, T)).toEqual(node(before, T));
  });

  it('an unknown name, another session, or the main agent changes no node', () => {
    const ev = builder();
    const before = run(idleTeammate(ev));
    for (const e of [
      ev('teammate.reported', MAIN, { teammateName: 'ghost', status: 'finished', note: null }),
      builder('other')('teammate.reported', agentKey('other'), {
        teammateName: 'mate',
        status: 'finished',
        note: null,
      }),
      ev('teammate.reported', MAIN, { teammateName: node(before, MAIN).role, status: 'finished', note: null }),
    ]) {
      const after = reduce(before, e);
      expect(node(after, T)).toEqual(node(before, T));
      expect(node(after, MAIN).status).toBe(node(before, MAIN).status);
    }
  });

  it('a teammate that is not idle (working, stopped) is left as it is', () => {
    const ev = builder();
    const working = run([...idleTeammate(ev), tool(ev, T)]);
    expect(node(working, T).status).toBe('working');
    const r1 = reduce(working, ev('teammate.reported', MAIN, { teammateName: 'mate', status: 'finished', note: null }));
    expect(node(r1, T).status).toBe('working');

    const ev2 = builder();
    const stopped = run([...idleTeammate(ev2), ev2('session.ended', MAIN, { reason: 'other' })]);
    const before = node(stopped, T);
    const r2 = reduce(
      stopped,
      ev2('teammate.reported', MAIN, { teammateName: 'mate', status: 'finished', note: null }),
    );
    expect(node(r2, T)).toEqual(before);
  });

  it('a done teammate works again on its next tool event (endedAt null), and on a new agent.started', () => {
    const ev = builder();
    const done = [
      ...idleTeammate(ev),
      ev('teammate.reported', MAIN, { teammateName: 'mate', status: 'finished', note: null }),
    ];
    const afterTool = run([...done, tool(ev, T)]);
    expect(node(afterTool, T).status).toBe('working');
    expect(node(afterTool, T).endedAt).toBeNull();
    const afterStart = run([
      ...done,
      ev('agent.started', T, { agentId: ID, role: 'mate', parentKey: MAIN, teammateName: 'mate' }),
    ]);
    expect(node(afterStart, T).status).toBe('working');
    expect(node(afterStart, T).endedAt).toBeNull();
    // ... and goes idle again (TeammateIdle replaces done as before).
    const idleAgain = run([
      ...done,
      tool(ev, T),
      ev('agent.stopped', T, { agentId: ID, result: null }),
      ev('teammate.idle', T, { agentId: ID, teammateName: 'mate', teamName: null }),
    ]);
    expect(node(idleAgain, T).status).toBe('idle');
  });

  it('a plain subagent that is done stays done on a late tool event (only teammates revive)', () => {
    const ev = builder();
    const SUB = agentKey(S, 'a0123456789abcdef');
    const state = run([
      ev('agent.started', SUB, { agentId: 'a0123456789abcdef', role: 'general-purpose', parentKey: MAIN }),
      ev('agent.stopped', SUB, { agentId: 'a0123456789abcdef', result: null }),
      tool(ev, SUB),
    ]);
    expect(node(state, SUB).status).toBe('done');
  });
});

describe('outbox author (M6 P5b)', () => {
  it("marks a message queued with source 'huddle' as the Huddle's; a user's has no author", () => {
    const ev = builder();
    const state = run([
      ...idleTeammate(ev),
      ev('message.queued', MAIN, { messageId: 'm1', text: 'from the user', delivery: 'auto' }, 'user'),
      ev('message.queued', MAIN, { messageId: 'm2', text: 'from the Huddle', delivery: 'auto' }, 'huddle'),
    ]);
    expect(node(state, MAIN).outbox).toEqual([
      { messageId: 'm1', text: 'from the user', delivery: 'auto', queuedAt: expect.any(Number) as number },
      {
        messageId: 'm2',
        text: 'from the Huddle',
        delivery: 'auto',
        queuedAt: expect.any(Number) as number,
        author: 'huddle',
      },
    ]);
  });
});
