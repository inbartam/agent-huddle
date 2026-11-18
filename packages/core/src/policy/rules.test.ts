import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '@huddle/shared';
import { DEFAULT_POLICY_RULES } from './defaults.js';
import {
  compileGlob,
  evaluate,
  isPlainCommand,
  isProtectedPath,
  namesProtectedPath,
  PROTECTED_PATHS,
  protectedForAllow,
  ruleMatches,
  type PolicyInput,
} from './rules.js';

const CWD = 'C:\\Users\\dev\\project';

/** The trusted session folder follows `cwd` unless a test sets it apart (the agent has not `cd`ed). */
function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    toolName: 'Bash',
    command: 'git status',
    paths: [],
    role: 'main',
    cwd: CWD,
    sessionCwd: overrides.cwd !== undefined ? overrides.cwd : CWD,
    origin: 'managed',
    clipped: false,
    masked: false,
    readable: true,
    ...overrides,
  };
}

function bash(command: string, extra: Partial<PolicyInput> = {}): PolicyInput {
  return input({ toolName: 'Bash', command, ...extra });
}
function ps(command: string, extra: Partial<PolicyInput> = {}): PolicyInput {
  return input({ toolName: 'PowerShell', command, ...extra });
}
function file(toolName: string, p: string, extra: Partial<PolicyInput> = {}): PolicyInput {
  return input({ toolName, command: null, paths: [p], ...extra });
}

let n = 0;
function rule(action: PolicyRule['action'], match: PolicyRule['match'], extra: Partial<PolicyRule> = {}): PolicyRule {
  n += 1;
  return { id: `r${String(n)}`, name: `rule ${String(n)}`, enabled: true, action, match, ...extra };
}

describe('precedence: deny beats ask beats allow, whatever the order', () => {
  const allow = rule('allow', { commandPrefix: 'git' }, { id: 'allow' });
  const ask = rule('ask', { commandPrefix: 'git' }, { id: 'ask' });
  const deny = rule('deny', { commandPrefix: 'git' }, { id: 'deny' });
  const cases: { rules: PolicyRule[]; want: string | null }[] = [
    { rules: [allow], want: 'allow' },
    { rules: [ask], want: 'ask' },
    { rules: [deny], want: 'deny' },
    { rules: [allow, ask], want: 'ask' },
    { rules: [ask, allow], want: 'ask' },
    { rules: [allow, deny], want: 'deny' },
    { rules: [deny, allow], want: 'deny' },
    { rules: [allow, ask, deny], want: 'deny' },
    { rules: [deny, ask, allow], want: 'deny' },
    { rules: [ask, deny], want: 'deny' },
    { rules: [], want: null },
    { rules: [{ ...deny, enabled: false }, allow], want: 'allow' },
    {
      rules: [
        { ...deny, enabled: false },
        { ...ask, enabled: false },
        { ...allow, enabled: false },
      ],
      want: null,
    },
  ];
  it.each(cases)('$want from $rules.length rules', ({ rules, want }) => {
    expect(evaluate(rules, bash('git status'))?.action ?? null).toBe(want);
  });

  it('the verdict names the deciding rule; the first rule of the winning action wins', () => {
    const a1 = rule('allow', { commandPrefix: 'git' }, { id: 'a1', name: 'first' });
    const a2 = rule('allow', { commandPrefix: 'git status' }, { id: 'a2', name: 'second' });
    expect(evaluate([a1, a2], bash('git status'))).toEqual({ action: 'allow', ruleId: 'a1', ruleName: 'first' });
  });

  it('no match is null: the request goes to the inbox', () => {
    expect(evaluate([rule('allow', { commandPrefix: 'npm test' })], bash('git status'))).toBeNull();
  });

  it('every match field must hold (AND); an empty deny matches every request', () => {
    const r = rule('deny', { tool: 'Bash', commandPrefix: 'git', role: 'Explore' });
    expect(ruleMatches(r, bash('git status', { role: 'main' }))).toBe(false);
    expect(ruleMatches(r, bash('git status', { role: 'Explore' }))).toBe(true);
    expect(ruleMatches(rule('deny', {}), file('Read', 'a.txt'))).toBe(true);
  });
});

describe('command prefixes match on whole words', () => {
  const r = rule('allow', { commandPrefix: 'git status' });
  it.each([
    ['git status', true],
    ['git status -s', true],
    ['  git status  ', true],
    ['git  status', true],
    ['git statusx', false],
    ['git stat', false],
    ['git', false],
    ['xgit status', false],
    ['GIT STATUS', false], // Bash is case-sensitive for an allow
  ])('Bash %j -> %s', (command, want) => {
    expect(ruleMatches(r, bash(command))).toBe(want);
  });

  it('PowerShell compares case-insensitively', () => {
    expect(ruleMatches(rule('allow', { commandPrefix: 'Get-ChildItem' }), ps('get-childitem -Force'))).toBe(true);
  });

  it('commandExact allows no arguments', () => {
    const exact = rule('allow', { commandPrefix: 'node --version', commandExact: true });
    expect(ruleMatches(exact, bash('node --version'))).toBe(true);
    expect(ruleMatches(exact, bash(' node --version '))).toBe(true);
    expect(ruleMatches(exact, bash('node --version -r ./evil.js'))).toBe(false);
    expect(ruleMatches(exact, bash('node --versionx'))).toBe(false);
  });

  it('a command rule does not apply to tools without a command', () => {
    expect(ruleMatches(rule('deny', { commandPrefix: 'rm' }), file('Read', 'rm'))).toBe(false);
  });

  it('deny and ask also look at every segment of a compound command, case-insensitively', () => {
    const deny = rule('deny', { commandPrefix: 'rm' });
    expect(ruleMatches(deny, bash('git status && rm -rf build'))).toBe(true);
    expect(ruleMatches(deny, bash('ls; RM x'))).toBe(true);
    expect(ruleMatches(deny, bash('echo $(rm x)'))).toBe(true);
    expect(ruleMatches(deny, ps('Get-ChildItem | rm'))).toBe(true);
    expect(ruleMatches(deny, bash('git status'))).toBe(false);
    expect(ruleMatches(deny, bash('rmdir x'))).toBe(false);
  });
});

