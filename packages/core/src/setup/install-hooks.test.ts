import { spawn, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_PREFIX,
  CORE_EVENTS,
  DEFAULT_TIMEOUT,
  FORWARDER_FILENAME,
  HOLD_TIMEOUT_S,
  HUDDLE_DIRNAME,
  HookInstaller,
  NEWER_EVENTS,
  PERMISSION_TIMEOUT_S,
  ORIGINAL_BACKUP_NAME,
  backupStamp,
  checkTimeoutOverrides,
  diffSettings,
  formatDiff,
  isHuddleHook,
  planInstall,
  planUninstall,
  type InstallOptions,
  type PreparedChange,
} from './install-hooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FORWARDER_SOURCE = path.resolve(here, '../../../../scripts/huddle-forward-hook.mjs');
const SCRIPT_INSTALLER = path.resolve(here, '../../../../scripts/install-hooks.mjs');
const TOKEN = 'test-token-0123456789';

// The user's own settings: never changed by the Huddle.
const USER_SETTINGS = {
  theme: 'dark',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-guard.js' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
  },
  env: { MY_VAR: '1' },
};

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-setup-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

function clock(start = Date.UTC(2026, 10, 13, 16, 41, 37, 0)): () => Date {
  let t = start;
  return () => new Date((t += 1000));
}

function installer(configDir: string, extra: Partial<ConstructorParameters<typeof HookInstaller>[0]> = {}) {
  return new HookInstaller({
    configDir,
    now: clock(),
    newToken: () => TOKEN,
    forwarderSource: FORWARDER_SOURCE,
    uninstallCommand: 'HuddleApp.exe --remove-hooks',
    ...extra,
  });
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
}

