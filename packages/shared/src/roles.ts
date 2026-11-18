/**
 * Agent types by role (owner, 2026-11-18). Claude Code reports a role per agent: the agent definition's name
 * ("code-reviewer", "Explore", "ui-engineer", "general-purpose") plus its one-line description. Those are free text, so
 * the Huddle sorts them into a small fixed set of types, each with a profile: its words, whether it is expected to
 * leave files alone, how long a quiet stretch is normal, and what its finish is called.
 *
 * Guess + override: `roleKindOf` guesses from the name (then the description), and the user's override for a role name
 * (`UserSettings.roleKinds`, set in Library > Roles) always wins. Pure: no clock, no I/O; nothing here is stored in
 * events, so a better guess or a new override applies to old history too.
 */
import type { AgentNode } from './model.js';

export type RoleKind =
  'lead' | 'planner' | 'builder' | 'designer' | 'reviewer' | 'tester' | 'researcher' | 'writer' | 'general';

export const ROLE_KINDS: readonly RoleKind[] = [
  'lead',
  'planner',
  'builder',
  'designer',
  'reviewer',
  'tester',
  'researcher',
  'writer',
  'general',
];

/** The user's corrections: exact role name -> type. */
export type RoleKindOverrides = Record<string, RoleKind>;

export interface RoleProfile {
  /** Sentence-case word for the type ("Reviewer"). */
  label: string;
  /** One line for Library > Roles: what this type does and what the Huddle expects of it. */
  about: string;
  /**
   * Expected to read and report, not change files. A file edit by such an agent raises a warning (`role_drift`): it is
   * usually a mis-briefed agent, and the user should know before it lands.
   */
  readOnly: boolean;
  /**
   * The stuck threshold is multiplied by this: a reviewer or researcher reading a large codebase is often quiet for
   * longer than a builder between edits.
   */
  quietFactor: number;
  /** The finish line in Needs you and toasts ("Review ready"). */
  finished: string;
}

export const ROLE_PROFILES: Readonly<Record<RoleKind, RoleProfile>> = {
  lead: {
    label: 'Lead',
    about: 'Runs a team: hands work to subagents or teammates and pulls it together.',
    readOnly: false,
    quietFactor: 1,
    finished: 'Team finished',
  },
  planner: {
    label: 'Planner',
    about: 'Plans and designs the approach: architects, analysts, strategists.',
    readOnly: false,
    quietFactor: 2,
    finished: 'Plan ready',
  },
  builder: {
    label: 'Builder',
    about: 'Writes and changes code: engineers, executors, developers.',
    readOnly: false,
    quietFactor: 1,
    finished: 'Changes done',
  },
  designer: {
    label: 'Designer',
    about: 'Shapes the interface: UI, UX and visual design.',
    readOnly: false,
    quietFactor: 1,
    finished: 'Design done',
  },
  reviewer: {
    label: 'Reviewer',
    about: 'Reviews, audits or verifies work. Expected to read, not edit: an edit raises a warning.',
    readOnly: true,
    quietFactor: 2,
    finished: 'Review ready',
  },
  tester: {
    label: 'Tester',
    about: 'Writes and runs tests. Long test runs are normal.',
    readOnly: false,
    quietFactor: 1.5,
    finished: 'Tests done',
  },
  researcher: {
    label: 'Researcher',
    about: 'Explores and reads to answer a question. Expected to read, not edit: an edit raises a warning.',
    readOnly: true,
    quietFactor: 2,
    finished: 'Findings ready',
  },
  writer: {
    label: 'Writer',
    about: 'Writes documentation and other text.',
    readOnly: false,
    quietFactor: 1,
    finished: 'Writing done',
  },
  general: {
    label: 'General',
    about: 'Any other agent. No special expectations.',
    readOnly: false,
    quietFactor: 1,
    finished: 'Finished',
  },
};

/**
 * Words that mark a type, checked in this order (the first type with a hit wins), so "test-engineer" is a tester
 * before it is a builder and "code-reviewer" a reviewer before anything else.
 */
