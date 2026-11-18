/**
 * At-a-glance figures for the title bar and the widget header, and the one item to pin at the bottom
 * of the widget. Counts come from the shared selectors.
 */
import {
  selectNeedsYouCount,
  selectStaleSessionIds,
  type AgentKey,
  type HuddleState,
  type SessionView,
  type TreeOptions,
} from '@huddle/shared';

/**
 * Selector options for this state: the Huddle's start time, so sessions only replayed from the log are marked
 * stale. Absent (tests, replays, before start) means nothing is stale.
 */
export function treeOptions(state: HuddleState | null): TreeOptions {
  const startedAt = state?.connection?.startedAt;
  return typeof startedAt === 'number' ? { huddleStartedAt: startedAt } : {};
}

export interface Counts {
  working: number;
  needsYou: number;
}

/** Stale sessions (not heard from since Huddle restarted) count in neither total: their statuses are history. */
export function counts(state: HuddleState, sessions: readonly SessionView[]): Counts {
  let working = 0;
  for (const s of sessions) if (s.stale !== true) working += s.statusCounts.working + s.statusCounts.starting;
  return { working, needsYou: selectNeedsYouCount(state, treeOptions(state)) };
}

export interface PinnedItem {
  agentKey: AgentKey;
  /** "needs approval", "needs an answer", "wants Bash", or the inbox item's title. */
  what: string;
  /** The command, file path or question. */
  detail: string | null;
  code: boolean;
}

/**
 * The top thing waiting on the user: the oldest unresolved inbox item that needs action, else the
 * first agent waiting for approval or an answer. Approve and deny buttons arrive with M3.
 */
export function pinnedItem(state: HuddleState): PinnedItem | null {
  // A request from a stale session was asked before the restart; it cannot be answered from here.
  const stale = selectStaleSessionIds(state, treeOptions(state));
  const live = (key: AgentKey) => {
    const agent = Object.hasOwn(state.agents, key) ? state.agents[key] : undefined;
    return agent === undefined || !stale.has(agent.sessionId);
  };
  const open = state.inbox
    .filter((i) => i.resolvedAt === null && i.severity === 'action_required' && live(i.agentKey))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (open) {
    if (open.approval) {
      return {
        agentKey: open.agentKey,
        what: `wants ${open.approval.toolName}`,
        detail: open.approval.summary,
        code: true,
      };
    }
    return { agentKey: open.agentKey, what: open.title, detail: open.detail || null, code: false };
  }
  const waiting = Object.values(state.agents)
    .filter((a) => (a.status === 'waiting_approval' || a.status === 'waiting_answer') && !stale.has(a.sessionId))
    .sort((a, b) => a.lastEventAt - b.lastEventAt)[0];
  if (!waiting) return null;
  return {
    agentKey: waiting.key,
    what: waiting.status === 'waiting_answer' ? 'needs an answer' : 'needs approval',
    detail: waiting.currentActivity,
    code: waiting.status === 'waiting_approval',
  };
}
