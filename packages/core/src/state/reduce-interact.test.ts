/**
 * M3 WP3: inbox items for approvals and questions, pause holds, the outbox and capabilities (F10 F11 F12 F13).
 * Synthetic events for each path, plus replays of the recorded permission and question fixtures.
 */
import { describe, expect, it } from 'vitest';
import {
  agentKey,
  type AgentNode,
  type ApprovalRequest,
  type AttentionItem,
  type EventOfType,
  type HuddleEvent,
  type QuestionRequest,
} from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import {
  ATTACHED_CAPABILITIES,
  MANAGED_CAPABILITIES,
  approvalItemId,
  capabilitiesFor,
  initialState,
  questionItemId,
  reduce,
  replay,
  type ReducerState,
} from './reduce.js';

const S = 'session-i';
const MAIN = agentKey(S);
const SUB = agentKey(S, 'sub1');

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

function builder() {
  let n = 0;
  return function ev<T extends HuddleEvent['type']>(type: T, key: string, fields: Fields<T>): HuddleEvent {
    n += 1;
    return {
      id: `i${String(n).padStart(3, '0')}`,
      type,
      ts: 1000 + n * 10,
      sessionId: S,
      agentKey: key,
      source: 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  };
}

function node(state: ReducerState, key: string): AgentNode {
  const found = state.agents[key];
  if (found === undefined) throw new Error(`no node ${key}`);
  return found;
}

function item(state: ReducerState, id: string): AttentionItem {
  const found = state.inbox.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

function approval(requestId: string, key = MAIN): ApprovalRequest {
  return {
    requestId,
    agentKey: key,
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    summary: 'npm test',
    receivedAt: 0,
    expiresAt: null,
    channel: 'hook',
  };
}

function question(requestId: string, key = MAIN): QuestionRequest {
  return {
    requestId,
    agentKey: key,
    questions: [{ question: 'Which tone?', options: [{ label: 'Plain' }, { label: 'Warm' }], multiSelect: false }],
    receivedAt: 0,
  };
}

function start(ev: ReturnType<typeof builder>): HuddleEvent[] {
  return [
    ev('session.started', MAIN, { origin: 'attached', cwd: 'C:/p', title: null, model: null, startKind: 'startup' }),
    ev('prompt.submitted', MAIN, { text: 'go', promptId: null }),
  ];
}

function withSubagent(ev: ReturnType<typeof builder>): HuddleEvent[] {
  return [...start(ev), ev('agent.started', SUB, { agentId: 'sub1', role: 'Explore', parentKey: MAIN })];
}

describe('approvals in the inbox (F10)', () => {
  it('approval.requested adds an action item; approval.resolved resolves it and the agent works again', () => {
    const ev = builder();
    const requested = ev('approval.requested', MAIN, { request: approval('r1') });
    let state = replay([...start(ev), requested]);
    const open = item(state, approvalItemId('r1'));
    expect(open).toMatchObject({
      kind: 'approval',
      severity: 'action_required',
      agentKey: MAIN,
      title: 'main needs approval',
      detail: 'Bash: npm test',
      createdAt: requested.ts,
      resolvedAt: null,
    });
    expect(open.approval?.requestId).toBe('r1');
    expect(node(state, MAIN).status).toBe('waiting_approval');

    const resolved = ev('approval.resolved', MAIN, {
      requestId: 'r1',
      outcome: 'allowed',
      by: 'user',
      policyRuleId: null,
      message: null,
    });
    state = reduce(state, resolved);
    expect(item(state, approvalItemId('r1')).resolvedAt).toBe(resolved.ts);
    expect(node(state, MAIN).status).toBe('working');
  });

  it('an older log approval.requested for AskUserQuestion opens no item and leaves the status alone', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('approval.requested', MAIN, {
        request: { ...approval('rq'), toolName: 'AskUserQuestion', toolInput: {}, summary: 'Which color?' },
      }),
    ]);
    expect(state.inbox.filter((i) => i.kind === 'approval')).toEqual([]);
    expect(node(state, MAIN).status).toBe('working');
  });

  it('an approval.resolved after the turn end already resolved its item does not wake the agent', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('approval.requested', MAIN, { request: approval('r1') }),
      ev('turn.ended', MAIN, { lastMessage: 'ok', backgroundAgentIds: [] }),
      ev('approval.resolved', MAIN, {
        requestId: 'r1',
        outcome: 'answered_elsewhere',
        by: 'claude_code',
        policyRuleId: null,
        message: null,
      }),
    ]);
    expect(node(state, MAIN).status).toBe('idle');
    expect(item(state, approvalItemId('r1')).resolvedAt).not.toBeNull();
  });

  it('a second open request keeps the agent waiting after the first resolves', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('approval.requested', MAIN, { request: approval('r1') }),
      ev('question.asked', MAIN, { request: question('q1') }),
      ev('approval.requested', MAIN, { request: approval('r2') }),
      ev('approval.resolved', MAIN, {
        requestId: 'r1',
        outcome: 'denied',
        by: 'user',
        policyRuleId: null,
        message: 'no',
      }),
    ]);
    expect(node(state, MAIN).status).toBe('waiting_approval');
    const after = replay(
      [
        ev('approval.resolved', MAIN, {
          requestId: 'r2',
          outcome: 'expired',
          by: 'claude_code',
          policyRuleId: null,
          message: null,
        }),
      ],
      state,
    );
    expect(node(after, MAIN).status).toBe('waiting_answer');
  });

  it('a duplicate approval.requested does not add a second item', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('approval.requested', MAIN, { request: approval('r1') }),
      ev('approval.requested', MAIN, { request: approval('r1') }),
    ]);
    expect(state.inbox.filter((i) => i.id === approvalItemId('r1'))).toHaveLength(1);
  });

  it('an approval for an unknown subagent adds no item (no node to show it on)', () => {
    const ev = builder();
    const state = replay([...start(ev), ev('approval.requested', SUB, { request: approval('r1', SUB) })]);
    expect(state.inbox).toHaveLength(0);
  });

  it("the agent's own turn end resolves its open requests, not another agent's", () => {
    const ev = builder();
    const state = replay([
      ...withSubagent(ev),
      ev('approval.requested', MAIN, { request: approval('rm') }),
      ev('approval.requested', SUB, { request: approval('rs', SUB) }),
      ev('turn.ended', SUB, { lastMessage: null }),
    ]);
    expect(item(state, approvalItemId('rs')).resolvedAt).not.toBeNull();
    expect(item(state, approvalItemId('rm')).resolvedAt).toBeNull();
  });
});

