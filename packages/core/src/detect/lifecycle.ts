/**
 * The detectors' own, small view of each agent's life (F21): is it working, waiting on the user, idle or ended, when
 * did it last show a sign of life, and which tool calls are open. Pure fold over HuddleEvents; no clock.
 *
 * It mirrors the reducer's status semantics (packages/core/src/state/reduce.ts) where they matter for "stuck", with
 * two deliberate differences, both to avoid false alarms:
 *  - A main agent's turn end makes it idle even when background subagents are still running (S0: Stop carries
 *    background_tasks; the reducer then shows the main agent as working). Those subagents send their own events and are
 *    watched themselves; the main agent is waiting on them, not stuck.
 *  - A late tool.finished / tool.failed does not wake an idle agent. Only a prompt, a subagent start or a tool start
 *    starts work. A stray PostToolUse after Stop would otherwise read as five silent minutes of "work".
 *
 * Waiting on the user (approval, question, pause hold) is tracked by request id, so one answered request does not
 * hide another still open. A missed resolution is cleared at the next prompt or turn end (fail toward silence).
 */
import type { AgentKey, HuddleEvent } from '@huddle/shared';
import { without } from './common.js';

export type Phase = 'idle' | 'working' | 'ended';

export interface TrackedAgent {
  sessionId: string;
  phase: Phase;
  /** Event ts of the agent's latest sign of life (see `isLiveness`), or of the moment it started waiting or working. */
  lastSeenTs: number;
  /** Id of that event. Deterministic ids of time-based raises derive from it. */
  lastSeenEventId: string;
  /** Open tool calls by toolUseId: tool name. */
  openTools: Record<string, string>;
  /** Open tool calls that carried no toolUseId: tool names, oldest first. */
  anonTools: string[];
  /** Open waits on the user: request ids (approvals, questions) and `hold:<toolUseId>` for pause holds. */
  waits: Record<string, true>;
  /** "Bash: npm test" of the latest tool start, for the stuck item's detail. */
  lastActivity: string | null;
}

export interface LifeState {
  agents: Record<AgentKey, TrackedAgent>;
  /** Ended agents, oldest first; the oldest are forgotten past MAX_ENDED_AGENTS. */
  endedOrder: AgentKey[];
  /** Latest sign of life of any agent per session (for agents waiting on a foreground subagent). */
  sessionLastSeen: Record<string, number>;
  /** Working directory per session, from session.started; null when not known. */
  sessionCwd: Record<string, string | null>;
}

/** Ended agents remembered (so late telemetry does not revive them). Past this the oldest are forgotten. */
export const MAX_ENDED_AGENTS = 2000;

/** Tool names that start a subagent and stay open while a foreground subagent runs. */
export const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

export function emptyLife(): LifeState {
  return { agents: {}, endedOrder: [], sessionLastSeen: {}, sessionCwd: {} };
}

export interface LifeStep {
  state: LifeState;
  /** Agents this event ended. */
  ended: AgentKey[];
}

/**
 * A sign of life from the agent itself: anything Claude Code reports (hook, telemetry, stream, status line), but not
 * the Huddle's own derived events and not the user's actions in the Huddle.
 */
export function isLiveness(event: HuddleEvent): boolean {
  return event.source !== 'huddle' && event.source !== 'user';
}

function fresh(event: HuddleEvent, phase: Phase): TrackedAgent {
  return {
    sessionId: event.sessionId,
    phase,
    lastSeenTs: event.ts,
    lastSeenEventId: event.id,
    openTools: {},
    anonTools: [],
    waits: {},
    lastActivity: null,
  };
}

function seen(agent: TrackedAgent, event: HuddleEvent): TrackedAgent {
  return { ...agent, lastSeenTs: event.ts, lastSeenEventId: event.id };
}

function idle(agent: TrackedAgent): TrackedAgent {
  return { ...agent, phase: 'idle', openTools: {}, anonTools: [], waits: {} };
}

