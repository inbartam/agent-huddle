/**
 * The broker runtime (broker.ts) with a fake HeldHandle: what happens when starting a hold throws, and when an answer
 * cannot be sent because the hold ended without its close listener being told (security review L3).
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import type { HeldHandle, HoldClosedReason } from '../ingest/hook-server.js';
import { parseHookPayload } from '../ingest/schemas.js';
import { hookFacts } from '../normalize/hook-facts.js';
import { normalizeHook } from '../normalize/hooks.js';
import { initialState, reduce, type ReducerState } from '../state/reduce.js';
import { payloads, T0, TIMEOUT_MS } from '../test/broker-sim.js';
import { Broker } from './broker.js';

const MAIN = agentKey('session-1');

class FakeHandle implements HeldHandle {
  closed = false;
  sent: unknown[] = [];
  listeners: ((why: HoldClosedReason) => void)[] = [];
  respond(body: unknown): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.sent.push(body);
    return true;
  }
  onClosed(cb: (why: HoldClosedReason) => void): void {
    this.listeners.push(cb);
  }
}

function harness() {
  let state: ReducerState = initialState();
  let n = 0;
  const log: HuddleEvent[] = [];
  const warnings: string[] = [];
  let failAccept: ((events: readonly HuddleEvent[]) => boolean) | null = null;
  const nextId = (): string => `id-${String((n += 1))}`;
  const feed = (events: readonly HuddleEvent[]): void => {
    for (const e of events) {
      state = reduce(state, e);
      log.push(e);
    }
  };
  const broker = new Broker({
    now: () => T0,
    nextId,
    getState: () => state,
    questionHoldSeconds: () => 120,
    huddleStartedAt: () => T0 - 60_000,
    timeouts: { permissionRequest: TIMEOUT_MS, preToolUse: TIMEOUT_MS },
    accept: (events) => {
      if (failAccept?.(events) === true) throw new Error('store is broken');
      feed(events);
    },
    warn: (message) => warnings.push(message),
  });
  const post = (payload: Record<string, unknown>) => {
    const parsed = parseHookPayload(payload);
    if (!parsed.ok) throw new Error(parsed.error);
    feed(normalizeHook(parsed, { receivedAt: new Date(T0).toISOString(), nextId }));
    return broker.onHook({}, hookFacts(parsed), T0, { approvalRequestId: null, questionRequestId: null });
  };
  post(payloads.sessionStart());
  post(payloads.prompt());
  return {
    broker,
    post,
    log,
    warnings,
    state: () => state,
    failWhen: (f: (events: readonly HuddleEvent[]) => boolean) => {
      failAccept = f;
    },
  };
}

describe('Broker runtime: holds that cannot run their normal course (L3)', () => {
  it('a hold whose start throws is forgotten, its ending written, and the error goes to the server', () => {
    const h = harness();
    expect(h.broker.command({ type: 'agent.pause', agentKey: MAIN })).toEqual({ ok: true });
    const decision = h.post(payloads.preToolUse('tu-1'));
    if (!('hold' in decision)) throw new Error('expected a hold');
    h.failWhen((events) => events.some((e) => e.type === 'hold.started'));
    const handle = new FakeHandle();
    expect(() => {
      decision.hold(handle);
    }).toThrow('store is broken');
    expect(h.broker.heldCount()).toBe(0);
    expect(h.warnings).toContain('a hold failed to start and was answered with no decision');
    expect(h.log.filter((e) => e.type === 'hold.ended')).toEqual([expect.objectContaining({ why: 'shutdown' })]);
    // Nothing is left to answer, and a later resume does not try to answer a dead hold.
    h.failWhen(() => false);
    expect(h.broker.command({ type: 'agent.resume', agentKey: MAIN })).toEqual({ ok: true });
    expect(handle.sent).toEqual([]);
  });

  it('an answer that cannot be sent because the hold already ended unseen drops the entry and its timers', () => {
    const h = harness();
    expect(h.broker.command({ type: 'agent.pause', agentKey: MAIN })).toEqual({ ok: true });
    const decision = h.post(payloads.preToolUse('tu-1'));
    if (!('hold' in decision)) throw new Error('expected a hold');
    const handle = new FakeHandle();
    decision.hold(handle);
    expect(h.broker.heldCount()).toBe(1);
    expect(h.state().agents[MAIN]?.status).toBe('paused');
    // The server ended the hold itself (say after a failure) without calling the close listeners.
    handle.closed = true;
    expect(h.broker.command({ type: 'agent.resume', agentKey: MAIN })).toMatchObject({ ok: false, code: 'expired' });
    expect(h.broker.heldCount()).toBe(0);
    expect(handle.listeners).toHaveLength(1);
  });
});