describe('questions in the inbox (F11)', () => {
  it.each([
    [
      'question.answered',
      (ev: ReturnType<typeof builder>) =>
        ev('question.answered', MAIN, { requestId: 'q1', answers: { 'Which tone?': 'Plain' } }),
    ],
    [
      'question.closed',
      (ev: ReturnType<typeof builder>) => ev('question.closed', MAIN, { requestId: 'q1', outcome: 'passed_through' }),
    ],
    [
      'tool.finished (answered in the terminal)',
      (ev: ReturnType<typeof builder>) =>
        ev('tool.finished', MAIN, { toolUseId: 'q1', toolName: 'AskUserQuestion', durationMs: 5 }),
    ],
    [
      'tool.failed',
      (ev: ReturnType<typeof builder>) =>
        ev('tool.failed', MAIN, { toolUseId: 'q1', toolName: 'AskUserQuestion', error: 'x', interrupted: true }),
    ],
  ])('%s resolves the question item', (_label, ending) => {
    const ev = builder();
    let state = replay([
      ...start(ev),
      ev('tool.started', MAIN, {
        toolUseId: 'q1',
        toolName: 'AskUserQuestion',
        summary: '',
        filePath: null,
        inputDigest: 'd',
      }),
      ev('question.asked', MAIN, { request: question('q1') }),
    ]);
    const open = item(state, questionItemId('q1'));
    expect(open).toMatchObject({
      kind: 'question',
      title: 'main asked a question',
      detail: 'Which tone?',
      resolvedAt: null,
    });
    expect(node(state, MAIN).status).toBe('waiting_answer');
    const end = ending(ev);
    state = reduce(state, end);
    expect(item(state, questionItemId('q1')).resolvedAt).toBe(end.ts);
    expect(node(state, MAIN).status).toBe('working');
  });

  it('a tool call with another id leaves the question open', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('question.asked', MAIN, { request: question('q1') }),
      ev('tool.finished', MAIN, { toolUseId: 'other', toolName: 'Bash', durationMs: 5 }),
    ]);
    expect(item(state, questionItemId('q1')).resolvedAt).toBeNull();
  });

  it('interactive-helpers fixture: the AskUserQuestion item opens and closes with its PostToolUse', () => {
    const events = fixtureEvents('interactive-helpers.jsonl');
    const asked = events.filter((e): e is EventOfType<'question.asked'> => e.type === 'question.asked');
    expect(asked.length).toBeGreaterThan(0);
    const state = replay(events);
    for (const q of asked) {
      const found = item(state, questionItemId(q.request.requestId));
      expect(found.kind).toBe('question');
      expect(found.resolvedAt).not.toBeNull();
    }
  });
});

