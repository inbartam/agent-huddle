import { describe, expect, it } from 'vitest';
import { agentKey } from '@huddle/shared';
import { BrokerSim, payloads, T0, TIMEOUT_MS } from '../test/broker-sim.js';
import { SELF_RELEASE_MARGIN_MS } from './model.js';

const MAIN = agentKey('session-1');

function paused() {
  const sim = new BrokerSim().startSession();
  expect(sim.command({ type: 'agent.pause', agentKey: MAIN }).result).toEqual({ ok: true });
  return sim;
}

describe('pause (F13)', () => {
  it('agent.pause -> control.applied pause (pausePending); the next PreToolUse is held with hold.started', () => {
    const sim = paused();
    expect(sim.ofType('control.applied')).toEqual([expect.objectContaining({ action: 'pause', source: 'user' })]);
    expect(sim.state.agents[MAIN]?.pausePending).toBe(true);

    const { held, fx } = sim.post(payloads.preToolUse('tu-1'));
    const limitAt = T0 + TIMEOUT_MS - SELF_RELEASE_MARGIN_MS;
    expect(held).toMatchObject({ kind: 'pause', toolUseId: 'tu-1' });
    expect(fx.hold?.timers).toEqual([{ at: limitAt, kind: 'hold_limit' }]);
    expect(sim.ofType('hold.started')).toEqual([expect.objectContaining({ toolUseId: 'tu-1', limitAt })]);
    expect(sim.state.agents[MAIN]).toMatchObject({ status: 'paused', pausePending: false });
  });

  it('parallel PreToolUses of a paused agent are all held', () => {
    const sim = paused();
    sim.post(payloads.preToolUse('tu-1'));
    sim.post(payloads.preToolUse('tu-2'));
    sim.post(payloads.preToolUse('tu-3'));
    expect(sim.held.map((h) => h.toolUseId)).toEqual(['tu-1', 'tu-2', 'tu-3']);
  });

  it('pause twice is ok and writes nothing new; an unknown agent is not_found', () => {
    const sim = paused();
    expect(sim.command({ type: 'agent.pause', agentKey: MAIN }).result).toMatchObject({ ok: true });
    expect(sim.ofType('control.applied')).toHaveLength(1);
    expect(sim.command({ type: 'agent.pause', agentKey: 'nobody' }).result).toMatchObject({ code: 'not_found' });
  });

  it('an ended agent cannot be paused', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.sessionEnd());
    expect(sim.command({ type: 'agent.pause', agentKey: MAIN }).result).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
  });

  it('resume releases every held call (notes ride on the first) -> hold.ended resumed each', () => {
    const sim = paused();
    const a = sim.post(payloads.preToolUse('tu-1')).held;
    const b = sim.post(payloads.preToolUse('tu-2')).held;
    if (a === null || b === null) throw new Error('not held');
    sim.command({ type: 'agent.message', agentKey: MAIN, text: 'use pnpm', delivery: 'next_tool' });
    expect(sim.command({ type: 'agent.resume', agentKey: MAIN }).result).toEqual({ ok: true });
    expect(sim.answers.get(a.holdId)).toEqual({ kind: 'preToolUse.note', text: 'use pnpm' });
    expect(sim.answers.get(b.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('hold.ended').map((e) => [e.toolUseId, e.why])).toEqual([
      ['tu-1', 'resumed'],
      ['tu-2', 'resumed'],
    ]);
    expect(sim.ofType('message.delivered')).toEqual([expect.objectContaining({ via: 'pre_tool_context' })]);
    expect(sim.state.agents[MAIN]).toMatchObject({ status: 'working', hold: null, outbox: [] });
    // Not paused any more: the next call goes through.
    expect(sim.post(payloads.preToolUse('tu-3')).held).toBeNull();
  });

  it('resume before the next tool call calls the pending pause off', () => {
    const sim = paused();
    expect(sim.command({ type: 'agent.resume', agentKey: MAIN }).result).toEqual({ ok: true });
    expect(sim.state.agents[MAIN]?.pausePending).toBe(false);
    expect(sim.post(payloads.preToolUse('tu-1')).held).toBeNull();
  });

  it('resume of an agent that is not paused is expired', () => {
    const sim = new BrokerSim().startSession();
    expect(sim.command({ type: 'agent.resume', agentKey: MAIN }).result).toMatchObject({ code: 'expired' });
  });

  it('AskUserQuestion while paused takes the question path', () => {
    const sim = paused();
    const { held } = sim.post(payloads.ask('tu-q'));
    expect(held?.kind).toBe('question');
  });

  it('all.pause pauses every live attached agent (not replayed or ended ones); all.resume releases them', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.subagentStart('sub-1'));
    // A replayed session from before this run: left alone.
    sim.now = T0;
    sim.huddleStartedAt = T0 + 1;
    sim.post({ ...payloads.sessionStart(), session_id: 'old-session' });
    sim.huddleStartedAt = T0 - 60_000;
    // Mark the old session as last seen before the start.
    const old = sim.state.agents['old-session'];
    if (!old) throw new Error('no old session');
    sim.state = { ...sim.state, agents: { ...sim.state.agents, 'old-session': { ...old, lastEventAt: T0 - 120_000 } } };

    const fx = sim.command({ type: 'all.pause' });
    expect(fx.result).toMatchObject({ ok: true, detail: 'Pausing 2 agents.' });
    expect(sim.ofType('control.applied').map((e) => e.agentKey)).toEqual([MAIN, agentKey('session-1', 'sub-1')]);

    const held = sim.post({ ...payloads.preToolUse('tu-s'), agent_id: 'sub-1' }).held;
    expect(held?.agentKey).toBe(agentKey('session-1', 'sub-1'));
    expect(sim.command({ type: 'all.resume' }).result).toMatchObject({ ok: true, detail: 'Resuming 2 agents.' });
    expect(sim.held).toEqual([]);
    expect(sim.ofType('hold.ended')[0]?.why).toBe('resumed');
  });
});

