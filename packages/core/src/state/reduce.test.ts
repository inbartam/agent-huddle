import { describe, expect, it } from 'vitest';
import { agentKey, EMPTY_STATE, type AgentNode, type EventOfType, type HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import {
  ATTACHED_CAPABILITIES,
  initialState,
  MAX_PENDING,
  reduce,
  replay,
  toHuddleState,
  type ReducerState,
} from './reduce.js';

// --- helpers -------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** Replays with every input frozen: any mutation of the state or an event throws. */
function frozenReplay(events: readonly HuddleEvent[]): ReducerState {
  let state = deepFreeze(initialState());
  for (const event of events) state = deepFreeze(reduce(state, deepFreeze(structuredClone(event))));
  return state;
}

function nodes(state: ReducerState): AgentNode[] {
  return Object.values(state.agents);
}

function node(state: ReducerState, key: string): AgentNode {
  const found = state.agents[key];
  if (found === undefined) throw new Error(`no node ${key}`);
  return found;
}

function sessionOf(events: readonly HuddleEvent[]): string {
  const first = events[0];
  if (first === undefined) throw new Error('no events');
  return first.sessionId;
}

const S = 'session-a';
const MAIN = agentKey(S);
const A1 = agentKey(S, 'a1');
const A2 = agentKey(S, 'a2');

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

/** Builds hand-made events with increasing ts and ids. */
function builder(sessionId = S) {
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

// --- fixtures --------------------------------------------------------------------------

describe('reduce over recorded fixtures', () => {
  it.each(listFixtureFiles())('%s replays deterministically without mutating its input', (name) => {
    const events = fixtureEvents(name);
    const a = frozenReplay(events);
    const b = replay(events);
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });

  it('parallel-subagents: 3 nodes; main works after the first two Stops, idles after the last', () => {
    const events = fixtureEvents('parallel-subagents.jsonl');
    const main = agentKey(sessionOf(events));
    const afterMainStops: string[] = [];
    let state = initialState();
    for (const event of events) {
      state = reduce(state, event);
      if (event.type === 'turn.ended' && event.agentKey === main) afterMainStops.push(node(state, main).status);
    }
    expect(nodes(state)).toHaveLength(3);
    expect(afterMainStops).toEqual(['working', 'working', 'idle']);
    for (const child of nodes(state).filter((n) => n.kind === 'subagent')) {
      expect(child.parentKey).toBe(main);
      expect(child.handoff?.link).toBe('exact');
      expect(child.status).toBe('done');
    }
    expect(node(state, main).childKeys).toHaveLength(2);
    expect(
      nodes(state)
        .map((n) => n.name)
        .sort(),
    ).toEqual(['(scrubbed text)', '(scrubbed text)', 'main']);
  });

  it('nested-subagents: Explore sits under general-purpose with an exact link', () => {
    const state = replay(fixtureEvents('nested-subagents.jsonl'));
    const explore = nodes(state).find((n) => n.role === 'Explore');
    const general = nodes(state).find((n) => n.role === 'general-purpose');
    expect(explore?.parentKey).toBe(general?.key);
    expect(explore?.handoff?.link).toBe('exact');
    expect(general?.childKeys).toEqual([explore?.key]);
    expect(general?.parentKey).toBe(general?.sessionId);
  });

  it('nested-subagents: before the link arrives, Explore is placed under its caller by order (heuristic)', () => {
    const events = fixtureEvents('nested-subagents.jsonl');
    const firstLink = events.findIndex((e) => e.type === 'agent.linked');
    const state = replay(events.slice(0, firstLink));
    const explore = nodes(state).find((n) => n.role === 'Explore');
    const general = nodes(state).find((n) => n.role === 'general-purpose');
    expect(explore?.parentKey).toBe(general?.key);
    expect(explore?.handoff?.link).toBe('heuristic');
  });

  it('compaction: one node, one compaction counted', () => {
    const state = replay(fixtureEvents('compaction.jsonl'));
    expect(nodes(state)).toHaveLength(1);
    expect(nodes(state)[0]?.context.compactions).toBe(1);
  });

  it('agent-messages: 3 nodes, main model opus from main-loop telemetry, never haiku', () => {
    const events = fixtureEvents('agent-messages.jsonl');
    const main = agentKey(sessionOf(events));
    let state = initialState();
    for (const event of events) {
      state = reduce(state, event);
      expect(state.agents[main]?.model ?? '').not.toMatch(/haiku/);
    }
    expect(nodes(state)).toHaveLength(3);
    expect(node(state, main).model).toBe('claude-opus-5-5');
    expect(node(state, main).status).toBe('idle');
    expect(nodes(state).every((n) => n.role !== '')).toBe(true);
  });

  it('interactive-helpers: 1 node, helpers hidden, main model opus, never haiku', () => {
    const events = fixtureEvents('interactive-helpers.jsonl');
    const main = agentKey(sessionOf(events));
    let state = initialState();
    for (const event of events) {
      state = reduce(state, event);
      expect(state.agents[main]?.model ?? '').not.toMatch(/haiku/);
    }
    expect(nodes(state)).toHaveLength(1);
    expect(node(state, main).model).toBe('claude-opus-5-5');
    expect(node(state, main).status).toBe('done');
  });

  it('every node of an attached session gets the attached capabilities; only the main agent gets follow-ups', () => {
    const state = replay(fixtureEvents('parallel-subagents.jsonl'));
    for (const n of nodes(state)) {
      expect(n.origin).toBe('attached');
      expect(n.capabilities).toEqual(
        n.kind === 'main' ? ATTACHED_CAPABILITIES : { ...ATTACHED_CAPABILITIES, followUp: false },
      );
    }
  });
});

// --- hand-built scenarios ----------------------------------------------------------------

describe('placement and links', () => {
  it('a link that arrives before the start is remembered and applied', () => {
    const ev = builder();
    const state = replay([
      ev('session.started', MAIN, { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('agent.spawn_requested', MAIN, { toolUseId: 't1', role: 'Explore', title: 'Scan', brief: 'b', model: null }),
      ev('agent.started', A1, { agentId: 'a1', role: 'general-purpose', parentKey: MAIN }),
      ev('agent.spawn_requested', A1, {
        toolUseId: 't2',
        role: 'Explore',
        title: 'Deep scan',
        brief: null,
        model: null,
      }),
      ev('agent.linked', A2, { toolUseId: 't2', childAgentId: 'a2', parentKey: A1, link: 'exact' }),
      ev('agent.started', A2, { agentId: 'a2', role: 'Explore', parentKey: MAIN }),
    ]);
    // By order alone a2 would take t1 (the first unmatched Explore call) under main; the early link wins.
    expect(node(state, A2).parentKey).toBe(A1);
    expect(node(state, A2).handoff).toMatchObject({ toolUseId: 't2', title: 'Deep scan', link: 'exact' });
    expect(node(state, A1).childKeys).toEqual([A2]);
    expect(node(state, MAIN).childKeys).toEqual([A1]);
    expect(state.book.pendingLinks).toEqual({});
  });

  it('an out-of-order link moves the node, even after the child stopped', () => {
    const ev = builder();
    const state = replay([
      ev('agent.spawn_requested', MAIN, {
        toolUseId: 't1',
        role: 'Explore',
        title: 'Main scan',
        brief: null,
        model: null,
      }),
      ev('agent.started', A1, { agentId: 'a1', role: 'general-purpose', parentKey: MAIN }),
      ev('agent.spawn_requested', A1, {
        toolUseId: 't2',
        role: 'Explore',
        title: 'Nested scan',
        brief: null,
        model: null,
      }),
      ev('agent.started', A2, { agentId: 'a2', role: 'Explore', parentKey: MAIN }),
      ev('agent.stopped', A2, { agentId: 'a2', result: 'found it' }),
      ev('agent.linked', A2, { toolUseId: 't2', childAgentId: 'a2', parentKey: A1, link: 'exact' }),
    ]);
    expect(node(state, A2).parentKey).toBe(A1);
    expect(node(state, A1).childKeys).toEqual([A2]);
    expect(node(state, MAIN).childKeys).toEqual([A1]);
    expect(node(state, A2).handoff).toEqual({
      toolUseId: 't2',
      title: 'Nested scan',
      brief: null,
      result: 'found it',
      link: 'exact',
    });
    expect(node(state, A2).name).toBe('Nested scan');
    expect(node(state, A2).status).toBe('done');
    // t1 was released and can match the next Explore.
    expect(state.book.sessions[S]?.spawns.find((s) => s.toolUseId === 't1')?.childKey).toBeNull();
  });

  it('a duplicate link is idempotent', () => {
    const ev = builder();
    const base = [
      ev('agent.spawn_requested', MAIN, { toolUseId: 't1', role: 'Explore', title: 'x', brief: null, model: null }),
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('agent.linked', A1, { toolUseId: 't1', childAgentId: 'a1', parentKey: MAIN, link: 'exact' }),
    ];
    const once = replay(base);
    const twice = replay([
      ...base,
      ev('agent.linked', A1, { toolUseId: 't1', childAgentId: 'a1', parentKey: MAIN, link: 'exact' }),
    ]);
    expect(twice.agents).toEqual(once.agents);
    expect(node(twice, MAIN).childKeys).toEqual([A1]);
  });

  it('a reopened subagent stays one node and keeps its ordinal', () => {
    const ev = builder();
    const state = replay([
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('agent.stopped', A1, { agentId: 'a1', result: 'r1' }),
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
    ]);
    expect(nodes(state)).toHaveLength(2);
    expect(node(state, MAIN).childKeys).toEqual([A1]);
    expect(node(state, A1)).toMatchObject({ status: 'working', endedAt: null, name: 'Explore #1' });
  });

  it('a link never creates a cycle', () => {
    const ev = builder();
    const state = replay([
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('agent.started', A2, { agentId: 'a2', role: 'Explore', parentKey: MAIN }),
      ev('agent.linked', A2, { toolUseId: 't2', childAgentId: 'a2', parentKey: A1, link: 'exact' }),
      ev('agent.linked', A1, { toolUseId: 't1', childAgentId: 'a1', parentKey: A2, link: 'exact' }),
    ]);
    expect(node(state, A1).parentKey).toBe(MAIN);
    expect(node(state, A2).parentKey).toBe(A1);
  });

  it('pending links are bounded', () => {
    const ev = builder();
    const events: HuddleEvent[] = [];
    for (let i = 0; i < MAX_PENDING + 20; i += 1) {
      events.push(
        ev('agent.linked', agentKey(S, `c${String(i)}`), {
          toolUseId: `t${String(i)}`,
          childAgentId: `c${String(i)}`,
          parentKey: MAIN,
          link: 'exact',
        }),
      );
    }
    const state = replay(events);
    expect(Object.keys(state.book.pendingLinks)).toHaveLength(MAX_PENDING);
    expect(state.book.pendingLinkOrder).toHaveLength(MAX_PENDING);
    expect(state.book.pendingLinks[agentKey(S, 'c0')]).toBeUndefined();
  });
});

describe('unknown keys', () => {
  it('agent.stopped and turn.ended for an unknown subagent create nothing', () => {
    const ev = builder();
    const state = replay([
      ev('turn.ended', A1, { lastMessage: null, backgroundAgentIds: [] }),
      ev('agent.stopped', A1, { agentId: 'a1', result: null }),
    ]);
    expect(state.agents).toEqual({});
    expect(state.rootKeys).toEqual([]);
  });

  it('any other event for an unknown session creates its root, mid-session', () => {
    const ev = builder();
    const state = replay([
      ev('tool.started', MAIN, { toolUseId: 't', toolName: 'Bash', summary: 'ls', filePath: null, inputDigest: 'd' }),
    ]);
    expect(node(state, MAIN)).toMatchObject({ kind: 'main', status: 'working', currentActivity: 'Bash: ls' });
    expect(state.rootKeys).toEqual([MAIN]);
  });

  it('a tool event of an unknown subagent creates the root only', () => {
    const ev = builder();
    const state = replay([
      ev('tool.started', A1, { toolUseId: 't', toolName: 'Read', summary: 'x', filePath: null, inputDigest: 'd' }),
    ]);
    expect(Object.keys(state.agents)).toEqual([MAIN]);
  });

  it('an unknown event type returns the state unchanged', () => {
    const state = replay([
      builder()('session.started', MAIN, {
        origin: 'attached',
        cwd: null,
        title: null,
        model: null,
        startKind: 'startup',
      }),
    ]);
    const future = {
      id: 'x',
      type: 'future.thing',
      ts: 1,
      sessionId: S,
      agentKey: MAIN,
      source: 'hook',
    } as unknown as HuddleEvent;
    expect(reduce(state, future)).toBe(state);
  });

  it('accepts a plain HuddleState without bookkeeping', () => {
    const state = reduce(
      EMPTY_STATE,
      builder()('prompt.submitted', MAIN, { text: 'hi', promptId: null, kind: 'user' }),
    );
    expect(node(state, MAIN).status).toBe('working');
    expect(toHuddleState(state)).not.toHaveProperty('book');
  });
});

describe('status (F3)', () => {
  it('waiting for approval clears on the next activity, done after agent.stopped', () => {
    const ev = builder();
    let state = replay([ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN })]);
    state = reduce(
      state,
      ev('approval.requested', A1, {
        request: {
          requestId: 'r',
          agentKey: A1,
          toolName: 'Bash',
          toolInput: {},
          summary: 'ls',
          receivedAt: 0,
          expiresAt: null,
          channel: 'hook',
        },
      }),
    );
    expect(node(state, A1).status).toBe('waiting_approval');
    state = reduce(state, ev('tool.finished', A1, { toolUseId: 't', toolName: 'Bash', durationMs: 5 }));
    expect(node(state, A1).status).toBe('working');
    state = reduce(state, ev('turn.ended', A1, { lastMessage: 'ok', backgroundAgentIds: [] }));
    state = reduce(state, ev('agent.stopped', A1, { agentId: 'a1', result: 'ok' }));
    expect(node(state, A1)).toMatchObject({
      status: 'done',
      currentActivity: null,
      endedAt: expect.any(Number) as number,
    });
  });

  it('current activity clears on Stop', () => {
    const ev = builder();
    const state = replay([
      ev('tool.started', MAIN, {
        toolUseId: 't',
        toolName: 'Bash',
        summary: 'npm test',
        filePath: null,
        inputDigest: 'd',
      }),
      ev('turn.ended', MAIN, { lastMessage: null, backgroundAgentIds: [] }),
    ]);
    expect(node(state, MAIN)).toMatchObject({ status: 'idle', currentActivity: null });
  });

  it('backgroundAgentIds null: idle only when no subagent of the session is still running', () => {
    const ev = builder();
    let state = replay([ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN })]);
    state = reduce(state, ev('turn.ended', MAIN, { lastMessage: null, backgroundAgentIds: null }));
    expect(node(state, MAIN).status).toBe('working');
    state = reduce(state, ev('agent.stopped', A1, { agentId: 'a1', result: null }));
    state = reduce(state, ev('turn.ended', MAIN, { lastMessage: null }));
    expect(node(state, MAIN).status).toBe('idle');
  });

  it('a subagent Stop with an empty session-wide list does not idle the main agent', () => {
    const ev = builder();
    const state = replay([
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('turn.ended', MAIN, { lastMessage: null, backgroundAgentIds: ['a1'] }),
      ev('turn.ended', A1, { lastMessage: null, backgroundAgentIds: [] }),
      ev('agent.stopped', A1, { agentId: 'a1', result: null }),
    ]);
    expect(node(state, MAIN).status).toBe('working');
  });

  it('session end marks the main agent done and stops running subagents', () => {
    const ev = builder();
    const state = replay([
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('session.ended', MAIN, { reason: 'other' }),
    ]);
    expect(node(state, MAIN).status).toBe('done');
    expect(node(state, A1).status).toBe('stopped');
  });
});