describe('ends close everything of the agent', () => {
  it('session.ended resolves open items and clears outbox, hold and pausePending of every agent in it', () => {
    const ev = builder();
    const ended = ev('session.ended', MAIN, { reason: 'other' });
    const state = replay([
      ...withSubagent(ev),
      ev('approval.requested', MAIN, { request: approval('r1') }),
      ev('question.asked', SUB, { request: question('q1', SUB) }),
      ev('message.queued', MAIN, { messageId: 'm1', text: 'hi', delivery: 'turn_end' }),
      ev('control.applied', SUB, { action: 'pause', detail: null }),
      ended,
    ]);
    expect(state.inbox.every((i) => i.resolvedAt === ended.ts)).toBe(true);
    expect(node(state, MAIN).outbox).toEqual([]);
    expect(node(state, SUB).pausePending).toBe(false);
    expect(node(state, SUB).status).toBe('stopped');
  });

  it('agent.stopped resolves the subagent items and clears its hold', () => {
    const ev = builder();
    const state = replay([
      ...withSubagent(ev),
      ev('hold.started', SUB, { toolUseId: 't1', limitAt: 9_999 }),
      ev('question.asked', SUB, { request: question('q1', SUB) }),
      ev('agent.stopped', SUB, { agentId: 'sub1', result: null }),
    ]);
    expect(item(state, questionItemId('q1')).resolvedAt).not.toBeNull();
    expect(node(state, SUB).hold).toBeNull();
    expect(node(state, SUB).status).toBe('done');
  });
});

describe('pause (F13)', () => {
  it('control pause sets pausePending; hold.started pauses; hold.ended resumes', () => {
    const ev = builder();
    let state = replay([...start(ev), ev('control.applied', MAIN, { action: 'pause', detail: null })]);
    expect(node(state, MAIN).pausePending).toBe(true);
    expect(node(state, MAIN).status).toBe('working');

    const held = ev('hold.started', MAIN, { toolUseId: 't1', limitAt: 600_000 });
    state = reduce(state, held);
    expect(node(state, MAIN)).toMatchObject({
      status: 'paused',
      pausePending: false,
      hold: { toolUseId: 't1', since: held.ts, limitAt: 600_000 },
    });

    // A parallel call finishing while held keeps the agent paused.
    state = reduce(state, ev('tool.finished', MAIN, { toolUseId: 't0', toolName: 'Read', durationMs: 1 }));
    expect(node(state, MAIN).status).toBe('paused');

    // hold.ended for another tool call leaves the hold.
    state = reduce(state, ev('hold.ended', MAIN, { toolUseId: 'other', why: 'resumed' }));
    expect(node(state, MAIN).hold).not.toBeNull();

    state = reduce(state, ev('hold.ended', MAIN, { toolUseId: 't1', why: 'resumed' }));
    expect(node(state, MAIN).hold).toBeNull();
    expect(node(state, MAIN).status).toBe('working');
  });

  it('resume before the next tool call clears pausePending', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('control.applied', MAIN, { action: 'pause', detail: null }),
      ev('control.applied', MAIN, { action: 'resume', detail: null }),
    ]);
    expect(node(state, MAIN).pausePending).toBe(false);
  });

  it('an approval while paused wins, and the agent returns to paused when it resolves', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('hold.started', MAIN, { toolUseId: 't1', limitAt: 600_000 }),
      ev('approval.requested', MAIN, { request: approval('r1') }),
    ]);
    expect(node(state, MAIN).status).toBe('waiting_approval');
    const after = replay(
      [
        ev('approval.resolved', MAIN, {
          requestId: 'r1',
          outcome: 'allowed',
          by: 'user',
          policyRuleId: null,
          message: null,
        }),
      ],
      state,
    );
    expect(node(after, MAIN).status).toBe('paused');
  });
});

