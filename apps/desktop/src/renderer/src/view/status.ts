/**
 * Status presentation from docs/DESIGN.md ("Status: shape, label and colour together").
 * Colour is never the only signal: every status has a glyph and a label.
 */
import type { AgentStatus } from '@huddle/shared';

/** CSS tone suffix: maps to the --working, --needs-you, ... tokens. */
export type StatusTone = 'working' | 'needs-you' | 'failed' | 'paused' | 'idle';

export interface StatusLook {
  glyph: string;
  label: string;
  tone: StatusTone;
}

export const STATUS_LOOK: Record<AgentStatus, StatusLook> = {
  starting: { glyph: '◌', label: 'starting', tone: 'working' },
  working: { glyph: '●', label: 'working', tone: 'working' },
  waiting_approval: { glyph: '▲', label: 'needs approval', tone: 'needs-you' },
  waiting_answer: { glyph: '▲', label: 'needs an answer', tone: 'needs-you' },
  paused: { glyph: '‖', label: 'paused', tone: 'paused' },
  idle: { glyph: '○', label: 'idle', tone: 'idle' },
  done: { glyph: '✓', label: 'done', tone: 'idle' },
  failed: { glyph: '✕', label: 'failed', tone: 'failed' },
  stopped: { glyph: '■', label: 'stopped', tone: 'idle' },
};

/** A status this build does not know (a newer core) gets a neutral look instead of crashing. */
export function statusLook(status: string): StatusLook {
  return (STATUS_LOOK as Record<string, StatusLook | undefined>)[status] ?? { glyph: '○', label: '—', tone: 'idle' };
}

/**
 * How loudly a status colours the rails leading to it (presentation only). Waiting wins over
 * everything, so a waiting subagent lights its path up to the root.
 */
const URGENCY: Record<AgentStatus, number> = {
  waiting_approval: 6,
  waiting_answer: 6,
  failed: 5,
  paused: 4,
  working: 3,
  starting: 2,
  idle: 1,
  done: 0,
  stopped: 0,
};

export function mostUrgent(statuses: Iterable<AgentStatus>): AgentStatus | null {
  let best: AgentStatus | null = null;
  for (const s of statuses) if (best === null || URGENCY[s] > URGENCY[best]) best = s;
  return best;
}

/**
 * A session the Huddle has not heard from since it restarted (SessionView.stale). Its agents keep their last
 * status, but that is history, not a reading: the row shows the "unknown or starting" glyph family from
 * DESIGN.md (◌, an outline with nothing known inside), muted, and says why in words.
 */
export const STALE_LOOK: StatusLook = { glyph: '◌', label: 'not seen since Huddle restarted', tone: 'idle' };

/** The look for a tree node or agent: the stale look wins over the last status it had. */
export function lookFor(status: string, stale: boolean | undefined): StatusLook {
  return stale === true ? STALE_LOOK : statusLook(status);
}