async function writeSettings(dir: string, value: unknown): Promise<void> {
  await fsp.writeFile(path.join(dir, 'settings.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function prepared(value: PreparedChange | { ok: false; error: string }): PreparedChange {
  if ('ok' in value) throw new Error(value.error);
  return value;
}

const options = (over: Partial<InstallOptions> = {}): InstallOptions => ({
  port: 47821,
  token: TOKEN,
  forwarderPath: 'C:\\Users\\me/.claude\\agent-huddle/huddle-forward-hook.mjs',
  ...over,
});

describe('planInstall / planUninstall (pure)', () => {
  it('adds HTTP hooks, the SessionStart forwarder and telemetry, keeping the user entries', () => {
    const plan = planInstall(USER_SETTINGS, options());
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.changed).toBe(true);
    const hooks = plan.after.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>;
    expect(hooks.PreToolUse?.[0]).toEqual(USER_SETTINGS.hooks.PreToolUse[0]);
    expect(hooks.PreToolUse?.[1]?.hooks[0]).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:47821/huddle/hooks/PreToolUse',
      timeout: 600,
    });
    expect(hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(600);
    expect(hooks.SessionStart?.[0]).toEqual(USER_SETTINGS.hooks.SessionStart[0]);
    // mixed slashes in the forwarder path become forward slashes in the command
    expect(hooks.SessionStart?.[1]?.hooks[0]?.command).toMatch(/^node ".*\/agent-huddle\/huddle-forward-hook\.mjs"$/);
    expect(String(hooks.SessionStart?.[1]?.hooks[0]?.command)).not.toContain('\\');
    expect(plan.after.env).toMatchObject({ MY_VAR: '1', OTEL_EXPORTER_OTLP_HEADERS: `X-Huddle-Token=${TOKEN}` });
    expect(plan.before).toEqual(USER_SETTINGS); // input untouched
  });

  it('is idempotent: installing over an install is no change', () => {
    const first = planInstall(USER_SETTINGS, options());
    if (!first.ok) throw new Error(first.error);
    const second = planInstall(first.after, options());
    if (!second.ok) throw new Error(second.error);
    expect(second.changed).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('a new port is a change, and replaces the old entries instead of adding twice', () => {
    const first = planInstall({}, options());
    if (!first.ok) throw new Error(first.error);
    const moved = planInstall(first.after, options({ port: 50000 }));
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.changed).toBe(true);
    const groups = (moved.after.hooks as Record<string, unknown[]>).PreToolUse;
    expect(groups).toHaveLength(1);
  });

  it('uninstall removes only the Huddle entries and keeps telemetry unless asked', () => {
    const installed = planInstall(USER_SETTINGS, options());
    if (!installed.ok) throw new Error(installed.error);
    const detached = planUninstall(installed.after);
    if (!detached.ok) throw new Error(detached.error);
    expect(detached.after.hooks).toEqual(USER_SETTINGS.hooks);
    expect(detached.after.env).toMatchObject({ MY_VAR: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
    const full = planUninstall(installed.after, { removeTelemetry: true });
    if (!full.ok) throw new Error(full.error);
    expect(full.after).toEqual(USER_SETTINGS);
  });

  it('leaves foreign telemetry alone and warns', () => {
    const plan = planInstall({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' } }, options());
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.after.env).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' });
    expect(plan.warnings.join('\n')).toMatch(/already have telemetry/);
  });

  it('rejects settings it cannot safely edit', () => {
    expect(planInstall([], options()).ok).toBe(false);
    expect(planInstall({ hooks: [] }, options()).ok).toBe(false);
    expect(planInstall({ env: 'x' }, options()).ok).toBe(false);
    expect(planInstall({}, options({ port: 80 })).ok).toBe(false);
    // a user key named "ok" is just a key
    const odd = planInstall({ ok: false }, options());
    expect(odd.ok).toBe(true);
  });

  it('only recognizes Huddle hooks by URL or forwarder name', () => {
    expect(isHuddleHook({ type: 'http', url: 'http://127.0.0.1:1/huddle/hooks/Stop' })).toBe(true);
    // Security review M1 (finding 6): only the exact form the installer writes counts.
    expect(
      isHuddleHook({ type: 'command', command: 'node "C:/Users/me/.claude/agent-huddle/huddle-forward-hook.mjs"' }),
    ).toBe(true);
    expect(isHuddleHook({ type: 'command', command: 'node "x/huddle-forward-hook.mjs"' })).toBe(false);
    expect(isHuddleHook({ type: 'http', url: 'http://127.0.0.1:1/other' })).toBe(false);
    expect(isHuddleHook('nope')).toBe(false);
  });
});

describe('refusals and telemetry on re-install (A2-06, A6-05, A6-07)', () => {
  it.each(['C:/Users/a$b', 'C:/Users/a`b', 'C:/Users/a"b', 'C:/Users/a%b%'])(
    'refuses a forwarder path with a shell-special character: %s',
    (dir) => {
      const plan = planInstall(
        { theme: 'dark' },
        options({ forwarderPath: `${dir}/agent-huddle/huddle-forward-hook.mjs` }),
      );
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error).toContain('cannot be quoted safely');
    },
  );

  it('refuses a status line wrapper path with a dollar sign', () => {
    const plan = planInstall(
      {},
      options({ statusLine: true, statuslineWrapperPath: 'C:/Users/a$b/agent-huddle/huddle-statusline.mjs' }),
    );
    expect(plan.ok).toBe(false);
  });

  it('a re-install without telemetry removes the Huddle telemetry it added before, and keeps foreign keys', () => {
    const first = planInstall({}, options());
    if (!first.ok) throw new Error(first.error);
    expect(first.after.env).toBeDefined();
    const second = planInstall(first.after, options({ otel: false }));
    if (!second.ok) throw new Error(second.error);
    expect(second.after.env).toBeUndefined();
    expect(second.notes.join('\n')).toMatch(/remove \d+ .*telemetry/);
    const foreign = planInstall({ env: { OTEL_LOGS_EXPORTER: 'console' } }, options({ otel: false }));
    if (!foreign.ok) throw new Error(foreign.error);
    expect(foreign.after.env).toEqual({ OTEL_LOGS_EXPORTER: 'console' });
  });

  it('refuses a hooks.<Event> that is not an array', () => {
    const plan = planInstall({ hooks: { Stop: {} } }, options());
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain('"hooks.Stop" in settings.json is not an array');
  });
});

describe('--timeout warnings (deferred minor M4)', () => {
  it('warns for SessionStart, for uninstall, and for an event that is not installed', () => {
    expect(checkTimeoutOverrides('install', 'all', { SessionStart: 30 }).warnings[0]).toMatch(
      /SessionStart.*no effect/,
    );
    expect(checkTimeoutOverrides('uninstall', 'all', { PreToolUse: 60 }).warnings[0]).toMatch(
      /no effect with uninstall/,
    );
    expect(checkTimeoutOverrides('install', 'core', { PostModelSwitch: 9 }).warnings[0]).toMatch(/not installed/);
    const ok = checkTimeoutOverrides('install', 'all', { PreToolUse: 60 });
    expect(ok.warnings).toEqual([]);
    expect(ok.effective).toEqual({ PreToolUse: 60 });
  });

  it('rejects unknown events and non-positive values', () => {
    expect(checkTimeoutOverrides('install', 'all', { NoSuchEvent: 10 }).errors).toHaveLength(1);
    expect(checkTimeoutOverrides('install', 'all', { PreToolUse: 0 }).errors).toHaveLength(1);
    expect(checkTimeoutOverrides('install', 'all', { PreToolUse: 1.5 }).errors).toHaveLength(1);
  });

  it('applies an effective override and surfaces the warnings in the plan', () => {
    const plan = planInstall({}, options({ timeouts: { PreToolUse: 60, SessionStart: 9 } }));
    if (!plan.ok) throw new Error(plan.error);
    const hooks = plan.after.hooks as Record<string, { hooks: { timeout: number }[] }[]>;
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.timeout).toBe(60);
    expect(hooks.SessionStart?.[0]?.hooks[0]?.timeout).toBe(5);
    expect(plan.warnings.join('\n')).toMatch(/SessionStart/);
    const un = planUninstall({}, { timeouts: { PreToolUse: 60 } });
    if (!un.ok) throw new Error(un.error);
    expect(un.warnings).toHaveLength(1);
  });
});

type HookTable = Record<string, { hooks: Record<string, unknown>[] }[]>;

function timeoutsOf(hooks: HookTable): Record<string, unknown> {
  return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups[0]?.hooks[0]?.timeout]));
}

