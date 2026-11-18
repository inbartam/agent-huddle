import { describe, expect, it } from 'vitest';
import {
  EMPTY_USAGE,
  type AgentCapabilities,
  type AgentNode,
  type ApprovalRequest,
  type AttentionItem,
  type ConnectionStatus,
  type QuestionRequest,
} from './model.js';
import {
  CONTROL_REASONS,
  questionIsAmbiguous,
  selectControls,
  whereMessageLands,
  type ControlName,
} from './selectors.js';

const T0 = 1_000_000;
const STARTED = T0 - 60_000; // the Huddle started a minute before the agent's requests
const KEY = 's1';
const ATTACHED: ConnectionStatus = { status: 'attached', message: null, startedAt: STARTED };

const MAIN_CAPS: AgentCapabilities = {
  approve: true,
  answerQuestions: true,
  message: 'queued',
  pause: true,
  stop: false,
  setModel: false,
  followUp: true,
};

function agent(partial: Partial<AgentNode> = {}): AgentNode {
  return {
    key: KEY,
    sessionId: 's1',
    agentId: null,
    parentKey: null,
    childKeys: [],
    kind: 'main',
    origin: 'attached',
    name: 'main',
    role: 'main',
    roleDescription: null,
    model: null,
    cwd: null,
    status: 'working',
    currentActivity: null,
    tasks: [],
    progress: {
      fraction: null,
      completedTasks: 0,
      totalTasks: 0,
      etaMs: null,
      etaLowMs: null,
      etaHighMs: null,
      basis: 'none',
      confidence: 'low',
    },
    usage: { ...EMPTY_USAGE },
    context: {
      usedTokens: null,
      windowTokens: null,
      usedPct: null,
      compactions: 0,
      lastCompactedAt: null,
      loadedInstructions: [],
      measuredBy: null,
    },
    handoff: null,
    capabilities: { ...MAIN_CAPS },
    toolCalls: 0,
    toolFailures: 0,
    startedAt: T0,
    endedAt: null,
    lastEventAt: T0,
    ...partial,
  };
}

function approvalItem(partial: Partial<ApprovalRequest> = {}, resolvedAt: number | null = null): AttentionItem {
  const request: ApprovalRequest = {
    requestId: 'r1',
    agentKey: KEY,
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    summary: 'npm test',
    receivedAt: T0,
    expiresAt: T0 + 600_000,
    channel: 'hook',
    ...partial,
  };
  return {
    id: 'approval:r1',
    kind: 'approval',
    severity: 'action_required',
    agentKey: KEY,
    title: 'main needs approval',
    detail: 'Bash: npm test',
    createdAt: request.receivedAt,
    resolvedAt,
    approval: request,
  };
}

function questionItem(
  multiSelect = false,
  options = 2,
  receivedAt = T0,
  resolvedAt: number | null = null,
): AttentionItem {
  const question: QuestionRequest = {
    requestId: 'q1',
    agentKey: KEY,
    questions: [
      {
        question: 'Which one?',
        options: Array.from({ length: options }, (_, i) => ({ label: `Option ${String(i + 1)}` })),
        multiSelect,
      },
    ],
    receivedAt,
  };
  return {
    id: 'question:q1',
    kind: 'question',
    severity: 'action_required',
    agentKey: KEY,
    title: 'main asked a question',
    detail: 'Which one?',
    createdAt: receivedAt,
    resolvedAt,
    question,
  };
}

const ALL: ControlName[] = [
  'approve',
  'deny',
  'passThrough',
  'answer',
  'message',
  'messageTurnEnd',
  'pause',
  'resume',
  'cancelMessage',
];

