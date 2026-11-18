/**
 * Ending 2 with the real policy engine (M4 WP2, F18): the broker asks the rules before anything is held. Payloads go
 * through the real chain (parse -> normalize -> reduce -> hookFacts -> decide), see test/broker-sim.ts.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent, type PolicyRule, type PolicySettings } from '@huddle/shared';
import { DENY_PREFIX } from '../ingest/hook-replies.js';
import { decideByPolicy, policyInputOf } from '../policy/decide.js';
import { defaultPolicyRules } from '../policy/defaults.js';
import { approvalItemId } from '../state/reduce.js';
import { BrokerSim, payloads, SESSION, T0 } from '../test/broker-sim.js';
import type { RuleHook } from './model.js';

const MAIN = agentKey(SESSION);

function hookFor(rules: () => PolicyRule[], settings: () => PolicySettings): RuleHook {
  return (s) => {
    if (s.facts === null) return null;
    const o = decideByPolicy(rules(), settings(), policyInputOf(s.facts, s.node, s.sessionCwd), s.managedRunLive);
    return o === null ? null : { decision: o.decision, ruleId: o.ruleId, message: o.message };
  };
}

function exited(): HuddleEvent {
  return {
    id: 'exit-1',
    type: 'run.exited',
    ts: T0 - 500,
    sessionId: SESSION,
    agentKey: MAIN,
    source: 'huddle',
    runId: 'run-1',
    exitCode: 0,
    how: 'completed',
    error: null,
  };
}

function launched(): HuddleEvent {
  return {
    id: 'launch-1',
    type: 'run.launched',
    ts: T0 - 1000,
    sessionId: SESSION,
    agentKey: MAIN,
    source: 'huddle',
    runId: 'run-1',
    claudeSessionId: SESSION,
    templateId: null,
    cwd: 'C:/Users/user/project',
    model: null,
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: null,
  };
}

/** The run's process ended, then the user ran `claude --resume <runId>` in a terminal: the session starts again. */
function resumeInTerminal(s: BrokerSim): void {
  s.feed([exited()]);
  s.post({ ...payloads.sessionStart(), source: 'resume' });
  s.post(payloads.prompt('go on'));
}

function sim(origin: 'managed' | 'attached', opts: { rules?: PolicyRule[]; applyToAttached?: boolean } = {}) {
  const s = new BrokerSim();
  const state = {
    rules: opts.rules ?? defaultPolicyRules(),
    settings: { applyToAttached: opts.applyToAttached ?? false },
  };
  if (origin === 'managed') s.feed([launched()]);
  // The core's RunHost: the run launched above is live until a test says otherwise.
  s.runLive = (runId) => runId === 'run-1';
  s.startSession();
  s.ruleDecision = hookFor(
    () => state.rules,
    () => state.settings,
  );
  expect(s.state.agents[MAIN]?.origin).toBe(origin);
  return { s, state };
}

const gitStatus = (extra: Record<string, unknown> = {}) =>
  payloads.permission({ tool_input: { command: 'git status', description: 'Show status' }, ...extra });

function requestIdOf(normalized: HuddleEvent[]): string {
  const e = normalized.find((x) => x.type === 'approval.requested');
  if (e?.type !== 'approval.requested') throw new Error('no approval.requested');
  return e.request.requestId;
}

