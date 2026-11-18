/**
 * The widget's session faces (Widget v2, owner's choice 2026-11-14): a small blocky mascot per session. Pure: the
 * mood follows the status, the colour follows a hash of the session id. Decorative only; the status glyph and label
 * are always shown next to it, so the face is never the only signal (docs/DESIGN.md "Widget v2").
 */
import type { AgentStatus } from '@huddle/shared';

/** How the face looks. `off` is the greyed face of a stopped or stale session. */
export type FaceMood = 'focused' | 'alert' | 'sleepy' | 'happy' | 'failed' | 'flat' | 'off';

const MOOD: Record<AgentStatus, FaceMood> = {
  starting: 'focused',
  working: 'focused',
  waiting_approval: 'alert',
  waiting_answer: 'alert',
  idle: 'sleepy',
  done: 'happy',
  failed: 'failed',
  paused: 'flat',
  stopped: 'off',
};

/**
 * The mood for a session card. A request waiting on the user wins (the card says "needs approval"), then a stale
 * session (its status is history, so the face greys out), then the status itself. An unknown status is `focused`'s
 * calm neighbour `flat`, never an alarm.
 */
export function faceMood(status: string, opts: { stale?: boolean; needsYou?: boolean } = {}): FaceMood {
  if (opts.needsYou === true) return 'alert';
  if (opts.stale === true) return 'off';
  return (MOOD as Record<string, FaceMood | undefined>)[status] ?? 'flat';
}

/** Number of face colours (`--face-0` … `--face-7` in tokens.css). */
export const FACE_HUES = 8;

/** FNV-1a, 32 bit: small, stable across runs and platforms, good enough to spread ids over a few colours. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The session's colour index, 0..FACE_HUES-1. The same session id always gets the same colour. */
export function faceHue(sessionId: string): number {
  return fnv1a(sessionId) % FACE_HUES;
}
