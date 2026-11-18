import { describe, expect, it, vi } from 'vitest';
import { createQuitGuard } from './quit.js';

describe('quit guard', () => {
  it('holds the first quit, disposes once, then lets the final quit through', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const quit = vi.fn();
    const guard = createQuitGuard({ shutdown, quit, timeoutMs: 3000 });

    expect(guard.requestQuit()).toBe(true); // tray Quit
    expect(guard.requestQuit()).toBe(true); // a second request while disposing (e.g. session end)
    expect(guard.phase()).toBe('shutting-down');
    await guard.finished;
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    // app.quit() fires before-quit again: it must pass through, not dispose a second time.
    expect(guard.requestQuit()).toBe(false);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('quits anyway when shutdown hangs past the bound', async () => {
    vi.useFakeTimers();
    try {
      const quit = vi.fn();
      const guard = createQuitGuard({ shutdown: () => new Promise(() => undefined), quit, timeoutMs: 3000 });
      guard.requestQuit();
      await vi.advanceTimersByTimeAsync(2999);
      expect(quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(quit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quits when shutdown rejects or throws, and reports the error', async () => {
    const errors: unknown[] = [];
    const quit = vi.fn();
    const rejecting = createQuitGuard({
      shutdown: () => Promise.reject(new Error('boom')),
      quit,
      timeoutMs: 3000,
      onError: (e) => errors.push(e),
    });
    rejecting.requestQuit();
    await rejecting.finished;
    const throwing = createQuitGuard({
      shutdown: () => {
        throw new Error('sync boom');
      },
      quit,
      timeoutMs: 3000,
      onError: (e) => errors.push(e),
    });
    throwing.requestQuit();
    await throwing.finished;
    expect(quit).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
  });
});
