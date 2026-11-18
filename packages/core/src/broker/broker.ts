/**
 * The broker's runtime (M3 WP5): owns the held hook responses and their timers, asks the pure `decide` what to do,
 * and applies the answer. Every event goes through the `accept` it is given (HuddleCore's reducer path), so the only
 * state kept here is the handles and timers themselves plus the plain entries that describe them.
 *
 * Fail open (CONTRIBUTING.md rule 5). Every held response ends exactly once, and each ending writes its event:
 *  1. user (a command) or 2. rule (decided at arrival, never held) -> `respond(body)`;
 *  3. Claude Code closed the request -> `HeldHandle.onClosed('closed_by_claude_code')`;
 *  4. shutdown -> `shutdown()` answers every hold with no decision and writes the events before the log closes; a hold
 *     the server releases itself (`onClosed('shutdown')`) is recorded the same way.
 * Plus the self-release timer at timeout - 5 s, so the Huddle never loses the race against Claude Code's timeout.
 * A hold the server refused (cap, or closing) is answered with no decision by the server; `holdRefused` records it.
 *
 * When `respond` fails (Claude Code had already gone), the answer's events are not written: the handle's close
 * listener records the real ending instead, and the command reports `expired`.
 */
import type { CommandResult, HuddleEvent, HuddleState } from '@huddle/shared';
import { hookReply } from '../ingest/hook-replies.js';
import type { HeldHandle, HoldClosedReason, HoldRefusedReason, HookDecision } from '../ingest/hook-server.js';
import type { HookFacts } from '../normalize/hook-facts.js';
import { decide } from './decide.js';
import { queueMessage } from './outbox.js';
import { pauseAgent } from './pause.js';
import type {
  BrokerCommand,
  BrokerCtx,
  BrokerEffects,
  BrokerInput,
  BrokerView,
  HeldEntry,
  HoldPlan,
  HoldTimeoutsMs,
  RuleHook,
  TimerKind,
} from './model.js';

export interface BrokerDeps {
  now: () => number;
  nextId: () => string;
  /** The reducer's state right now. */
  getState: () => HuddleState;
  /** Read on every decision, so a settings change applies to the next question. */
  questionHoldSeconds: () => number;
  huddleStartedAt: () => number | null;
  timeouts: HoldTimeoutsMs;
  /** Reduce and store events (HuddleCore's accept). Must not throw. */
  accept: (events: readonly HuddleEvent[]) => void;
  warn: (message: string, data: Record<string, unknown>) => void;
  ruleDecision?: RuleHook;
  /** Is this managed run's process alive (RunHost.isAlive)? Absent: none is (rules treat every session as attached). */
  runLive?: (runId: string) => boolean;
}

interface Held {
  entry: HeldEntry;
  handle: HeldHandle;
  timers: NodeJS.Timeout[];
}

const GONE: CommandResult = {
  ok: false,
  code: 'expired',
  message: 'Claude Code had already moved on, so nothing was sent.',
};

export class Broker {
  private readonly deps: BrokerDeps;
  private readonly held = new Map<string, Held>();
  /** Holds planned for a hook but not started yet, by the hook's parse result (to record a refused hold). */
  private readonly planned = new WeakMap<object, HoldPlan>();
  private stopped = false;

  constructor(deps: BrokerDeps) {
    this.deps = deps;
  }

  /** Holds open right now. */
  heldCount(): number {
    return this.held.size;
  }

  /** Plain copies of the held entries, oldest first (tests and diagnostics). */
  heldEntries(): HeldEntry[] {
    return [...this.held.values()].map((h) => h.entry);
  }

