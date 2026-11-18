/**
 * Event id generator for the ingest edge (no ULID library, per the M1 plan).
 *
 * An id is `<time><counter>`: the receive time in milliseconds and a per-millisecond counter, both in
 * fixed-width base 36. Fixed width means the plain string order is the creation order, so ids sort
 * by time without parsing. The generator is monotonic: if the clock stands still or steps back, it
 * keeps the last time and counts up, so a later id never sorts before an earlier one.
 *
 * The clock is injected so tests are exact. Reducers never call this; ids are created here, at the edge.
 */

/** 9 base-36 digits hold every millisecond until the year 5188. */
const TIME_WIDTH = 9;
/** 4 base-36 digits: 1,679,616 ids per millisecond before the time part is advanced. */
const COUNTER_WIDTH = 4;
const COUNTER_MAX = 36 ** COUNTER_WIDTH - 1;

export interface IdGeneratorOptions {
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export type IdGenerator = () => string;

export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? Date.now;
  let lastTime = -1;
  let counter = 0;

  return () => {
    const raw = now();
    const time = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    if (time > lastTime) {
      lastTime = time;
      counter = 0;
    } else if (counter < COUNTER_MAX) {
      counter += 1;
    } else {
      // Counter exhausted within one millisecond: borrow the next millisecond to stay unique and sorted.
      lastTime += 1;
      counter = 0;
    }
    return lastTime.toString(36).padStart(TIME_WIDTH, '0') + counter.toString(36).padStart(COUNTER_WIDTH, '0');
  };
}
