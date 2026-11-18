import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey } from '@huddle/shared';
import { BrokerSim, payloads } from '../test/broker-sim.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function scenario(): BrokerSim {
  const sim = new BrokerSim().startSession();
  sim.post(payloads.permission());
  sim.command({ type: 'agent.message', agentKey: agentKey('session-1'), text: 'hi', delivery: 'auto' });
  sim.command({ type: 'agent.pause', agentKey: agentKey('session-1') });
  sim.post(payloads.preToolUse('tu-1'));
  sim.post(payloads.ask('tu-2'));
  sim.now += 1000;
  sim.run({ type: 'shutdown' });
  return sim;
}

describe('decide', () => {
  it('is deterministic and reads no clock: same inputs, same effects and events', () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the broker read the clock');
    });
    const a = scenario();
    const b = scenario();
    expect(clock).not.toHaveBeenCalled();
    expect(a.log).toEqual(b.log);
    expect([...a.answers]).toEqual([...b.answers]);
  });

  it('never holds observation hooks, and answers them with no decision', () => {
    const sim = new BrokerSim().startSession();
    sim.command({ type: 'agent.pause', agentKey: agentKey('session-1') });
    for (const payload of [
      payloads.postToolUse('tu-1'),
      payloads.prompt(),
      payloads.subagentStart('sub-1'),
      payloads.subagentStop('sub-1'),
      payloads.sessionStart(),
    ]) {
      const { held, fx } = sim.post(payload);
      expect(held).toBeNull();
      expect(fx.reply).toEqual({ kind: 'none' });
    }
  });

  it('a PreToolUse of an unknown subagent passes through, even with everything paused', () => {
    const sim = new BrokerSim().startSession();
    sim.command({ type: 'all.pause' });
    const { held, fx } = sim.post({ ...payloads.preToolUse('tu-x'), agent_id: 'ghost' });
    expect(held).toBeNull();
    expect(fx.reply).toEqual({ kind: 'none' });
  });

  it('a hook from a session first seen now (Huddle started mid-session) is decided for the new root', () => {
    const sim = new BrokerSim();
    // No SessionStart: the reducer creates the root from this event, so the request is held.
    expect(sim.post(payloads.permission()).held?.kind).toBe('approval');
  });

  it('shutdown answers every hold with no decision and writes one ending each', () => {
    const sim = scenario();
    expect(sim.held).toEqual([]);
    expect(sim.ofType('approval.resolved').map((e) => e.by)).toEqual(['shutdown']);
    expect(sim.ofType('question.closed').map((e) => e.outcome)).toEqual(['shutdown']);
    expect(sim.ofType('hold.ended').map((e) => e.why)).toEqual(['shutdown']);
    expect([...sim.answers.values()].every((r) => r.kind === 'none')).toBe(true);
  });
});