describe('model precedence', () => {
  it('telemetry before the first hook is kept pending, and session_start beats it', () => {
    const ev = builder();
    let state = replay([ev('model.observed', MAIN, { model: 'claude-sonnet-x', via: 'telemetry' })]);
    expect(state.agents).toEqual({});
    expect(state.book.pendingModels[MAIN]).toEqual({ model: 'claude-sonnet-x', rank: 2 });
    state = reduce(state, ev('prompt.submitted', MAIN, { text: '', promptId: null, kind: 'user' }));
    expect(node(state, MAIN).model).toBe('claude-sonnet-x');
    expect(state.book.pendingModels).toEqual({});
    state = reduce(state, ev('model.observed', MAIN, { model: 'claude-opus-x', via: 'session_start' }));
    state = reduce(state, ev('model.observed', MAIN, { model: 'claude-haiku-x', via: 'telemetry' }));
    expect(node(state, MAIN).model).toBe('claude-opus-x');
    state = reduce(state, ev('model.observed', MAIN, { model: 'claude-sonnet-y', via: 'switch' }));
    expect(node(state, MAIN).model).toBe('claude-sonnet-y');
  });

  it('a subagent takes the Agent call model, and the resolved model over the requested alias', () => {
    const ev = builder();
    const state = replay([
      ev('agent.spawn_requested', MAIN, { toolUseId: 't1', role: 'Explore', title: null, brief: null, model: 'haiku' }),
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('model.observed', A1, { model: 'claude-haiku-4-5', via: 'agent_call' }),
    ]);
    expect(node(state, A1).model).toBe('claude-haiku-4-5');
    expect(node(state, MAIN).model).toBeNull();
  });

  it('pending models are bounded', () => {
    const ev = builder();
    const events = Array.from({ length: MAX_PENDING + 5 }, (_, i) =>
      ev('model.observed', `s${String(i)}`, { model: 'm', via: 'telemetry' }),
    );
    const state = replay(events);
    expect(state.book.pendingModelOrder).toHaveLength(MAX_PENDING);
    expect(Object.keys(state.book.pendingModels)).toHaveLength(MAX_PENDING);
  });
});

