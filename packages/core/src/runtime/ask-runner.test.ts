/**
 * AskRunner with the fake claude (test/fake-claude-ask.mjs, spawned with process.execPath): argv, cwd, stdin, env,
 * result parsing, every error kind, timeout (tree kill), cancel, busy and the API key refusal. No real claude runs.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_SYSTEM_PROMPT, buildAskArgs } from '../ingest/ask-cli.js';
import {
  ASK_OTHER_PROVIDER_ENV_VARS,
  askRefusal,
  AskRunner,
  hasApiKey,
  usesOtherProvider,
  withTelemetryOff,
  type AskRunnerOptions,
} from './ask-runner.js';
import type { HuddleLogger } from './huddle-core.js';

const FAKE = fileURLToPath(new URL('../test/fake-claude-ask.mjs', import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-ask-test-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

interface Logged {
  argv: string[];
  cwd: string;
  stdin: string;
  nested: boolean;
  telemetry: Record<string, string | null>;
}

function spyLogger(): HuddleLogger & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    info: (m, d) => calls.push([m, d]),
    warn: (m, d) => calls.push([m, d]),
    error: (m, d) => calls.push([m, d]),
  };
}

/** The machine's own credential and provider variables never reach these tests. */
const STRIPPED: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  ...ASK_OTHER_PROVIDER_ENV_VARS,
]);

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIPPED.has(k.toUpperCase())) env[k] = v;
  return { ...env, ...extra };
}