describe('rules decide a PermissionRequest before it is held', () => {
  it('managed: a default rule allows git status at once, logged by policy with the rule id; nothing held', () => {
    const { s } = sim('managed');
    const { held, fx, normalized } = s.post(gitStatus());
    expect(held).toBeNull();
    expect(fx.reply).toEqual({ kind: 'permission.allow' });
    const requestId = requestIdOf(normalized);
    expect(s.ofType('approval.resolved')).toEqual([
      expect.objectContaining({
        requestId,
        outcome: 'allowed',
        by: 'policy',
        policyRuleId: 'default:git-status',
        message: null,
        source: 'huddle',
      }),
    ]);
    expect(s.state.inbox.find((i) => i.id === approvalItemId(requestId))?.resolvedAt).toBe(T0);
    expect(s.state.agents[MAIN]?.status).not.toBe('waiting_approval');
  });

  it('attached: rules do not apply while applyToAttached is off (default): the request is held for the user', () => {
    const { s } = sim('attached');
    const { held } = s.post(gitStatus());
    expect(held).not.toBeNull();
    expect(s.ofType('approval.resolved')).toEqual([]);
  });

  it('attached with applyToAttached on: the rule decides', () => {
    const { s } = sim('attached', { applyToAttached: true });
    const { held, fx } = s.post(gitStatus());
    expect(held).toBeNull();
    expect(fx.reply).toEqual({ kind: 'permission.allow' });
  });

  it("after the agent's own cd out of the session folder (payload cwd), even git status is held", () => {
    const { s } = sim('managed');
    expect(s.state.agents[MAIN]?.sessionCwd).toBe('C:/Users/user/project');
    expect(s.post(gitStatus({ cwd: 'C:/Users/user/elsewhere' })).held).not.toBeNull();
    // A cd into a subfolder stays inside: still allowed.
    expect(s.post(gitStatus({ cwd: 'C:/Users/user/project/src' })).held).toBeNull();
  });

  it('a compound command is held even though it starts with git status', () => {
    const { s } = sim('managed');
    expect(s.post(gitStatus({ tool_input: { command: 'git status && rm -rf build' } })).held).not.toBeNull();
    expect(s.post(gitStatus({ tool_input: { command: 'git diff --output=x' } })).held).not.toBeNull();
  });

  it('a deny rule answers with its own wording, not the user prefix', () => {
    const deny: PolicyRule = {
      id: 'no-npm-view',
      name: 'No npm view',
      enabled: true,
      action: 'deny',
      match: { commandPrefix: 'npm view' },
    };
    const { s } = sim('managed', { rules: [deny] });
    const { held, fx } = s.post(payloads.permission());
    expect(held).toBeNull();
    const message = 'Denied by Agent Huddle rule "No npm view" (no-npm-view).';
    expect(fx.reply).toEqual({ kind: 'permission.denyByRule', message });
    expect(message).not.toContain(DENY_PREFIX.trim());
    expect(s.ofType('approval.resolved')[0]).toMatchObject({
      outcome: 'denied',
      by: 'policy',
      policyRuleId: 'no-npm-view',
      message,
    });
  });

  it('an ask rule holds as usual and notes its id on the ending; it beats a matching allow', () => {
    const ask: PolicyRule = {
      id: 'ask-git',
      name: 'Ask git',
      enabled: true,
      action: 'ask',
      match: { commandPrefix: 'git' },
    };
    const { s } = sim('managed', { rules: [...defaultPolicyRules(), ask] });
    const { held, normalized } = s.post(gitStatus());
    expect(held).toMatchObject({ kind: 'approval', askedByRuleId: 'ask-git' });
    const requestId = requestIdOf(normalized);
    s.command({ type: 'approval.decide', requestId, decision: 'allow' });
    expect(s.ofType('approval.resolved')).toEqual([
      expect.objectContaining({ by: 'user', outcome: 'allowed', policyRuleId: null, askedByRuleId: 'ask-git' }),
    ]);
  });

  it('a request no rule matches is held without askedByRuleId', () => {
    const { s } = sim('managed');
    const { held, normalized } = s.post(payloads.permission());
    expect(held).not.toBeNull();
    expect(held?.askedByRuleId ?? null).toBeNull();
    s.command({ type: 'approval.decide', requestId: requestIdOf(normalized), decision: 'deny' });
    expect(s.ofType('approval.resolved')[0]).not.toHaveProperty('askedByRuleId');
  });

  describe('a managed root counts as managed only while its run is live (security review 2026-11-14, L1)', () => {
    it('after run.exited (resumed in a terminal with claude --resume), a request goes to the inbox', () => {
      const { s } = sim('managed');
      resumeInTerminal(s);
      expect(s.state.agents[MAIN]?.origin).toBe('managed');
      expect(s.state.agents[MAIN]?.run?.exited).toMatchObject({ how: 'completed' });
      const { held, fx } = s.post(gitStatus());
      expect(held).not.toBeNull();
      expect(fx.reply).toEqual({ kind: 'none' });
      expect(s.ofType('approval.resolved')).toEqual([]);
    });

    it('a run the host does not know as live (the Huddle restarted, no run.exited on record) goes to the inbox', () => {
      const { s } = sim('managed');
      s.runLive = () => false;
      expect(s.post(gitStatus()).held).not.toBeNull();
      s.runLive = undefined; // no liveness supplied at all: fail safe, not live
      expect(s.post(gitStatus()).held).not.toBeNull();
      expect(s.ofType('approval.resolved')).toEqual([]);
    });

    it('with applyToAttached on, the rules apply to it as to any attached session', () => {
      const { s } = sim('managed', { applyToAttached: true });
      resumeInTerminal(s);
      expect(s.post(gitStatus()).held).toBeNull();
    });

    it('allowAllMatchingPolicy skips it, even with applyToAttached on', () => {
      const { s, state } = sim('managed', { applyToAttached: true, rules: [] });
      expect(s.post(gitStatus()).held).not.toBeNull();
      s.runLive = () => false; // the run's process ended while the request was held
      state.rules = defaultPolicyRules();
      s.command({ type: 'approval.allowAllMatchingPolicy' });
      expect(s.held).toHaveLength(1);
      expect(s.ofType('approval.resolved')).toEqual([]);
    });
  });

  it('the raw facts stay in memory: no event carries a field the log did not have before', () => {
    const { s } = sim('managed');
    s.post(gitStatus());
    const text = JSON.stringify(s.log);
    expect(text).not.toContain('"readable"');
    expect(text).not.toContain('"paths"');
  });
});

