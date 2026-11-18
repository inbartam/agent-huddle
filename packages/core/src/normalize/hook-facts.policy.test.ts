/**
 * The raw facts approval rules match on (M4 WP2, F18), read from recorded PermissionRequest payloads, and their stored
 * counterpart for the preview. Every recorded PermissionRequest in fixtures/ is replayed.
 */
import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS, type PolicyRule } from '@huddle/shared';
import { parseHookPayload } from '../ingest/schemas.js';
import { DEFAULT_POLICY_RULES } from '../policy/defaults.js';
import { policyInputOf } from '../policy/decide.js';
import { evaluate, ruleMatches } from '../policy/rules.js';
import { listFixtureFiles, readFixture } from '../test/fixtures.js';
import { hookFacts, policyFactsOf, storedPolicyFacts, type PolicyFacts } from './hook-facts.js';
import { normalizeHook } from './hooks.js';

interface Recorded {
  file: string;
  facts: PolicyFacts;
  stored: Record<string, unknown>;
}

function permissionRequests(): Recorded[] {
  const out: Recorded[] = [];
  for (const file of listFixtureFiles()) {
    for (const line of readFixture(file)) {
      if (line.kind !== 'hook' || line.event !== 'PermissionRequest') continue;
      const parsed = parseHookPayload(line.payload);
      if (!parsed.ok) throw new Error(parsed.error);
      const facts = hookFacts(parsed);
      if (facts.kind !== 'permission_request') throw new Error('not a permission request');
      const events = normalizeHook(parsed, { receivedAt: line.t, nextId: () => 'e' });
      const requested = events.find((e) => e.type === 'approval.requested');
      out.push({
        file,
        facts: facts.policy,
        stored: requested?.type === 'approval.requested' ? requested.request.toolInput : {},
      });
    }
  }
  return out;
}

const node = { role: 'main', origin: 'managed' as const, cwd: null };
const anyShell: PolicyRule[] = [
  { id: 'b', name: 'any Bash', enabled: true, action: 'allow', match: { tool: 'Bash' } },
  { id: 'p', name: 'any PowerShell', enabled: true, action: 'allow', match: { tool: 'PowerShell' } },
];

describe('policy facts from recorded PermissionRequests (fixtures)', () => {
  const recorded = permissionRequests();

  it('there are recorded requests in both shells', () => {
    expect(recorded.length).toBeGreaterThan(3);
    expect(recorded.some((r) => r.facts.toolName === 'Bash')).toBe(true);
    expect(recorded.some((r) => r.facts.toolName === 'PowerShell')).toBe(true);
  });

  it('reads the raw command and the payload cwd; nothing clipped or masked', () => {
    for (const r of recorded) {
      if (r.facts.toolName === 'AskUserQuestion') continue;
      expect(r.facts.readable, r.file).toBe(true);
      expect(r.facts.cwd).toBe('C:/Users/user/project');
      if (r.facts.toolName === 'Bash' || r.facts.toolName === 'PowerShell') {
        expect(typeof r.facts.command).toBe('string');
        expect(r.facts.command).toBe(r.stored.command);
      }
      expect(r.facts.clipped).toBe(false);
      expect(r.facts.masked).toBe(false);
    }
  });

  it('no default rule allows any recorded request; a blanket shell allow skips every compound one', () => {
    for (const r of recorded) {
      const live = policyInputOf(r.facts, node, r.facts.cwd);
      expect(evaluate([...DEFAULT_POLICY_RULES], live), `${r.file}: ${String(r.facts.command)}`).toBeNull();
      const compound = r.facts.command !== null && /&&|;|\||\$\(/.test(r.facts.command);
      if (compound) expect(evaluate(anyShell, live), String(r.facts.command)).toBeNull();
    }
  });

  it('the stored input gives the same facts for these short commands', () => {
    for (const r of recorded) {
      const stored = storedPolicyFacts(r.facts.toolName, r.stored, r.facts.cwd);
      expect(stored).toEqual(r.facts);
    }
  });
});

describe('policyFactsOf', () => {
  it('a command longer than the log keeps is clipped; one with a secret is masked', () => {
    const long = `git status ${'x'.repeat(CLIP_LIMITS.message)}`;
    expect(policyFactsOf('Bash', { command: long }, 'C:/p').clipped).toBe(true);
    expect(policyFactsOf('Bash', { command: 'git status API_KEY=abcdef0123456789' }, 'C:/p').masked).toBe(true);
    expect(policyFactsOf('Bash', { command: 'git status' }, 'C:/p')).toMatchObject({ clipped: false, masked: false });
  });

  it('an odd shape is unreadable, never an exception', () => {
    expect(policyFactsOf('Bash', undefined, undefined)).toMatchObject({ readable: false, command: null, cwd: null });
    expect(policyFactsOf('Bash', { command: 42 }, 'C:/p').readable).toBe(false);
    expect(policyFactsOf('Read', {}, 'C:/p').readable).toBe(false);
    expect(policyFactsOf('Read', { file_path: ['a'] }, 'C:/p').readable).toBe(false);
    expect(policyFactsOf('Grep', { pattern: 'x' }, 'C:/p')).toMatchObject({ readable: true, paths: [] });
    expect(policyFactsOf('NotebookEdit', { notebook_path: 'a.ipynb' }, 'C:/p').paths).toEqual(['a.ipynb']);
    expect(policyFactsOf('WebFetch', { url: 'https://x' }, '')).toMatchObject({ readable: true, cwd: null });
  });

  it('stored text that was clipped or masked is reported so (preview), and then never allows', () => {
    const allowGit: PolicyRule = {
      id: 'g',
      name: 'git',
      enabled: true,
      action: 'allow',
      match: { commandPrefix: 'git status' },
    };
    const clipped = storedPolicyFacts('Bash', { command: 'git status aaaa…' }, 'C:/p');
    const masked = storedPolicyFacts('Bash', { command: 'git status TOKEN=<redacted>' }, 'C:/p');
    expect(clipped.clipped).toBe(true);
    expect(masked.masked).toBe(true);
    expect(ruleMatches(allowGit, policyInputOf(clipped, node, 'C:/p'))).toBe(false);
    expect(ruleMatches(allowGit, policyInputOf(masked, node, 'C:/p'))).toBe(false);
    expect(ruleMatches({ ...allowGit, action: 'deny' }, policyInputOf(clipped, node, 'C:/p'))).toBe(true);
  });
});