const RULES: readonly (readonly [RoleKind, RegExp])[] = [
  ['lead', /\b(lead|leader|orchestrat\w*|manager|coordinator|producer|shepherd|chief|director|commander|conductor)\b/],
  ['reviewer', /\b(review\w*|audit\w*|critic|verif\w*|checker|inspector|reality|evidence)\b/],
  ['tester', /\b(tests?|tester|qa|testing)\b/],
  ['designer', /\b(design\w*|ux|ui|visual|brand|artist|stylist|whimsy)\b/],
  ['planner', /\b(plan|planner|planning|architect|analyst|strategist|prioritizer)\b/],
  [
    'researcher',
    /\b(explore\w*|research\w*|search|reader|scientist|investigat\w*|archaeologist|tracer|scout|lister)\b/,
  ],
  ['writer', /\b(writer|docs?|documentation|document\w*|copywriter|content|editor)\b/],
  [
    'builder',
    /\b(engineer|executor|developer|dev|builder|implement\w*|coder|fix|fixes|fixer|migrat\w*|refactor\w*|debugger|programmer|prototyper|maintainer|simplifier)\b/,
  ],
];

/** "oh-my-claudecode:code-reviewer" -> "code reviewer": the plugin prefix and separators out, lower case. */
function words(text: string): string {
  const bare = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text;
  return bare
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_/.]+/g, ' ')
    .toLowerCase();
}

function guess(text: unknown): RoleKind | null {
  if (typeof text !== 'string') return null;
  const w = words(text);
  for (const [kind, re] of RULES) if (re.test(w)) return kind;
  return null;
}

function isRoleKind(value: unknown): value is RoleKind {
  return typeof value === 'string' && (ROLE_KINDS as readonly string[]).includes(value);
}

/**
 * The type of a role. The user's override wins; then the name; then the description (only when the name says
 * nothing, since descriptions mention reviewing or testing in passing); else general. "main" is general here:
 * whether a main agent leads a team depends on the tree (`agentRoleKind`).
 */
export function roleKindOf(
  role: string,
  description: string | null = null,
  overrides: RoleKindOverrides | null | undefined = null,
): RoleKind {
  const own = overrides && Object.hasOwn(overrides, role) ? overrides[role] : undefined;
  if (isRoleKind(own)) return own;
  if (typeof role !== 'string' || role === 'main' || role === 'general-purpose') return 'general';
  return guess(role) ?? (description !== null ? guess(description) : null) ?? 'general';
}

/** Whether the type of this role came from the user's override (Library > Roles shows "set by you"). */
export function isRoleKindOverridden(role: string, overrides: RoleKindOverrides | null | undefined): boolean {
  return overrides !== null && overrides !== undefined && Object.hasOwn(overrides, role) && isRoleKind(overrides[role]);
}

/**
 * One agent's type. A main agent with subagents or teammates is a lead (unless the user set "main" otherwise); every
 * other agent goes by its role.
 */
export function agentRoleKind(agent: AgentNode, overrides: RoleKindOverrides | null | undefined): RoleKind {
  if (agent.kind === 'main' && !isRoleKindOverridden(agent.role, overrides) && agent.childKeys.length > 0)
    return 'lead';
  return roleKindOf(agent.role, agent.roleDescription, overrides);
}

/** A role name that is safe as a plain-object key (never `__proto__` and friends) and of a sane length. */
export function isSafeRoleKey(role: string): boolean {
  return (
    role.length > 0 && role.length <= 200 && role !== '__proto__' && role !== 'constructor' && role !== 'prototype'
  );
}

/** Pure: overrides with one role set (a kind) or cleared (null). New object; never mutates. */
export function withRoleKind(
  overrides: RoleKindOverrides | null | undefined,
  role: string,
  kind: RoleKind | null,
): RoleKindOverrides {
  const rest: RoleKindOverrides = Object.fromEntries(Object.entries(overrides ?? {}).filter(([r]) => r !== role));
  if (!isSafeRoleKey(role) || kind === null) return rest;
  return { ...rest, [role]: kind };
}