describe('pause endings', () => {
  function heldPause() {
    const sim = paused();
    const { held } = sim.post(payloads.preToolUse('tu-1'));
    if (held === null) throw new Error('not held');
    return { sim, held };
  }

  it('self-release at the hold limit -> no decision, hold.ended hold_limit, the agent continues', () => {
    const { sim, held } = heldPause();
    sim.now = T0 + TIMEOUT_MS - SELF_RELEASE_MARGIN_MS;
    sim.timer(held.holdId, 'hold_limit');
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('hold.ended')[0]).toMatchObject({ why: 'hold_limit', toolUseId: 'tu-1' });
    expect(sim.state.agents[MAIN]?.status).toBe('working');
  });

  it('Claude Code closed it -> hold.ended closed_by_claude_code, with a warning', () => {
    const { sim, held } = heldPause();
    sim.now = T0 + 10_000;
    const fx = sim.close(held.holdId, 'closed_by_claude_code');
    expect(sim.ofType('hold.ended')[0]?.why).toBe('closed_by_claude_code');
    expect(fx.warnings).toEqual([expect.objectContaining({ data: { agentKey: MAIN, heldMs: 10_000 } })]);
  });

  it('shutdown -> no decision, hold.ended shutdown', () => {
    const { sim, held } = heldPause();
    sim.run({ type: 'shutdown' });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('hold.ended')[0]?.why).toBe('shutdown');
  });

  it('a refused pause hold writes nothing and stays pending', () => {
    const sim = paused();
    const { fx } = sim.post(payloads.preToolUse('tu-1'));
    if (fx.hold === null) throw new Error('no plan');
    // Undo the started hold the sim applied, as if the server had refused it.
    sim.held = [];
    const out = sim.run({ type: 'refused', plan: fx.hold, why: 'cap' });
    expect(out.events).toEqual([]);
  });
});