describe('hook timeouts (ADR-019)', () => {
  it('PreToolUse gets the 600 s hold timeout; every other event keeps its timeout', () => {
    expect(HOLD_TIMEOUT_S).toBe(600);
    expect(PERMISSION_TIMEOUT_S).toBe(600);
    const plan = planInstall({}, options());
    if (!plan.ok) throw new Error(plan.error);
    const expected: Record<string, number> = { SessionStart: DEFAULT_TIMEOUT };
    for (const event of [...CORE_EVENTS, ...NEWER_EVENTS]) expected[event] = DEFAULT_TIMEOUT;
    expected.PreToolUse = 600;
    expected.PermissionRequest = 600;
    expected.SessionEnd = 1;
    expect(timeoutsOf(plan.after.hooks as HookTable)).toEqual(expected);
  });

  it('an override still wins over the 600 s default, and 600 itself passes validation without a warning', () => {
    const plan = planInstall({}, options({ timeouts: { PreToolUse: 60 } }));
    if (!plan.ok) throw new Error(plan.error);
    expect(timeoutsOf(plan.after.hooks as HookTable).PreToolUse).toBe(60);
    const check = checkTimeoutOverrides('install', 'all', { PreToolUse: 600, PermissionRequest: 600 });
    expect(check).toEqual({ errors: [], warnings: [], effective: { PreToolUse: 600, PermissionRequest: 600 } });
  });

  it('the consent fingerprint changes with the timeout, so an install from the 5 s table is a new change', () => {
    const old = planInstall(USER_SETTINGS, options({ timeouts: { PreToolUse: 5 } }));
    const now = planInstall(USER_SETTINGS, options());
    if (!old.ok || !now.ok) throw new Error('plan failed');
    expect(now.fingerprint).not.toBe(old.fingerprint);
    // Settings that hold the M2 install (PreToolUse 5 s): re-planning is a real change, shown on the consent screen.
    const over = planInstall(old.after, options());
    if (!over.ok) throw new Error(over.error);
    expect(over.changed).toBe(true);
    expect(over.fingerprint).toBe(now.fingerprint);
    const shown = formatDiff(diffSettings(over.before, over.after, [TOKEN]));
    expect(shown).toMatch(/^\+.*"timeout": 600/m);
    expect(shown).toMatch(/^-.*"timeout": 5,?$/m);
  });

  it('the remembered-consent fingerprint follows the hook table, not the port, token, status line or user settings', () => {
    const base = planInstall(USER_SETTINGS, options());
    if (!base.ok) throw new Error(base.error);
    const fp = base.consentFingerprint;
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const same = [
      planInstall({}, options()),
      planInstall(USER_SETTINGS, options({ port: 51000, token: 'another-token-abcdef' })),
      // An installed bridge (ADR-018) stays as it is at every start: not part of what the consent covers.
      planInstall(USER_SETTINGS, options({ statusLine: true, statuslineWrapperPath: path.resolve('/x/sl.mjs') })),
    ];
    for (const plan of same) {
      if (!plan.ok) throw new Error(plan.error);
      expect(plan.consentFingerprint).toBe(fp);
    }
    // The token is never in it in clear (it is a hash), and a changed table is a new fingerprint.
    expect(fp).not.toContain(TOKEN);
    for (const other of [
      planInstall(USER_SETTINGS, options({ timeouts: { PreToolUse: 5 } })),
      planInstall(USER_SETTINGS, options({ events: 'core' })),
      planInstall(USER_SETTINGS, options({ otel: false })),
    ]) {
      if (!other.ok) throw new Error(other.error);
      expect(other.consentFingerprint).not.toBe(fp);
    }
  });
});