  /**
   * A hook arrived; its own events are already reduced. Synchronous, no I/O: it runs on the agent's critical path.
   * `key` identifies this hook for `holdRefused`.
   */
  onHook(
    key: object,
    facts: HookFacts,
    receivedAt: number,
    ids: { approvalRequestId: string | null; questionRequestId: string | null },
  ): HookDecision {
    const fx = this.run({ type: 'hook', facts, receivedAt, ...ids });
    this.apply(fx);
    const plan = fx.hold;
    if (plan === null) return { now: hookReply(fx.reply) };
    if (this.stopped) {
      // Quitting: never start a hold now. Recorded as refused while closing.
      this.apply(this.run({ type: 'refused', plan, why: 'closing' }));
      return { now: null };
    }
    this.planned.set(key, plan);
    return {
      hold: (handle) => {
        this.planned.delete(key);
        this.start(plan, handle);
      },
    };
  }

  /** The server answered a planned hold with no decision instead of holding it. */
  holdRefused(key: object, why: HoldRefusedReason): void {
    const plan = this.planned.get(key);
    if (plan === undefined) return;
    this.planned.delete(key);
    this.apply(this.run({ type: 'refused', plan, why }));
  }

  /** A command from the desktop, or (M6, `via: 'phone'`) one a paired phone sent (ADR-024 approvals, ADR-030 the rest). */
  command(cmd: BrokerCommand, origin?: { via: 'phone' }): CommandResult {
    if (this.stopped) return { ok: false, code: 'failed', message: 'Agent Huddle is shutting down.' };
    const fx = this.run({ type: 'command', command: cmd, ...(origin !== undefined ? { via: origin.via } : {}) });
    const failed = this.apply(fx);
    const result = fx.result ?? { ok: true };
    return failed > 0 && result.ok ? GONE : result;
  }

  /**
   * A pause the Huddle asks for itself (a budget, F19): the same path and checks as `agent.pause`, but the
   * `control.applied` it writes has source 'huddle' and `detail` (the budget item's id). Already paused: ok.
   */
  pauseByHuddle(agentKey: string, detail: string | null): CommandResult {
    if (this.stopped) return { ok: false, code: 'failed', message: 'Agent Huddle is shutting down.' };
    const fx = pauseAgent(this.view(), agentKey, this.ctx(), { source: 'huddle', detail });
    this.apply(fx);
    return fx.result ?? { ok: true };
  }

  /**
   * A message the Huddle writes itself (M6 P5b, ADR-027: the lead check on an idle teammate): the same path and checks
   * as the user's `agent.message`, but `message.queued` has source 'huddle', so it is delivered without the "from the
   * user" prefix. Resolves the result and the queued message's id (null when it was refused).
   */
  messageByHuddle(
    agentKey: string,
    text: string,
    delivery: 'auto' | 'next_tool' | 'turn_end',
  ): { result: CommandResult; messageId: string | null } {
    if (this.stopped)
      return { result: { ok: false, code: 'failed', message: 'Agent Huddle is shutting down.' }, messageId: null };
    const fx = queueMessage(this.view(), { agentKey, text, delivery }, this.ctx(), 'huddle');
    this.apply(fx);
    const queued = fx.events.find((e) => e.type === 'message.queued');
    return {
      result: fx.result ?? { ok: true },
      messageId: queued?.type === 'message.queued' ? queued.messageId : null,
    };
  }

  /** Ending 4: answer every hold with no decision and write the endings. No hold starts afterwards. */
  shutdown(): void {
    this.stopped = true;
    this.apply(this.run({ type: 'shutdown' }));
    // Anything left (a respond that failed) is closed already; its listener has recorded it. Drop the timers.
    for (const held of this.held.values()) this.clearTimers(held);
    this.held.clear();
  }

  // -------------------------------------------------------------------------------------------------------------------

  private view(): BrokerView {
    const deps = this.deps;
    return {
      state: deps.getState(),
      held: [...this.held.values()].map((h) => h.entry),
      questionHoldSeconds: deps.questionHoldSeconds(),
      timeouts: deps.timeouts,
      huddleStartedAt: deps.huddleStartedAt(),
      ...(deps.ruleDecision !== undefined ? { ruleDecision: deps.ruleDecision } : {}),
      ...(deps.runLive !== undefined ? { runLive: deps.runLive } : {}),
    };
  }

