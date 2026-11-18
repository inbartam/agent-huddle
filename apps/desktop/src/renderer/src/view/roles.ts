/**
 * Agent types in the UI (2026-11-18): the words a row, card or detail shows for an agent's type. Pure; the type
 * itself comes from `roleKindOf` / `agentRoleKind` in @huddle/shared (guess + the user's override).
 */
import {
  ROLE_KINDS,
  ROLE_PROFILES,
  roleKindOf,
  type AgentKind,
  type HuddleCommand,
  type RoleKind,
  type RoleKindOverrides,
} from '@huddle/shared';

/** What a tree row or card needs to know about an agent to name its type. */
export interface RoleSource {
  kind: AgentKind;
  role: string;
  roleDescription: string | null;
  /** Main agents: whether it has subagents or teammates (then it leads). */
  hasChildren?: boolean;
}

/** The agent's type, or null when there is nothing to say (a general agent, a main agent working alone). */
export function typeOf(source: RoleSource, overrides: RoleKindOverrides | null | undefined): RoleKind | null {
  const own = overrides && Object.hasOwn(overrides, source.role) ? overrides[source.role] : undefined;
  if (source.kind === 'main' && own === undefined) return source.hasChildren === true ? 'lead' : null;
  const kind = roleKindOf(source.role, source.roleDescription, overrides);
  return kind === 'general' ? null : kind;
}

/** The type's word ("Reviewer"), or null. */
export function typeLabel(source: RoleSource, overrides: RoleKindOverrides | null | undefined): string | null {
  const kind = typeOf(source, overrides);
  return kind === null ? null : ROLE_PROFILES[kind].label;
}

/** A finished agent of a type says its finish line on the row ("review ready") instead of plain "done". */
export function doneWords(kind: RoleKind | null): string | null {
  if (kind === null || kind === 'general') return null;
  return ROLE_PROFILES[kind].finished.toLowerCase();
}

/** The types in the order Library > Roles and the filters list them. */
export const TYPE_OPTIONS: readonly { kind: RoleKind; label: string }[] = ROLE_KINDS.map((kind) => ({
  kind,
  label: ROLE_PROFILES[kind].label,
}));

/** One role on Library > Roles. */
export interface RoleRow {
  role: string;
  /** The definition's one-line description, when known. Agent text: render as text. */
  description: string | null;
  /** Agents with this role in the Huddle now (live and remembered sessions). */
  agents: number;
  /** The type from the name and description alone. */
  guess: RoleKind;
  /** The type in use: the user's, else the guess. */
  kind: RoleKind;
  /** The user set it. */
  overridden: boolean;
}

/**
 * Every role the Huddle has seen (subagents and teammates; "main" is not a role the user would type), plus roles the
 * user typed a type for that are not around now. Ordered by type (as TYPE_OPTIONS), then by name.
 */
export function roleRows(
  agents: Readonly<Record<string, { kind: AgentKind; role: string; roleDescription: string | null }>>,
  overrides: RoleKindOverrides | null | undefined,
): RoleRow[] {
  const seen = new Map<string, { description: string | null; agents: number }>();
  for (const agent of Object.values(agents)) {
    if (agent.kind === 'main' || agent.role === '') continue;
    const was = seen.get(agent.role);
    seen.set(agent.role, {
      description: was?.description ?? agent.roleDescription,
      agents: (was?.agents ?? 0) + 1,
    });
  }
  for (const role of Object.keys(overrides ?? {}))
    if (!seen.has(role)) seen.set(role, { description: null, agents: 0 });
  const order = (k: RoleKind) => ROLE_KINDS.indexOf(k);
  return [...seen.entries()]
    .map(([role, v]) => {
      const guess = roleKindOf(role, v.description, null);
      const overridden = overrides !== null && overrides !== undefined && Object.hasOwn(overrides, role);
      return {
        role,
        description: v.description,
        agents: v.agents,
        guess,
        kind: roleKindOf(role, v.description, overrides),
        overridden,
      };
    })
    .sort((a, b) => order(a.kind) - order(b.kind) || a.role.localeCompare(b.role));
}

/** The `settings.update` that sets a role's type, or clears it back to the guess (null). */
export function roleKindCommand(role: string, kind: RoleKind | null): HuddleCommand {
  return { type: 'settings.update', patch: { roleKinds: { [role]: kind } } };
}
