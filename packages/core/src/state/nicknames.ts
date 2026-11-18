/**
 * Kept nicknames (M5 WP5, owner decision): retention and "delete all history" delete the `control.applied` rename
 * events that carry nicknames (ADR-015), so the core copies each agent's latest nickname into
 * `UserSettings.nicknames` before it deletes. This is where that map is read: the state the UI sees names an agent by
 * its kept nickname when the log no longer gives it one (a session that comes back after its history was deleted).
 *
 * Precedence: a nickname from the log (the agent's book) wins, then the kept one, then the reducer's own name (session
 * or handoff title, role plus ordinal). Pure; the reducer's state itself is not changed.
 */
import type { AgentKey, AgentNode } from '@huddle/shared';
import type { ReducerState } from './reduce.js';

export function withNicknameFallback(state: ReducerState, nicknames: Readonly<Record<AgentKey, string>>): ReducerState {
  let agents: Record<AgentKey, AgentNode> | null = null;
  for (const [key, name] of Object.entries(nicknames)) {
    if (!Object.hasOwn(state.agents, key)) continue;
    const node = state.agents[key];
    if (node === undefined || name === '' || node.name === name) continue;
    const own = Object.hasOwn(state.book.agents, key) ? (state.book.agents[key]?.nickname ?? null) : null;
    if (own !== null) continue;
    agents ??= { ...state.agents };
    Object.defineProperty(agents, key, {
      value: { ...node, name },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return agents === null ? state : { ...state, agents };
}