describe('selectControls', () => {
  it('enables approve, deny and pass-through for an open approval of a live, connected agent', () => {
    const c = selectControls(agent(), ATTACHED, STARTED, approvalItem());
    for (const name of ['approve', 'deny', 'passThrough'] as const)
      expect(c[name]).toEqual({ enabled: true, reason: null });
    expect(c.message.enabled).toBe(true);
    expect(c.messageTurnEnd.enabled).toBe(true);
    expect(c.pause.enabled).toBe(true);
  });

  const connections: [string, ConnectionStatus | undefined, string][] = [
    ['absent', undefined, CONTROL_REASONS.notConnected],
    ['needs_consent', { status: 'needs_consent', message: null }, CONTROL_REASONS.notConnected],
    ['port_in_use', { status: 'port_in_use', message: 'x' }, CONTROL_REASONS.portInUse],
    ['error', { status: 'error', message: 'x' }, CONTROL_REASONS.connectionError],
  ];
  it.each(connections)('connection %s disables every control', (_label, connection, reason) => {
    const c = selectControls(agent({ outbox: [], pausePending: true }), connection, STARTED, approvalItem());
    for (const name of ALL) expect(c[name]).toEqual({ enabled: false, reason });
  });

  it.each(['done', 'failed', 'stopped'] as const)('an agent that is %s has every control disabled', (status) => {
    const c = selectControls(agent({ status, endedAt: T0 + 1 }), ATTACHED, STARTED, approvalItem());
    for (const name of ALL) expect(c[name]).toEqual({ enabled: false, reason: CONTROL_REASONS.ended });
  });

  it('a capability turned off disables its controls with a reason', () => {
    const caps: AgentCapabilities = {
      ...MAIN_CAPS,
      approve: false,
      answerQuestions: false,
      message: 'none',
      pause: false,
    };
    expect(selectControls(agent({ capabilities: caps }), ATTACHED, STARTED, approvalItem()).approve.reason).toBe(
      CONTROL_REASONS.noApprove,
    );
    const c = selectControls(agent({ capabilities: caps }), ATTACHED, STARTED, questionItem());
    expect(c.answer.reason).toBe(CONTROL_REASONS.noAnswer);
    expect(c.message.reason).toBe(CONTROL_REASONS.noMessage);
    expect(c.messageTurnEnd.reason).toBe(CONTROL_REASONS.noMessage);
    expect(c.cancelMessage.reason).toBe(CONTROL_REASONS.noMessage);
    expect(c.pause.reason).toBe(CONTROL_REASONS.noPause);
    expect(c.resume.reason).toBe(CONTROL_REASONS.noPause);
  });

  it('a subagent cannot get an end-of-turn follow-up', () => {
    const sub = agent({ kind: 'subagent', capabilities: { ...MAIN_CAPS, followUp: false } });
    const c = selectControls(sub, ATTACHED, STARTED);
    expect(c.message.enabled).toBe(true);
    expect(c.messageTurnEnd).toEqual({ enabled: false, reason: CONTROL_REASONS.noFollowUp });
  });

  it('request controls need an open item of this agent', () => {
    expect(selectControls(agent(), ATTACHED, STARTED).approve.reason).toBe(CONTROL_REASONS.noApproval);
    expect(selectControls(agent(), ATTACHED, STARTED).answer.reason).toBe(CONTROL_REASONS.noQuestion);
    const other = { ...approvalItem(), agentKey: 'someone-else' };
    expect(selectControls(agent(), ATTACHED, STARTED, other).approve.reason).toBe(CONTROL_REASONS.noApproval);
    expect(selectControls(agent(), ATTACHED, STARTED, questionItem()).approve.reason).toBe(CONTROL_REASONS.noApproval);
    expect(selectControls(agent(), ATTACHED, STARTED, approvalItem({}, T0 + 5)).approve.reason).toBe(
      CONTROL_REASONS.answered,
    );
    expect(selectControls(agent(), ATTACHED, STARTED, questionItem(false, 2, T0, T0 + 5)).answer.reason).toBe(
      CONTROL_REASONS.answered,
    );
  });

  it('answers single-select, multi-select and typed-answer questions (S14 b)', () => {
    expect(selectControls(agent(), ATTACHED, STARTED, questionItem()).answer.enabled).toBe(true);
    expect(selectControls(agent(), ATTACHED, STARTED, questionItem(true)).answer.enabled).toBe(true);
    expect(selectControls(agent(), ATTACHED, STARTED, questionItem(false, 0)).answer.enabled).toBe(true);
  });

  it('a question whose shown options or questions repeat is answered in the terminal (masked or clipped words)', () => {
    const same = questionItem();
    const q = same.question;
    if (!q) throw new Error('no question');
    const twinOptions: AttentionItem = {
      ...same,
      question: { ...q, questions: q.questions.map((x) => ({ ...x, options: [{ label: 'A' }, { label: 'A' }] })) },
    };
    const first = q.questions[0];
    if (!first) throw new Error('no question');
    const twinQuestions: AttentionItem = { ...same, question: { ...q, questions: [first, { ...first }] } };
    for (const item of [twinOptions, twinQuestions]) {
      expect(questionIsAmbiguous(item.question ?? q)).toBe(true);
      const c = selectControls(agent(), ATTACHED, STARTED, item);
      expect(c.answer).toEqual({ enabled: false, reason: CONTROL_REASONS.ambiguousChoice });
      expect(c.passThrough.enabled).toBe(true);
    }
    expect(questionIsAmbiguous(q)).toBe(false);
  });

  it('a request received before this Huddle started cannot be answered here', () => {
    const late = STARTED + 1;
    expect(selectControls(agent(), ATTACHED, late, approvalItem({ receivedAt: STARTED })).approve.reason).toBe(
      CONTROL_REASONS.beforeRestart,
    );
    expect(selectControls(agent(), ATTACHED, late, questionItem(false, 2, STARTED)).answer.reason).toBe(
      CONTROL_REASONS.beforeRestart,
    );
    // Without a start time (replays, tests) nothing is judged stale.
    expect(selectControls(agent(), ATTACHED, undefined, approvalItem({ receivedAt: STARTED })).approve.enabled).toBe(
      true,
    );
  });

  it('passThrough ("answer in terminal") is enabled for an open question this Huddle holds, any question shape', () => {
    for (const item of [questionItem(), questionItem(true), questionItem(false, 0)]) {
      const c = selectControls(agent(), ATTACHED, STARTED, item);
      expect(c.passThrough).toEqual({ enabled: true, reason: null });
      // approve and deny stay approval-only.
      expect(c.approve.reason).toBe(CONTROL_REASONS.noApproval);
    }
  });

  it('passThrough for a question is disabled when it is closed, from before the restart, or not answerable here', () => {
    expect(selectControls(agent(), ATTACHED, STARTED, questionItem(false, 2, T0, T0 + 5)).passThrough).toEqual({
      enabled: false,
      reason: CONTROL_REASONS.answered,
    });
    expect(selectControls(agent(), ATTACHED, STARTED + 1, questionItem(true, 2, STARTED)).passThrough.reason).toBe(
      CONTROL_REASONS.beforeRestart,
    );
    const noAnswer = agent({ capabilities: { ...MAIN_CAPS, answerQuestions: false } });
    expect(selectControls(noAnswer, ATTACHED, STARTED, questionItem()).passThrough.reason).toBe(
      CONTROL_REASONS.noAnswer,
    );
    // A question of another agent is not this agent's item.
    const other = { ...questionItem(), agentKey: 'someone-else' };
    expect(selectControls(agent(), ATTACHED, STARTED, other).passThrough.reason).toBe(CONTROL_REASONS.noApproval);
    expect(
      selectControls(agent({ status: 'done', endedAt: T0 + 1 }), ATTACHED, STARTED, questionItem()).passThrough.reason,
    ).toBe(CONTROL_REASONS.ended);
    expect(selectControls(agent(), undefined, STARTED, questionItem()).passThrough.reason).toBe(
      CONTROL_REASONS.notConnected,
    );
  });

  it('pause and resume follow the hold and the pending pause', () => {
    const running = selectControls(agent(), ATTACHED, STARTED);
    expect(running.pause.enabled).toBe(true);
    expect(running.resume.reason).toBe(CONTROL_REASONS.notPaused);

    const pending = selectControls(agent({ pausePending: true }), ATTACHED, STARTED);
    expect(pending.pause.reason).toBe(CONTROL_REASONS.pausePending);
    expect(pending.resume.enabled).toBe(true);

    const held = agent({ status: 'paused', hold: { toolUseId: 't1', since: T0, limitAt: T0 + 595_000 } });
    const h = selectControls(held, ATTACHED, STARTED);
    expect(h.pause.reason).toBe(CONTROL_REASONS.alreadyPaused);
    expect(h.resume.enabled).toBe(true);

    // A hold from an earlier Huddle process: its connection is gone, so it cannot be resumed, but a new pause can be asked.
    const old = selectControls(held, ATTACHED, T0 + 1);
    expect(old.resume.reason).toBe(CONTROL_REASONS.holdBeforeRestart);
    expect(old.pause.enabled).toBe(true);
  });

  it('cancel needs a queued message', () => {
    expect(selectControls(agent(), ATTACHED, STARTED).cancelMessage.reason).toBe(CONTROL_REASONS.noQueued);
    const queued = agent({ outbox: [{ messageId: 'm1', text: 'hi', delivery: 'auto', queuedAt: T0 }] });
    expect(selectControls(queued, ATTACHED, STARTED).cancelMessage.enabled).toBe(true);
  });
});

describe('whereMessageLands', () => {
  it('main agent: by mode', () => {
    expect(whereMessageLands(agent(), 'next_tool')).toBe('after the next tool call');
    expect(whereMessageLands(agent(), 'turn_end')).toBe('when this turn ends');
    expect(whereMessageLands(agent(), 'auto')).toBe('after the next tool call or when this turn ends');
  });

  it('a subagent always lands at its next tool call', () => {
    const sub = agent({ kind: 'subagent', capabilities: { ...MAIN_CAPS, followUp: false } });
    for (const mode of ['auto', 'next_tool', 'turn_end'] as const) {
      expect(whereMessageLands(sub, mode)).toBe('after the next tool call');
    }
  });

  it('an idle agent gets it when it next works; a managed one at once', () => {
    expect(whereMessageLands(agent({ status: 'idle' }), 'auto')).toBe('agent is idle: when it next works');
    expect(whereMessageLands(agent({ capabilities: { ...MAIN_CAPS, message: 'live' } }), 'turn_end')).toBe('at once');
  });
});