describe('outbox (F12)', () => {
  it('message.queued appends; message.delivered and message.dropped remove', () => {
    const ev = builder();
    const queued = ev('message.queued', MAIN, { messageId: 'm1', text: 'first', delivery: 'next_tool' });
    let state = replay([
      ...start(ev),
      queued,
      ev('message.queued', MAIN, { messageId: 'm2', text: 'second', delivery: 'auto' }),
      ev('message.queued', MAIN, { messageId: 'm2', text: 'second', delivery: 'auto' }),
    ]);
    expect(node(state, MAIN).outbox).toEqual([
      { messageId: 'm1', text: 'first', delivery: 'next_tool', queuedAt: queued.ts },
      expect.objectContaining({ messageId: 'm2' }),
    ]);
    state = reduce(state, ev('message.delivered', MAIN, { messageId: 'm1', via: 'pre_tool_context' }));
    expect(node(state, MAIN).outbox?.map((m) => m.messageId)).toEqual(['m2']);
    state = reduce(state, ev('message.dropped', MAIN, { messageId: 'm2', reason: 'cancelled' }));
    expect(node(state, MAIN).outbox).toEqual([]);
    // An unknown message id changes nothing.
    const same = reduce(state, ev('message.dropped', MAIN, { messageId: 'nope', reason: 'cancelled' }));
    expect(same.agents).toBe(state.agents);
  });
});

describe('capabilities', () => {
  it('attached main: answers questions and takes follow-ups; subagents do not take follow-ups', () => {
    expect(capabilitiesFor('attached', 'main')).toEqual(ATTACHED_CAPABILITIES);
    expect(ATTACHED_CAPABILITIES.answerQuestions).toBe(true);
    expect(ATTACHED_CAPABILITIES.followUp).toBe(true);
    expect(capabilitiesFor('attached', 'subagent')).toEqual({ ...ATTACHED_CAPABILITIES, followUp: false });
    expect(MANAGED_CAPABILITIES.answerQuestions).toBe(false);
    expect(capabilitiesFor('managed', 'subagent').followUp).toBe(false);
  });

  it('nodes get them from the reducer', () => {
    const ev = builder();
    const state = replay(withSubagent(ev));
    expect(node(state, MAIN).capabilities.followUp).toBe(true);
    expect(node(state, SUB).capabilities.followUp).toBe(false);
    expect(node(state, SUB).capabilities.answerQuestions).toBe(true);
  });
});

