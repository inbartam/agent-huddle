/**
 * Stuck detector (F21). Time-based: raised only by `tickStuck`, resolved by `stepStuck`.
 *
 * Raise: an agent that is working (not idle, not ended, not waiting on the user) has shown no sign of life for
 *   `stuckMinutes`, or `stuckOpenToolMinutes` while a tool call is still open (long builds and tests are normal).
 *   An agent with an open Agent/Task call is waiting on a foreground subagent: its silence is measured against the
 *   whole session (any agent's sign of life counts), with the open-tool threshold, and it is never stuck while
 *   another agent of the session waits on the user.
 * Item: `stuck:<agentKey>`, one per agent at a time.
 * Resolve: at the next event that shows life for that agent (or, for an agent waiting on a subagent, for its
 *   session), or when the agent goes idle, starts waiting on the user, or ends.
 */
import type { AgentKey, AttentionItem, DetectorSettings, HuddleEvent } from '@huddle/shared';
import { atLeast, MINUTE_MS, minutesText, raisedEvent, resolvedEvent, without, type DetectorEmit } from './common.js';
import { plain } from '../text.js';
import { hasOpenSpawn, isWaiting, openToolCount, type LifeState, type TrackedAgent } from './lifecycle.js';

export interface OpenStuck {
  itemId: string;
  /** The agent's lastSeenEventId when raised: any newer sign of life resolves the item. */
  seenEventId: string;
  /** The silence was measured from this ts (own or session-wide, see above). */
  seenTs: number;
  /** Measured against the session (the agent was waiting on a foreground subagent). */
  sessionWide: boolean;
}

export interface StuckState {
  open: Record<AgentKey, OpenStuck>;
}

export function emptyStuck(): StuckState {
  return { open: {} };
}

export function stuckItemId(agentKey: AgentKey): string {
  return `stuck:${agentKey}`;
}

function stillStuck(life: LifeState, agent: TrackedAgent | undefined, open: OpenStuck): boolean {
  if (agent?.phase !== 'working' || isWaiting(agent)) return false;
  if (agent.lastSeenEventId !== open.seenEventId) return false;
  if (open.sessionWide) {
    if (!hasOpenSpawn(agent)) return false;
    const sessionSeen = life.sessionLastSeen[agent.sessionId] ?? agent.lastSeenTs;
    if (sessionSeen > open.seenTs) return false;
  }
  return true;
}

/** Resolve open stuck items whose condition cleared with this event. `life` is the state after the event. */
export function stepStuck(
  state: StuckState,
  life: LifeState,
  event: HuddleEvent,
): { state: StuckState; emit: DetectorEmit[] } {
  const emit: DetectorEmit[] = [];
  let open = state.open;
  for (const key of Object.keys(state.open).sort()) {
    const item = state.open[key];
    if (item === undefined) continue;
    const agent = life.agents[key];
    if (stillStuck(life, agent, item)) continue;
    emit.push(
      resolvedEvent(
        { sessionId: agent?.sessionId ?? event.sessionId, agentKey: key, ts: event.ts },
        item.itemId,
        event.id,
      ),
    );
    open = without(open, key);
  }
  return { state: open === state.open ? state : { open }, emit };
}

function sessionHasWaitingAgent(life: LifeState, sessionId: string): boolean {
  return Object.values(life.agents).some((a) => a.sessionId === sessionId && a.phase === 'working' && isWaiting(a));
}

/** Raise stuck items for agents silent past their threshold at `now`. */
export function tickStuck(
  state: StuckState,
  life: LifeState,
  now: number,
  thresholds: DetectorSettings,
  /** Per agent: the quiet limits are multiplied by this (its type's quietFactor). Default 1. */
  quietFactor: (key: AgentKey) => number = () => 1,
): { state: StuckState; emit: DetectorEmit[] } {
  const quietMs = atLeast(thresholds.stuckMinutes, 0) * MINUTE_MS;
  const openToolMs = atLeast(thresholds.stuckOpenToolMinutes, 0) * MINUTE_MS;
  const emit: DetectorEmit[] = [];
  let open = state.open;

  for (const key of Object.keys(life.agents).sort()) {
    const agent = life.agents[key];
    if (agent?.phase !== 'working' || isWaiting(agent) || key in open) continue;

    const sessionWide = hasOpenSpawn(agent);
    let seenTs = agent.lastSeenTs;
    let limitMs = openToolCount(agent) > 0 ? openToolMs : quietMs;
    if (sessionWide) {
      if (sessionHasWaitingAgent(life, agent.sessionId)) continue;
      seenTs = Math.max(seenTs, life.sessionLastSeen[agent.sessionId] ?? seenTs);
      limitMs = openToolMs;
    }
    const factor = quietFactor(key);
    limitMs *= Number.isFinite(factor) && factor > 0 ? factor : 1;
    const silentMs = now - seenTs;
    if (silentMs < limitMs) continue;

    const itemId = stuckItemId(key);
    const quiet = minutesText(silentMs);
    let detail: string;
    if (sessionWide) detail = `Waiting on a subagent, and no agent in this session has reported anything for ${quiet}.`;
    else if (openToolCount(agent) > 0 && agent.lastActivity !== null)
      detail = `Still inside ${agent.lastActivity}. Nothing reported for ${quiet}.`;
    else detail = `Working, but nothing reported for ${quiet}.`;

    const item: AttentionItem = {
      id: itemId,
      kind: 'stuck',
      severity: 'warning',
      agentKey: key,
      title: plain(`No activity for ${quiet}`),
      detail: plain(detail),
      createdAt: now,
      resolvedAt: null,
    };
    // The episode is identified by the last sign of life it started from; `now` stays out of the id.
    const trigger = `${agent.lastSeenEventId}@${String(seenTs)}`;
    emit.push(raisedEvent({ sessionId: agent.sessionId, agentKey: key, ts: now }, item, trigger));
    open = { ...open, [key]: { itemId, seenEventId: agent.lastSeenEventId, seenTs, sessionWide } };
  }
  return { state: open === state.open ? state : { open }, emit };
}
