import { describe, expect, it } from 'vitest';
import { agentKey, CLIP_LIMITS } from '@huddle/shared';
import { approvalItemId } from '../state/reduce.js';
import { BrokerSim, payloads, T0, TIMEOUT_MS } from '../test/broker-sim.js';
import { EXPIRY_WINDOW_MS, SELF_RELEASE_MARGIN_MS } from './model.js';

function heldApproval() {
  const sim = new BrokerSim().startSession();
  const { held, fx, normalized } = sim.post(payloads.permission());
  if (held === null) throw new Error('not held');
  const requested = normalized.find((e) => e.type === 'approval.requested');
  if (requested?.type !== 'approval.requested') throw new Error('no approval.requested');
  return { sim, held, fx, requestId: requested.request.requestId };
}

function openItem(sim: BrokerSim, requestId: string) {
  return sim.state.inbox.find((i) => i.id === approvalItemId(requestId));
}

describe('PermissionRequest is held (F10)', () => {
  it('holds a known agent request, correlated with its approval.requested id, self-release at timeout - 5 s', () => {
    const { sim, held, fx, requestId } = heldApproval();
    expect(held).toMatchObject({
      kind: 'approval',
      agentKey: agentKey('session-1'),
      requestId,
      receivedAt: T0,
      timeoutAt: T0 + TIMEOUT_MS,
    });
    expect(fx.hold?.timers).toEqual([{ at: T0 + TIMEOUT_MS - SELF_RELEASE_MARGIN_MS, kind: 'hold_limit' }]);
    expect(openItem(sim, requestId)?.resolvedAt).toBeNull();
    expect(sim.state.agents[agentKey('session-1')]?.status).toBe('waiting_approval');
  });

  it('never holds for an agent the reducer does not know (an unknown subagent)', () => {
    const sim = new BrokerSim().startSession();
    const { held, fx } = sim.post(payloads.permission({ agent_id: 'never-started' }));
    expect(held).toBeNull();
    expect(fx.reply).toEqual({ kind: 'none' });
  });

  it('never holds when the agent cannot be approved from the Huddle', () => {
    const sim = new BrokerSim().startSession();
    const key = agentKey('session-1');
    const node = sim.state.agents[key];
    if (!node) throw new Error('no node');
    sim.state = {
      ...sim.state,
      agents: { ...sim.state.agents, [key]: { ...node, capabilities: { ...node.capabilities, approve: false } } },
    };
    expect(sim.post(payloads.permission()).held).toBeNull();
  });
});

