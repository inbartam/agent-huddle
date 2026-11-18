/**
 * Arming delay for request cards (security review, 2026-11-14). When one request resolves, the next can mount in
 * the same spot within ~100 ms, and cards re-sort as sessions act, so the second click of a double-click (Windows
 * allows 500 ms) could answer a request the user never saw. A request card therefore ignores every press, pointer
 * and keyboard shortcut alike, for ARMING_MS after it is first shown or after its item changes; its buttons say so
 * (aria-disabled with JUST_ARRIVED as the reason). Pure: the clock is passed in.
 */
import type { ControlState, ControlsView } from '@huddle/shared';

/** Longer than the Windows double-click time (500 ms by default). */
export const ARMING_MS = 600;

export const JUST_ARRIVED = 'Just arrived. Wait a moment before answering.';

/** Whether a card shown at `shownAt` takes presses at `now`. `ms` 0 or less: always. */
export function isArmed(shownAt: number, now: number, ms: number = ARMING_MS): boolean {
  return ms <= 0 || now - shownAt >= ms;
}

/** The control as shown while the card is not armed yet: off, with the reason. An off control keeps its own reason. */
export function armControl(control: ControlState, armed: boolean): ControlState {
  return armed || !control.enabled ? control : { enabled: false, reason: JUST_ARRIVED };
}

/** Run `press` only if the card is armed at the moment of the press. Returns whether it ran. */
export function pressWhenArmed(shownAt: number, now: number, ms: number, press: () => void): boolean {
  if (!isArmed(shownAt, now, ms)) return false;
  press();
  return true;
}

/**
 * The approval card's one-key shortcuts (A allow, D deny, T terminal), given the controls as drawn: while the card is
 * not armed they are off, so a shortcut does nothing, the same as a click.
 */
export function approvalShortcut(
  key: string,
  controls: Pick<ControlsView, 'approve' | 'deny' | 'passThrough'>,
): 'allow' | 'deny' | 'pass' | null {
  const k = key.toLowerCase();
  if (k === 'a' && controls.approve.enabled) return 'allow';
  if (k === 'd' && controls.deny.enabled) return 'deny';
  if (k === 't' && controls.passThrough.enabled) return 'pass';
  return null;
}
