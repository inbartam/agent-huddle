/**
 * Hiding a card in the widget (Widget v2): the × hides a session's card until the session does something new or
 * needs the user. Renderer-local only (WidgetView keeps the marks in memory); nothing is sent to Claude Code or the
 * core. Pure.
 *
 * A mark is the session's `lastActivityAt` when the user hid it. `lastActivityAt` only grows, so once a session has
 * moved past its mark it stays visible without the mark having to be cleared.
 */
import type { AgentKey, SessionView } from '@huddle/shared';

export const HIDE_HINT = 'Hide until it does something new';

/** Root key of a hidden session → its `lastActivityAt` when it was hidden. */
export type HiddenMarks = ReadonlyMap<AgentKey, number>;

/** Whether a session's card is hidden right now. A card that needs the user is never hidden. */
export function isHidden(session: SessionView, marks: HiddenMarks, needsYou: boolean): boolean {
  if (needsYou) return false;
  const mark = marks.get(session.rootKey);
  return mark !== undefined && session.lastActivityAt <= mark;
}

/** The marks after hiding one more session. */
export function hide(marks: HiddenMarks, session: SessionView): HiddenMarks {
  const next = new Map(marks);
  next.set(session.rootKey, session.lastActivityAt);
  return next;
}

/** Marks that still hide something; marks of sessions that moved on or left are dropped. */
export function pruneMarks(
  marks: HiddenMarks,
  sessions: readonly SessionView[],
  needsYou: (s: SessionView) => boolean,
): HiddenMarks {
  let changed = false;
  const next = new Map<AgentKey, number>();
  for (const [key, mark] of marks) {
    const session = sessions.find((s) => s.rootKey === key);
    if (session !== undefined && isHidden(session, marks, needsYou(session))) next.set(key, mark);
    else changed = true;
  }
  return changed ? next : marks;
}