describe('attention.raised with a stable detector id (WP7)', () => {
  function stuck(createdAt: number): AttentionItem {
    return {
      id: `stuck:${MAIN}`,
      kind: 'stuck',
      severity: 'warning',
      agentKey: MAIN,
      title: 'main looks stuck',
      detail: 'No activity for 6 min while working.',
      createdAt,
      resolvedAt: null,
    };
  }

  it('drops a duplicate while the item is still open', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('attention.raised', MAIN, { item: stuck(1) }),
      ev('attention.raised', MAIN, { item: stuck(2) }),
    ]);
    expect(state.inbox).toHaveLength(1);
    expect(state.inbox[0]?.createdAt).toBe(1);
  });

  it('replaces a resolved item: a second episode is a new, open item', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('attention.raised', MAIN, { item: stuck(1) }),
      ev('attention.resolved', MAIN, { itemId: `stuck:${MAIN}` }),
      ev('attention.raised', MAIN, { item: stuck(2) }),
    ]);
    expect(state.inbox).toHaveLength(1);
    expect(state.inbox[0]).toMatchObject({ createdAt: 2, resolvedAt: null });
  });

  it('an answered request is not reopened by a repeated approval.requested', () => {
    const ev = builder();
    const state = replay([
      ...start(ev),
      ev('approval.requested', MAIN, { request: approval('r1') }),
      ev('approval.resolved', MAIN, {
        requestId: 'r1',
        outcome: 'allowed',
        by: 'user',
        policyRuleId: null,
        message: null,
      }),
      ev('approval.requested', MAIN, { request: approval('r1') }),
    ]);
    expect(item(state, approvalItemId('r1')).resolvedAt).not.toBeNull();
  });
});

