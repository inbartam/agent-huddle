/**
 * M3 renderer fixtures: an attached, connected session with one of each inbox item (approval, single-select question,
 * multiSelect question, stuck, loop, conflict), a paused agent with a hold, one with a pause pending, and a main agent
 * with two queued messages. Shaped like what core's reducer produces (WP3), built with the shared model only.
 */
import type {
  AgentCapabilities,
  AgentNode,
  ApprovalRequest,
  AttentionItem,
  ConnectionStatus,
  HuddleState,
  QuestionRequest,
} from '@huddle/shared';
import { agentKey } from '@huddle/shared';
import { agent, SESSION, T0, XSS } from './fixture.js';

export const NOW = T0 + 60_000;
export const STARTED_AT = T0 - 60_000;

export const IK = {
  main: agentKey(SESSION),
  tester: agentKey(SESSION, 'test-1'),
  asker: agentKey(SESSION, 'ask-1'),
  paused: agentKey(SESSION, 'build-1'),
  pending: agentKey(SESSION, 'e2e-1'),
};

export const ATTACHED: AgentCapabilities = {
  approve: true,
  answerQuestions: true,
  message: 'queued',
  pause: true,
  stop: false,
  setModel: false,
  followUp: false,
};
export const MAIN_CAPS: AgentCapabilities = { ...ATTACHED, followUp: true };

export const CONNECTED: ConnectionStatus = { status: 'attached', message: null, startedAt: STARTED_AT };

export const APPROVAL: ApprovalRequest = {
  requestId: 'req-1',
  agentKey: IK.tester,
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  summary: 'npm test -- parser',
  receivedAt: T0,
  expiresAt: T0 + 600_000,
  channel: 'hook',
};

export const SINGLE: QuestionRequest = {
  requestId: 'q-1',
  agentKey: IK.asker,
  receivedAt: T0 + 10_000,
  expiresAt: T0 + 610_000,
  questions: [
    {
      question: 'Which tone should the notes use?',
      header: 'Tone',
      multiSelect: false,
      options: [{ label: 'Plain', description: 'Short sentences' }, { label: 'Friendly' }, { label: 'Technical' }],
    },
  ],
};

export const MULTI: QuestionRequest = {
  requestId: 'q-2',
  agentKey: IK.main,
  receivedAt: T0 + 20_000,
  questions: [
    {
      question: 'Which sections?',
      header: 'Sections',
      multiSelect: true,
      options: [{ label: 'Features' }, { label: 'Fixes' }],
    },
  ],
};

export function approvalItem(extra: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'approval:req-1',
    kind: 'approval',
    severity: 'action_required',
    agentKey: IK.tester,
    title: 'Tests needs approval',
    detail: 'Bash: npm test -- parser',
    createdAt: APPROVAL.receivedAt,
    resolvedAt: null,
    approval: APPROVAL,
    ...extra,
  };
}

export function questionItem(request: QuestionRequest = SINGLE, extra: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `question:${request.requestId}`,
    kind: 'question',
    severity: 'action_required',
    agentKey: request.agentKey,
    title: 'asked a question',
    detail: request.questions[0]?.question ?? '',
    createdAt: request.receivedAt,
    resolvedAt: null,
    question: request,
    ...extra,
  };
}

export const STUCK: AttentionItem = {
  id: `stuck:${IK.pending}`,
  kind: 'stuck',
  severity: 'warning',
  agentKey: IK.pending,
  title: 'e2e looks stuck',
  detail: 'No activity for 6 min while working.',
  createdAt: T0 + 5_000,
  resolvedAt: null,
};

export const CONFLICT: AttentionItem = {
  id: 'conflict:C:\\p:C:\\p\\src\\a.ts',
  kind: 'file_conflict',
  severity: 'warning',
  agentKey: IK.tester,
  title: 'File conflict on src\\a.ts',
  detail: 'Two agents edited src\\a.ts in the last 10 min.',
  createdAt: T0 + 6_000,
  resolvedAt: null,
  relatedAgentKeys: [IK.tester, IK.asker],
};

export interface InteractOptions {
  connection?: ConnectionStatus | undefined;
  inbox?: AttentionItem[];
  agents?: Partial<Record<keyof typeof IK, Partial<AgentNode>>>;
}

export function interactState(opts: InteractOptions = {}): HuddleState {
  const o = opts.agents ?? {};
  const nodes: AgentNode[] = [
    agent({
      key: IK.main,
      name: 'Release notes',
      kind: 'main',
      role: 'main',
      childKeys: [IK.tester, IK.asker, IK.paused, IK.pending],
      capabilities: MAIN_CAPS,
      status: 'waiting_answer',
      lastEventAt: T0 + 20_000,
      outbox: [
        { messageId: 'm-1', text: 'Keep it under one page.', delivery: 'next_tool', queuedAt: T0 + 1_000 },
        { messageId: 'm-2', text: 'List the open issues too.', delivery: 'turn_end', queuedAt: T0 + 2_000 },
      ],
      ...o.main,
    }),
    agent({
      key: IK.tester,
      agentId: 'test-1',
      parentKey: IK.main,
      name: 'Tests',
      role: 'test-engineer',
      capabilities: ATTACHED,
      status: 'waiting_approval',
      lastEventAt: T0,
      ...o.tester,
    }),
    agent({
      key: IK.asker,
      agentId: 'ask-1',
      parentKey: IK.main,
      name: 'Summary',
      role: 'docs-writer',
      capabilities: ATTACHED,
      status: 'waiting_answer',
      lastEventAt: T0 + 10_000,
      ...o.asker,
    }),
    agent({
      key: IK.paused,
      agentId: 'build-1',
      parentKey: IK.main,
      name: 'Changelog',
      role: 'general-purpose',
      capabilities: ATTACHED,
      status: 'paused',
      lastEventAt: T0,
      hold: { toolUseId: 'toolu_1', since: T0, limitAt: NOW + 9 * 60_000 + 42_000 },
      ...o.paused,
    }),
    agent({
      key: IK.pending,
      agentId: 'e2e-1',
      parentKey: IK.main,
      name: 'e2e',
      role: 'test-engineer',
      capabilities: ATTACHED,
      status: 'working',
      lastEventAt: T0,
      pausePending: true,
      ...o.pending,
    }),
  ];
  const state: HuddleState = {
    agents: Object.fromEntries(nodes.map((n) => [n.key, n])),
    rootKeys: [IK.main],
    inbox: opts.inbox ?? [approvalItem(), questionItem(), questionItem(MULTI), STUCK, CONFLICT],
    rateLimits: null,
  };
  if (!('connection' in opts)) state.connection = CONNECTED;
  else if (opts.connection !== undefined) state.connection = opts.connection;
  return state;
}

/** Agent text that must stay text. */
export const HOSTILE = XSS;
