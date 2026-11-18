/**
 * Two small pure helpers for the shell's failure paths (A4-01, A4-02): the words of the start-failure dialog, and the
 * throttle that decides whether a crashed renderer is reloaded.
 */

const START_FAILURE_MAX = 300;
const START_FAILURE_FALLBACK = 'Something went wrong while starting. Close Agent Huddle and open it again.';
/** A renderer that crashes again within this long after a reload stays down: no reload loop. */
export const RELOAD_MIN_GAP_MS = 60_000;

/** The message of a start-up failure for `dialog.showErrorBox`: the message only (never the stack), clipped. */
export function startFailureText(err: unknown): string {
  if (!(err instanceof Error)) return START_FAILURE_FALLBACK;
  const message = err.message.trim();
  if (message === '') return START_FAILURE_FALLBACK;
  return message.length <= START_FAILURE_MAX ? message : `${message.slice(0, START_FAILURE_MAX - 1).trimEnd()}…`;
}

/** Reload a crashed renderer unless this one was already reloaded less than a minute ago. */
export function shouldReload(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt === null || now - lastReloadAt >= RELOAD_MIN_GAP_MS;
}
