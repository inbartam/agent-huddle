/**
 * While the core is still bringing older history in (M5, F22), the runs list asks again so it "shows what has arrived
 * so far" (DESIGN.md "History (F22)", import). The last answer said `migrating: true`: ask again every 2 s, one
 * question in flight at a time, and stop at the first answer that says `migrating: false`.
 *
 * The timer is injected so tests can step it; the renderer passes the window's `setTimeout`.
 */
import type { RunsAnswer } from './history-query.js';

export const MIGRATING_REFRESH_MS = 2000;

export interface Scheduler {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export const windowScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

type Answered = Extract<RunsAnswer, { ok: true }>;

export interface MigrationPoll {
  /** Ask after one interval (or now, with `now`). Does nothing while a question is in flight or after `stop`. */
  start: (now?: boolean) => void;
  /** Ask once now (window focus, the view shown again), unless a question is already in flight. */
  poke: () => void;
  stop: () => void;
  /** True while a timer is set or a question is in flight. */
  readonly active: boolean;
}

export function migrationPoll(opts: {
  load: () => Promise<RunsAnswer>;
  onAnswer: (a: Answered) => void;
  scheduler?: Scheduler;
  intervalMs?: number;
}): MigrationPoll {
  const scheduler = opts.scheduler ?? windowScheduler;
  const interval = opts.intervalMs ?? MIGRATING_REFRESH_MS;
  let timer: unknown = null;
  let inFlight = false;
  let stopped = false;
  let done = false;

  const clear = () => {
    if (timer !== null) scheduler.clear(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped || done || inFlight || timer !== null) return;
    timer = scheduler.set(() => {
      timer = null;
      ask();
    }, interval);
  };

  const ask = () => {
    if (stopped || done || inFlight) return;
    clear();
    inFlight = true;
    opts.load().then(
      (a) => {
        inFlight = false;
        if (stopped) return;
        if (a.ok) {
          opts.onAnswer(a);
          if (!a.migrating) {
            done = true;
            return;
          }
        }
        // A failed question keeps the rows shown; the last good answer still said migrating, so ask again.
        schedule();
      },
      () => {
        inFlight = false;
        schedule();
      },
    );
  };

  return {
    start: (now = false) => {
      if (now) ask();
      else schedule();
    },
    poke: ask,
    stop: () => {
      stopped = true;
      clear();
    },
    get active() {
      return !stopped && !done && (inFlight || timer !== null);
    },
  };
}
