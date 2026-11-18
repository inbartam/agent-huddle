/**
 * Home (main window redesign, WP3): the date line, the Today list
 * and the explanation. Pure: counts, projects, identities and `now` come in, words and rows go out.
 *
 * Titles and project names may come from an agent or a path on disk: the component renders them as text.
 */
import type { AgentKey, AgentStatus, ProjectView, SessionIdentity, SessionView } from '@huddle/shared';
import { clockTime, plural, UNKNOWN } from './format.js';
import { lookFor, type StatusTone } from './status.js';
import { sessionStatus } from './tree.js';

export const HOME_WORDS = {
  explain: 'Explain this screen',
  hideExplain: 'Hide the explanation',
  explanation:
    'Home is the one place to start. The left side lists every project, its sessions and the agents inside them, with whoever is waiting on you pinned on top. The numbers in the title bar count the agents on this computer that are working, waiting on you or stuck right now; Today lists the sessions that ran today. Ask the Huddle answers questions about your agents in plain words; it can read, never act.',
  start: 'Start a run',
  today: 'Today',
  allHistory: 'All history',
  todayEmpty: 'Nothing has run today. Start Claude Code in any terminal, or start a run here.',
} as const;

/** "Monday 16 Nov", in the viewer's time zone. */
export function dayWords(now: number): string {
  const d = new Date(now);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  return `${weekday} ${String(d.getDate())} ${month}`;
}

/** "Monday 16 Nov · 4 projects · 6 sessions today". */
/** Home's heading (2026-11-18): the day, since the rail already says "Home". */
export function homeHeading(now: number): string {
  return dayWords(now);
}

/** The line under Home's heading: "4 projects · 7 sessions today". */
export function homeCountsLine(projectCount: number, todayCount: number): string {
  return `${plural(projectCount, 'project')} · ${plural(todayCount, 'session')} today`;
}

/** Local midnight of `now`'s day. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface TodayRow {
  rootKey: AgentKey;
  title: string;
  status: AgentStatus;
  stale: boolean;
  glyph: string;
  tone: StatusTone;
  /** "agent-huddle · 3 agents · needs approval", "series-a · ended 09:40". */
  meta: string;
}

/**
 * Sessions active today (live and Earlier, as the sidebar shows them; hidden runs stay hidden), most recent first.
 * Each with its readable title (`identity`, the sidebar rule) and a status shape and word.
 */
export function todayRows(
  projects: readonly ProjectView[],
  now: number,
  identity: (rootKey: AgentKey) => SessionIdentity | null,
): TodayRow[] {
  const since = startOfDay(now);
  const rows: { view: SessionView; project: ProjectView }[] = [];
  for (const p of projects)
    for (const view of [...p.sessions, ...p.earlier]) if (view.lastActivityAt >= since) rows.push({ view, project: p });
  rows.sort((a, b) => b.view.lastActivityAt - a.view.lastActivityAt);
  return rows.map(({ view, project }) => {
    const who = identity(view.rootKey);
    const status = sessionStatus(view);
    const stale = view.stale === true;
    const look = lookFor(status, stale);
    const parts = [project.name, plural(view.agentCount, 'agent')];
    // Ended rows keep the status word too: "failed · ended 14:02" is not "done · ended 14:02".
    parts.push(look.label);
    if (view.ended) parts.push(`ended ${clockTime(view.lastActivityAt)}`);
    return {
      rootKey: view.rootKey,
      title: who?.label ?? UNKNOWN,
      status,
      stale,
      glyph: look.glyph,
      tone: look.tone,
      meta: parts.join(' · '),
    };
  });
}