async function makeRunner(mode: string, extra: Partial<AskRunnerOptions> = {}) {
  const root = await tempDir();
  const log = path.join(root, 'fake.log');
  const pidFile = path.join(root, 'grandchild.pid');
  const tempRoot = path.join(root, 'asks');
  await fsp.mkdir(tempRoot);
  const logger = spyLogger();
  const spawned: { command: string; args: readonly string[] }[] = [];
  const runner = new AskRunner({
    now: Date.now,
    logger,
    claudeCommand: 'fake-claude',
    env: baseEnv({
      FAKE_ASK_MODE: mode,
      FAKE_LOG: log,
      FAKE_PID_FILE: pidFile,
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      // The Huddle's own telemetry env, as the installer writes it (one name in another case, as Windows allows).
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      otel_logs_exporter: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:47821',
    }),
    tempRoot,
    spawn: (command, args, options) => {
      spawned.push({ command, args });
      return nodeSpawn(process.execPath, [FAKE, ...args], options);
    },
    ...extra,
  });
  const logged = async (): Promise<Logged> => JSON.parse(await fsp.readFile(log, 'utf8')) as Logged;
  return { runner, logger, spawned, logged, tempRoot, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('AskRunner with the fake claude', () => {
  // A temp folder reached through a short 8.3 name (C:\Users\RUNNER~1\…, as on CI runners and for long user names)
  // or a junction must still give the ask its canonical folder, so the guard and Claude Code see the same path.
  it('runs in the canonical folder when the temp root is reached through a junction', async () => {
    const root = await tempDir();
    const real = path.join(root, 'real-temp');
    const link = path.join(root, 'linked-temp');
    await fsp.mkdir(real);
    await fsp.symlink(real, link, 'junction');
    const t = await makeRunner('ok', { tempRoot: link });
    await t.runner.run('Question\nwho?\n');
    const seen = await t.logged();
    expect(path.dirname(seen.cwd).toLowerCase()).toBe((await fsp.realpath(real)).toLowerCase());
  });

  it('spawns the exact argv with shell:false in a fresh temp folder, writes stdin, reads the json result', async () => {
    const t = await makeRunner('ok');
    const stdin = 'Instructions\n…\nQuestion\nwho? ✓\n';
    const result = await t.runner.run(stdin);
    expect(result).toEqual({
      ok: true,
      text: `ANSWER-MARKER-5e1f: saw ${String(stdin.length)} chars`,
      model: 'claude-haiku-5-5',
      apiMs: 700,
      costUsd: 0.00084,
      tokens: { input: 3710, output: 42 },
      wallMs: expect.any(Number) as number,
      sessionId: 'ask-session-0001',
    });
    const seen = await t.logged();
    // The argv claude received: the S18 command element by element, the empty --tools value intact, no --bare.
    expect(seen.argv).toEqual(buildAskArgs());
    expect(seen.argv[seen.argv.indexOf('--tools') + 1]).toBe('');
    expect(seen.argv).not.toContain('--bare');
    expect(seen.argv.at(-1)).toBe(ASK_SYSTEM_PROMPT);
    expect(t.spawned[0]?.command).toBe('fake-claude');
    expect(seen.stdin).toBe(stdin);
    // cwd: a fresh folder under the temp root, removed afterwards.
    expect(path.dirname(seen.cwd).toLowerCase()).toBe((await fsp.realpath(t.tempRoot)).toLowerCase());
    expect(path.basename(seen.cwd)).toMatch(/^huddle-ask-/);
    expect(existsSync(seen.cwd)).toBe(false);
    // The nested Claude Code markers are not passed on.
    expect(seen.nested).toBe(false);
    // Telemetry off in the child env too (mirrors the inline --settings env).
    expect(seen.telemetry).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '0',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
    });
    expect(Object.keys(t.runner.childEnv()).filter((k) => k.toUpperCase() === 'OTEL_LOGS_EXPORTER')).toEqual([
      'OTEL_LOGS_EXPORTER',
    ]);
    expect(t.runner.busy).toBe(false);
  });

  it('logs only the outcome, wall time and token counts: never the question, context or answer', async () => {
    const t = await makeRunner('ok');
    await t.runner.run('QUESTION-MARKER-77 context');
    const text = JSON.stringify(t.logger.calls);
    expect(text).not.toContain('QUESTION-MARKER-77');
    expect(text).not.toContain('ANSWER-MARKER');
    expect(t.logger.calls).toEqual([
      [
        'ask finished',
        { outcome: 'answer', wallMs: expect.any(Number) as number, inputTokens: 3710, outputTokens: 42 },
      ],
    ]);
  });

  it.each([
    ['error', 'model_error', /^Claude Code couldn't answer: overloaded_error: try later\.$/],
    ['notlogged', 'not_logged_in', /isn't logged in/],
    ['status401', 'not_logged_in', /isn't logged in/],
    ['crash', 'model_error', /claude exited with code 3/],
    ['garbage', 'model_error', /no result came back/],
    ['big', 'model_error', /too long/],
  ])('maps %s to %s', async (mode, kind, words) => {
    const t = await makeRunner(mode, { stdoutMaxBytes: 256 * 1024 });
    const result = await t.runner.run('q');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(kind);
    expect(result.message).toMatch(words);
  });

  it('claude not found: the bare spawn fails with ENOENT', async () => {
    const t = await makeRunner('ok', {
      spawn: undefined,
      claudeCommand: path.join(os.tmpdir(), 'no-such-claude-9f.exe'),
    });
    expect(await t.runner.run('q')).toMatchObject({ ok: false, error: 'claude_not_found' });
  });

  it('claude not found on PATH (only absolute PATH entries are searched)', async () => {
    const empty = await tempDir();
    const runner = new AskRunner({ now: Date.now, logger: spyLogger(), env: { PATH: empty, Path: empty } });
    expect(await runner.run('q')).toMatchObject({ ok: false, error: 'claude_not_found' });
  });

  it('timeout ends the process tree', async () => {
    const t = await makeRunner('hang', { timeoutMs: 1500 });
    const result = await t.runner.run('q');
    expect(result).toMatchObject({ ok: false, error: 'timeout' });
    if (!result.ok) expect(result.message).toBe('No answer within 2 seconds. Ask again, or ask something shorter.');
    const pid = Number(await fsp.readFile(t.pidFile, 'utf8'));
    await vi.waitFor(
      () => {
        expect(alive(pid)).toBe(false);
      },
      { timeout: 5000 },
    );
  }, 20_000);

  it('cancel ends the ask with cancelled; switching off ends it with disabled; busy while one runs', async () => {
    const t = await makeRunner('hang', { timeoutMs: 15_000 });
    const first = t.runner.run('q');
    expect(t.runner.busy).toBe(true);
    expect(await t.runner.run('q2')).toMatchObject({ ok: false, error: 'busy' });
    await vi.waitFor(async () => {
      expect(existsSync(t.pidFile)).toBe(true);
      expect((await fsp.readFile(t.pidFile, 'utf8')).length).toBeGreaterThan(0);
    });
    expect(t.runner.cancel()).toBe(true);
    expect(await first).toMatchObject({ ok: false, error: 'cancelled' });
    expect(t.runner.busy).toBe(false);
    expect(t.runner.cancel()).toBe(false);

    const second = t.runner.run('q');
    t.runner.cancel('disabled');
    expect(await second).toMatchObject({
      ok: false,
      error: 'disabled',
      message: 'Stopped: Ask the Huddle was turned off.',
    });
  }, 30_000);

  it('refuses when ANTHROPIC_API_KEY is in the env claude would get (any case), and spawns nothing', async () => {
    const t = await makeRunner('ok', { env: baseEnv({ anthropic_api_key: 'sk-ant-xyz' }) });
    expect(t.runner.apiKeySet()).toBe(true);
    expect(await t.runner.run('q')).toMatchObject({ ok: false, error: 'api_key_set' });
    expect(t.spawned).toHaveLength(0);
    expect(hasApiKey({ ANTHROPIC_API_KEY: '  ' })).toBe(false);
    expect(hasApiKey({ ANTHROPIC_API_KEY: 'x' })).toBe(true);
  });

  it('refuses when ANTHROPIC_AUTH_TOKEN is set and non-empty, too', async () => {
    const t = await makeRunner('ok', { env: baseEnv({ ANTHROPIC_AUTH_TOKEN: 'tok-123' }) });
    expect(t.runner.apiKeySet()).toBe(true);
    expect(await t.runner.run('q')).toMatchObject({ ok: false, error: 'api_key_set' });
    expect(t.spawned).toHaveLength(0);
    expect(hasApiKey({ anthropic_auth_token: 'x' })).toBe(true);
    expect(hasApiKey({ ANTHROPIC_AUTH_TOKEN: '' })).toBe(false);
  });

  it.each(ASK_OTHER_PROVIDER_ENV_VARS.map((n) => [n]))(
    'refuses other_provider when %s is set in the env (L1), and spawns nothing',
    async (name) => {
      const value = name === 'ANTHROPIC_BASE_URL' ? 'https://proxy.example' : '1';
      const t = await makeRunner('ok', { env: baseEnv({ [name.toLowerCase()]: value }) });
      expect(t.runner.otherProvider()).toBe(true);
      expect(t.runner.apiKeySet()).toBe(false);
      expect(await t.runner.run('q')).toMatchObject({ ok: false, error: 'other_provider' });
      expect(t.spawned).toHaveLength(0);
    },
  );

  it('an empty or "0" provider switch is not another provider', () => {
    expect(
      usesOtherProvider({ CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: ' ', ANTHROPIC_BASE_URL: '' }),
    ).toBe(false);
    expect(usesOtherProvider({ CLAUDE_CODE_USE_FOUNDRY: 'true' })).toBe(true);
  });

  it('askRefusal reads settings.json key names: credentials, apiKeyHelper, providers; a billed key first', () => {
    const keys = (envKeys: string[], apiKeyHelper = false) => ({ envKeys, apiKeyHelper });
    expect(askRefusal({}, null)).toBeNull();
    expect(askRefusal({}, keys(['FOO', 'OTEL_EXPORTER_OTLP_ENDPOINT']))).toBeNull();
    expect(askRefusal({}, keys(['anthropic_api_key']))).toEqual({ kind: 'api_key_set', where: 'claude_settings' });
    expect(askRefusal({}, keys(['ANTHROPIC_AUTH_TOKEN']))).toEqual({ kind: 'api_key_set', where: 'claude_settings' });
    expect(askRefusal({}, keys([], true))).toEqual({ kind: 'api_key_set', where: 'claude_settings' });
    expect(askRefusal({}, keys(['CLAUDE_CODE_USE_VERTEX']))).toEqual({
      kind: 'other_provider',
      where: 'claude_settings',
    });
    expect(askRefusal({ ANTHROPIC_BASE_URL: 'https://x' }, keys(['ANTHROPIC_API_KEY']))).toEqual({
      kind: 'api_key_set',
      where: 'claude_settings',
    });
    expect(askRefusal({ ANTHROPIC_API_KEY: 'k' }, null)).toEqual({ kind: 'api_key_set', where: 'environment' });
  });

  it('refuses from settings.json key names, read again before every ask; an unreadable file is unknown', async () => {
    let next: { envKeys: string[]; apiKeyHelper: boolean } | null = {
      envKeys: ['ANTHROPIC_BASE_URL'],
      apiKeyHelper: false,
    };
    let fail = false;
    const t = await makeRunner('ok', {
      readClaudeSettingsKeys: () => (fail ? Promise.reject(new Error('EACCES secret-value')) : Promise.resolve(next)),
    });
    expect(t.runner.otherProvider()).toBe(false); // not read yet
    expect(await t.runner.refreshClaudeSettings()).toBe(true);
    expect(t.runner.otherProvider()).toBe(true);
    expect(await t.runner.run('q')).toMatchObject({ ok: false, error: 'other_provider' });
    next = { envKeys: [], apiKeyHelper: true };
    expect(await t.runner.run('q')).toMatchObject({ ok: false, error: 'api_key_set' });
    expect(t.spawned).toHaveLength(0);
    fail = true;
    expect(await t.runner.refreshClaudeSettings()).toBe(true);
    expect(t.runner.refusal()).toBeNull();
    expect(JSON.stringify(t.logger.calls)).not.toContain('secret-value');
  });
});

describe('withTelemetryOff', () => {
  it('replaces the four switches in any case and keeps everything else', () => {
    expect(
      withTelemetryOff({ Path: 'C:/x', Otel_Metrics_Exporter: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: 'h=1' }),
    ).toEqual({
      Path: 'C:/x',
      OTEL_EXPORTER_OTLP_HEADERS: 'h=1',
      CLAUDE_CODE_ENABLE_TELEMETRY: '0',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
    });
  });
});