describe('approval endings', () => {
  it('1. user allows -> permission.allow, approval.resolved allowed by user', () => {
    const { sim, held, requestId } = heldApproval();
    const fx = sim.command({ type: 'approval.decide', requestId, decision: 'allow' });
    expect(fx.result).toEqual({ ok: true });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'permission.allow' });
    expect(sim.ofType('approval.resolved')).toEqual([
      expect.objectContaining({ requestId, outcome: 'allowed', by: 'user', policyRuleId: null, message: null }),
    ]);
    expect(openItem(sim, requestId)?.resolvedAt).toBe(T0);
    expect(sim.held).toEqual([]);
  });

  it('1. user denies with a message (trimmed, clipped) -> permission.deny with it', () => {
    const { sim, held, requestId } = heldApproval();
    const long = `  ${'x'.repeat(CLIP_LIMITS.message + 50)}  `;
    sim.command({ type: 'approval.decide', requestId, decision: 'deny', message: long });
    const reply = sim.answers.get(held.holdId);
    expect(reply?.kind).toBe('permission.deny');
    const message = reply?.kind === 'permission.deny' ? reply.message : undefined;
    expect(message?.length).toBe(CLIP_LIMITS.message);
    expect(sim.ofType('approval.resolved')[0]).toMatchObject({ outcome: 'denied', by: 'user', message });
  });

  it('1. deny without a message sends none', () => {
    const { sim, held, requestId } = heldApproval();
    sim.command({ type: 'approval.decide', requestId, decision: 'deny', message: '   ' });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'permission.deny' });
    expect(sim.ofType('approval.resolved')[0]?.message).toBeNull();
  });

  it('1. pass through -> no decision (Claude Code prompt carries on), passed_through by user', () => {
    const { sim, held, requestId } = heldApproval();
    expect(sim.command({ type: 'approval.passThrough', requestId }).result).toEqual({ ok: true });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('approval.resolved')[0]).toMatchObject({ outcome: 'passed_through', by: 'user' });
  });

  it('a second decision for the same request is expired; an unknown id is not_found', () => {
    const { sim, requestId } = heldApproval();
    sim.command({ type: 'approval.decide', requestId, decision: 'allow' });
    expect(sim.command({ type: 'approval.decide', requestId, decision: 'deny' }).result).toMatchObject({
      ok: false,
      code: 'expired',
    });
    expect(sim.command({ type: 'approval.passThrough', requestId }).result).toMatchObject({ code: 'expired' });
    expect(sim.command({ type: 'approval.decide', requestId: 'nope', decision: 'allow' }).result).toMatchObject({
      code: 'not_found',
    });
    expect(sim.ofType('approval.resolved')).toHaveLength(1);
  });

  it('2. a rule decides at arrival (M4 hook point): answered at once, by policy with the rule id, never held', () => {
    const sim = new BrokerSim().startSession();
    sim.ruleDecision = ({ request }) =>
      request.toolName === 'Bash' ? { decision: 'deny', ruleId: 'no-npm', message: 'Not here.' } : null;
    const { held, fx } = sim.post(payloads.permission());
    expect(held).toBeNull();
    // A rule's deny is sent as is (it names the rule), never with the user's DENY_PREFIX (M4).
    expect(fx.reply).toEqual({ kind: 'permission.denyByRule', message: 'Not here.' });
    expect(sim.ofType('approval.resolved')[0]).toMatchObject({
      outcome: 'denied',
      by: 'policy',
      policyRuleId: 'no-npm',
      message: 'Not here.',
      source: 'huddle',
    });
  });

  it('M3 has no rules: the default hook point never decides', () => {
    const sim = new BrokerSim().startSession();
    expect(sim.post(payloads.permission()).held).not.toBeNull();
  });

  it('3. Claude Code closes it early -> answered_elsewhere by claude_code', () => {
    const { sim, held, requestId } = heldApproval();
    sim.now = T0 + 30_000;
    sim.close(held.holdId, 'closed_by_claude_code');
    expect(sim.ofType('approval.resolved')).toEqual([
      expect.objectContaining({ requestId, outcome: 'answered_elsewhere', by: 'claude_code', ts: T0 + 30_000 }),
    ]);
    expect(openItem(sim, requestId)?.resolvedAt).toBe(T0 + 30_000);
  });

  it('3. Claude Code closes it at about its timeout -> expired by timeout (inferred from timing)', () => {
    const { sim, held } = heldApproval();
    sim.now = T0 + TIMEOUT_MS - EXPIRY_WINDOW_MS;
    sim.close(held.holdId, 'closed_by_claude_code');
    expect(sim.ofType('approval.resolved')[0]).toMatchObject({ outcome: 'expired', by: 'timeout' });
  });

  it('4. shutdown -> no decision, passed_through by shutdown', () => {
    const { sim, held } = heldApproval();
    sim.run({ type: 'shutdown' });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('approval.resolved')[0]).toMatchObject({ outcome: 'passed_through', by: 'shutdown' });
  });

  it('4. the server released it on shutdown (closed listener) -> by shutdown too', () => {
    const { sim, held } = heldApproval();
    sim.close(held.holdId, 'shutdown');
    expect(sim.ofType('approval.resolved')[0]).toMatchObject({ outcome: 'passed_through', by: 'shutdown' });
  });

  it('self-release at the hold limit -> no decision, expired by timeout', () => {
    const { sim, held } = heldApproval();
    sim.now = T0 + TIMEOUT_MS - SELF_RELEASE_MARGIN_MS;
    sim.timer(held.holdId, 'hold_limit');
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('approval.resolved')[0]).toMatchObject({ outcome: 'expired', by: 'timeout' });
  });

  it('a refused hold (cap) is recorded as passed through to Claude Code; while closing, by shutdown', () => {
    for (const [why, by] of [
      ['cap', 'claude_code'],
      ['closing', 'shutdown'],
    ] as const) {
      const sim = new BrokerSim().startSession();
      const { fx } = sim.post(payloads.permission());
      if (fx.hold === null) throw new Error('no plan');
      sim.held = [];
      sim.run({ type: 'refused', plan: fx.hold, why });
      expect(sim.ofType('approval.resolved')[0]).toMatchObject({ outcome: 'passed_through', by });
    }
  });

  it('a timer or close for a hold that already ended does nothing', () => {
    const { sim, held, requestId } = heldApproval();
    sim.command({ type: 'approval.decide', requestId, decision: 'allow' });
    expect(sim.timer(held.holdId, 'hold_limit').releases).toEqual([]);
    expect(sim.close(held.holdId, 'closed_by_claude_code').events).toEqual([]);
    expect(sim.ofType('approval.resolved')).toHaveLength(1);
  });
});