describe('recorded permission fixtures', () => {
  it.each(['permission-allow.jsonl', 'permission-deny.jsonl'])(
    '%s: one approval item, open while the request waits, resolved by the end',
    (name) => {
      const events = fixtureEvents(name);
      const requested = events.find((e): e is EventOfType<'approval.requested'> => e.type === 'approval.requested');
      if (requested === undefined) throw new Error('fixture has no approval.requested');
      const id = approvalItemId(requested.request.requestId);
      let state = initialState();
      let sawOpen = false;
      for (const event of events) {
        state = reduce(state, event);
        if (event === requested) {
          const open = item(state, id);
          expect(open).toMatchObject({ kind: 'approval', severity: 'action_required', resolvedAt: null });
          expect(open.approval?.toolName).toBe('Bash');
          expect(node(state, requested.agentKey).status).toBe('waiting_approval');
          sawOpen = true;
        }
      }
      expect(sawOpen).toBe(true);
      expect(state.inbox.filter((i) => i.kind === 'approval')).toHaveLength(1);
      // No broker in the recording: the request was answered in the terminal; the turn end (Stop) closes the item.
      const turnEnd = events.find((e) => e.type === 'turn.ended' && e.ts >= requested.ts);
      expect(item(state, id).resolvedAt).toBe(turnEnd?.ts);
    },
  );

  it('permission-allow.jsonl plus a parallel Read and Grep while the Bash approval waits: still waiting_approval', () => {
    const events = fixtureEvents('permission-allow.jsonl');
    const at = events.findIndex((e) => e.type === 'approval.requested');
    const requested = events[at];
    if (requested === undefined || requested.type !== 'approval.requested') throw new Error('no approval.requested');
    const key = requested.agentKey;
    const base = { sessionId: requested.sessionId, agentKey: key, source: 'hook' as const };
    const parallel: HuddleEvent[] = [
      {
        ...base,
        id: 'par-1',
        type: 'tool.started',
        ts: requested.ts + 1,
        toolUseId: 'par-read',
        toolName: 'Read',
        summary: 'C:/p/a.ts',
        filePath: 'C:/p/a.ts',
        inputDigest: 'd1',
      },
      {
        ...base,
        id: 'par-2',
        type: 'tool.finished',
        ts: requested.ts + 2,
        toolUseId: 'par-read',
        toolName: 'Read',
        durationMs: 1,
      },
      {
        ...base,
        id: 'par-3',
        type: 'tool.started',
        ts: requested.ts + 3,
        toolUseId: 'par-grep',
        toolName: 'Grep',
        summary: 'x',
        filePath: null,
        inputDigest: 'd2',
      },
      {
        ...base,
        id: 'par-4',
        type: 'tool.failed',
        ts: requested.ts + 4,
        toolUseId: 'par-grep',
        toolName: 'Grep',
        error: 'no match',
        interrupted: false,
      },
    ];
    let state = initialState();
    for (const event of events.slice(0, at + 1)) state = reduce(state, event);
    for (const event of parallel) {
      state = reduce(state, event);
      expect(node(state, key).status, event.type).toBe('waiting_approval');
    }
    expect(item(state, approvalItemId(requested.request.requestId)).resolvedAt).toBeNull();
    // The Bash call itself finishing (answered in the terminal, no broker in the recording) clears the wait (M1).
    const rest = events.slice(at + 1);
    const finishedAt = rest.findIndex((e) => e.type === 'tool.finished');
    for (const event of rest.slice(0, finishedAt + 1)) state = reduce(state, event);
    expect(node(state, key).status).toBe('working');
    for (const event of rest.slice(finishedAt + 1)) state = reduce(state, event);
    expect(node(state, key).status).toBe(node(replay(events), key).status);
    expect(state.inbox).toEqual(replay(events).inbox);
  });

  it('an approval that never got an end does not hold a later turn in waiting_approval', () => {
    const ev = builder();
    // A PermissionRequest with no end (Huddle crash, a log without the broker, a terminal No), then a new turn.
    let state = replay([
      ...start(ev),
      ev('approval.requested', MAIN, { request: approval('stale') }),
      ev('prompt.submitted', MAIN, { text: 'next', promptId: null }),
      ev('tool.started', MAIN, {
        toolUseId: 'r1',
        toolName: 'Read',
        summary: 'a',
        filePath: 'C:/p/a',
        inputDigest: 'dr',
      }),
    ]);
    expect(node(state, MAIN).status).toBe('working');
    state = reduce(state, ev('tool.finished', MAIN, { toolUseId: 'r1', toolName: 'Read', durationMs: 1 }));
    expect(node(state, MAIN).status).toBe('working');
    // The stale item stays in the inbox as it was (only the turn end or its own end resolves it).
    expect(item(state, approvalItemId('stale')).resolvedAt).toBeNull();

    // A question in the new turn: a parallel Read finishing keeps waiting_answer, not the stale waiting_approval.
    state = reduce(
      state,
      ev('tool.started', MAIN, {
        toolUseId: 'q1',
        toolName: 'AskUserQuestion',
        summary: '',
        filePath: null,
        inputDigest: 'dq',
      }),
    );
    state = reduce(state, ev('question.asked', MAIN, { request: question('q1') }));
    state = reduce(
      state,
      ev('tool.started', MAIN, {
        toolUseId: 'r2',
        toolName: 'Read',
        summary: 'b',
        filePath: 'C:/p/b',
        inputDigest: 'db',
      }),
    );
    state = reduce(state, ev('tool.finished', MAIN, { toolUseId: 'r2', toolName: 'Read', durationMs: 1 }));
    expect(node(state, MAIN).status).toBe('waiting_answer');
    // Answered: working again, not the stale approval.
    state = reduce(state, ev('question.answered', MAIN, { requestId: 'q1', answers: { 'Which tone?': 'Plain' } }));
    expect(node(state, MAIN).status).toBe('working');
  });

  it('a parallel tool finishing while a question waits keeps waiting_answer; the question call ending clears it', () => {
    const ev = builder();
    let state = replay([
      ...start(ev),
      ev('tool.started', MAIN, {
        toolUseId: 'q1',
        toolName: 'AskUserQuestion',
        summary: '',
        filePath: null,
        inputDigest: 'dq',
      }),
      ev('question.asked', MAIN, { request: question('q1') }),
      ev('tool.started', MAIN, {
        toolUseId: 'r1',
        toolName: 'Read',
        summary: 'a',
        filePath: 'C:/p/a',
        inputDigest: 'dr',
      }),
    ]);
    expect(node(state, MAIN).status).toBe('waiting_answer');
    state = reduce(state, ev('tool.finished', MAIN, { toolUseId: 'r1', toolName: 'Read', durationMs: 1 }));
    expect(node(state, MAIN).status).toBe('waiting_answer');
    state = reduce(state, ev('tool.finished', MAIN, { toolUseId: 'q1', toolName: 'AskUserQuestion', durationMs: 9 }));
    expect(node(state, MAIN).status).toBe('working');
    expect(item(state, questionItemId('q1')).resolvedAt).not.toBeNull();
  });
});