describe('compound, redirect and substitution syntax never matches an allow', () => {
  const anyBash = rule('allow', { tool: 'Bash' });
  const anyPs = rule('allow', { tool: 'PowerShell' });
  const lsBash = rule('allow', { commandPrefix: 'ls' });

  it.each([
    'ls && rm -rf /',
    'ls || rm -rf /',
    'ls; rm -rf /',
    'ls | sh',
    'ls `rm x`',
    'ls $(rm x)',
    'ls > out.txt',
    'ls >> out.txt',
    'ls < in.txt',
    'ls\nrm x',
    'ls\rrm x',
    'ls &',
    'ls & rm x',
    'ls <(rm x)',
    'ls $HOME',
    'ls ${x}',
    "ls $'\\x2d'",
    'ls {a,--output=x}',
    'ls *',
    'ls ?',
    'ls [ab]',
    'ls (x)',
    'ls\tx',
    'ls \u2028 rm',
    // Review of 7ce0558: Bash unescapes backslashes and expands tilde forms, the path check does neither.
    'ls .g\\it/config',
    'ls .claude\\/settings.json',
    'ls ~-/config',
    'ls ~+/config',
    'ls ~user/.bashrc',
    'ls ~/x',
  ])('Bash %j', (command) => {
    expect(isPlainCommand(command, 'bash')).toBe(false);
    expect(ruleMatches(anyBash, bash(command))).toBe(false);
    expect(ruleMatches(lsBash, bash(command))).toBe(false);
  });

  it.each([
    'Get-ChildItem; Remove-Item x',
    'Get-ChildItem | Remove-Item',
    'Get-ChildItem && Remove-Item x',
    'Get-ChildItem || Remove-Item x',
    'Get-ChildItem & Remove-Item x',
    '& Remove-Item x',
    'Get-ChildItem `; Remove-Item x',
    'Get-ChildItem $(Remove-Item x)',
    'Get-ChildItem @(Remove-Item x)',
    'Get-ChildItem (Remove-Item x)',
    'Get-ChildItem { Remove-Item x }',
    'Get-ChildItem > out.txt',
    'Get-ChildItem 2> err.txt',
    'Get-ChildItem\nRemove-Item x',
    'Get-ChildItem $env:USERPROFILE',
    'git diff @args',
  ])('PowerShell %j', (command) => {
    expect(isPlainCommand(command, 'powershell')).toBe(false);
    expect(ruleMatches(anyPs, ps(command))).toBe(false);
  });

  it('plain commands pass', () => {
    expect(isPlainCommand('git log --oneline -5', 'bash')).toBe(true);
    expect(isPlainCommand('ls -la src', 'bash')).toBe(true);
    expect(isPlainCommand('Get-ChildItem -Path C:\\Users\\dev -Force', 'powershell')).toBe(true);
    // PowerShell cmdlets expand wildcards themselves (`.gi?\config`), so an allow never sees one.
    expect(isPlainCommand('Get-ChildItem *.ts', 'powershell')).toBe(false);
  });

  it('writing or program-running git arguments void an allow, in every spelling', () => {
    for (const command of [
      'git diff --output=x',
      'git log --output x',
      'git diff --outp=x',
      'git diff --ou=x',
      'git diff "--output=x"',
      "git diff --out''put=x",
      'git diff --OUTPUT=x',
      'git diff \u2013\u2013output=x',
      'git diff --ext-diff',
      'git diff --ext',
      'git diff -O../../orderfile',
      'git diff -Oorderfile',
      'git diff -pO../../orderfile',
      'git diff -RO../x',
    ]) {
      expect(isPlainCommand(command, 'bash'), command).toBe(false);
      expect(isPlainCommand(command, 'powershell'), command).toBe(false);
    }
  });

  it('network paths and PowerShell provider drives void an allow', () => {
    expect(isPlainCommand('ls \\\\server\\share', 'bash')).toBe(false);
    expect(isPlainCommand('ls //server/share', 'bash')).toBe(false);
    expect(isPlainCommand('dir \\\\server\\share', 'powershell')).toBe(false);
    expect(isPlainCommand('Get-ChildItem -Path:\\\\server\\share', 'powershell')).toBe(false);
    expect(isPlainCommand('Get-ChildItem Env:', 'powershell')).toBe(false);
    expect(isPlainCommand('Get-ChildItem -Path Env:\\', 'powershell')).toBe(false);
    expect(isPlainCommand('Get-ChildItem -Path:HKLM:\\Software', 'powershell')).toBe(false);
    expect(isPlainCommand('ls "Variable:"', 'powershell')).toBe(false);
    expect(isPlainCommand('git log --pretty=format:x http://example.com', 'bash')).toBe(false);
    expect(isPlainCommand('Get-ChildItem C:\\x', 'powershell')).toBe(true);
  });
});

describe('clipped, masked or unreadable input never allows, but still denies and asks', () => {
  const allow = rule('allow', { commandPrefix: 'git status' });
  const deny = rule('deny', { commandPrefix: 'git status' });
  const ask = rule('ask', { commandPrefix: 'git status' });
  it.each([
    ['clipped', { clipped: true }],
    ['masked', { masked: true }],
    ['unreadable', { readable: false }],
    ['unreadable, no command', { readable: false, command: null }],
  ] as const)('%s', (_label, flags) => {
    const i = bash('git status', flags);
    expect(ruleMatches(allow, i)).toBe(false);
    expect(ruleMatches(deny, i)).toBe(true);
    expect(ruleMatches(ask, i)).toBe(true);
    expect(evaluate([allow], i)).toBeNull();
    expect(evaluate([allow, deny], i)?.action).toBe('deny');
  });

  it('a shell tool with no command never allows, even for a tool-only rule', () => {
    expect(ruleMatches(rule('allow', { tool: 'Bash' }), bash('x', { command: null }))).toBe(false);
  });

  it('a file rule cannot allow an unreadable file call, but a deny on it holds', () => {
    const unreadable = input({ toolName: 'Read', command: null, paths: [], readable: false });
    expect(ruleMatches(rule('allow', { tool: 'Read', pathGlob: '**' }), unreadable)).toBe(false);
    expect(ruleMatches(rule('deny', { pathGlob: '**/.env' }), unreadable)).toBe(true);
    // A tool that names no path (WebFetch) is not a "maybe" for a path rule.
    expect(
      ruleMatches(rule('deny', { pathGlob: '**' }), input({ toolName: 'WebFetch', command: null, readable: false })),
    ).toBe(false);
  });
});