  private ctx(): BrokerCtx {
    return { now: this.deps.now(), nextId: this.deps.nextId };
  }

  private run(input: BrokerInput): BrokerEffects {
    return decide(this.view(), input, this.ctx());
  }

  /**
   * Starts a hold. Exception-safe: if anything here throws, the server answers the request with no decision and no
   * close listener will ever fire, so the entry and its timers are removed here (a pause entry left behind would keep
   * holding the agent's tool calls), the ending is written as a release (`shutdown`: the Huddle answered with no
   * decision), and the error goes on to the server, which counts it.
   */
  private start(plan: HoldPlan, handle: HeldHandle): void {
    const entry = plan.entry;
    const now = this.deps.now();
    const held: Held = { entry, handle, timers: [] };
    this.held.set(entry.holdId, held);
    try {
      for (const timer of plan.timers) {
        const t = setTimeout(
          () => {
            this.onTimer(entry.holdId, timer.kind);
          },
          Math.max(0, timer.at - now),
        );
        t.unref();
        held.timers.push(t);
      }
      handle.onClosed((why) => {
        this.onClosed(entry.holdId, why);
      });
      this.deps.accept(plan.events);
    } catch (error) {
      this.abandon(held);
      throw error;
    }
  }

  /** A hold that failed to start: forget it, and record its ending if that can be done. Never throws. */
  private abandon(held: Held): void {
    const holdId = held.entry.holdId;
    if (this.held.get(holdId) !== held) return;
    let fx: BrokerEffects | null;
    try {
      fx = this.run({ type: 'closed', holdId, why: 'shutdown' });
    } catch {
      fx = null;
    }
    this.held.delete(holdId);
    this.clearTimers(held);
    try {
      if (fx !== null) {
        for (const w of fx.warnings) this.deps.warn(w.message, w.data);
        if (fx.events.length > 0) this.deps.accept(fx.events);
      }
      this.deps.warn('a hold failed to start and was answered with no decision', { agentKey: held.entry.agentKey });
    } catch {
      // The server answers with no decision anyway; nothing more can be done here.
    }
  }

  private onTimer(holdId: string, kind: TimerKind): void {
    if (!this.held.has(holdId)) return;
    this.apply(this.run({ type: 'timer', holdId, kind }));
  }

  private onClosed(holdId: string, why: HoldClosedReason): void {
    const held = this.held.get(holdId);
    if (held === undefined) return;
    const fx = this.run({ type: 'closed', holdId, why });
    this.held.delete(holdId);
    this.clearTimers(held);
    this.apply(fx);
  }

  /** Applies effects. Returns how many answers could not be sent (the request had already ended). */
  private apply(fx: BrokerEffects): number {
    for (const w of fx.warnings) this.deps.warn(w.message, w.data);
    if (fx.events.length > 0) this.deps.accept(fx.events);
    let failed = 0;
    for (const release of fx.releases) {
      const held = this.held.get(release.holdId);
      if (held === undefined) {
        failed += 1;
        continue;
      }
      // If Claude Code is already gone, respond() returns false and the close listener records the ending.
      const sent = held.handle.respond(hookReply(release.reply));
      if (!sent) {
        failed += 1;
        // Normally the close listener has already removed the entry. If the hold ended without telling it (the server
        // answered it after a failure), it never will: drop the entry and its timers so nothing waits on it.
        if (held.handle.closed && this.held.get(release.holdId) === held) {
          this.held.delete(release.holdId);
          this.clearTimers(held);
        }
        continue;
      }
      this.held.delete(release.holdId);
      this.clearTimers(held);
      this.deps.accept(release.events);
    }
    return failed;
  }

  private clearTimers(held: Held): void {
    for (const t of held.timers.splice(0)) clearTimeout(t);
  }
}
