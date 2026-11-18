/**
 * Agent-team teammates in the UI (M6 item 3, S20). The reducer makes a teammate a `teammate` node under the session
 * root (the lead); this file only decides the words: the "teammate" and "team lead" badges, the idle status words,
 * and the facts the detail pane shows from the teammate's own `teammate.idle` events. Pure, so the tree, the widget
 * and the detail share it and render tests can check it.
 */
import type { AgentKey, AgentKind, AgentStatus, HuddleEvent } from '@huddle/shared';
import { plural } from './format.js';
import { lookFor, type StatusLook } from './status.js';

export const TEAMMATE_WORDS = {
  badge: 'teammate',
  badgeTitle: 'Agent-team teammate: the lead started it by name; it works alongside the lead, not inside it',
  lead: 'team lead',
  idle: 'idle, waiting for the lead',
  /** Known limit: OTel carries no agent id for in-process teammates, so their requests land on the lead. */
  tokensOnLead:
    'Tokens and cost of an in-process teammate are counted on the team lead: Claude Code does not report which teammate made a request.',
  leadCarriesTeam:
    "This agent's usage includes its in-process teammates' requests (Claude Code does not tell them apart).",
  /** Known limit: no TaskStop signal is read yet. */
  staysIdle: 'A teammate the lead has stopped still shows idle here until the session ends.',
} as const;

/** A teammate waiting for the lead reads so, with the idle glyph (○); every other status keeps its usual look. */
export const TEAMMATE_IDLE_LOOK: StatusLook = { glyph: '○', label: TEAMMATE_WORDS.idle, tone: 'idle' };

/** The look for an agent of this kind: `lookFor`, plus the teammate idle words. */
export function agentLook(kind: AgentKind, status: AgentStatus, stale: boolean | undefined): StatusLook {
  if (stale !== true && kind === 'teammate' && status === 'idle') return TEAMMATE_IDLE_LOOK;
  return lookFor(status, stale);
}

/** How many of these children are teammates. */
export function teammateCount(children: readonly { kind: AgentKind }[]): number {
  return children.filter((c) => c.kind === 'teammate').length;
}

/** "Leads 2 teammates", for a lead's tooltip and accessible name. */
export function leadWords(teammates: number): string {
  return `Leads ${plural(teammates, 'teammate')}`;
}

export interface TeammateIdleFact {
  /** When the teammate last went idle (event time). */
  ts: number;
  /** The hook's team name, e.g. `session-1a2b3c4d`; null when the hook did not carry one. */
  teamName: string | null;
}

/** The latest `teammate.idle` for this agent in its events (oldest first), or null when there is none. */
export function lastTeammateIdle(events: readonly HuddleEvent[], key: AgentKey): TeammateIdleFact | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === 'teammate.idle' && e.agentKey === key) return { ts: e.ts, teamName: e.teamName };
  }
  return null;
}

/**
 * The usage table's rollup column head (owner decision 2026-11-16, after P5): "With team (N)" when the agent leads
 * agent-team teammates, else "With subagents (N)". N is the rollup's agent count, the agent itself included.
 */
export function usageRollupHead(leadsTeammates: boolean, agentCount: number): string {
  return `${leadsTeammates ? 'With team' : 'With subagents'} (${String(agentCount)})`;
}