describe('names and roles (F2)', () => {
  it('nickname beats title beats role plus ordinal', () => {
    const ev = builder();
    let state = replay([
      ev('session.started', MAIN, { origin: 'attached', cwd: 'C:/p', title: null, model: null, startKind: 'startup' }),
      ev('agent.started', A1, { agentId: 'a1', role: 'Explore', parentKey: MAIN }),
      ev('agent.started', A2, { agentId: 'a2', role: 'Explore', parentKey: MAIN }),
    ]);
    expect(node(state, MAIN).name).toBe('main');
    expect(node(state, A1).name).toBe('Explore #1');
    expect(node(state, A2).name).toBe('Explore #2');
    state = reduce(
      state,
      ev('session.started', MAIN, {
        origin: 'attached',
        cwd: null,
        title: 'Fix the build',
        model: null,
        startKind: 'resume',
      }),
    );
    expect(node(state, MAIN).name).toBe('Fix the build');
    state = reduce(state, ev('control.applied', A2, { action: 'rename', detail: '  scout ' }));
    expect(node(state, A2).name).toBe('scout');
    state = reduce(state, ev('control.applied', A2, { action: 'rename', detail: null }));
    expect(node(state, A2).name).toBe('Explore #2');
  });

  it('role descriptions: project wins over user, applied to existing and later nodes', () => {
    const ev = builder();
    const state = replay([
      ev('agent.started', A1, { agentId: 'a1', role: 'core-engineer', parentKey: MAIN }),
      ev('role.described', MAIN, {
        role: 'core-engineer',
        description: 'project one',
        definedIn: 'project',
        filePath: null,
      }),
      ev('role.described', MAIN, { role: 'core-engineer', description: 'user one', definedIn: 'user', filePath: null }),
      ev('agent.started', A2, { agentId: 'a2', role: 'core-engineer', parentKey: MAIN }),
    ]);
    expect(node(state, A1).roleDescription).toBe('project one');
    expect(node(state, A2).roleDescription).toBe('project one');
  });
});
