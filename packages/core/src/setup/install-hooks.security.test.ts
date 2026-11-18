/** Security review M1, findings 4 to 7: parse errors, the consent diff, ownership and symlinked settings. */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HookInstaller,
  describeJsonError,
  diffSettings,
  formatDiff,
  isHuddleHook,
  planInstall,
  planUninstall,
  settingsForDisplay,
} from './install-hooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FORWARDER_SOURCE = path.resolve(here, '../../../../scripts/huddle-forward-hook.mjs');
const TOKEN = 'test-token-0123456789';
const OLD_TOKEN = 'old-token-abcdefghij';

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-setup-sec-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

function installer(configDir: string): HookInstaller {
  let t = Date.UTC(2026, 10, 13, 16, 41, 37, 0);
  return new HookInstaller({
    configDir,
    now: () => new Date((t += 1000)),
    newToken: () => TOKEN,
    forwarderSource: FORWARDER_SOURCE,
  });
}

function hooksOf(settings: Record<string, unknown>): Record<string, unknown>[] {
  const hooks = (settings.hooks ?? {}) as Record<string, { hooks?: Record<string, unknown>[] }[]>;
  return Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks ?? []));
}

describe('JSON parse errors never echo settings.json (finding 4)', () => {
  it('reports only a line and column', async () => {
    const dir = await tmpDir();
    const secret = 'sk-ant-api03-SECRETSECRETSECRET';
    await fsp.writeFile(path.join(dir, 'settings.json'), `{\n  "env": { "ANTHROPIC_API_KEY": "${secret}" ,, }\n}`);
    const prepared = await installer(dir).prepareInstall({ port: 47821, token: TOKEN });
    if (!('ok' in prepared)) throw new Error('expected a plan error');
    const error = prepared.error;
    expect(error).toMatch(/is not valid JSON at line 2, column \d+\. Fix or remove/);
    expect(error).not.toContain(secret);
    expect(error).not.toContain('SECRET');
  });

  it('describes errors from the message position, the end of input, or not at all', () => {
    const text = '{\n  "a": 1,\n  x\n}';
    expect(describeJsonError(text, new SyntaxError('Unexpected token x in JSON at position 14'))).toBe(
      'not valid JSON at line 3, column 3',
    );
    expect(describeJsonError('{"a":', new SyntaxError('Unexpected end of JSON input'))).toBe(
      'not valid JSON at line 1, column 6',
    );
    expect(describeJsonError('x', new Error('something "secret" here'))).toBe('not valid JSON');
    expect(describeJsonError('x', 'not an error')).toBe('not valid JSON');
  });
});

describe('the consent diff hides other secrets (finding 5)', () => {
  const before = {
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrSt',
      MY_VAR: 'plain',
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'http',
              url: 'https://hooks.example.com/x',
              headers: { Authorization: 'Bearer user-secret-1', 'X-Huddle-Token': OLD_TOKEN, 'X-Trace': 'abc' },
            },
          ],
        },
      ],
    },
    apiKeyHelper: '/usr/bin/get-key',
    mcp: { password: 'pw-123' },
    note: 'GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ',
  };

  it('hides foreign env values, every X-Huddle-Token, credential headers and masked text', () => {
    const plan = planInstall(before, {
      port: 47821,
      token: TOKEN,
      forwarderPath: 'C:/Users/me/.claude/agent-huddle/huddle-forward-hook.mjs',
    });
    if (!plan.ok) throw new Error(plan.error);
    const text = formatDiff(diffSettings(plan.before, plan.after, [TOKEN]), 1000);
    for (const secret of [
      'AbCdEfGhIjKlMnOpQrSt',
      'plain',
      'user-secret-1',
      OLD_TOKEN,
      TOKEN,
      'pw-123',
      'ghp_0123456789abcdefghijABCDEFGHIJ',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"ANTHROPIC_API_KEY": "<hidden>"');
    expect(text).toContain('"X-Huddle-Token": "<token>"');
    expect(text).toContain('"OTEL_EXPORTER_OTLP_HEADERS": "X-Huddle-Token=<token>"');
    expect(text).toContain('"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:47821"');
    expect(text).toContain('"X-Trace": "abc"');
    expect(text).toContain('"apiKeyHelper": "/usr/bin/get-key"');
  });

  it('hides values in OTEL headers that are not the Huddle token', () => {
    const shown = settingsForDisplay({
      env: { OTEL_EXPORTER_OTLP_HEADERS: `X-Huddle-Token=${OLD_TOKEN},x-honeycomb-team=abc123` },
    });
    expect(shown).toEqual({ env: { OTEL_EXPORTER_OTLP_HEADERS: 'X-Huddle-Token=<token>,x-honeycomb-team=<hidden>' } });
  });
});

