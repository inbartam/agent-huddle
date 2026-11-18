/**
 * Test helpers for the arming delay (view/arming.ts). A request card ignores presses for ARMING_MS after it is
 * first shown, so a static render of a fresh card shows its buttons off with JUST_ARRIVED. Tests about anything
 * else render "settled" cards: the card has been on screen long enough, so arming is out of the way.
 */
import type { ReactElement } from 'react';
import { ArmingContext, type ArmingSettings } from '../components/Arming.js';

/** Arming off: every card behaves as if it had been on screen for a while. */
export const SETTLED: ArmingSettings = { ms: 0, clock: () => 0 };

export function settled(element: ReactElement): ReactElement {
  return <ArmingContext value={SETTLED}>{element}</ArmingContext>;
}

/**
 * A clock that reads `shownAt` the first time (when the card is first shown) and `then` every time after: one static
 * render of a card that was shown at `shownAt` and is drawn (or pressed) at `then`.
 */
export function clockFrom(shownAt: number, then: number): () => number {
  let first = true;
  return () => {
    if (!first) return then;
    first = false;
    return shownAt;
  };
}