describe('path globs', () => {
  const src = rule('allow', { tool: 'Read', pathGlob: 'src/**' });
  const env = rule('deny', { pathGlob: '**/.env' });

  it('match relative to the session cwd, case-insensitively, either separator', () => {
    expect(ruleMatches(src, file('Read', `${CWD}\\src\\a.ts`))).toBe(true);
    expect(ruleMatches(src, file('Read', 'C:/users/DEV/Project/SRC/deep/b.ts'))).toBe(true);
    expect(ruleMatches(src, file('Read', 'src/a.ts'))).toBe(true);
    expect(ruleMatches(src, file('Read', `${CWD}\\test\\a.ts`))).toBe(false);
    expect(ruleMatches(rule('allow', { tool: 'Read', pathGlob: '.\\SRC\\*.TS' }), file('Read', 'src\\a.ts'))).toBe(
      true,
    );
  });

  it('a path that escapes the cwd with .. never matches an allow; a deny still sees it', () => {
    const anything = rule('allow', { tool: 'Read', pathGlob: '**' });
    expect(ruleMatches(anything, file('Read', `${CWD}\\src\\..\\..\\secrets.txt`))).toBe(false);
    expect(ruleMatches(src, file('Read', 'src\\..\\..\\project\\src\\a.ts'))).toBe(true); // resolves back inside
    expect(ruleMatches(src, file('Read', 'src/../../other/src/a.ts'))).toBe(false);
    expect(ruleMatches(anything, file('Read', 'D:\\elsewhere\\a.ts'))).toBe(false);
    expect(ruleMatches(env, file('Read', '..\\other\\.env'))).toBe(true);
    expect(ruleMatches(env, file('Read', 'D:\\elsewhere\\.env'))).toBe(true);
  });

  it('device, UNC and stream paths never allow; Windows equivalences cannot dodge a deny', () => {
    const anything = rule('allow', { tool: 'Read', pathGlob: '**' });
    expect(ruleMatches(anything, file('Read', '\\\\server\\share\\a.ts'))).toBe(false);
    expect(ruleMatches(anything, file('Read', '\\\\?\\C:\\Users\\dev\\project\\a.ts'))).toBe(false);
    expect(ruleMatches(anything, file('Read', `${CWD}\\a.ts::$DATA`))).toBe(false);
    expect(ruleMatches(anything, file('Read', `${CWD}\\a.ts.`))).toBe(false);
    expect(ruleMatches(anything, file('Read', 'C:a.ts'))).toBe(false);
    expect(ruleMatches(env, file('Read', `${CWD}\\.env::$DATA`))).toBe(true);
    expect(ruleMatches(env, file('Read', `${CWD}\\.ENV.`))).toBe(true);
    expect(ruleMatches(env, file('Read', `${CWD}\\.env `))).toBe(true);
  });

  it('an unknown cwd: no allow on a relative glob; an absolute deny glob still applies', () => {
    expect(ruleMatches(src, file('Read', `${CWD}\\src\\a.ts`, { cwd: null }))).toBe(false);
    expect(ruleMatches(src, file('Read', 'src\\a.ts', { cwd: null }))).toBe(false);
    const abs = rule('deny', { pathGlob: 'C:\\Users\\dev\\project\\secret\\**' });
    expect(ruleMatches(abs, file('Read', `${CWD}\\secret\\k.pem`, { cwd: null }))).toBe(true);
  });

  it('an absolute allow glob still needs the path inside the cwd', () => {
    const abs = rule('allow', { tool: 'Read', pathGlob: 'C:/Users/dev/**' });
    expect(ruleMatches(abs, file('Read', `${CWD}\\a.ts`))).toBe(true);
    expect(ruleMatches(abs, file('Read', 'C:\\Users\\dev\\other\\a.ts'))).toBe(false);
  });

  it('a path rule ignores tools without paths', () => {
    expect(ruleMatches(rule('deny', { pathGlob: '**' }), bash('ls'))).toBe(false);
  });
});

