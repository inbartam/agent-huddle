/**
 * Agent teams in the tree (M6 item 3, spike S20): teammates are nodes of kind 'teammate' under the lead (the session
 * root), named by their teammate name, idle after TeammateIdle and working again on their next tool event.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type AgentNode, type EventOfType, type HuddleEvent } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { initialState, reduce, replay, type ReducerState } from './reduce.js';

const SID = '00000000-0000-4000-8000-000000000001';
const ROOT = agentKey(SID);
const ALPHA = agentKey(SID, 'aalpha-0000000000000001');
const BETA = agentKey(SID, 'abeta-0000000000000002');
const PLAIN = agentKey(SID, 'a0000000000000003');

function node(state: ReducerState, key: string): AgentNode {
  const found = state.agents[key];
  if (found === undefined) throw new Error(`no node ${key}`);
  return found;
}

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

function builder(sessionId = 's') {
  let n = 0;
  return function ev<T extends HuddleEvent['type']>(type: T, key: string, fields: Fields<T>): HuddleEvent {
    n += 1;
    return {
      id: `e${String(n).padStart(3, '0')}`,
      type,
      ts: 1000 + n * 10,
      sessionId,
      agentKey: key,
      source: 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  };
}

function run(events: readonly HuddleEvent[]): ReducerState {
  return events.reduce(reduce, initialState());
}

describe('agent-team.jsonl (S20 b)', () => {
  const events = fixtureEvents('agent-team.jsonl');
  const state = replay(events);

  it('puts both teammates and the plain subagent under the lead', () => {
    expect(node(state, ROOT).childKeys).toEqual([ALPHA, BETA, PLAIN]);
    expect([ALPHA, BETA, PLAIN].map((k) => node(state, k).parentKey)).toEqual([ROOT, ROOT, ROOT]);
  });

  it('makes alpha and beta teammates named by their teammate name, idle and not ended', () => {
    for (const [key, name] of [
      [ALPHA, 'alpha'],
      [BETA, 'beta'],
    ] as const) {
      const n = node(state, key);
      expect(n.kind).toBe('teammate');
      expect(n.name).toBe(name);
      expect(n.role).toBe(name);
      expect(n.status).toBe('idle');
      expect(n.endedAt).toBeNull();
      expect(n.capabilities.followUp).toBe(false);
    }
  });

  it('matches each teammate to the Agent call that named it (handoff and requested model)', () => {
    expect(node(state, ALPHA).handoff).toMatchObject({ toolUseId: 'tool_use-1', link: 'heuristic' });
    expect(node(state, BETA).handoff).toMatchObject({ toolUseId: 'tool_use-2', link: 'heuristic' });
    expect(node(state, ALPHA).model).toBe('haiku');
  });

  it('keeps the plain a<16 hex> subagent a subagent, matched to its own unnamed call, done', () => {
    const plain = node(state, PLAIN);
    expect(plain.kind).toBe('subagent');
    expect(plain.status).toBe('done');
    expect(plain.handoff).toMatchObject({ toolUseId: 'tool_use-4' });
  });

  it('creates no node for the helper SubagentStops (empty agent_type, no SubagentStart)', () => {
    expect(Object.keys(state.agents).sort()).toEqual([ROOT, ALPHA, BETA, PLAIN].sort());
  });

  it('leaves the lead idle after its Stop: running teammates are not background subagents', () => {
    expect(node(state, ROOT).status).toBe('idle');
  });

  it('shows the teammate done between its SubagentStop and its TeammateIdle (about 20 ms)', () => {
    const idleAt = events.findIndex((e) => e.type === 'teammate.idle');
    const before = replay(events.slice(0, idleAt));
    expect(node(before, ALPHA).status).toBe('done');
    expect(node(replay(events.slice(0, idleAt + 1)), ALPHA).status).toBe('idle');
  });
});

describe('teammate.idle and the teammate lifecycle', () => {
  const S = 's';
  const MAIN = agentKey(S);
  const T = agentKey(S, 'amate-0123456789abcdef');

  it('an idle teammate works again on its next tool event, and on a new agent.started', () => {
    const ev = builder(S);
    const base = [
      ev('agent.started', T, {
        agentId: 'amate-0123456789abcdef',
        role: 'mate',
        parentKey: MAIN,
        teammateName: 'mate',
      }),
      ev('agent.stopped', T, { agentId: 'amate-0123456789abcdef', result: null }),
      ev('teammate.idle', T, { agentId: 'amate-0123456789abcdef', teammateName: 'mate', teamName: 'session-s' }),
    ];
    expect(node(run(base), T).status).toBe('idle');
    const afterTool = run([
      ...base,
      ev('tool.started', T, { toolUseId: 'x', toolName: 'Read', summary: 'f', filePath: null, inputDigest: 'd' }),
    ]);
    expect(node(afterTool, T).status).toBe('working');
    const afterMessage = run([
      ...base,
      ev('agent.started', T, {
        agentId: 'amate-0123456789abcdef',
        role: 'mate',
        parentKey: MAIN,
        teammateName: 'mate',
      }),
    ]);
    expect(node(afterMessage, T).status).toBe('working');
    expect(node(afterMessage, MAIN).childKeys).toEqual([T]);
  });

  it('places a teammate under the root even when a subagent made the Agent call', () => {
    const ev = builder(S);
    const SUB = agentKey(S, 'a0123456789abcdef');
    const state = run([
      ev('agent.started', SUB, { agentId: 'a0123456789abcdef', role: 'general-purpose', parentKey: MAIN }),
      ev('agent.spawn_requested', SUB, {
        toolUseId: 'call-1',
        role: 'general-purpose',
        title: 't',
        brief: null,
        model: null,
        name: 'mate',
      }),
      ev('agent.started', T, {
        agentId: 'amate-0123456789abcdef',
        role: 'mate',
        parentKey: MAIN,
        teammateName: 'mate',
      }),
    ]);
    expect(node(state, T).parentKey).toBe(MAIN);
    expect(node(state, T).handoff).toMatchObject({ toolUseId: 'call-1', title: 't' });
    expect(node(state, SUB).childKeys).toEqual([]);
  });

  it('a named call does not stop a plain subagent of that role from matching it (named subagent under -p, S20 a)', () => {
    const ev = builder(S);
    const SUB = agentKey(S, 'a0123456789abcdef');
    const state = run([
      ev('agent.spawn_requested', MAIN, {
        toolUseId: 'call-1',
        role: 'general-purpose',
        title: 't',
        brief: null,
        model: null,
        name: 'mate',
      }),
      ev('agent.started', SUB, { agentId: 'a0123456789abcdef', role: 'general-purpose', parentKey: MAIN }),
    ]);
    expect(node(state, SUB).kind).toBe('subagent');
    expect(node(state, SUB).handoff).toMatchObject({ toolUseId: 'call-1' });
  });

  it('turns an existing subagent node into a teammate under the root on teammate.idle', () => {
    const ev = builder(S);
    const SUB = agentKey(S, 'a0123456789abcdef');
    const X = agentKey(S, 'aodd-name');
    const state = run([
      ev('agent.started', SUB, { agentId: 'a0123456789abcdef', role: 'general-purpose', parentKey: MAIN }),
      ev('agent.linked', X, { toolUseId: 'c', childAgentId: 'aodd-name', parentKey: SUB, link: 'exact' }),
      ev('agent.started', X, { agentId: 'aodd-name', role: 'odd', parentKey: MAIN }),
      ev('teammate.idle', X, { agentId: 'aodd-name', teammateName: 'odd', teamName: null }),
    ]);
    expect(node(state, X)).toMatchObject({ kind: 'teammate', parentKey: MAIN, status: 'idle', name: 'odd' });
    expect(node(state, SUB).childKeys).toEqual([]);
    expect(node(state, MAIN).childKeys).toEqual([SUB, X]);
  });

  it('creates an unseen teammate idle when teammate.idle names its agent id (Huddle started mid-run)', () => {
    const ev = builder(S);
    const state = run([
      ev('teammate.idle', T, { agentId: 'amate-0123456789abcdef', teammateName: 'mate', teamName: 'session-s' }),
    ]);
    expect(node(state, T)).toMatchObject({
      kind: 'teammate',
      parentKey: MAIN,
      status: 'idle',
      name: 'mate',
      endedAt: null,
    });
    expect(node(state, MAIN).childKeys).toEqual([T]);
  });

  it('without an agent id: finds the teammate by name, and creates nothing for an unknown name', () => {
    const ev = builder(S);
    const started = ev('agent.started', T, {
      agentId: 'amate-0123456789abcdef',
      role: 'mate',
      parentKey: MAIN,
      teammateName: 'mate',
    });
    const byName = run([started, ev('teammate.idle', MAIN, { agentId: null, teammateName: 'mate', teamName: null })]);
    expect(node(byName, T).status).toBe('idle');
    expect(node(byName, MAIN).status).not.toBe('idle');
    const unknown = run([ev('teammate.idle', MAIN, { agentId: null, teammateName: 'ghost', teamName: null })]);
    expect(Object.keys(unknown.agents)).toEqual([MAIN]);
  });

  it('leaves a stopped teammate stopped (session ended) and ignores teammate.idle on the main key', () => {
    const ev = builder(S);
    const state = run([
      ev('agent.started', T, {
        agentId: 'amate-0123456789abcdef',
        role: 'mate',
        parentKey: MAIN,
        teammateName: 'mate',
      }),
      ev('session.ended', MAIN, { reason: 'other' }),
      ev('teammate.idle', T, { agentId: 'amate-0123456789abcdef', teammateName: 'mate', teamName: null }),
      ev('teammate.idle', MAIN, { agentId: 'x', teammateName: 'main', teamName: null }),
    ]);
    expect(node(state, T).status).toBe('stopped');
    expect(node(state, MAIN)).toMatchObject({ kind: 'main', status: 'done' });
  });

  it('names a teammate by its name, not by the handoff title or role plus ordinal', () => {
    const ev = builder(S);
    const state = run([
      ev('agent.spawn_requested', MAIN, {
        toolUseId: 'call-1',
        role: 'general-purpose',
        title: 'reads a file',
        brief: null,
        model: null,
        name: 'mate',
      }),
      ev('agent.started', T, {
        agentId: 'amate-0123456789abcdef',
        role: 'mate',
        parentKey: MAIN,
        teammateName: 'mate',
      }),
    ]);
    expect(node(state, T).handoff?.title).toBe('reads a file');
    expect(node(state, T).name).toBe('mate');
  });
});
