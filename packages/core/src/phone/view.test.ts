/**
 * selectPhoneView (shared) over states replayed from recorded fixtures, and the core's second masking pass. What a
 * phone sees: names, roles, status, progress, open items with their masked one-line summary; never tool input, a
 * folder path, a prompt or history.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTROL_REASONS,
  PHONE_OPTIONS_MAX,
  phoneViewAgent,
  phoneViewHasApproval,
  phoneViewQuestion,
  selectPhoneView,
  type AttentionItem,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';
import { replay, toHuddleState } from '../state/reduce.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { maskPhoneView } from './view.js';

function stateUntil(name: string, stop: (e: HuddleEvent) => boolean): { state: HuddleState; at: number } {
  const events = fixtureEvents(name);
  const end = events.findIndex(stop);
  const taken = end === -1 ? events : events.slice(0, end + 1);
  return { state: toHuddleState(replay(taken)), at: taken[taken.length - 1]?.ts ?? 0 };
}

describe('selectPhoneView', () => {
  it('shows a held approval with its summary and tool name, and nothing of its input, folder or prompt', () => {
    const { state, at } = stateUntil('permission-allow.jsonl', (e) => e.type === 'approval.requested');
    const view = selectPhoneView(state, at);
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0]).toMatchObject({ rootKey: 'session-1', title: 'project session', project: 'project' });
    expect(view.sessions[0]?.agents[0]).toMatchObject({ key: 'session-1', depth: 0, status: 'waiting_approval' });
    const approval = view.inbox[0];
    expect(approval).toMatchObject({ kind: 'approval', toolName: 'Bash', summary: 'npm view zod version' });
    if (approval?.kind !== 'approval') throw new Error('no approval');
    expect(phoneViewHasApproval(view, approval.requestId)).toBe(true);
    const text = JSON.stringify(view);
    for (const leak of ['(scrubbed text)', 'C:/Users', 'toolInput', 'description', 'permission', 'cwd', 'prompt']) {
      expect(text).not.toContain(leak);
    }
    expect(JSON.parse(text)).toEqual(view);
  });

  it('drops the approval once it is resolved, and an expired one', () => {
    const resolved = stateUntil('permission-allow.jsonl', (e) => e.type === 'approval.resolved');
    expect(selectPhoneView(resolved.state, resolved.at).inbox.filter((i) => i.kind === 'approval')).toEqual([]);
    const held = stateUntil('permission-allow.jsonl', (e) => e.type === 'approval.requested');
    const item = held.state.inbox[0];
    if (item?.approval === undefined) throw new Error('no approval');
    const expiring: HuddleState = {
      ...held.state,
      inbox: [{ ...item, approval: { ...item.approval, expiresAt: held.at + 10 } }],
    };
    expect(selectPhoneView(expiring, held.at + 9).inbox).toHaveLength(1);
    expect(selectPhoneView(expiring, held.at + 10).inbox).toHaveLength(0);
  });

  it('lists subagents under their parent with progress, and leaves out ended and stale sessions', () => {
    const events = fixtureEvents('nested-subagents.jsonl');
    const mid = events.findIndex((e) => e.type === 'agent.stopped');
    const partial = toHuddleState(replay(events.slice(0, mid + 1)));
    const at = events[mid]?.ts ?? 0;
    const view = selectPhoneView(partial, at);
    const agents = view.sessions[0]?.agents ?? [];
    expect(agents.length).toBeGreaterThan(1);
    expect(agents[0]?.depth).toBe(0);
    expect(agents.slice(1).every((a) => a.depth >= 1 && a.parentKey !== null)).toBe(true);
    for (const a of agents) {
      expect(Object.keys(a).sort()).toEqual([
        'activity',
        'controls',
        'depth',
        'key',
        'messageLands',
        'name',
        'parentKey',
        'progress',
        'role',
        'status',
      ]);
      if (a.progress.fraction !== null) expect(a.progress.fraction).toBeGreaterThanOrEqual(0);
    }
    // Stale: nothing heard since the Huddle started.
    expect(selectPhoneView(partial, at, { huddleStartedAt: at + 1 }).sessions).toEqual([]);
    // Ended.
    const done = toHuddleState(replay(events));
    const root = done.agents['session-1'];
    if (root?.endedAt !== null) expect(selectPhoneView(done, at).sessions).toEqual([]);
  });

  it('gives each agent what it is doing now and its phone controls from its capabilities, with reasons', () => {
    const { state, at } = stateUntil('permission-allow.jsonl', (e) => e.type === 'approval.requested');
    const view = selectPhoneView(state, at);
    const main = phoneViewAgent(view, 'session-1');
    if (main === null) throw new Error('no main agent');
    // An attached session (hooks): message and pause from its capabilities; stop only for runs Huddle launched.
    expect(main.controls.message).toEqual({ enabled: true, reason: null });
    expect(main.controls.pause).toEqual({ enabled: true, reason: null });
    expect(main.controls.resume).toEqual({ enabled: false, reason: CONTROL_REASONS.notPaused });
    expect(main.controls.stop.enabled).toBe(false);
    expect(main.controls.stop.reason).not.toBeNull();
    expect(main.messageLands).not.toBeNull();
    // Capabilities say no: every control is off, with the desktop's words.
    const root = state.agents['session-1'];
    if (root === undefined) throw new Error('no root');
    const locked: HuddleState = {
      ...state,
      agents: {
        ...state.agents,
        'session-1': { ...root, capabilities: { ...root.capabilities, message: 'none', pause: false, stop: false } },
      },
    };
    const off = phoneViewAgent(selectPhoneView(locked, at), 'session-1');
    expect(off?.controls.message).toEqual({ enabled: false, reason: CONTROL_REASONS.noMessage });
    expect(off?.controls.pause).toEqual({ enabled: false, reason: CONTROL_REASONS.noPause });
    expect(off?.messageLands).toBeNull();
    // What it is doing now: a running tool's one line, whitespace collapsed and clipped.
    const busy: HuddleState = {
      ...state,
      agents: {
        ...state.agents,
        'session-1': {
          ...root,
          currentActivity: `Bash:  npm
 test ${'x'.repeat(400)}`,
        },
      },
    };
    const activity = phoneViewAgent(selectPhoneView(busy, at), 'session-1')?.activity ?? '';
    expect(activity.startsWith('Bash: npm test x')).toBe(true);
    expect(activity.length).toBeLessThanOrEqual(300);
  });

  it('carries a held question with its options and the answer control; a cut-short question is for the terminal', () => {
    const { state, at } = stateUntil('permission-allow.jsonl', (e) => e.type === 'approval.requested');
    const question: AttentionItem = {
      id: 'question:tu-q',
      kind: 'question',
      severity: 'action_required',
      agentKey: 'session-1',
      title: 'Which color?',
      detail: '',
      createdAt: at,
      resolvedAt: null,
      question: {
        requestId: 'tu-q',
        agentKey: 'session-1',
        receivedAt: at,
        expiresAt: at + 60_000,
        questions: [
          {
            question: 'Which color?',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
          },
        ],
      },
    };
    const req = question.question;
    if (req === undefined) throw new Error('no question');
    const view = selectPhoneView({ ...state, inbox: [...state.inbox, question] }, at);
    const q = phoneViewQuestion(view, 'tu-q');
    expect(q).toEqual({
      kind: 'question',
      id: 'question:tu-q',
      requestId: 'tu-q',
      agentKey: 'session-1',
      agentName: 'project session',
      title: 'Which color?',
      questions: [
        {
          question: 'Which color?',
          header: 'Color',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'warm' },
            { label: 'Blue', description: null },
          ],
        },
      ],
      answer: { enabled: true, reason: null },
      createdAt: at,
      expiresAt: at + 60_000,
    });
    // Approvals come first, then questions, then the rest.
    expect(view.inbox.map((i) => i.kind).slice(0, 2)).toEqual(['approval', 'question']);
    // Two options that look the same: the desktop's rule sends it to the terminal.
    const twin: AttentionItem = {
      ...question,
      question: {
        ...req,
        questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }, { label: 'A' }] }],
      },
    };
    expect(phoneViewQuestion(selectPhoneView({ ...state, inbox: [twin] }, at), 'tu-q')?.answer).toEqual({
      enabled: false,
      reason: CONTROL_REASONS.ambiguousChoice,
    });
    const many: AttentionItem = {
      ...question,
      question: {
        ...req,
        questions: [
          {
            question: 'Which?',
            multiSelect: true,
            options: Array.from({ length: PHONE_OPTIONS_MAX + 1 }, (_, i) => ({ label: `o${String(i)}` })),
          },
        ],
      },
    };
    const cut = phoneViewQuestion(selectPhoneView({ ...state, inbox: [many] }, at), 'tu-q');
    expect(cut?.questions[0]?.options).toHaveLength(PHONE_OPTIONS_MAX);
    expect(cut?.answer.enabled).toBe(false);
  });

  it('the core masks every free-text field again and leaves identifiers alone', () => {
    const { state, at } = stateUntil('permission-allow.jsonl', (e) => e.type === 'approval.requested');
    const view = selectPhoneView(state, at);
    const masked = maskPhoneView(view, (t) => `<${t}>`);
    const a = masked.inbox[0];
    if (a?.kind !== 'approval' || view.inbox[0]?.kind !== 'approval') throw new Error('no approval');
    expect(a.summary).toBe('<npm view zod version>');
    expect(a.requestId).toBe(view.inbox[0].requestId);
    expect(masked.sessions[0]?.title).toBe('<project session>');
    expect(masked.sessions[0]?.rootKey).toBe('session-1');
  });
});
