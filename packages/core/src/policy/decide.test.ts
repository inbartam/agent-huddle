import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type PolicyRule } from '@huddle/shared';
import { DENY_PREFIX } from '../ingest/hook-replies.js';
import { decideByPolicy, policyInputOf, ruleDenyMessage, rulesApplyTo } from './decide.js';
import type { PolicyInput } from './rules.js';

const OFF = DEFAULT_USER_SETTINGS.policy;
const ON = { applyToAttached: true };

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    toolName: 'Bash',
    command: 'git push --force',
    paths: [],
    role: 'main',
    cwd: 'C:\\p',
    sessionCwd: 'C:\\p',
    origin: 'managed',
    clipped: false,
    masked: false,
    readable: true,
    ...overrides,
  };
}

const deny: PolicyRule = {
  id: 'no-force',
  name: 'No force push',
  enabled: true,
  action: 'deny',
  match: { commandPrefix: 'git push' },
};

describe('scope: managed always, attached only when the setting is on (S15 open)', () => {
  it('the default setting is off', () => {
    expect(OFF.applyToAttached).toBe(false);
  });

  it.each([
    ['managed', OFF, true],
    ['managed', ON, true],
    ['attached', OFF, false],
    ['attached', ON, true],
  ] as const)('%s with applyToAttached=%o -> %s', (origin, settings, applies) => {
    expect(rulesApplyTo(origin, settings, origin === 'managed')).toBe(applies);
    expect(decideByPolicy([deny], settings, input({ origin }), origin === 'managed') !== null).toBe(applies);
  });

  // Security review 2026-11-14, L1: a managed root resumed in a terminal (`claude --resume <runId>`) keeps its
  // `managed` origin, but it is an interactive session now: rules treat it as attached once its run is not live.
  it.each([
    [OFF, false],
    [ON, true],
  ] as const)('managed with its run no longer live is treated as attached (applyToAttached=%o -> %s)', (s, applies) => {
    expect(rulesApplyTo('managed', s, false)).toBe(applies);
    expect(decideByPolicy([deny], s, input({ origin: 'managed' }), false) !== null).toBe(applies);
  });

  it('a live run on an attached session changes nothing (liveness only narrows managed)', () => {
    expect(rulesApplyTo('attached', OFF, true)).toBe(false);
  });
});

describe('deny wording', () => {
  it('names the rule and its id, never the user prefix', () => {
    const outcome = decideByPolicy([deny], OFF, input(), true);
    expect(outcome).toEqual({
      decision: 'deny',
      ruleId: 'no-force',
      ruleName: 'No force push',
      message: 'Denied by Agent Huddle rule "No force push" (no-force).',
    });
    expect(outcome?.message).not.toContain(DENY_PREFIX.trim());
    expect(outcome?.message).not.toMatch(/by the user/i);
  });

  it('a name with quotes, control characters or great length stays one plain line', () => {
    const msg = ruleDenyMessage({ id: 'x', name: `a"b\nc\u0007${'z'.repeat(300)}` });
    expect(msg).not.toContain('\n');
    expect(msg).not.toContain(String.fromCharCode(7));
    expect(msg.startsWith('Denied by Agent Huddle rule "a b c')).toBe(true);
    expect(msg.length).toBeLessThan(200);
  });

  it('allow and ask carry no message', () => {
    expect(decideByPolicy([{ ...deny, action: 'ask' }], OFF, input(), true)?.message).toBeNull();
    expect(
      decideByPolicy(
        [{ ...deny, action: 'allow', match: { commandPrefix: 'git status' } }],
        OFF,
        input({ command: 'git status' }),
        true,
      )?.message,
    ).toBeNull();
  });
});

describe('policyInputOf', () => {
  it('the payload cwd wins over the node cwd; role and origin come from the node', () => {
    const facts = {
      toolName: 'Bash',
      command: 'ls',
      paths: [],
      cwd: null,
      readable: true,
      clipped: false,
      masked: false,
    };
    expect(policyInputOf(facts, { role: 'Explore', origin: 'attached', cwd: 'C:\\n' }, 'C:\\s')).toMatchObject({
      cwd: 'C:\\n',
      sessionCwd: 'C:\\s',
      role: 'Explore',
      origin: 'attached',
    });
    expect(
      policyInputOf({ ...facts, cwd: 'C:\\payload' }, { role: '', origin: 'managed', cwd: 'C:\\n' }, null),
    ).toMatchObject({ cwd: 'C:\\payload', sessionCwd: null, role: null });
  });
});
