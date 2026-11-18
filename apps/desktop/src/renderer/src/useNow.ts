/**
 * The renderer's clock. Selectors take `now` as a parameter (they stay pure); components get it from here and
 * re-render every `intervalMs`, so an ETA moves without a new event. Tests pass `now` as a prop instead.
 * `null` starts no timer (a parent already ticks and passes its `now` down).
 */
import { useEffect, useState } from 'react';

export const NOW_TICK_MS = 5000;

export function useNow(intervalMs: number | null = NOW_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
