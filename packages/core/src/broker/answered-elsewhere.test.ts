/**
 * A held PermissionRequest answered in the terminal (M3 runbook, 2026-11-14, Claude Code 2.1.325 interactive): Claude Code
 * does not close the held request, so the broker ends it from what it sees next for the same agent. Pure (BrokerSim).
 */
import { describe, expect, it } from 'vitest';
import { agentKey } from '@huddle/shared';
import { approvalItemId, questionItemId } from '../state/reduce.js';
import { BrokerSim, payloads, T0 } from '../test/broker-sim.js';

const MAIN = agentKey('session-1');
const SUB = agentKey('session-1', 'agent-a');

/** The call from the runbook evidence: the same tool_input on PreToolUse, PermissionRequest and PostToolUse. */
const LODASH = {
  tool_name: 'PowerShell',
  tool_input: { command: 'npm view lodash version', description: 'Check the lodash version' },
};

function heldLodash(sim = new BrokerSim().startSession(), extra: Record<string, unknown> = {}) {
  sim.post(payloads.preToolUse('toolu_013x', { ...LODASH, ...extra }));
  sim.now = T0 + 2_000;
  const { held, normalized } = sim.post(payloads.permission({ ...LODASH, ...extra }));
  if (held === null) throw new Error('not held');
  const requested = normalized.find((e) => e.type === 'approval.requested');
  if (requested?.type !== 'approval.requested') throw new Error('no approval.requested');
  sim.now = T0 + 8_000;
  sim.post(payloads.notification());
  return { sim, held, requestId: requested.request.requestId };
}

function item(sim: BrokerSim, requestId: string) {
  return sim.state.inbox.find((i) => i.id === approvalItemId(requestId));
}