function working(agent: TrackedAgent): TrackedAgent {
  return agent.phase === 'working' ? agent : { ...agent, phase: 'working', openTools: {}, anonTools: [], waits: {} };
}

function closeTool(agent: TrackedAgent, toolUseId: string | null, toolName: string): TrackedAgent {
  if (toolUseId !== null) {
    return toolUseId in agent.openTools ? { ...agent, openTools: without(agent.openTools, toolUseId) } : agent;
  }
  const index = agent.anonTools.indexOf(toolName);
  if (index < 0) return agent;
  return { ...agent, anonTools: agent.anonTools.filter((_, i) => i !== index) };
}

function addWait(agent: TrackedAgent, id: string): TrackedAgent {
  return { ...agent, waits: { ...agent.waits, [id]: true } };
}

function dropWait(agent: TrackedAgent, id: string): TrackedAgent {
  return id in agent.waits ? { ...agent, waits: without(agent.waits, id) } : agent;
}

function holdWaitId(toolUseId: string | null): string {
  return `hold:${toolUseId ?? ''}`;
}

/** What the event does to the agent it is about, or undefined when it changes nothing but liveness. */
function transition(agent: TrackedAgent | undefined, event: HuddleEvent): TrackedAgent | undefined {
  const ended = agent?.phase === 'ended';
  switch (event.type) {
    case 'session.started': {
      // Startup, resume, clear: the main agent waits for a prompt. Compaction happens mid-turn: keep the phase.
      if (agent === undefined || ended) return fresh(event, 'idle');
      return event.startKind === 'compact' ? agent : idle(agent);
    }
    case 'prompt.submitted':
    case 'agent.started':
      // A new turn (or a resumed subagent): reopens an ended agent like the reducer does.
      return working(agent === undefined || ended ? fresh(event, 'working') : agent);
    case 'tool.started': {
      if (ended) return agent;
      // Untracked: the Huddle started mid-turn; the reducer treats a tool start as work too.
      const base = working(agent ?? fresh(event, 'working'));
      const activity =
        event.summary === '' || event.summary === event.toolName
          ? event.toolName
          : `${event.toolName}: ${event.summary}`;
      return event.toolUseId !== null
        ? { ...base, openTools: { ...base.openTools, [event.toolUseId]: event.toolName }, lastActivity: activity }
        : { ...base, anonTools: [...base.anonTools, event.toolName], lastActivity: activity };
    }
    case 'tool.finished':
    case 'tool.failed':
      if (agent === undefined || ended) return agent;
      return closeTool(agent, event.toolUseId, event.toolName);
    case 'approval.requested':
      if (ended) return agent;
      return addWait(working(agent ?? fresh(event, 'working')), event.request.requestId);
    case 'question.asked':
      if (ended) return agent;
      return addWait(working(agent ?? fresh(event, 'working')), event.request.requestId);
    case 'hold.started':
      if (ended) return agent;
      return addWait(working(agent ?? fresh(event, 'working')), holdWaitId(event.toolUseId));
    case 'approval.resolved':
    case 'question.answered':
    case 'question.closed':
      return agent === undefined || ended ? agent : dropWait(agent, event.requestId);
    case 'hold.ended':
      return agent === undefined || ended ? agent : dropWait(agent, holdWaitId(event.toolUseId));
    case 'turn.ended':
    case 'turn.failed':
      return agent === undefined || ended ? agent : idle(agent);
    case 'agent.stopped':
      return agent === undefined ? agent : { ...idle(agent), phase: 'ended' };
    default:
      return agent;
  }
}

