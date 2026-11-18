/**
 * The arming delay as a hook (timing in view/arming.ts). The clock and the delay come from a context so tests can
 * inject them; the app uses the defaults (Date.now, ARMING_MS).
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { ARMING_MS, isArmed, pressWhenArmed } from '../view/arming.js';

export interface ArmingSettings {
  /** How long a newly shown request ignores presses; 0 turns arming off. */
  ms: number;
  clock: () => number;
}

export const ArmingContext = createContext<ArmingSettings>({ ms: ARMING_MS, clock: () => Date.now() });

export interface Arming {
  /** Presses count now (for drawing the buttons). */
  armed: boolean;
  /** Run a press only if the card is armed at the moment of the press. */
  guard: (press: () => void) => void;
}

/** Arms `itemId`'s card ARMING_MS after it is first shown, and again from the start when the item changes. */
export function useArming(itemId: string): Arming {
  const { ms, clock } = useContext(ArmingContext);
  const [shown, setShown] = useState(() => ({ id: itemId, at: clock() }));
  // Another item in the same card (same component instance): it gets its own delay.
  const at = shown.id === itemId ? shown.at : clock();
  if (shown.id !== itemId) setShown({ id: itemId, at });
  const armed = isArmed(at, clock(), ms);
  const [, rerender] = useState(0);
  useEffect(() => {
    if (armed) return;
    // Draw the buttons as on once the delay is over.
    const timer = setTimeout(
      () => {
        rerender((n) => n + 1);
      },
      Math.max(0, at + ms - clock()) + 10,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [armed, at, ms, clock]);
  return {
    armed,
    guard: (press) => {
      pressWhenArmed(at, clock(), ms, press);
    },
  };
}