describe('ownership is exact (finding 6)', () => {
  const ours = [
    { type: 'http', url: 'http://127.0.0.1:47821/huddle/hooks/PreToolUse' },
    { type: 'command', command: 'node "C:/Users/me/.claude/agent-huddle/huddle-forward-hook.mjs"' },
    { type: 'command', command: 'node "C:\\Users\\me/.claude\\agent-huddle/huddle-forward-hook.mjs"' },
    { type: 'command', command: 'node "/home/me/.claude/agent-huddle/huddle-forward-hook.mjs"' },
  ];
  const theirs = [
    { type: 'http', url: 'https://example.com/huddle/hooks/x' },
    { type: 'http', url: 'http://127.0.0.1:47821/huddle/hooks/PreToolUse?forward=1' },
    { type: 'http', url: 'http://localhost:47821/huddle/hooks/Stop' },
    { type: 'command', command: 'node "C:/Users/me/.claude/agent-huddle/huddle-forward-hook.mjs" && echo wrapped' },
    { type: 'command', command: 'my-wrapper node "C:/Users/me/.claude/agent-huddle/huddle-forward-hook.mjs"' },
    { type: 'command', command: 'node "C:/tools/huddle-forward-hook.mjs"' },
  ];

  it.each(ours)('owns %j', (hook) => {
    expect(isHuddleHook(hook)).toBe(true);
  });
  it.each(theirs)('does not own %j', (hook) => {
    expect(isHuddleHook(hook)).toBe(false);
  });

  it("keeps a user's wrapper command and https hook on uninstall", () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [...ours.slice(0, 1), theirs[0]] }],
        SessionStart: [{ hooks: [ours[1], theirs[3]] }],
      },
    };
    const plan = planUninstall(settings);
    if (!plan.ok) throw new Error(plan.error);
    expect(hooksOf(plan.after)).toEqual([theirs[0], theirs[3]]);
  });
});

describe('a symlinked settings.json (finding 7)', () => {
  it('writes the link target and keeps the link', async (ctx) => {
    const dir = await tmpDir();
    const real = path.join(dir, 'dotfiles', 'claude-settings.json');
    await fsp.mkdir(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, '{"theme":"dark"}\n');
    const link = path.join(dir, 'settings.json');
    try {
      await fsp.symlink(real, link, 'file');
    } catch (err) {
      // Windows without Developer Mode or admin rights refuses to create symbolic links (EPERM). Only this test
      // depends on that; the behavior is the same on every OS that has links.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip();
        return;
      }
      throw err;
    }
    const result = await installer(dir).install({ port: 47821, token: TOKEN }, { consent: true });
    expect(result.status).toBe('written');
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(await fsp.readFile(real, 'utf8')) as Record<string, unknown>;
    expect(written.theme).toBe('dark');
    expect(hooksOf(written).some((h) => isHuddleHook(h))).toBe(true);
    // The backup holds the content from before the write.
    if (result.status === 'written' && result.backupPath !== null) {
      expect(await fsp.readFile(result.backupPath, 'utf8')).toBe('{"theme":"dark"}\n');
    }
  });

  it('routes the write to the link target (simulated link, runs on every machine)', async () => {
    const dir = await tmpDir();
    const real = path.join(dir, 'dotfiles', 'claude-settings.json');
    const link = path.join(dir, 'settings.json');
    await fsp.mkdir(path.dirname(real), { recursive: true });
    // Same content in both, as a real link would read; lstat/realpath report a link for settings.json.
    await fsp.writeFile(real, '{"theme":"dark"}\n');
    await fsp.writeFile(link, '{"theme":"dark"}\n');
    const realLstat = fsp.lstat.bind(fsp);
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation(async (p, opts) => {
      const stat = await realLstat(p, opts as undefined);
      if (path.resolve(String(p)) === path.resolve(link)) return Object.assign(stat, { isSymbolicLink: () => true });
      return stat;
    });
    const realpath = vi.spyOn(fsp, 'realpath').mockImplementation((p) => {
      if (path.resolve(String(p)) === path.resolve(link)) return Promise.resolve(real);
      return Promise.resolve(path.resolve(String(p)));
    });
    try {
      const result = await installer(dir).install({ port: 47821, token: TOKEN }, { consent: true });
      expect(result.status).toBe('written');
    } finally {
      lstat.mockRestore();
      realpath.mockRestore();
    }
    expect(await fsp.readFile(link, 'utf8')).toBe('{"theme":"dark"}\n');
    const written = JSON.parse(await fsp.readFile(real, 'utf8')) as Record<string, unknown>;
    expect(hooksOf(written).some((h) => isHuddleHook(h))).toBe(true);
    // The temp file was made next to the target, and nothing is left behind.
    expect((await fsp.readdir(path.dirname(real))).filter((n) => n.includes('huddle-tmp'))).toEqual([]);
  });
});

describe('readAskRelevantKeys (M5 security review L1): key names only, read-only', () => {
  it('answers the env key names and whether apiKeyHelper is set, never a value', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'settings.json');
    const text = JSON.stringify({
      apiKeyHelper: 'C:/tools/VALUE-HELPER.cmd',
      env: { ANTHROPIC_BASE_URL: 'https://VALUE-URL.example', ANTHROPIC_API_KEY: 'sk-ant-VALUE-KEY' },
    });
    await fsp.writeFile(file, text);
    const keys = await installer(dir).readAskRelevantKeys();
    expect(keys).toEqual({ envKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'], apiKeyHelper: true });
    expect(JSON.stringify(keys)).not.toContain('VALUE');
    expect(await fsp.readFile(file, 'utf8')).toBe(text);
    expect(await fsp.readdir(dir)).toEqual(['settings.json']);
  });

  it('a missing file has neither; an empty helper is none; a broken or non-object file is unknown', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'settings.json');
    expect(await installer(dir).readAskRelevantKeys()).toEqual({ envKeys: [], apiKeyHelper: false });
    await fsp.writeFile(file, JSON.stringify({ apiKeyHelper: '', env: 'nope' }));
    expect(await installer(dir).readAskRelevantKeys()).toEqual({ envKeys: [], apiKeyHelper: false });
    await fsp.writeFile(file, '{ "env": { "ANTHROPIC_API_KEY": "sk-x" ,, }');
    expect(await installer(dir).readAskRelevantKeys()).toBeNull();
    await fsp.writeFile(file, '[1, 2]');
    expect(await installer(dir).readAskRelevantKeys()).toBeNull();
  });
});
