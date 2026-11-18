/**
 * Loop detector (F21). Event-based: raised and resolved by `stepLoop`.
 *
 * Repeat: the same tool input digest (tool name + input, hashed by the normalizer) `loopRepeat` times in a row in one
 *   agent's tool starts. Item `loop:<agentKey>:<digest>`. Resolved when that agent starts a tool with a different
 *   digest, a new prompt arrives, its turn ends or fails, or it ends.
 * Failures: `loopFailures` tool failures in a row with no successful tool call between. Item
 *   `loop:<agentKey>:failures`. Failures of calls that ran in parallel count once: a failure counts only when the
 *   agent started a tool since the last counted failure (Claude Code fails sibling calls together). A user interrupt
 *   is not a failure and resets the count. Resolved by the next successful tool call, a new prompt, a turn end or
 *   failure, or the agent ending.
 */
import type { AgentKey, AttentionItem, DetectorSettings, HuddleEvent } from '@huddle/shared';
import { atLeast, raisedEvent, resolvedEvent, without, type DetectorEmit, type EmitTarget } from './common.js';
import { plain } from '../text.js';
import type { LifeState } from './lifecycle.js';

export interface AgentLoop {
  sessionId: string;
  lastDigest: string | null;
  repeat: number;
  /** Open repeat item id, or null. */
  repeatItem: string | null;
  failures: number;
  /** A tool started since the last counted failure. */
  startedSinceFailure: boolean;
  failureItem: string | null;
}

export interface LoopState {
  agents: Record<AgentKey, AgentLoop>;
}

export function emptyLoop(): LoopState {
  return { agents: {} };
}

export function repeatItemId(agentKey: AgentKey, digest: string): string {
  return `loop:${agentKey}:${digest}`;
}

export function failureItemId(agentKey: AgentKey): string {
  return `loop:${agentKey}:failures`;
}

function freshLoop(sessionId: string): AgentLoop {
  return {
    sessionId,
    lastDigest: null,
    repeat: 0,
    repeatItem: null,
    failures: 0,
    startedSinceFailure: true,
    failureItem: null,
  };
}

/** Resolve whatever is open for the agent and forget its counts. */
function clearAgent(agent: AgentLoop, target: EmitTarget, triggerId: string, emit: DetectorEmit[]): void {
  if (agent.repeatItem !== null) emit.push(resolvedEvent(target, agent.repeatItem, triggerId));
  if (agent.failureItem !== null) emit.push(resolvedEvent(target, agent.failureItem, triggerId));
}

export function stepLoop(
  state: LoopState,
  life: LifeState,
  event: HuddleEvent,
  thresholds: DetectorSettings,
  ended: readonly AgentKey[],
): { state: LoopState; emit: DetectorEmit[] } {
  const emit: DetectorEmit[] = [];
  let agents = state.agents;

  for (const key of ended) {
    const agent = agents[key];
    if (agent === undefined) continue;
    clearAgent(agent, { sessionId: agent.sessionId, agentKey: key, ts: event.ts }, event.id, emit);
    agents = without(agents, key);
  }

  const key = event.agentKey;
  const target: EmitTarget = { sessionId: event.sessionId, agentKey: key, ts: event.ts };
  const tracked = life.agents[key];
  const current = agents[key];

  switch (event.type) {
    case 'tool.started': {
      if (tracked === undefined || tracked.phase === 'ended') break;
      const agent = current ?? freshLoop(event.sessionId);
      let next: AgentLoop = { ...agent, startedSinceFailure: true };
      if (event.inputDigest !== '' && event.inputDigest === agent.lastDigest) {
        next.repeat = agent.repeat + 1;
      } else {
        if (agent.repeatItem !== null) emit.push(resolvedEvent(target, agent.repeatItem, event.id));
        next = {
          ...next,
          lastDigest: event.inputDigest === '' ? null : event.inputDigest,
          repeat: 1,
          repeatItem: null,
        };
      }
      const limit = Math.floor(atLeast(thresholds.loopRepeat, 2));
      if (next.lastDigest !== null && next.repeatItem === null && next.repeat >= limit) {
        const itemId = repeatItemId(key, next.lastDigest);
        const activity =
          event.summary === '' || event.summary === event.toolName
            ? event.toolName
            : `${event.toolName}: ${event.summary}`;
        const item: AttentionItem = {
          id: itemId,
          kind: 'loop',
          severity: 'warning',
          agentKey: key,
          title: plain(`Same ${event.toolName} call ${String(next.repeat)} times in a row`),
          detail: plain(`${activity}. Repeated with the same input; the agent may be going in circles.`),
          createdAt: event.ts,
          resolvedAt: null,
        };
        emit.push(raisedEvent(target, item, event.id));
        next = { ...next, repeatItem: itemId };
      }
      agents = { ...agents, [key]: next };
      break;
    }
    case 'tool.failed': {
      if (current === undefined) break;
      if (event.interrupted) {
        if (current.failureItem !== null) emit.push(resolvedEvent(target, current.failureItem, event.id));
        agents = { ...agents, [key]: { ...current, failures: 0, failureItem: null, startedSinceFailure: true } };
        break;
      }
      if (!current.startedSinceFailure) break;
      let next: AgentLoop = { ...current, failures: current.failures + 1, startedSinceFailure: false };
      const limit = Math.floor(atLeast(thresholds.loopFailures, 2));
      if (next.failureItem === null && next.failures >= limit) {
        const itemId = failureItemId(key);
        const item: AttentionItem = {
          id: itemId,
          kind: 'loop',
          severity: 'warning',
          agentKey: key,
          title: plain(`${String(next.failures)} tool calls failed in a row`),
          detail: plain(`Last: ${event.toolName}: ${event.error}`),
          createdAt: event.ts,
          resolvedAt: null,
        };
        emit.push(raisedEvent(target, item, event.id));
        next = { ...next, failureItem: itemId };
      }
      agents = { ...agents, [key]: next };
      break;
    }
    case 'tool.finished': {
      if (current === undefined) break;
      if (current.failureItem !== null) emit.push(resolvedEvent(target, current.failureItem, event.id));
      if (current.failures !== 0 || current.failureItem !== null) {
        agents = { ...agents, [key]: { ...current, failures: 0, failureItem: null } };
      }
      break;
    }
    case 'prompt.submitted':
    case 'turn.ended':
    case 'turn.failed': {
      if (current === undefined) break;
      clearAgent(current, target, event.id, emit);
      agents = without(agents, key);
      break;
    }
    default:
      break;
  }
  return { state: agents === state.agents ? state : { agents }, emit };
}