function markEnded(state: LifeState, keys: AgentKey[]): LifeState {
  if (keys.length === 0) return state;
  let order = [...state.endedOrder.filter((k) => !keys.includes(k)), ...keys];
  let agents = state.agents;
  let { sessionLastSeen, sessionCwd } = state;
  if (order.length > MAX_ENDED_AGENTS) {
    const forget = order.slice(0, order.length - MAX_ENDED_AGENTS);
    order = order.slice(order.length - MAX_ENDED_AGENTS);
    agents = { ...agents };
    const sessions = new Set<string>();
    for (const key of forget) {
      const agent = agents[key];
      if (agent?.phase !== 'ended') continue;
      sessions.add(agent.sessionId);
      agents = without(agents, key);
    }
    // A session none of whose agents is remembered any more is forgotten too, so these maps stay bounded like the
    // agents. If it comes back (resume), session.started and its next events fill them again.
    const live = new Set(Object.values(agents).map((a) => a.sessionId));
    for (const sessionId of sessions) {
      if (live.has(sessionId)) continue;
      sessionLastSeen = without(sessionLastSeen, sessionId);
      sessionCwd = without(sessionCwd, sessionId);
    }
  }
  return { ...state, agents, endedOrder: order, sessionLastSeen, sessionCwd };
}

export function stepLife(state: LifeState, event: HuddleEvent): LifeStep {
  // The Huddle's own attention events say nothing about any agent.
  if (event.type === 'attention.raised' || event.type === 'attention.resolved') return { state, ended: [] };

  let next = state;
  if (event.type === 'session.started') {
    next = {
      ...next,
      sessionCwd: { ...next.sessionCwd, [event.sessionId]: event.cwd ?? next.sessionCwd[event.sessionId] ?? null },
    };
  }

  if (event.type === 'session.ended') {
    // The session's process is gone: every agent of it has ended.
    const ended: AgentKey[] = [];
    const agents = { ...next.agents };
    for (const [key, agent] of Object.entries(agents)) {
      if (agent.sessionId !== event.sessionId || agent.phase === 'ended') continue;
      agents[key] = { ...idle(agent), phase: 'ended' };
      ended.push(key);
    }
    if (!(event.agentKey in agents)) {
      agents[event.agentKey] = { ...fresh(event, 'ended') };
      ended.push(event.agentKey);
    }
    return { state: markEnded({ ...next, agents }, ended), ended };
  }

  const before = next.agents[event.agentKey];
  let after = transition(before, event);
  if (after !== undefined && isLiveness(event) && after.phase !== 'ended') after = seen(after, event);
  // Leaving a wait or starting work restarts the silence clock even when the event came from the Huddle.
  if (after !== undefined && before !== undefined && after !== before && after.phase === 'working') {
    const waitsChanged = Object.keys(after.waits).length !== Object.keys(before.waits).length;
    if (waitsChanged || before.phase !== 'working') after = seen(after, event);
  }

  if (after !== undefined && after !== before) {
    next = { ...next, agents: { ...next.agents, [event.agentKey]: after } };
  }
  if (isLiveness(event) && after !== undefined && after.phase !== 'ended') {
    const prev = next.sessionLastSeen[event.sessionId];
    if (prev === undefined || event.ts > prev) {
      next = { ...next, sessionLastSeen: { ...next.sessionLastSeen, [event.sessionId]: event.ts } };
    }
  }

  const endedNow = after?.phase === 'ended' && before?.phase !== 'ended' ? [event.agentKey] : [];
  if (endedNow.length > 0) {
    next = markEnded(next, endedNow);
  } else if (after?.phase !== 'ended' && before?.phase === 'ended') {
    // Reopened (resume): no longer in the ended list.
    next = { ...next, endedOrder: next.endedOrder.filter((k) => k !== event.agentKey) };
  }
  return { state: next, ended: endedNow };
}

/** Does the agent have an open call to a subagent-spawning tool? */
export function hasOpenSpawn(agent: TrackedAgent): boolean {
  return (
    Object.values(agent.openTools).some((name) => SPAWN_TOOLS.has(name)) ||
    agent.anonTools.some((n) => SPAWN_TOOLS.has(n))
  );
}

export function openToolCount(agent: TrackedAgent): number {
  return Object.keys(agent.openTools).length + agent.anonTools.length;
}

export function isWaiting(agent: TrackedAgent): boolean {
  return Object.keys(agent.waits).length > 0;
}