describe('compileGlob', () => {
  it.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/deep/a.ts', true],
    ['src/**', 'src/a/b', true],
    ['src/**', 'srcx/a', false],
    ['src/**/x', 'src/x', true],
    ['src/**/x', 'src/a/b/x', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['**', '', true],
    ['a.b', 'aXb', false],
    ['[x]', '[x]', true],
  ])('%j vs %j -> %s', (glob, subject, want) => {
    expect(compileGlob(glob)(subject)).toBe(want);
  });

  it('a pathological pattern stays fast', () => {
    const glob = `${'**a'.repeat(40)}b`;
    const subject = 'a'.repeat(2000);
    const t0 = performance.now();
    expect(compileGlob(glob)(subject)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('role and folder', () => {
  it('role is exact; an unknown role fails an allow but matches a deny', () => {
    expect(ruleMatches(rule('allow', { tool: 'Bash', role: 'Explore' }), bash('ls', { role: 'Explore' }))).toBe(true);
    expect(ruleMatches(rule('allow', { tool: 'Bash', role: 'Explore' }), bash('ls', { role: 'explore' }))).toBe(false);
    expect(ruleMatches(rule('allow', { tool: 'Bash', role: 'Explore' }), bash('ls', { role: null }))).toBe(false);
    expect(ruleMatches(rule('deny', { role: 'Explore' }), bash('ls', { role: null }))).toBe(true);
  });

  it('folder: the cwd is the folder or inside it, case-insensitive and normalized', () => {
    const r = rule('allow', { tool: 'Bash', folder: 'c:/users/DEV/' });
    expect(ruleMatches(r, bash('ls'))).toBe(true);
    expect(ruleMatches(r, bash('ls', { cwd: 'C:\\Users\\dev' }))).toBe(true);
    expect(ruleMatches(r, bash('ls', { cwd: 'C:\\Users\\developer' }))).toBe(false);
    expect(ruleMatches(r, bash('ls', { cwd: 'C:\\Users\\dev\\..\\other' }))).toBe(false);
    expect(ruleMatches(r, bash('ls', { cwd: null }))).toBe(false);
    expect(ruleMatches(rule('deny', { folder: 'C:\\Users\\dev' }), bash('ls', { cwd: null }))).toBe(true);
    expect(ruleMatches(rule('allow', { tool: 'Bash', folder: 'relative\\x' }), bash('ls'))).toBe(false);
  });
});

describe('PowerShell provider paths never match an allow (security review 2026-11-14, HIGH)', () => {
  const lsAny = rule('allow', { tool: 'PowerShell', commandPrefix: 'Get-ChildItem' });
  it.each([
    'Get-ChildItem Microsoft.PowerShell.Core\\Environment::',
    'Get-ChildItem Microsoft.PowerShell.Core\\Registry::HKEY_CURRENT_USER',
    'Get-ChildItem FileSystem::\\\\host\\share',
    'Get-ChildItem FileSystem::C:\\x',
    "Get-ChildItem 'x'+'Env:'",
    'Get-ChildItem -Path Variable:',
    'Get-ChildItem Env:',
    'Get-ChildItem -Path:C:\\x',
    'Get-ChildItem Function:\\',
    'Get-ChildItem C:\\x\\Env:',
    'Get-ChildItem "Cert:\\CurrentUser"',
  ])('%j', (command) => {
    expect(isPlainCommand(command, 'powershell')).toBe(false);
    expect(ruleMatches(lsAny, ps(command))).toBe(false);
    expect(evaluate([...DEFAULT_POLICY_RULES], ps(command))).toBeNull();
    expect(evaluate([...DEFAULT_POLICY_RULES], ps(command.replace('Get-ChildItem', 'dir')))).toBeNull();
    expect(evaluate([...DEFAULT_POLICY_RULES], ps(command.replace('Get-ChildItem', 'ls')))).toBeNull();
  });

  it('file system paths still allow', () => {
    // Inside the session folder (A2-01: a path outside it asks).
    expect(evaluate([...DEFAULT_POLICY_RULES], ps('Get-ChildItem C:\\Users\\dev\\project\\src'))?.ruleId).toBe(
      'default:get-childitem',
    );
    expect(evaluate([...DEFAULT_POLICY_RULES], ps('Get-ChildItem -Path C:/Users/dev/project/src -Force'))?.ruleId).toBe(
      'default:get-childitem',
    );
    expect(evaluate([...DEFAULT_POLICY_RULES], ps('dir .\\src'))?.ruleId).toBe('default:dir');
    expect(evaluate([...DEFAULT_POLICY_RULES], ps('ls src'))?.ruleId).toBe('default:ls');
  });
});

describe('allows are contained in the trusted session folder (security review 2026-11-14, MEDIUM)', () => {
  const TRUSTED = 'C:\\repo';
  const inFolder = rule('allow', { tool: 'Bash', folder: TRUSTED });
  const srcGlob = rule('allow', { tool: 'Read', pathGlob: 'src/**' });

  it("a folder-scoped allow does not follow the agent's cd outside the session folder", () => {
    expect(ruleMatches(inFolder, bash('ls', { cwd: TRUSTED, sessionCwd: TRUSTED }))).toBe(true);
    expect(ruleMatches(inFolder, bash('ls', { cwd: 'C:\\repo\\src', sessionCwd: TRUSTED }))).toBe(true);
    expect(ruleMatches(inFolder, bash('ls', { cwd: 'C:\\elsewhere', sessionCwd: TRUSTED }))).toBe(false);
    // Even a rule with no folder or path condition: outside the session folder nothing is allowed.
    expect(ruleMatches(rule('allow', { commandPrefix: 'ls' }), bash('ls', { cwd: 'D:\\x', sessionCwd: TRUSTED }))).toBe(
      false,
    );
    expect(
      evaluate([...DEFAULT_POLICY_RULES], bash('git status', { cwd: 'C:\\other', sessionCwd: TRUSTED })),
    ).toBeNull();
  });

  it('the payload cwd cannot claim a folder the session did not start in', () => {
    // The session started in C:\other; the agent says it is in C:\repo (or cd'ed there): not inside the trusted folder.
    expect(ruleMatches(inFolder, bash('ls', { cwd: TRUSTED, sessionCwd: 'C:\\other' }))).toBe(false);
    expect(ruleMatches(inFolder, bash('ls', { cwd: null, sessionCwd: 'C:\\other' }))).toBe(false);
    expect(ruleMatches(inFolder, bash('ls', { cwd: TRUSTED, sessionCwd: null }))).toBe(false);
  });

  it('a relative path is resolved against the trusted folder when the request names no cwd', () => {
    const i = file('Read', 'src\\a.ts', { cwd: null, sessionCwd: TRUSTED });
    expect(ruleMatches(srcGlob, i)).toBe(true);
    expect(ruleMatches(srcGlob, file('Read', '..\\other\\src\\a.ts', { cwd: null, sessionCwd: TRUSTED }))).toBe(false);
    // In a subfolder of the trusted one, relative paths resolve where the agent is; the glob stays trusted-relative.
    expect(ruleMatches(srcGlob, file('Read', 'a.ts', { cwd: 'C:\\repo\\src', sessionCwd: TRUSTED }))).toBe(true);
    expect(ruleMatches(srcGlob, file('Read', 'C:\\repo\\src\\a.ts', { cwd: 'C:\\x', sessionCwd: TRUSTED }))).toBe(
      false,
    );
  });

  it('deny and ask still match on either folder (fail safe)', () => {
    const denyRepo = rule('deny', { folder: TRUSTED });
    expect(ruleMatches(denyRepo, bash('ls', { cwd: 'C:\\elsewhere', sessionCwd: TRUSTED }))).toBe(true);
    expect(ruleMatches(denyRepo, bash('ls', { cwd: TRUSTED, sessionCwd: 'C:\\other' }))).toBe(true);
    expect(ruleMatches(denyRepo, bash('ls', { cwd: 'C:\\a', sessionCwd: 'C:\\b' }))).toBe(false);
    expect(ruleMatches(denyRepo, bash('ls', { cwd: null, sessionCwd: null }))).toBe(true);
    const denyEnv = rule('deny', { pathGlob: 'secret/**' });
    expect(ruleMatches(denyEnv, file('Read', 'secret\\k.pem', { cwd: 'C:\\elsewhere', sessionCwd: TRUSTED }))).toBe(
      true,
    );
    expect(ruleMatches(denyEnv, file('Read', 'secret\\k.pem', { cwd: TRUSTED, sessionCwd: 'C:\\other' }))).toBe(true);
    expect(ruleMatches(rule('ask', { folder: TRUSTED }), bash('ls', { cwd: 'C:\\x', sessionCwd: TRUSTED }))).toBe(true);
  });
});

describe("Claude Code's protected paths never match an allow (INTEGRATION.md §3)", () => {
  const anyWrite = (tool: string) => rule('allow', { tool, pathGlob: '**' });
  const absoluteAnyWrite = (tool: string) => rule('allow', { tool, pathGlob: 'C:/**' });

  it.each([
    ['Edit', '.git/config'],
    ['Edit', `${CWD}\\.git\\config`],
    ['Write', '.husky/pre-commit'],
    ['Write', 'C:\\repo\\.claude\\settings.json'],
    ['Write', '.claude/agents/x.md'],
    ['MultiEdit', '.vscode/tasks.json'],
    ['NotebookEdit', '.devcontainer/devcontainer.json'],
    ['Write', '.config/git/config'],
    ['Write', '.GIT/HOOKS/pre-commit'],
    ['Write', '.git./config'],
    ['Write', '.git::$DATA'],
    ['Write', 'sub/.gitmodules'],
    ['Write', '.npmrc'],
    ['Write', '.yarnrc.yml'],
    ['Write', 'lefthook.yml'],
    ['Write', 'lefthook.yaml'],
    ['Write', '.mcp.json'],
    ['Write', '.pre-commit-config.yaml'],
    ['Write', 'C:\\Users\\dev\\.bashrc'],
    ['Write', 'C:\\Users\\dev\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1'],
    ['Write', 'src\\..\\.idea\\workspace.xml'],
    ['Write', '.claude/worktrees/feat/.git'],
  ])('%s %j', (tool, p) => {
    expect(isProtectedPath(p)).toBe(true);
    const i = file(tool, p, { cwd: 'C:\\repo' });
    expect(ruleMatches(anyWrite(tool), i)).toBe(false);
    expect(ruleMatches(absoluteAnyWrite(tool), i)).toBe(false);
    expect(ruleMatches(rule('allow', { tool }), i)).toBe(false);
    // Deny and ask are unaffected.
    expect(ruleMatches(rule('deny', { tool }), i)).toBe(true);
    expect(ruleMatches(rule('ask', { tool }), i)).toBe(true);
  });

  it('.claude/worktrees/… is not protected: a matching allow still allows', () => {
    expect(isProtectedPath('.claude/worktrees/x.txt')).toBe(false);
    expect(ruleMatches(anyWrite('Write'), file('Write', '.claude/worktrees/x.txt'))).toBe(true);
    expect(ruleMatches(anyWrite('Write'), file('Write', `${CWD}\\.claude\\worktrees\\feat\\src\\a.ts`))).toBe(true);
    // The folder itself, and other .claude folders, stay protected.
    expect(isProtectedPath('.claude/worktrees')).toBe(true);
    expect(isProtectedPath('.claude/settings.local.json')).toBe(true);
  });

  it('ordinary paths are not protected; reading a protected path is not a write', () => {
    for (const p of [
      'src/a.ts',
      'gitconfig.md',
      '.github/workflows/ci.yml',
      '.config/nvim/init.lua',
      'docs/.git-notes',
    ]) {
      expect(isProtectedPath(p), p).toBe(false);
    }
    expect(ruleMatches(rule('allow', { tool: 'Read', pathGlob: '**' }), file('Read', '.git/config'))).toBe(true);
  });

  it('a shell command naming a protected path never matches an allow', () => {
    const setContent = rule('allow', { tool: 'PowerShell', commandPrefix: 'Set-Content' });
    expect(ruleMatches(setContent, ps('Set-Content .vscode\\tasks.json x'))).toBe(false);
    expect(ruleMatches(setContent, ps('Set-Content -Path:.vscode\\tasks.json -Value x'))).toBe(false);
    expect(ruleMatches(setContent, ps('Set-Content "C:\\repo\\.git\\config" x'))).toBe(false);
    expect(ruleMatches(setContent, ps('Set-Content notes.txt x'))).toBe(true);
    const cp = rule('allow', { tool: 'Bash', commandPrefix: 'cp' });
    expect(ruleMatches(cp, bash('cp evil .git/hooks/pre-commit'))).toBe(false);
    expect(ruleMatches(cp, bash('cp a --target-directory=.husky'))).toBe(false);
    expect(ruleMatches(cp, bash('cp a b'))).toBe(true);
    // A redirect is refused on its own, and its target is a protected path too.
    expect(ruleMatches(rule('allow', { tool: 'Bash', commandPrefix: 'echo' }), bash('echo x > .git/config'))).toBe(
      false,
    );
    expect(namesProtectedPath('echo x >.git/config')).toBe(true);
    expect(namesProtectedPath('echo x 2>>.npmrc')).toBe(true);
    expect(namesProtectedPath('git status')).toBe(false);
    // A path glued to git's -O, also in a bundle of short options (R-07).
    expect(namesProtectedPath('git diff -pO.git/config')).toBe(true);
    expect(ruleMatches(rule('deny', { commandPrefix: 'cp' }), bash('cp evil .git/hooks/pre-commit'))).toBe(true);
  });

  it('the default git status allow still works', () => {
    expect(evaluate([...DEFAULT_POLICY_RULES], bash('git status'))?.ruleId).toBe('default:git-status');
    expect(evaluate([...DEFAULT_POLICY_RULES], ps('git status -s'))?.ruleId).toBe('default:git-status');
    // …but not when it names a protected path (reading one through a default allow goes to the user).
    expect(evaluate([...DEFAULT_POLICY_RULES], bash('git diff .git/config'))).toBeNull();
  });

  describe('bypasses found in review of a88f205: one check over every form of every path', () => {
    const setContent = rule('allow', { tool: 'PowerShell', commandPrefix: 'Set-Content' });
    const write = rule('allow', { tool: 'Write', pathGlob: '**' });
    const REPO = 'C:\\repo';

    it('(a) a shell already inside a protected folder: `cd .git` then `Set-Content config x`', () => {
      expect(ruleMatches(setContent, ps('Set-Content config x', { cwd: `${REPO}\\.git`, sessionCwd: REPO }))).toBe(
        false,
      );
      expect(ruleMatches(setContent, ps('Set-Content notes.txt x', { cwd: `${REPO}\\.git`, sessionCwd: REPO }))).toBe(
        false,
      );
      expect(ruleMatches(setContent, ps('Set-Content notes.txt x', { cwd: REPO, sessionCwd: REPO }))).toBe(true);
    });

    it('(b) a relative token is resolved where the agent is: `..\\.git\\config` from a subfolder', () => {
      const i = ps('Set-Content ..\\.git\\config x', { cwd: `${REPO}\\src`, sessionCwd: REPO });
      expect(ruleMatches(setContent, i)).toBe(false);
      expect(ruleMatches(write, file('Write', '..\\.git\\config', { cwd: `${REPO}\\src`, sessionCwd: REPO }))).toBe(
        false,
      );
      // `..` that the Huddle cannot pin down is refused for an allow even when it names nothing protected.
      expect(
        ruleMatches(setContent, ps('Set-Content ..\\notes.txt x', { cwd: `${REPO}\\src`, sessionCwd: REPO })),
      ).toBe(false);
    });

    it('(c) `.claude/worktrees/../settings.json` is not exempt (Write tool and shell token)', () => {
      expect(isProtectedPath('.claude/worktrees/../settings.json')).toBe(true);
      expect(ruleMatches(write, file('Write', '.claude/worktrees/../settings.json', { cwd: REPO }))).toBe(false);
      expect(ruleMatches(write, file('Write', `${REPO}\\.claude\\worktrees\\..\\settings.json`, { cwd: REPO }))).toBe(
        false,
      );
      expect(ruleMatches(setContent, ps('Set-Content .claude\\worktrees\\..\\settings.json x', { cwd: REPO }))).toBe(
        false,
      );
    });

    it('(d) PowerShell wildcards: `Set-Content .gi?\\config x`', () => {
      for (const command of [
        'Set-Content .gi?\\config x',
        'Set-Content .g*\\config x',
        'Set-Content .gi[t]\\config x',
      ]) {
        expect(isPlainCommand(command, 'powershell'), command).toBe(false);
        expect(ruleMatches(setContent, ps(command, { cwd: REPO })), command).toBe(false);
      }
    });

    it('(e) 8.3 short names: `Set-Content GIT~1\\config x`', () => {
      expect(protectedForAllow('GIT~1\\config')).toBe(true);
      expect(protectedForAllow('GITCON~1')).toBe(true);
      expect(ruleMatches(setContent, ps('Set-Content GIT~1\\config x', { cwd: REPO }))).toBe(false);
      expect(ruleMatches(write, file('Write', `${REPO}\\GIT~1\\config`, { cwd: REPO }))).toBe(false);
      expect(ruleMatches(write, file('Write', 'GITCON~1', { cwd: REPO }))).toBe(false);
      // Cost: a git ref like HEAD~1 looks the same, so it goes to the user too.
      expect(evaluate([...DEFAULT_POLICY_RULES], bash('git diff HEAD~1', { cwd: REPO }))).toBeNull();
    });

    it('deny and ask are unaffected', () => {
      const deny = rule('deny', { tool: 'PowerShell', commandPrefix: 'Set-Content' });
      expect(ruleMatches(deny, ps('Set-Content GIT~1\\config x', { cwd: `${REPO}\\.git`, sessionCwd: REPO }))).toBe(
        true,
      );
    });

    it('ordinary work still allows', () => {
      expect(ruleMatches(write, file('Write', '.claude/worktrees/feat/a.txt', { cwd: REPO }))).toBe(true);
      expect(ruleMatches(write, file('Write', `${REPO}\\.claude\\worktrees\\feat\\a.txt`, { cwd: REPO }))).toBe(true);
      expect(ruleMatches(write, file('Write', `${REPO}\\src\\a.ts`, { cwd: `${REPO}\\src`, sessionCwd: REPO }))).toBe(
        true,
      );
      const defaults = [...DEFAULT_POLICY_RULES];
      expect(evaluate(defaults, ps('Get-ChildItem src', { cwd: REPO }))?.ruleId).toBe('default:get-childitem');
      expect(evaluate(defaults, ps('dir .\\src', { cwd: REPO }))?.ruleId).toBe('default:dir');
      expect(evaluate(defaults, bash('git status', { cwd: REPO }))?.ruleId).toBe('default:git-status');
      expect(evaluate(defaults, bash('git status', { cwd: `${REPO}\\src`, sessionCwd: REPO }))?.ruleId).toBe(
        'default:git-status',
      );
    });
  });

  it('the list is one frozen constant covering the documented directories and files', () => {
    expect(Object.isFrozen(PROTECTED_PATHS)).toBe(true);
    expect(PROTECTED_PATHS.dirs).toEqual(
      expect.arrayContaining([
        '.git',
        '.vscode',
        '.idea',
        '.husky',
        '.cargo',
        '.devcontainer',
        '.yarn',
        '.mvn',
        '.claude',
      ]),
    );
    expect(PROTECTED_PATHS.files).toEqual(
      expect.arrayContaining([
        '.gitconfig',
        '.gitmodules',
        '.npmrc',
        '.pnpmfile.cjs',
        '.bazelrc',
        '.mcp.json',
        '.claude.json',
      ]),
    );
  });
});

describe('the default rule set (ADR-020 §3)', () => {
  const defaults = [...DEFAULT_POLICY_RULES];

  it('has stable default:* ids, a note each, and only allows', () => {
    expect(defaults.map((r) => r.id)).toEqual([
      'default:git-status',
      'default:git-diff',
      'default:git-log',
      'default:ls',
      'default:dir',
      'default:get-childitem',
      'default:pwd',
      'default:get-location',
      'default:node-version',
      'default:npm-version',
      'default:claude-version',
    ]);
    for (const r of defaults) {
      expect(r.action).toBe('allow');
      expect(r.enabled).toBe(true);
      expect(r.note?.length ?? 0).toBeGreaterThan(0);
      expect(r.match.commandPrefix).toBeDefined();
    }
  });

  it.each([
    'rm x',
    'rm -rf /',
    'rm -rf .',
    'del x',
    'ri x',
    'rmdir x',
    'Remove-Item x',
    'Remove-Item -Recurse -Force .',
    'git push --force',
    'git push -f',
    'git push origin main',
    'git clean -fdx',
    'git clean',
    'git reset --hard',
    'git checkout -- .',
    'npm i',
    'npm i lodash',
    'npm install',
    'npm install lodash',
    'npm --version install lodash',
    'npx something',
    'pip install requests',
    'curl https://example.com',
    'wget https://example.com',
    'iwr https://example.com',
    'Invoke-WebRequest https://example.com',
    'git diff --output=x',
    'git log --output x',
    'git diff -O../../orderfile',
    'git diff -pO../../orderfile',
    'git diff -RO../x',
    'git status && rm -rf x',
    'ls; rm -rf x',
    'node --version -r ./evil.js',
    'node -e "require(1)"',
    'claude --version --dangerously-skip-permissions',
    'Get-ChildItem Env:',
    'dir \\\\attacker\\share',
  ])('no default allows %j (Bash or PowerShell)', (command) => {
    expect(evaluate(defaults, bash(command))).toBeNull();
    expect(evaluate(defaults, ps(command))).toBeNull();
  });

  it.each([
    ['git status', 'default:git-status'],
    ['git status -s', 'default:git-status'],
    ['git diff HEAD', 'default:git-diff'],
    ['git log --oneline -5', 'default:git-log'],
    ['git log -1 --oneline', 'default:git-log'],
    ['git diff -p src/a.ts', 'default:git-diff'],
    ['ls -la', 'default:ls'],
    ['dir', 'default:dir'],
    ['pwd', 'default:pwd'],
    ['node --version', 'default:node-version'],
    ['npm --version', 'default:npm-version'],
    ['claude --version', 'default:claude-version'],
  ])('allows the read-only %j', (command, id) => {
    expect(evaluate(defaults, bash(command))).toMatchObject({ action: 'allow', ruleId: id });
  });

  it('allows the PowerShell read-only commands', () => {
    expect(evaluate(defaults, ps('Get-ChildItem -Force'))?.ruleId).toBe('default:get-childitem');
    expect(evaluate(defaults, ps('Get-Location'))?.ruleId).toBe('default:get-location');
  });

  it('applies to shell tools only', () => {
    expect(evaluate(defaults, file('Read', `${CWD}\\a.ts`))).toBeNull();
    expect(evaluate(defaults, input({ toolName: 'WebFetch', command: null }))).toBeNull();
  });
});

describe('security review of the M4 branch (2026-11-14): H1 Unicode spaces and quotes', () => {
  const defaults = [...DEFAULT_POLICY_RULES];
  it.each([
    'git diff HEAD\u00A0--output=C:/x',
    'git diff HEAD\u2003--output=C:/x',
    'git diff HEAD\u3000--output=C:/x',
    'git diff HEAD\u0085--output=C:/x',
    'git diff --o\u2018\u2019utput=x',
    'git diff --o\u201C\u201Dutput=x',
    'git diff \u2013\u2013output=x',
    'git status caf\u00e9',
    'ls \uff3c\uff3cattacker\uff3cshare',
  ])('an allow never matches a command with a non-ASCII character: %j', (command) => {
    expect(isPlainCommand(command, 'bash')).toBe(false);
    expect(isPlainCommand(command, 'powershell')).toBe(false);
    expect(evaluate(defaults, bash(command))).toBeNull();
    expect(evaluate(defaults, ps(command))).toBeNull();
  });

  it('deny and ask read Unicode spaces, smart quotes and dashes the way PowerShell does', () => {
    const deny = rule('deny', { commandPrefix: 'git diff --output' });
    expect(ruleMatches(deny, ps('git\u00A0diff\u2003--output x'))).toBe(true);
    expect(ruleMatches(deny, ps('git diff \u2013\u2013output\u3000x'))).toBe(true);
    expect(ruleMatches(rule('ask', { commandPrefix: 'rm -rf' }), bash('rm\u00A0-rf x'))).toBe(true);
    // The protected-path check uses the same tokens: a Unicode space does not hide a token.
    expect(namesProtectedPath('Set-Content\u00A0.git\\config\u2003x')).toBe(true);
    expect(namesProtectedPath('Set-Content \u2018.git\\config\u2019 x')).toBe(true);
  });

  it('plain ASCII commands still allow', () => {
    expect(evaluate(defaults, bash('git diff HEAD -- src'))?.ruleId).toBe('default:git-diff');
    expect(evaluate(defaults, ps('Get-ChildItem -Force'))?.ruleId).toBe('default:get-childitem');
  });
});

describe('security review of the M4 branch (2026-11-14): H2 network paths after quote removal', () => {
  const defaults = [...DEFAULT_POLICY_RULES];
  it.each([
    "ls '//attacker/share'",
    "ls '/'/attacker/share",
    'ls "//attacker/share"',
    'ls \\/attacker/share',
    'ls /\\attacker\\share',
    'ls src//attacker/share',
    'ls --dir=//attacker/share',
    'Get-ChildItem "//attacker/share"',
    "Get-ChildItem '\\\\attacker\\share'",
    "Get-ChildItem '\\'\\attacker\\share",
    'Get-ChildItem -Path "\\\\attacker\\share"',
    'dir \\\\.\\pipe\\x',
    'dir \\\\?\\C:\\x',
    'dir \\??\\C:\\x',
  ])('%j never matches a default allow, in either shell', (command) => {
    expect(evaluate(defaults, bash(command))).toBeNull();
    expect(evaluate(defaults, ps(command))).toBeNull();
    expect(isPlainCommand(command, 'powershell')).toBe(false);
    expect(isPlainCommand(command, 'bash')).toBe(false);
  });

  it('single separators still allow', () => {
    expect(evaluate(defaults, ps('Get-ChildItem C:/Users/dev/project/src'))?.ruleId).toBe('default:get-childitem');
    expect(evaluate(defaults, ps("Get-ChildItem 'src/a'"))?.ruleId).toBe('default:get-childitem');
    expect(evaluate(defaults, bash('ls src/a'))?.ruleId).toBe('default:ls');
  });
});

describe('security review of the M4 branch (2026-11-14): H3 file-tool allows are contained', () => {
  const STARTUP = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat';
  const OUTSIDE = [STARTUP, '~/.aws/credentials', '~\\.ssh\\id_ed25519', 'D:\\x', '..\\other\\a.ts', '\\\\h\\s\\a'];
  it.each(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])(
    'an allow on %s without a path glob approves nothing outside the session folder',
    (tool) => {
      const r = rule('allow', { tool });
      for (const p of OUTSIDE) expect(ruleMatches(r, file(tool, p)), p).toBe(false);
      expect(ruleMatches(r, file(tool, 'src\\a.ts'))).toBe(true);
      expect(ruleMatches(r, file(tool, `${CWD}\\src\\a.ts`))).toBe(true);
    },
  );

  it('a role-only allow (refused on save, but hand-built) is contained the same way', () => {
    const r = rule('allow', { role: 'main' });
    expect(ruleMatches(r, file('Edit', STARTUP))).toBe(false);
    expect(ruleMatches(r, file('Edit', 'src\\a.ts'))).toBe(true);
  });

  it('home-relative and variable paths never allow', () => {
    const r = rule('allow', { tool: 'Read' });
    for (const p of ['~', '~/x', 'src/~/x', '%USERPROFILE%\\.ssh\\id_rsa', '$HOME/.ssh/id_rsa', 'src\\~user\\a']) {
      expect(ruleMatches(r, file('Read', p)), p).toBe(false);
    }
  });

  it('a file tool with no path: Glob and Grep search the cwd (allowed); Read must name one', () => {
    expect(ruleMatches(rule('allow', { tool: 'Glob' }), input({ toolName: 'Glob', command: null }))).toBe(true);
    expect(ruleMatches(rule('allow', { tool: 'Read' }), input({ toolName: 'Read', command: null }))).toBe(false);
  });

  it('deny and ask are unchanged', () => {
    expect(ruleMatches(rule('deny', { tool: 'Edit' }), file('Edit', STARTUP))).toBe(true);
    expect(ruleMatches(rule('ask', { tool: 'Read' }), file('Read', '~/.aws/credentials'))).toBe(true);
  });
});

describe('security review of the M4 branch (2026-11-14): L2 an unknown session folder allows nothing', () => {
  it.each([
    ['Bash', () => bash('git status', { sessionCwd: null })],
    ['PowerShell', () => ps('Get-ChildItem', { sessionCwd: null })],
    ['Read', () => file('Read', `${CWD}\\a.ts`, { sessionCwd: null })],
    ['Glob', () => input({ toolName: 'Glob', command: null, sessionCwd: null })],
    ['WebFetch', () => input({ toolName: 'WebFetch', command: null, sessionCwd: null })],
  ] as const)('%s', (tool, make) => {
    const i = make();
    expect(evaluate([...DEFAULT_POLICY_RULES], i)).toBeNull();
    expect(ruleMatches(rule('allow', { tool }), i)).toBe(false);
    expect(ruleMatches(rule('deny', { tool }), i)).toBe(true);
  });
});

describe('default allows stay inside the session folder (A2-01, AX-02)', () => {
  const PROJ = 'C:\\proj';
  const at = { cwd: PROJ, sessionCwd: PROJ };
  it.each([
    ['Bash', 'git diff --no-index C:/Users/Jane/.ssh/id_rsa C:/proj/x'],
    ['Bash', 'git diff --no-index /c/Users/Jane/.ssh/id_rsa /dev/null'],
    ['PowerShell', 'git diff --no-index C:/Users/Jane/.ssh/id_rsa NUL'],
    ['PowerShell', 'git diff --no-index a NUL'],
    ['Bash', 'git diff --no-i a b'],
    ['Bash', 'git diff --output=x'],
    ['Bash', 'ls -la C:/Users/Jane/.ssh'],
    ['Bash', 'ls ../other'],
    ['Bash', 'ls src/../../other'],
    ['PowerShell', 'Get-ChildItem C:/Users/Jane/.ssh -Force'],
    ['PowerShell', 'Get-ChildItem -Path:C:/Users/J/.ssh -Force'],
    ['PowerShell', 'Get-ChildItem \\Users\\Jane\\.ssh'],
    ['PowerShell', 'dir D:\\secrets'],
    ['Bash', 'git -C C:/other status'],
  ])('%s %j is not allowed', (tool, command) => {
    expect(evaluate([...DEFAULT_POLICY_RULES], input({ toolName: tool, command, ...at }))).toBeNull();
  });

  it.each([
    ['Bash', 'git diff src/a.ts'],
    ['Bash', 'git log --oneline -5'],
    ['Bash', 'ls src'],
    ['Bash', 'ls src/lib'],
    ['PowerShell', 'git diff HEAD -- src/a.ts'],
    ['PowerShell', 'Get-ChildItem C:\\proj\\src'],
    ['PowerShell', 'dir .\\src'],
  ])('%s %j is still allowed', (tool, command) => {
    expect(evaluate([...DEFAULT_POLICY_RULES], input({ toolName: tool, command, ...at }))?.action).toBe('allow');
  });
});
