/**
 * Role tracking for the detectors (2026-11-18, agent types by role): each live agent's role and each role's
 * description, so a detector can ask for an agent's type (`roleKindOf` with the user's overrides).
 *
 * Role drift: an agent whose type is expected to read, not edit (reviewer, researcher; `ROLE_PROFILES[k].readOnly`)
 * starts a file edit (Write, Edit, MultiEdit, NotebookEdit). Raised once per agent at the first such edit, before it
 * lands: usually a mis-briefed agent the user wants to know about. Item `role:<agentKey>`, warning. Resolved when the
 * agent ends (or the user dismisses it). If the edit is expected, the user sets the role's type in Library > Roles.
 * Pure: no clock, no randomness, no I/O.
 */
import {
  isSafeRoleKey,
  ROLE_PROFILES,
  roleKindOf,
  type AgentKey,
  type AttentionItem,
  type HuddleEvent,
  type RoleKind,
  type RoleKindOverrides,
} from '@huddle/shared';
import { raisedEvent, resolvedEvent, without, type DetectorEmit } from './common.js';
import { plain } from '../text.js';
import { EDIT_TOOLS } from './conflict.js';

export interface RoleState {
  /** Role per live agent: 'main' for a session root, the subagent type otherwise. Forgotten when the agent ends. */
  roles: Record<AgentKey, string>;
  /** One-line description per role name (role.described). */
  descriptions: Record<string, string>;
  /** Open role-drift item per agent. */
  raised: Record<AgentKey, string>;
}

export function emptyRoles(): RoleState {
  return { roles: {}, descriptions: {}, raised: {} };
}

export function roleDriftItemId(agentKey: AgentKey): string {
  return `role:${agentKey}`;
}

/** Descriptions kept; past this new roles are not described (the guess then goes by name only). */
const MAX_DESCRIPTIONS = 2000;

/** The type of a tracked agent, or null when its role is not known (yet). */
export function trackedRoleKind(
  state: RoleState,
  key: AgentKey,
  overrides: RoleKindOverrides | null | undefined,
): RoleKind | null {
  // Own properties only: a role named "constructor" must not read Object.prototype (security review, 2026-11-18).
  const role = Object.hasOwn(state.roles, key) ? state.roles[key] : undefined;
  if (typeof role !== 'string') return null;
  const description = Object.hasOwn(state.descriptions, role) ? state.descriptions[role] : undefined;
  return roleKindOf(role, typeof description === 'string' ? description : null, overrides);
}

function remember(state: RoleState, event: HuddleEvent): RoleState {
  switch (event.type) {
    case 'session.started':
      return Object.hasOwn(state.roles, event.agentKey)
        ? state
        : { ...state, roles: { ...state.roles, [event.agentKey]: 'main' } };
    case 'agent.started':
      if (!isSafeRoleKey(event.role)) return state;
      return state.roles[event.agentKey] === event.role
        ? state
        : { ...state, roles: { ...state.roles, [event.agentKey]: event.role } };
    case 'role.described': {
      if (!isSafeRoleKey(event.role)) return state;
      if (Object.hasOwn(state.descriptions, event.role) && state.descriptions[event.role] === event.description)
        return state;
      if (!Object.hasOwn(state.descriptions, event.role) && Object.keys(state.descriptions).length >= MAX_DESCRIPTIONS)
        return state;
      return { ...state, descriptions: { ...state.descriptions, [event.role]: event.description } };
    }
    default:
      return state;
  }
}

/** Fold one event: track roles, raise drift, resolve the items of agents that ended (and forget them). */
export function stepRoles(
  state: RoleState,
  event: HuddleEvent,
  ended: readonly AgentKey[],
  overrides: RoleKindOverrides | null | undefined,
): { state: RoleState; emit: DetectorEmit[] } {
  const emit: DetectorEmit[] = [];
  let next = remember(state, event);

  if (
    event.type === 'tool.started' &&
    EDIT_TOOLS.has(event.toolName) &&
    !Object.hasOwn(next.raised, event.agentKey) &&
    !ended.includes(event.agentKey)
  ) {
    const kind = trackedRoleKind(next, event.agentKey, overrides);
    if (kind !== null && ROLE_PROFILES[kind].readOnly) {
      const label = ROLE_PROFILES[kind].label;
      const itemId = roleDriftItemId(event.agentKey);
      const role = Object.hasOwn(next.roles, event.agentKey) ? (next.roles[event.agentKey] ?? '') : '';
      const item: AttentionItem = {
        id: itemId,
        kind: 'role_drift',
        severity: 'warning',
        agentKey: event.agentKey,
        title: plain(`A ${label.toLowerCase()} is changing files`),
        detail: plain(
          `${event.toolName}: ${event.summary}. A ${label.toLowerCase()} is expected to read, not edit. If ${role} should edit, set its type in Library › Roles.`,
        ),
        createdAt: event.ts,
        resolvedAt: null,
      };
      emit.push(raisedEvent({ sessionId: event.sessionId, agentKey: event.agentKey, ts: event.ts }, item, event.id));
      next = { ...next, raised: { ...next.raised, [event.agentKey]: itemId } };
    }
  }

  for (const key of ended) {
    const itemId = next.raised[key];
    if (itemId !== undefined) {
      emit.push(resolvedEvent({ sessionId: event.sessionId, agentKey: key, ts: event.ts }, itemId, event.id));
      next = { ...next, raised: without(next.raised, key) };
    }
    if (Object.hasOwn(next.roles, key)) next = { ...next, roles: without(next.roles, key) };
  }
  return { state: next, emit };
}
