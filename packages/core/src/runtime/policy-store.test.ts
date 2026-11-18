import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PolicyRule } from '@huddle/shared';
import { DEFAULT_POLICY_RULES } from '../policy/defaults.js';
import {
  parsePolicyRules,
  POLICY_RULE_PROBLEMS,
  policyRuleProblem,
  policyRuleSaveProblem,
  policyRulesPath,
  preserveBadPolicyRulesFile,
  readPolicyRules,
  removePolicyRule,
  serializePolicyRules,
  upsertPolicyRule,
  writePolicyRules,
} from './policy-store.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true, maxRetries: 3 });
});
async function tmp(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-policy-'));
  dirs.push(d);
  return d;
}

const mine: PolicyRule = {
  id: 'user:no-push',
  name: 'No push',
  enabled: true,
  action: 'deny',
  match: { tool: 'Bash', commandPrefix: 'git push' },
  note: 'mine',
};

describe('policy-rules.json', () => {
  it('a missing file gives the default set without a warning', async () => {
    const load = await readPolicyRules(await tmp());
    expect(load.warning).toBeNull();
    expect(load.rules).toEqual([...DEFAULT_POLICY_RULES]);
  });

  it('round-trips: write, read back the same rules; unknown fields are not kept', async () => {
    const dir = await tmp();
    const rules = upsertPolicyRule([...DEFAULT_POLICY_RULES], { ...mine, extra: 'x' } as PolicyRule);
    await writePolicyRules(dir, rules);
    const text = await fsp.readFile(policyRulesPath(dir), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ version: 1 });
    expect(text).not.toContain('extra');
    const load = await readPolicyRules(dir);
    expect(load.warning).toBeNull();
    expect(load.rules).toEqual([...DEFAULT_POLICY_RULES, mine]);
    // No temp files left behind.
    expect((await fsp.readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['not an object', '[]'],
    ['no rules', '{"version":1}'],
    ['an invalid rule', JSON.stringify({ version: 1, rules: [{ ...mine, action: 'yes' }] })],
    ['a rule without an id', JSON.stringify({ version: 1, rules: [{ ...mine, id: '' }] })],
    ['two rules with one id', JSON.stringify({ version: 1, rules: [mine, mine] })],
    ['a newer version', JSON.stringify({ version: 99, rules: [mine] })],
    ['an allow for everything', JSON.stringify({ version: 1, rules: [{ ...mine, action: 'allow', match: {} }] })],
  ])('a corrupt file (%s) gives the defaults and a warning, never a throw or a partial list', (_label, text) => {
    const load = parsePolicyRules(text);
    expect(load.rules).toEqual([...DEFAULT_POLICY_RULES]);
    expect(load.warning).toMatch(/using the default rules/);
    expect(load.warning).not.toContain('git push'); // never echoes file contents
  });

  it('a corrupt file on disk loads as the defaults', async () => {
    const dir = await tmp();
    await fsp.writeFile(policyRulesPath(dir), '\u0000garbage');
    const load = await readPolicyRules(dir);
    expect(load.rules).toEqual([...DEFAULT_POLICY_RULES]);
    expect(load.warning).not.toBeNull();
  });

  it('a BOM is tolerated; an empty rule list stays empty (the user removed every rule)', () => {
    expect(parsePolicyRules(`\ufeff${serializePolicyRules([mine])}`).rules).toEqual([mine]);
    expect(parsePolicyRules(serializePolicyRules([])).rules).toEqual([]);
  });

  it('upsert replaces by id in place; remove drops by id', () => {
    const a = upsertPolicyRule([mine], { ...mine, name: 'renamed' });
    expect(a).toEqual([{ ...mine, name: 'renamed' }]);
    expect(removePolicyRule([...DEFAULT_POLICY_RULES, mine], mine.id)).toEqual([...DEFAULT_POLICY_RULES]);
  });

  it('an allow must name a tool, a command or a path', () => {
    expect(policyRuleProblem({ ...mine, action: 'allow', match: { role: 'Explore' } })).not.toBeNull();
    expect(policyRuleProblem({ ...mine, action: 'allow', match: { folder: 'C:\\p' } })).not.toBeNull();
    expect(policyRuleProblem({ ...mine, action: 'allow', match: { tool: 'Read' } })).toBeNull();
    expect(policyRuleProblem({ ...mine, action: 'deny', match: {} })).toBeNull();
    expect(policyRuleProblem({ ...mine, match: { commandExact: true } })).not.toBeNull();
  });
});

describe('security review of the M4 branch (2026-11-14): M3 allows that approve every command', () => {
  const allow = (match: PolicyRule['match']): PolicyRule => ({ ...mine, action: 'allow', match });

  it('a Bash or PowerShell allow must name a command', () => {
    expect(policyRuleProblem(allow({ tool: 'Bash' }))).toBe(POLICY_RULE_PROBLEMS.shellNeedsCommand);
    expect(policyRuleProblem(allow({ tool: 'PowerShell' }))).toBe(POLICY_RULE_PROBLEMS.shellNeedsCommand);
    expect(policyRuleProblem(allow({ tool: 'PowerShell', folder: 'C:\\p', role: 'main' }))).toBe(
      POLICY_RULE_PROBLEMS.shellNeedsCommand,
    );
    expect(policyRuleProblem(allow({ tool: 'Bash', commandPrefix: 'git status' }))).toBeNull();
    // Deny and ask on a whole shell are fine (fail safe).
    expect(policyRuleProblem({ ...mine, action: 'deny', match: { tool: 'Bash' } })).toBeNull();
    expect(policyRuleProblem({ ...mine, action: 'ask', match: { tool: 'PowerShell' } })).toBeNull();
  });

  it.each(['git', 'npm', 'node', 'pwsh', 'cmd', 'powershell', 'bash', 'sh', 'python', 'npx', 'GIT', ' git ', 'rm'])(
    'an allow on the single word %j is refused, with or without a tool, exact or not',
    (word) => {
      expect(policyRuleProblem(allow({ commandPrefix: word }))).toBe(POLICY_RULE_PROBLEMS.singleWord);
      expect(policyRuleProblem(allow({ tool: 'Bash', commandPrefix: word }))).toBe(POLICY_RULE_PROBLEMS.singleWord);
      expect(policyRuleProblem(allow({ commandPrefix: word, commandExact: true }))).toBe(
        POLICY_RULE_PROBLEMS.singleWord,
      );
      expect(policyRuleProblem({ ...mine, action: 'deny', match: { commandPrefix: word } })).toBeNull();
    },
  );

  it('the read-only single words stay allowed; a command with its subcommand is fine', () => {
    for (const word of ['ls', 'dir', 'pwd', 'Get-ChildItem', 'get-location', 'LS']) {
      expect(policyRuleProblem(allow({ commandPrefix: word })), word).toBeNull();
    }
    for (const p of ['git status', 'npm  test', 'node --version', 'python -m pytest']) {
      expect(policyRuleProblem(allow({ commandPrefix: p })), p).toBeNull();
    }
    // The default set passes its own check.
    for (const r of DEFAULT_POLICY_RULES) expect(policyRuleProblem(r), r.id).toBeNull();
  });

  it('an allow command with a non-ASCII character (it could never match) is refused', () => {
    expect(policyRuleProblem(allow({ commandPrefix: 'git\u00A0status' }))).toBe(POLICY_RULE_PROBLEMS.nonAscii);
    expect(policyRuleProblem(allow({ commandPrefix: 'git st\u00e4tus' }))).toBe(POLICY_RULE_PROBLEMS.nonAscii);
  });

  it.each([
    ['a Bash allow with no command', { tool: 'Bash' }],
    ['a PowerShell allow with no command', { tool: 'PowerShell' }],
    ['an allow on git alone', { commandPrefix: 'git' }],
    ['an allow on pwsh alone', { tool: 'PowerShell', commandPrefix: 'pwsh' }],
  ] as const)('a stored file with %s loads as the defaults, with a warning', async (_label, match) => {
    const text = serializePolicyRules([...DEFAULT_POLICY_RULES, allow(match)]);
    const load = parsePolicyRules(text);
    expect(load.rules).toEqual([...DEFAULT_POLICY_RULES]);
    expect(load.warning).toMatch(/using the default rules/);
    const dir = await tmp();
    await fsp.writeFile(policyRulesPath(dir), text);
    expect((await readPolicyRules(dir)).rules).toEqual([...DEFAULT_POLICY_RULES]);
  });
});

describe('a bad rules file is kept, not overwritten (A2-02)', () => {
  it('marks a bad file, and not a missing one', async () => {
    expect(parsePolicyRules(null).bad).toBe(false);
    expect(parsePolicyRules('{ nope').bad).toBe(true);
    expect(parsePolicyRules(serializePolicyRules([...DEFAULT_POLICY_RULES])).bad).toBe(false);
    const load = await readPolicyRules(await tmp());
    expect(load).toMatchObject({ bad: false, readFailed: false });
  });

  it('moves the bad file aside once, with its original bytes', async () => {
    const dir = await tmp();
    const original = JSON.stringify({ version: 1, rules: [mine, mine] });
    await fsp.writeFile(policyRulesPath(dir), original);
    expect((await readPolicyRules(dir)).bad).toBe(true);
    const moved = await preserveBadPolicyRulesFile(dir, 1234);
    expect(moved).toBe(`${policyRulesPath(dir)}.bad-1234`);
    expect(await fsp.readFile(`${policyRulesPath(dir)}.bad-1234`, 'utf8')).toBe(original);
    expect(await preserveBadPolicyRulesFile(dir, 1235)).toBeNull();
  });
});

describe('allow rules refused when saved (AX-05)', () => {
  const allow = (commandPrefix: string, tool?: string): PolicyRule => ({
    id: 'user:x',
    name: 'x',
    enabled: true,
    action: 'allow',
    match: { ...(tool === undefined ? {} : { tool }), commandPrefix },
  });

  it.each([
    ['bash -c', 'launcher'],
    ['sh -c', 'launcher'],
    ['cmd /c', 'launcher'],
    ['cmd.exe /c', 'launcher'],
    ['C:\\Windows\\System32\\cmd.exe /c', 'launcher'],
    ['"bash" -c', 'launcher'],
    ['powershell -c', 'launcher'],
    ['pwsh -Command', 'launcher'],
    ['node -e', 'launcher'],
    ['python -c', 'launcher'],
    ['npx create-thing', 'launcher'],
    ['git -c core.pager=x', 'launcher'],
    ['npm install', 'install'],
    ['npm i', 'install'],
    ['pip install', 'install'],
    ['yarn add', 'install'],
    ['git push', 'push'],
    ['GIT PUSH', 'push'],
    ['git clean', 'discard'],
    ['git reset --hard', 'discard'],
    ['git reset', 'discard'],
    ['rm -rf', 'delete'],
    ['Remove-Item -Recurse', 'delete'],
    ['del /s', 'delete'],
    ['git rm', 'delete'],
  ] as const)('refuses an allow on %j', (prefix, kind) => {
    const expected = {
      launcher: POLICY_RULE_PROBLEMS.launcher,
      install: POLICY_RULE_PROBLEMS.install,
      push: POLICY_RULE_PROBLEMS.push,
      discard: POLICY_RULE_PROBLEMS.discard,
      delete: POLICY_RULE_PROBLEMS.deletes,
    }[kind];
    expect(policyRuleSaveProblem(allow(prefix))).toBe(expected);
    expect(policyRuleSaveProblem(allow(prefix, 'Bash'))).toBe(expected);
  });

  it('accepts ordinary allows and every deny or ask', () => {
    for (const prefix of ['git status', 'npm test', 'npm run build', 'git log --oneline', 'ls']) {
      expect(policyRuleSaveProblem(allow(prefix)), prefix).toBeNull();
    }
    expect(policyRuleSaveProblem({ ...allow('git push'), action: 'deny' })).toBeNull();
    expect(policyRuleSaveProblem({ ...allow('rm -rf'), action: 'ask' })).toBeNull();
  });

  it('accepts a risky allow saved switched off, so it can always be turned off (R-04)', () => {
    expect(policyRuleSaveProblem({ ...allow('npm install'), enabled: false })).toBeNull();
    expect(policyRuleSaveProblem(allow('npm install'))).toBe(POLICY_RULE_PROBLEMS.install);
  });

  it('a stored file that already holds such a rule still loads unchanged', () => {
    const rules = [...DEFAULT_POLICY_RULES, allow('bash -c')];
    const load = parsePolicyRules(serializePolicyRules(rules));
    expect(load).toMatchObject({ warning: null, bad: false });
    expect(load.rules).toEqual(rules);
  });
});