describe('parity with scripts/install-hooks.mjs (npm run hooks:preview)', () => {
  it('the script and the core installer write the same hook entries', async () => {
    const dir = await tmpDir();
    const run = spawnSync(process.execPath, [SCRIPT_INSTALLER, '--config-dir', dir, '--show-json'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DRY RUN');
    // --show-json prints the resulting settings.json between a line "{" and a line "}", the token as <token>.
    const lines = run.stdout.split(/\r?\n/);
    const start = lines.indexOf('{');
    const end = lines.indexOf('}', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const printed = lines
      .slice(start, end + 1)
      .join('\n')
      .replaceAll('<token>', TOKEN);
    const fromScript = JSON.parse(printed) as { hooks: HookTable };
    const plan = planInstall(
      {},
      { port: 47821, token: TOKEN, forwarderPath: path.join(dir, HUDDLE_DIRNAME, FORWARDER_FILENAME) },
    );
    if (!plan.ok) throw new Error(plan.error);
    expect(fromScript.hooks).toEqual(plan.after.hooks);
    expect(timeoutsOf(fromScript.hooks).PreToolUse).toBe(HOLD_TIMEOUT_S);
    // A dry run writes nothing.
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});

describe('diff for the consent screen', () => {
  it('shows added lines and hides the token', () => {
    const plan = planInstall({ theme: 'dark' }, options());
    if (!plan.ok) throw new Error(plan.error);
    const diff = diffSettings(plan.before, plan.after, [TOKEN]);
    expect(diff.some((l) => l.op === '+' && l.text.includes('/huddle/hooks/PreToolUse'))).toBe(true);
    expect(diff.find((l) => l.text.includes('"theme"'))?.op).toBe(' ');
    const text = formatDiff(diff);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('<token>');
  });

  it('an empty diff for no change', () => {
    expect(diffSettings({ a: 1 }, { a: 1 }).every((l) => l.op === ' ')).toBe(true);
  });
});

describe('HookInstaller (temp config folder)', () => {
  it('round trip: install then uninstall leaves the user settings as they were', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const inst = installer(dir);

    expect((await inst.install({}, { consent: true })).status).toBe('written');
    const installed = await readJson(path.join(dir, 'settings.json'));
    expect(Object.keys(installed.hooks as object)).toContain('Stop');

    // idempotent install
    expect((await inst.install({}, { consent: true })).status).toBe('unchanged');

    expect((await inst.uninstall({ removeTelemetry: true }, { consent: true })).status).toBe('written');
    expect(await readJson(path.join(dir, 'settings.json'))).toEqual(USER_SETTINGS);
  });

  it('writes nothing without consent', async () => {
    const dir = await tmpDir();
    const inst = installer(dir);
    const change = prepared(await inst.prepareInstall());
    expect(change.plan.changed).toBe(true);
    expect(change.diff.length).toBeGreaterThan(0);
    expect(await inst.apply(change, { consent: false })).toEqual({ status: 'needs-consent' });
    expect(await inst.apply(change, { consent: 'yes' })).toEqual({ status: 'needs-consent' });
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('re-reads settings.json before writing: a change made after prepare is kept', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, { theme: 'dark' });
    const inst = installer(dir);
    const change = prepared(await inst.prepareInstall());
    // the user (or Claude Code) edits settings.json while the consent screen is open
    await writeSettings(dir, { theme: 'light', permissions: { deny: ['Read(./.env)'] } });
    expect((await inst.apply(change, { consent: true })).status).toBe('written');
    const after = await readJson(path.join(dir, 'settings.json'));
    expect(after.theme).toBe('light');
    expect(after.permissions).toEqual({ deny: ['Read(./.env)'] });
    expect(after.hooks).toBeDefined();
  });

  it('asks again when a concurrent edit changes the Huddle part of the write', async () => {
    const dir = await tmpDir();
    const inst = installer(dir);
    const change = prepared(await inst.prepareInstall());
    // the user adds their own telemetry: the Huddle would now skip its telemetry, which is a different change
    await writeSettings(dir, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' } });
    const result = await inst.apply(change, { consent: true });
    expect(result.status).toBe('stale');
    expect(await readJson(path.join(dir, 'settings.json'))).toEqual({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    });
  });

  it('refuses to overwrite a settings.json that is not valid JSON', async () => {
    const dir = await tmpDir();
    await fsp.writeFile(path.join(dir, 'settings.json'), '{ "theme": "dark", }');
    const result = await installer(dir).install({}, { consent: true });
    expect(result.status).toBe('error');
    expect(await fsp.readFile(path.join(dir, 'settings.json'), 'utf8')).toBe('{ "theme": "dark", }');
  });

  it('writes atomically: no temp files are left behind', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    await installer(dir).install({}, { consent: true });
    const all = [dir, path.join(dir, 'agent-huddle')];
    for (const d of all) {
      expect((await fsp.readdir(d)).filter((n) => n.includes('huddle-tmp'))).toEqual([]);
    }
  });

  it('removes the settings.json temp file when writing it fails (full disk): error, settings.json untouched', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const before = await fsp.readFile(path.join(dir, 'settings.json'), 'utf8');
    const realWrite = fsp.writeFile.bind(fsp);
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation((async (file: string, data: string, opts?: object) => {
      if (path.basename(file).startsWith('settings.json.huddle-tmp-')) {
        await realWrite(file, 'partial');
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      await realWrite(file, data, opts);
    }) as unknown as typeof fsp.writeFile);
    try {
      const result = await installer(dir).install({}, { consent: true });
      expect(result.status).toBe('error');
    } finally {
      spy.mockRestore();
    }
    expect(await fsp.readFile(path.join(dir, 'settings.json'), 'utf8')).toBe(before);
    expect((await fsp.readdir(dir)).filter((n) => n.includes('huddle-tmp'))).toEqual([]);
  });

  it('rotates backups, keeping the last N plus the original', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const inst = installer(dir, { keepBackups: 3 });
    for (let i = 0; i < 4; i++) {
      expect((await inst.install({}, { consent: true })).status).toBe('written');
      expect((await inst.uninstall({}, { consent: true })).status).toBe('written');
    }
    const names = (await fsp.readdir(dir)).filter((n) => n.startsWith(BACKUP_PREFIX)).sort();
    expect(names).toContain(ORIGINAL_BACKUP_NAME);
    expect(names.filter((n) => n !== ORIGINAL_BACKUP_NAME)).toHaveLength(3);
    // the original is the user's file from before the first Huddle write
    expect(await readJson(path.join(dir, ORIGINAL_BACKUP_NAME))).toEqual(USER_SETTINGS);
  });

  it('no backup when there was no settings.json yet', async () => {
    const dir = await tmpDir();
    const result = await installer(dir).install({}, { consent: true });
    expect(result).toMatchObject({ status: 'written', backupPath: null });
  });

  it('resolves a config dir given with mixed slashes', async () => {
    const dir = await tmpDir();
    const nested = path.join(dir, 'a', 'b');
    await fsp.mkdir(nested, { recursive: true });
    const mixed = `${dir.replace(/\\/g, '/')}\\a/b`;
    const inst = installer(mixed);
    expect(inst.settingsPath).toBe(path.join(nested, 'settings.json'));
    expect((await inst.install({}, { consent: true })).status).toBe('written');
    const settings = await readJson(path.join(nested, 'settings.json'));
    const start = (settings.hooks as Record<string, { hooks: { command: string }[] }[]>).SessionStart?.[0]?.hooks[0];
    expect(start?.command).toBe(
      `node "${path.join(nested, 'agent-huddle', 'huddle-forward-hook.mjs').replace(/\\/g, '/')}"`,
    );
  });

  it('install writes config.json (port, token, hint command) and copies the forwarder', async () => {
    const dir = await tmpDir();
    const inst = installer(dir);
    await inst.install({ port: 47999 }, { consent: true });
    const config = await readJson(path.join(dir, 'agent-huddle', 'config.json'));
    expect(config).toMatchObject({ port: 47999, token: TOKEN, uninstallCommand: 'HuddleApp.exe --remove-hooks' });
    expect(await fsp.readFile(inst.forwarderTarget, 'utf8')).toBe(await fsp.readFile(FORWARDER_SOURCE, 'utf8'));
    // an existing token is reused, never replaced
    const again = new HookInstaller({
      configDir: dir,
      now: clock(),
      newToken: () => 'another-token-xyz',
      forwarderSource: FORWARDER_SOURCE,
    });
    await again.install({ port: 47999 }, { consent: true });
    expect((await readJson(path.join(dir, 'agent-huddle', 'config.json'))).token).toBe(TOKEN);
  });
});

describe('ADR-014: quitting removes the hooks, a crash leaves the hint in place', () => {
  async function closedPort(): Promise<number> {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        s.close(() => {
          resolve(port);
        });
      });
    });
  }

  function runForwarder(file: string, configDir: string): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [file], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('exit', (code) => {
        resolve({ code, out });
      });
      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }));
    });
  }

  it('quit: install then uninstall leaves no Huddle hook', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const inst = installer(dir);
    await inst.install({}, { consent: true });
    await inst.uninstall({}, { consent: true });
    const settings = await readJson(path.join(dir, 'settings.json'));
    expect(settings.hooks).toEqual(USER_SETTINGS.hooks);
    // ADR-014: telemetry stays installed (a dead exporter is silent)
    expect(settings.env).toMatchObject({ MY_VAR: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
  });

  it('crash: with no uninstall, the SessionStart forwarder is in place and prints the hint', async () => {
    const dir = await tmpDir();
    const port = await closedPort();
    const inst = installer(dir);
    await inst.install({ port }, { consent: true });
    // ...the Huddle crashes here: no uninstall.
    const settings = await readJson(path.join(dir, 'settings.json'));
    const start = (settings.hooks as Record<string, { hooks: { command: string }[] }[]>).SessionStart?.[0]?.hooks[0];
    expect(start?.command).toContain('huddle-forward-hook.mjs');
    const result = await runForwarder(inst.forwarderTarget, dir);
    expect(result.code).toBe(0);
    const msg = JSON.parse(result.out) as { systemMessage: string };
    expect(msg.systemMessage).toMatch(/isn't running/);
    expect(msg.systemMessage).toContain('HuddleApp.exe --remove-hooks');
  });
});

describe('backupStamp', () => {
  it('is sortable UTC with milliseconds', () => {
    expect(backupStamp(new Date(Date.UTC(2026, 10, 13, 16, 41, 37, 123)))).toBe('20261113-164137-123');
  });
});