describe('a held approval answered in the terminal ends from what follows (2.1.325)', () => {
  it('PostToolUse of the same call -> no decision, answered_elsewhere by claude_code, item resolved', () => {
    const { sim, held, requestId } = heldLodash();
    expect(sim.state.agents[MAIN]?.status).toBe('waiting_approval');
    sim.now = T0 + 39_000;
    const { fx } = sim.post(payloads.postToolUse('toolu_013x', { ...LODASH, duration_ms: 11_364 }));
    expect(fx.releases.map((r) => r.holdId)).toEqual([held.holdId]);
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.held).toEqual([]);
    expect(sim.ofType('approval.resolved')).toEqual([
      expect.objectContaining({
        requestId,
        outcome: 'answered_elsewhere',
        by: 'claude_code',
        policyRuleId: null,
        message: null,
        source: 'huddle',
        ts: T0 + 39_000,
      }),
    ]);
    expect(item(sim, requestId)?.resolvedAt).toBe(T0 + 39_000);
    expect(sim.state.agents[MAIN]?.status).toBe('working');
    // A late decision from the Huddle is too late.
    expect(sim.command({ type: 'approval.decide', requestId, decision: 'allow' }).result).toMatchObject({
      code: 'expired',
    });
  });

  it('PostToolUseFailure or PermissionDenied of the same call ends it too', () => {
    for (const ended of [payloads.postToolUseFailure, payloads.permissionDenied]) {
      const { sim, held } = heldLodash();
      sim.post(ended('toolu_013x', LODASH));
      expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
      expect(sim.ofType('approval.resolved')).toEqual([
        expect.objectContaining({ outcome: 'answered_elsewhere', by: 'claude_code' }),
      ]);
    }
  });

  it('the same command with a changed description still matches (same tool, same summary)', () => {
    const { sim, held } = heldLodash();
    sim.post(
      payloads.postToolUse('toolu_013x', {
        tool_name: 'PowerShell',
        tool_input: { command: 'npm view lodash version', description: 'something else', timeout: 120_000 },
      }),
    );
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
  });

  it('an unrelated tool call of the same agent (a parallel call) does not end it', () => {
    const { sim, held, requestId } = heldLodash();
    sim.post(payloads.preToolUse('toolu_read', { tool_name: 'Read', tool_input: { file_path: 'C:/p/README.md' } }));
    sim.post(payloads.postToolUse('toolu_read', { tool_name: 'Read', tool_input: { file_path: 'C:/p/README.md' } }));
    // Same tool, another command.
    sim.post(
      payloads.postToolUse('toolu_other', {
        tool_name: 'PowerShell',
        tool_input: { command: 'npm view zod version', description: 'Check the lodash version' },
      }),
    );
    // Same input, another tool.
    sim.post(payloads.postToolUse('toolu_bash', { ...LODASH, tool_name: 'Bash' }));
    expect(sim.held.map((h) => h.holdId)).toEqual([held.holdId]);
    expect(sim.answers.size).toBe(0);
    expect(sim.ofType('approval.resolved')).toEqual([]);
    expect(item(sim, requestId)?.resolvedAt).toBeNull();
  });

  it('the same call finishing in another agent does not end it', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.subagentStart('agent-a'));
    const { held } = heldLodash(sim);
    sim.post(payloads.postToolUse('toolu_sub', { ...LODASH, agent_id: 'agent-a', agent_type: 'Explore' }));
    expect(sim.held.map((h) => h.holdId)).toEqual([held.holdId]);
  });

  it('one PostToolUse ends one of two identical held requests, the oldest', () => {
    const { sim, held } = heldLodash();
    const second = sim.post(payloads.permission(LODASH)).held;
    if (second === null) throw new Error('second not held');
    sim.post(payloads.postToolUse('toolu_013x', LODASH));
    expect(sim.held.map((h) => h.holdId)).toEqual([second.holdId]);
    expect(sim.answers.has(held.holdId)).toBe(true);
  });

  it('prefers the exact call over an older hold that only shares a clipped summary', () => {
    const sim = new BrokerSim().startSession();
    const prefix = `echo ${'x'.repeat(400)}`;
    const older = { tool_name: 'Bash', tool_input: { command: `${prefix} && echo one` } };
    const newer = { tool_name: 'Bash', tool_input: { command: `${prefix} && echo two` } };
    const a = sim.post(payloads.permission(older)).held;
    const b = sim.post(payloads.permission(newer)).held;
    if (a === null || b === null) throw new Error('not held');
    sim.post(payloads.postToolUse('toolu_two', newer));
    expect(sim.held.map((h) => h.holdId)).toEqual([a.holdId]);
    expect(sim.answers.has(b.holdId)).toBe(true);
  });

  it('Stop of the main agent ends its held approval; the agent is then idle, not working again', () => {
    const { sim, held, requestId } = heldLodash();
    sim.now = T0 + 44_000;
    const { fx } = sim.post(payloads.stop());
    expect(fx.reply).toEqual({ kind: 'none' });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('approval.resolved')).toEqual([
      expect.objectContaining({ requestId, outcome: 'answered_elsewhere', by: 'claude_code' }),
    ]);
    expect(item(sim, requestId)?.resolvedAt).toBe(T0 + 44_000);
    expect(sim.state.agents[MAIN]?.status).toBe('idle');
  });

  it('Stop still delivers a queued follow-up after ending the held approval', () => {
    const { sim, held } = heldLodash();
    expect(
      sim.command({ type: 'agent.message', agentKey: MAIN, text: 'then run the tests', delivery: 'turn_end' }).result,
    ).toEqual({ ok: true });
    const { fx } = sim.post(payloads.stop());
    expect(fx.reply).toMatchObject({ kind: 'stop.block' });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
  });

  it('a new UserPromptSubmit in the session ends the main agent hold (likely denied in the terminal)', () => {
    const { sim, held } = heldLodash();
    sim.post(payloads.prompt('try something else'));
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('approval.resolved')).toEqual([expect.objectContaining({ outcome: 'answered_elsewhere' })]);
  });

  it('SessionEnd ends every held approval of the session', () => {
    const { sim, held } = heldLodash();
    sim.post(payloads.sessionEnd());
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('approval.resolved')).toEqual([expect.objectContaining({ outcome: 'answered_elsewhere' })]);
  });

  it('SubagentStop ends only that subagent hold; the main Stop leaves a subagent hold alone', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.subagentStart('agent-a'));
    const sub = sim.post(payloads.permission({ ...LODASH, agent_id: 'agent-a', agent_type: 'Explore' })).held;
    const main = sim.post(
      payloads.permission({ tool_name: 'Bash', tool_input: { command: 'npm view zod version' } }),
    ).held;
    if (sub === null || main === null) throw new Error('not held');
    expect(sub.agentKey).toBe(SUB);
    sim.post(payloads.stop());
    expect(sim.held.map((h) => h.holdId)).toEqual([sub.holdId]);
    sim.post(payloads.subagentStop('agent-a'));
    expect(sim.held).toEqual([]);
    expect(sim.ofType('approval.resolved').map((e) => e.agentKey)).toEqual([MAIN, SUB]);
  });

  it('a request the user already answered writes nothing more when its call finishes', () => {
    const { sim, requestId } = heldLodash();
    sim.command({ type: 'approval.decide', requestId, decision: 'allow' });
    sim.post(payloads.postToolUse('toolu_013x', LODASH));
    sim.post(payloads.stop());
    expect(sim.ofType('approval.resolved')).toEqual([expect.objectContaining({ outcome: 'allowed', by: 'user' })]);
  });
});

describe('PermissionRequest(AskUserQuestion) after "answer in terminal" is not an approval', () => {
  it('is answered at once with no decision, opens no approval item and changes no status', () => {
    const sim = new BrokerSim().startSession();
    const asked = sim.post(payloads.ask('tu-q1'));
    if (asked.held === null) throw new Error('question not held');
    sim.command({ type: 'approval.passThrough', requestId: 'tu-q1' });
    expect(sim.ofType('question.closed')).toEqual([expect.objectContaining({ outcome: 'passed_through' })]);

    const { fx, held, normalized } = sim.post(
      payloads.permission({ tool_name: 'AskUserQuestion', tool_input: asked.held.question?.toolInput ?? {} }),
    );
    expect(held).toBeNull();
    expect(fx.hold).toBeNull();
    expect(fx.reply).toEqual({ kind: 'none' });
    expect(fx.events).toEqual([]);
    expect(normalized.filter((e) => e.type === 'approval.requested')).toEqual([]);
    expect(sim.state.inbox.filter((i) => i.kind === 'approval')).toEqual([]);
    expect(sim.state.agents[MAIN]?.status).toBe('working');

    sim.post(
      payloads.postToolUse('tu-q1', { tool_name: 'AskUserQuestion', tool_input: asked.held.question?.toolInput }),
    );
    expect(sim.state.inbox.find((i) => i.id === questionItemId('tu-q1'))?.resolvedAt).not.toBeNull();
    expect(sim.ofType('approval.resolved')).toEqual([]);
  });
});
