/**
 * The agent-team fixture (M6 item 3, S20) as renderer test state, built with the shared model only (the renderer
 * cannot run the core's reducer). It copies what the reducer makes of `fixtures/agent-team.jsonl`, as recorded in
 * `packages/core/src/state/__snapshots__/tree/agent-team.json`: a lead (main, idle) with two haiku teammates, alpha and
 * beta (idle after TeammateIdle, endedAt null, heuristic link), and one finished general-purpose subagent. The two
 * `teammate.idle` events are the normalizer's (`packages/core/src/normalize/__snapshots__/hooks/agent-team.json`).
 * Keys, names, models, statuses and times are the snapshot's; capabilities are the attached ones for each kind.
 */
import type { AgentCapabilities, AgentKey, AgentNode, HuddleEvent, HuddleState } from '@huddle/shared';
import { agent } from './fixture.js';

export const TEAM_SESSION = '00000000-0000-4000-8000-000000000001';

export const TEAM_KEYS = {
  lead: TEAM_SESSION,
  alpha: `${TEAM_SESSION}::aalpha-0000000000000001`,
  beta: `${TEAM_SESSION}::abeta-0000000000000002`,
  helper: `${TEAM_SESSION}::a0000000000000003`,
} as const;

/** The snapshot's lastActivityAt: the time the tests look at the tree. */
export const TEAM_NOW = 1794832235544;

/** The attached capabilities (`capabilitiesFor('attached', kind)`): follow-ups for the main agent only. */
function attached(kind: AgentNode['kind']): AgentCapabilities {
  return {
    approve: true,
    answerQuestions: true,
    message: 'queued',
    pause: true,
    stop: false,
    setModel: false,
    followUp: kind === 'main',
  };
}

const common = { sessionId: TEAM_SESSION, origin: 'attached' as const, cwd: null };

export function teamState(overrides: Partial<Record<keyof typeof TEAM_KEYS, Partial<AgentNode>>> = {}): HuddleState {
  const agents: Record<AgentKey, AgentNode> = {
    [TEAM_KEYS.lead]: agent({
      ...common,
      key: TEAM_KEYS.lead,
      name: 'main',
      kind: 'main',
      role: 'main',
      status: 'idle',
      childKeys: [TEAM_KEYS.alpha, TEAM_KEYS.beta, TEAM_KEYS.helper],
      capabilities: attached('main'),
      startedAt: 1794832221699,
      lastEventAt: TEAM_NOW,
      ...overrides.lead,
    }),
    [TEAM_KEYS.alpha]: agent({
      ...common,
      key: TEAM_KEYS.alpha,
      agentId: 'aalpha-0000000000000001',
      parentKey: TEAM_KEYS.lead,
      name: 'alpha',
      kind: 'teammate',
      role: 'alpha',
      model: 'haiku',
      status: 'idle',
      capabilities: attached('teammate'),
      handoff: { toolUseId: 'toolu-alpha', title: null, brief: null, result: null, link: 'heuristic' },
      startedAt: 1794832226285,
      lastEventAt: 1794832228772,
      ...overrides.alpha,
    }),
    [TEAM_KEYS.beta]: agent({
      ...common,
      key: TEAM_KEYS.beta,
      agentId: 'abeta-0000000000000002',
      parentKey: TEAM_KEYS.lead,
      name: 'beta',
      kind: 'teammate',
      role: 'beta',
      model: 'haiku',
      status: 'idle',
      capabilities: attached('teammate'),
      handoff: { toolUseId: 'toolu-beta', title: null, brief: null, result: null, link: 'heuristic' },
      startedAt: 1794832227301,
      lastEventAt: 1794832229520,
      ...overrides.beta,
    }),
    [TEAM_KEYS.helper]: agent({
      ...common,
      key: TEAM_KEYS.helper,
      agentId: 'a0000000000000003',
      parentKey: TEAM_KEYS.lead,
      name: '(scrubbed text)',
      kind: 'subagent',
      role: 'general-purpose',
      status: 'done',
      capabilities: attached('subagent'),
      handoff: { toolUseId: 'toolu-helper', title: null, brief: null, result: null, link: 'heuristic' },
      startedAt: 1794832228424,
      endedAt: 1794832229640,
      lastEventAt: 1794832229640,
      ...overrides.helper,
    }),
  };
  return { agents, rootKeys: [TEAM_KEYS.lead], inbox: [], rateLimits: null };
}

/** alpha's own events as `getEvents` returns them (oldest first): its TeammateIdle. */
export const ALPHA_IDLE: HuddleEvent = {
  id: 'evt-0020',
  type: 'teammate.idle',
  ts: 1794832228772,
  sessionId: TEAM_SESSION,
  agentKey: TEAM_KEYS.alpha,
  source: 'hook',
  agentId: 'aalpha-0000000000000001',
  teammateName: 'alpha',
  teamName: 'session-00000000',
};
