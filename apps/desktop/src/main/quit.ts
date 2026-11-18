/**
 * The one quit path. Every way out (tray Quit, app.quit(), a second Ctrl+Q, Windows ending the session)
 * goes through `requestQuit`: the first call blocks the quit, runs `shutdown` once (bounded, never rejects),
 * then quits for real; calls while that runs are swallowed; the final quit passes straight through.
 *
 * Electron-free so it can be tested: main passes `app.quit` as `quit`.
 */

export type QuitPhase = 'running' | 'shutting-down' | 'done';

export interface QuitGuard {
  /**
   * Call from `before-quit`. Returns true when the caller must `event.preventDefault()` (quit held until
   * shutdown finishes), false when the quit may proceed.
   */
  requestQuit(): boolean;
  /** Resolves when shutdown has finished (or its time ran out). Same promise for every caller. */
  readonly finished: Promise<void>;
  phase(): QuitPhase;
}

export interface QuitGuardDeps {
  /** Release everything: core.dispose() (held responses, hooks detached, store flushed), save widget bounds. */
  shutdown: () => Promise<unknown>;
  /** Quit for real (app.quit). Called once, after shutdown. */
  quit: () => void;
  /** Upper bound for shutdown. HuddleCore bounds itself at 3 s; this is the backstop. */
  timeoutMs: number;
  onError?: (error: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let phase: QuitPhase = 'running';
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ??
    ((h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    });

  const run = async (): Promise<void> => {
    let timer: unknown = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimer(resolve, deps.timeoutMs);
    });
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(deps.shutdown()).catch((error: unknown) => deps.onError?.(error));
    } catch (error) {
      deps.onError?.(error);
      work = Promise.resolve();
    }
    await Promise.race([work, timeout]);
    clearTimer(timer);
  };

  return {
    requestQuit() {
      if (phase === 'done') return false;
      if (phase === 'shutting-down') return true;
      phase = 'shutting-down';
      void run().finally(() => {
        phase = 'done';
        resolveFinished();
        deps.quit();
      });
      return true;
    },
    finished,
    phase: () => phase,
  };
}
