/**
 * Ask the Huddle (M5, F25): keeps the ask's own `claude -p` session out of the Huddle's tree. Defence in depth.
 *
 * S18 (d) showed `--settings {"disableAllHooks":true}` gives zero hook events, so no hook from the ask is expected.
 * Two ways it could still reach the Huddle, both handled here, on HuddleEvents only (no payload field names):
 *  1. Hooks, if `disableAllHooks` ever stopped applying (a managed-policy hook, a future Claude Code): the first hook
 *     is SessionStart, whose `session.started` names the cwd, and the ask's cwd is a fresh folder only the ask uses.
 *     A `session.started` whose cwd is (inside) an ask folder marks its session as the ask's; every event of a marked
 *     session is dropped, from then on and after the ask (the id is remembered).
 *  2. Telemetry. The installer puts the OTEL variables in the `env` block of the user's settings.json, which
 *     `disableAllHooks` does not touch, so an ask probably exports its `api_request` records to the Huddle
 *     (S18 did not test OTEL: "OTEL export from the user env block: not tested"). The reducer does not make a tree
 *     node from telemetry alone (usage of an unknown agent is parked as pending), but the events would be stored, so
 *     the ask would show in History as a run of its own. Telemetry carries no cwd, and the
 *     ask's session id is known only from its json result at the end. So while an ask runs, telemetry and status line
 *     events of a session the state does not know yet are held back here; when the ask ends, those of the ask's session
 *     id are dropped and the rest released (in order). An ask that ended without a session id (timeout, cancel) drops
 *     held events of sessions still unknown to the state: a real session that sends only telemetry (no hooks) and
 *     started during that ask loses its first few seconds of usage, the safe direction.
 *
 * Hook events are never held: a real session's hooks must reach the broker at once.
 * No clock, no I/O; the caller says which sessions the state knows.
 */
import type { HuddleEvent } from '@huddle/shared';
import { isPathInside, samePath } from './worktree.js';

/** Ask session ids and folders remembered after their ask (late events are still dropped). */
const REMEMBERED = 64;
/** Most events held back during one ask; beyond it the oldest are released (fail open). */
export const ASK_GUARD_HOLD_MAX = 5000;

export class AskGuard {
  private readonly dropped = new Set<string>();
  private readonly folders: string[] = [];
  private active = false;
  private held: HuddleEvent[] = [];
  private readonly platform: NodeJS.Platform;
  /** Events dropped so far (stats). */
  droppedCount = 0;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
  }

  /** An ask is about to start in `folder`. */
  begin(folder: string): void {
    this.active = true;
    this.folders.push(folder);
    if (this.folders.length > REMEMBERED) this.folders.shift();
  }

  /** Marks a session id as the ask's: its events are dropped from now on. */
  markSession(sessionId: string): void {
    this.dropped.add(sessionId);
    if (this.dropped.size > REMEMBERED) {
      const first = this.dropped.values().next();
      if (first.done !== true) this.dropped.delete(first.value);
    }
  }

  isAskSession(sessionId: string): boolean {
    return this.dropped.has(sessionId);
  }

  private inAskFolder(cwd: string | null): boolean {
    if (cwd === null) return false;
    return this.folders.some((f) => samePath(f, cwd, this.platform) || isPathInside(f, cwd, this.platform));
  }

  /**
   * Hook events: the ones to accept now. A `session.started` in an ask folder marks its session first.
   */
  admitHook(events: readonly HuddleEvent[]): HuddleEvent[] {
    for (const e of events) if (e.type === 'session.started' && this.inAskFolder(e.cwd)) this.markSession(e.sessionId);
    return this.drop(events);
  }

  /**
   * Telemetry and status line events: the ones to accept now. While an ask runs, events of a session `known` does not
   * know are held back until `end`.
   */
  admitOther(events: readonly HuddleEvent[], known: (sessionId: string) => boolean): HuddleEvent[] {
    const kept = this.drop(events);
    if (!this.active) return kept;
    const now: HuddleEvent[] = [];
    for (const e of kept) {
      if (known(e.sessionId)) now.push(e);
      else this.held.push(e);
    }
    if (this.held.length > ASK_GUARD_HOLD_MAX) now.push(...this.held.splice(0, this.held.length - ASK_GUARD_HOLD_MAX));
    return now;
  }

  /**
   * The ask ended; `sessionId` is its session from the result (null when unknown). Returns the held events to accept
   * now, oldest first.
   */
  end(sessionId: string | null, known: (sessionId: string) => boolean): HuddleEvent[] {
    if (sessionId !== null) this.markSession(sessionId);
    this.active = false;
    const held = this.held;
    this.held = [];
    const out = this.drop(held);
    return sessionId !== null ? out : this.countDropped(out, (e) => known(e.sessionId));
  }

  private drop(events: readonly HuddleEvent[]): HuddleEvent[] {
    if (this.dropped.size === 0) return [...events];
    return this.countDropped(events, (e) => !this.dropped.has(e.sessionId));
  }

  private countDropped(events: readonly HuddleEvent[], keep: (e: HuddleEvent) => boolean): HuddleEvent[] {
    const out = events.filter(keep);
    this.droppedCount += events.length - out.length;
    return out;
  }
}