describe('approval.allowAllMatchingPolicy (managed sessions only until S15)', () => {
  const allowNpmView: PolicyRule = {
    id: 'npm-view',
    name: 'npm view',
    enabled: true,
    action: 'allow',
    match: { commandPrefix: 'npm view' },
  };

  it('managed: a held request a new allow rule matches is allowed by policy', () => {
    const { s, state } = sim('managed');
    const { held, normalized } = s.post(payloads.permission());
    expect(held).not.toBeNull();
    state.rules = [...state.rules, allowNpmView];
    const fx = s.command({ type: 'approval.allowAllMatchingPolicy' });
    expect(fx.result).toMatchObject({ ok: true });
    expect(s.held).toEqual([]);
    expect(held === null ? null : s.answers.get(held.holdId)).toEqual({ kind: 'permission.allow' });
    expect(s.ofType('approval.resolved')).toEqual([
      expect.objectContaining({ requestId: requestIdOf(normalized), by: 'policy', policyRuleId: 'npm-view' }),
    ]);
  });

  it('attached: never, even with applyToAttached on', () => {
    const { s, state } = sim('attached', { applyToAttached: true, rules: [] });
    expect(s.post(payloads.permission()).held).not.toBeNull();
    state.rules = [allowNpmView];
    const fx = s.command({ type: 'approval.allowAllMatchingPolicy' });
    expect(fx.result).toMatchObject({ ok: true });
    expect(s.held).toHaveLength(1);
    expect(s.ofType('approval.resolved')).toEqual([]);
  });

  it('a deny or ask match, or no match, stays held', () => {
    const { s, state } = sim('managed', { rules: [] });
    s.post(payloads.permission());
    state.rules = [{ ...allowNpmView, action: 'deny' }];
    s.command({ type: 'approval.allowAllMatchingPolicy' });
    expect(s.held).toHaveLength(1);
  });
});