describe('who paused (M4 runbook fix): pausedBy', () => {
  const OVER = `budget:session:${MAIN}:over`;
  const byHuddle = (e: HuddleEvent): HuddleEvent => ({ ...e, source: 'huddle' });

  it("a Huddle pause names its reason on every agent it paused; each agent's own resume clears only its own", () => {
    const ev = builder();
    let state = replay([
      ...withSubagent(ev),
      byHuddle(ev('control.applied', MAIN, { action: 'pause', detail: OVER })),
      byHuddle(ev('control.applied', SUB, { action: 'pause', detail: OVER })),
      ev('hold.started', SUB, { toolUseId: 't1', limitAt: 600_000 }),
    ]);
    expect(node(state, MAIN)).toMatchObject({ pausePending: true, pausedBy: OVER });
    expect(node(state, SUB)).toMatchObject({ status: 'paused', pausedBy: OVER });

    // The runbook case: Cancel pause on the root leaves the held subagent paused, and it still says why.
    state = reduce(state, ev('control.applied', MAIN, { action: 'resume', detail: null }));
    expect(node(state, MAIN)).toMatchObject({ pausePending: false, pausedBy: null });
    expect(node(state, SUB).pausedBy).toBe(OVER);

    state = reduce(state, ev('control.applied', SUB, { action: 'resume', detail: null }));
    state = reduce(state, ev('hold.ended', SUB, { toolUseId: 't1', why: 'resumed' }));
    expect(node(state, SUB)).toMatchObject({ status: 'working', pausedBy: null });
  });

  it('the hold ending by itself (hold limit) clears it; a user pause sets none', () => {
    const ev = builder();
    let state = replay([
      ...start(ev),
      byHuddle(ev('control.applied', MAIN, { action: 'pause', detail: OVER })),
      ev('hold.started', MAIN, { toolUseId: 't1', limitAt: 600_000 }),
      ev('hold.ended', MAIN, { toolUseId: 't1', why: 'hold_limit' }),
    ]);
    expect(node(state, MAIN).pausedBy).toBeNull();
    state = reduce(state, ev('control.applied', MAIN, { action: 'pause', detail: null }));
    expect(node(state, MAIN).pausePending).toBe(true);
    expect(node(state, MAIN).pausedBy ?? null).toBeNull();
  });

  it("the agent's end clears it; an agent never paused by the Huddle has no field at all", () => {
    const ev = builder();
    const state = replay([
      ...withSubagent(ev),
      byHuddle(ev('control.applied', SUB, { action: 'pause', detail: OVER })),
      ev('agent.stopped', SUB, { agentId: 'sub1', result: null }),
    ]);
    expect(node(state, SUB).pausedBy).toBeNull();
    expect('pausedBy' in node(state, MAIN)).toBe(false);
  });

  it('attention.resolved with reason dismissed marks the item dismissed; a plain resolve does not', () => {
    const ev = builder();
    const item1: AttentionItem = {
      id: 'stuck:a',
      kind: 'stuck',
      severity: 'warning',
      agentKey: MAIN,
      title: 't',
      detail: 'd',
      createdAt: 1,
      resolvedAt: null,
    };
    const state = replay([
      ...start(ev),
      ev('attention.raised', MAIN, { item: item1 }),
      ev('attention.raised', MAIN, { item: { ...item1, id: 'stuck:b' } }),
      ev('attention.resolved', MAIN, { itemId: 'stuck:a', reason: 'dismissed' }),
      ev('attention.resolved', MAIN, { itemId: 'stuck:b' }),
    ]);
    expect(item(state, 'stuck:a')).toMatchObject({ dismissed: true });
    expect(item(state, 'stuck:a').resolvedAt).not.toBeNull();
    expect('dismissed' in item(state, 'stuck:b')).toBe(false);
  });
});
