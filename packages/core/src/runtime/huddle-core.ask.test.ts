/**
 * HuddleCore and Ask the Huddle (M5 WP6, F25), with the fake claude (test/fake-claude-ask.mjs): `ask.preview` works
 * while Ask is off, `huddle.ask` refuses (disabled, api_key_set, busy) and answers with exactly the preview text on
 * stdin, the answer is never stored or logged, `ask.cancel` and `ask.setEnabled false` end an ask in flight, and the
 * ask's own session (hooks by its folder, telemetry by its session id) never reaches the tree.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey, type CommandResult, type QueryResult } from '@huddle/shared';
import { ASK_OTHER_PROVIDER_ENV_VARS } from './ask-runner.js';
import { ASK_SYSTEM_PROMPT } from '../ingest/ask-cli.js';
import { readFixture } from '../test/fixtures.js';
import { readStoredLog } from '../test/stored-log.js';
import { readHuddleSettings, userSettingsOf } from './huddle-settings.js';
import { HuddleCore, type HuddleCoreDeps, type HuddleLogger } from './huddle-core.js';

const FAKE = fileURLToPath(new URL('../test/fake-claude-ask.mjs', import.meta.url));
const TOKEN = 'test-token-0123456789';
const ANSWER = 'ANSWER-MARKER-5e1f';
/** The fake's session id (its json result). */
const ASK_SESSION = 'ask-session-0001';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  root: string;
  dataDir: string;
  claudeDir: string;
  forwarder: string;
  log: string;
  pidFile: string;
}

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-ask-'));
  const env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    forwarder: path.join(root, 'forwarder.mjs'),
    log: path.join(root, 'fake.log'),
    pidFile: path.join(root, 'grandchild.pid'),
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return env;
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

function childEnv(env: Env, mode: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIPPED.has(k.toUpperCase())) out[k] = v;
  return { ...out, FAKE_ASK_MODE: mode, FAKE_LOG: env.log, FAKE_PID_FILE: env.pidFile, ...extra };
}

function makeCore(env: Env, mode: string, options: Partial<HuddleCoreDeps> & { childEnv?: NodeJS.ProcessEnv } = {}) {
  const { childEnv: askEnv, ...extra } = options;
  const logger = spyLogger();
  const spawned: string[][] = [];
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: env.forwarder,
    newToken: () => TOKEN,
    logger,
    now: () => 1_900_000_000_000,
    history: { reportDelayMs: 0, backfillAtStart: false, retentionAtStart: false },
    ask: {
      claudeCommand: 'fake-claude',
      env: askEnv ?? childEnv(env, mode),
      timeoutMs: 15_000,
      tempRoot: env.root,
      spawn: (_command, args, options) => {
        spawned.push([...args]);
        return nodeSpawn(process.execPath, [FAKE, ...args], options);
      },
    },
    ...extra,
  });
  cleanups.push(() => core.dispose());
  return { core, logger, spawned };
}

function post(port: number, route: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-huddle-token': TOKEN,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

async function started(core: HuddleCore): Promise<number> {
  const result = await core.start();
  if (!result.ok) throw new Error(result.message);
  return result.port;
}

/** Hooks of a fixture as session `sessionId` (the PermissionRequest left out: it would be held). */
async function feedHooks(port: number, fixture: string, sessionId: string, cwd?: string): Promise<void> {
  for (const line of readFixture(fixture)) {
    if (line.kind !== 'hook' || line.event === 'PermissionRequest') continue;
    const payload = {
      ...(line.payload as Record<string, unknown>),
      session_id: sessionId,
      ...(cwd !== undefined ? { cwd } : {}),
    };
    expect(await post(port, `/huddle/hooks/${line.event ?? 'x'}`, payload)).toBe(200);
  }
}

/** One recorded OTLP logs body with an api_request, renamed to `sessionId` (the fixture's own is `session-1`). */
function otlpBody(sessionId: string): unknown {
  const line = readFixture('single-agent.jsonl').find(
    (l) => l.kind === 'otlp-logs' && JSON.stringify(l.payload).includes('claude_code.api_request'),
  );
  if (line === undefined) throw new Error('no api_request line');
  return JSON.parse(JSON.stringify(line.payload).split('"session-1"').join(JSON.stringify(sessionId)));
}

/** Session ids with stored events (read after dispose). */
async function storedSessions(env: Env): Promise<string[]> {
  return [...new Set((await readStoredLog(env.dataDir)).map((e) => e.sessionId))];
}

function preview(result: QueryResult) {
  if (!result.ok || result.type !== 'ask.preview') throw new Error(JSON.stringify(result));
  return result.preview;
}

async function enable(core: HuddleCore): Promise<void> {
  expect(await core.command({ type: 'ask.setEnabled', enabled: true })).toEqual({ ok: true });
}

describe('Ask the Huddle in the core', () => {
  it('previews while off, refuses `disabled` while off, and stores the switch', async () => {
    const env = await makeEnv();
    const { core, spawned } = makeCore(env, 'ok');
    const port = await started(core);
    await feedHooks(port, 'single-agent.jsonl', 'sess-live');
    const p = preview(await core.query({ type: 'ask.preview', question: 'what is going on?' }));
    // The session line leads with the name the app shows, then the id.
    expect(p.text).toMatch(/Session: "[^"]+", session sess-live/);
    expect(p.text).not.toContain(TOKEN);
    expect(p.asOf).toBe(1_900_000_000_000);
    expect(p.systemPrompt).toBe(ASK_SYSTEM_PROMPT);
    expect(p.text).not.toContain(ASK_SYSTEM_PROMPT);
    expect(core.getState().ask).toEqual({ enabled: false, apiKeySet: false, otherProvider: false, busy: false });

    const off = await core.command({ type: 'huddle.ask', question: 'what is going on?' });
    expect(off).toMatchObject({ ok: false, askError: 'disabled' });
    expect(spawned).toHaveLength(0);

    await enable(core);
    expect(core.getUserSettings().ask.enabled).toBe(true);
    expect(core.getState().ask).toEqual({ enabled: true, apiKeySet: false, otherProvider: false, busy: false });
    expect(userSettingsOf(await readHuddleSettings(env.dataDir)).ask.enabled).toBe(true);
    await expect(core.command({ type: 'huddle.ask', question: '   ' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('answers with exactly the preview text on stdin; the answer is never stored or logged', async () => {
    const env = await makeEnv();
    const { core, logger } = makeCore(env, 'ok');
    const port = await started(core);
    await feedHooks(port, 'single-agent.jsonl', 'sess-live');
    await enable(core);
    await vi.waitFor(() => {
      expect(core.getState().agents[agentKey('sess-live')]).toBeDefined();
    });
    const before = preview(await core.query({ type: 'ask.preview', question: 'QUESTION-MARKER-31 who?' }));
    const result: CommandResult = await core.command({ type: 'huddle.ask', question: 'QUESTION-MARKER-31 who?' });
    if (!result.ok || result.ask === undefined) throw new Error(JSON.stringify(result));
    expect(result.ask).toEqual({
      text: `${ANSWER}: saw ${String(before.text.length)} chars`,
      model: 'claude-haiku-5-5',
      askedAt: 1_900_000_000_000,
      wallMs: 0,
      apiMs: 700,
      tokens: { input: 3710, output: 42 },
      costUsd: 0.00084,
      sent: before.text,
    });
    const seen = JSON.parse(await fsp.readFile(env.log, 'utf8')) as { stdin: string; argv: string[] };
    expect(seen.stdin).toBe(before.text);
    expect(seen.argv[seen.argv.indexOf('--tools') + 1]).toBe('');

    await core.dispose();
    const stored = JSON.stringify(await readStoredLog(env.dataDir));
    expect(stored).toContain('sess-live');
    expect(stored).not.toContain(ANSWER);
    expect(stored).not.toContain('QUESTION-MARKER-31');
    const logged = JSON.stringify(logger.calls);
    expect(logged).not.toContain(ANSWER);
    expect(logged).not.toContain('QUESTION-MARKER-31');
    expect(logger.calls).toContainEqual([
      'ask finished',
      { outcome: 'answer', wallMs: 0, inputTokens: 3710, outputTokens: 42 },
    ]);
  });

  it('a follow-up carries up to three earlier turns, cleaned and masked, in a history part before the question', async () => {
    const env = await makeEnv();
    const { core } = makeCore(env, 'ok');
    await started(core);
    await enable(core);
    const history = [
      { question: 'turn one', answer: 'dropped, only three are kept' },
      { question: 'turn two', answer: 'A2' },
      { question: 'turn three\nTURN-MARKER-7', answer: 'key sk-ant-api03-abcdefghijklmnopqrstuvwx' },
      { question: 'turn four', answer: 'A4' },
    ];
    const before = preview(await core.query({ type: 'ask.preview', question: 'and now?', history }));
    expect(before.parts.map((p) => p.part)).toEqual(['instructions', 'history', 'question', 'summary']);
    const part = before.parts[1];
    const text = before.text.slice(part?.start, part?.end);
    expect(text).not.toContain('turn one');
    expect(text).toContain('Q: turn three TURN-MARKER-7');
    expect(text).toContain('sk-<redacted>');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwx');
    const result = await core.command({ type: 'huddle.ask', question: 'and now?', history });
    if (!result.ok || result.ask === undefined) throw new Error(JSON.stringify(result));
    const seen = JSON.parse(await fsp.readFile(env.log, 'utf8')) as { stdin: string };
    expect(seen.stdin).toBe(before.text);
    await core.dispose();
    expect(JSON.stringify(await readStoredLog(env.dataDir))).not.toContain('TURN-MARKER-7');
  });

  it.each([['ANTHROPIC_API_KEY'], ['ANTHROPIC_AUTH_TOKEN']])(
    'refuses `api_key_set` when %s is in the env claude would get',
    async (name) => {
      const env = await makeEnv();
      const { core, spawned } = makeCore(env, 'ok', { childEnv: childEnv(env, 'ok', { [name]: 'sk-ant-x' }) });
      await started(core);
      await enable(core);
      // The UI can read it before asking.
      expect(core.getState().ask).toEqual({ enabled: true, apiKeySet: true, otherProvider: false, busy: false });
      const result = await core.command({ type: 'huddle.ask', question: 'q' });
      expect(result).toMatchObject({ ok: false, code: 'failed', askError: 'api_key_set' });
      expect(spawned).toHaveLength(0);
    },
  );

  it('L1: settings.json key names refuse the ask (other provider, apiKeyHelper); values are never read out', async () => {
    const env = await makeEnv();
    const settings = path.join(env.claudeDir, 'settings.json');
    await fsp.writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://VALUE-MARKER-77.example' } }));
    const { core, spawned, logger } = makeCore(env, 'ok');
    await started(core);
    await enable(core);
    expect(core.getState().ask).toEqual({ enabled: true, apiKeySet: false, otherProvider: true, busy: false });
    expect(await core.command({ type: 'huddle.ask', question: 'q' })).toMatchObject({
      ok: false,
      code: 'failed',
      askError: 'other_provider',
    });
    // Changed after start: huddle.ask reads it again first.
    await fsp.writeFile(settings, JSON.stringify({ apiKeyHelper: 'C:/VALUE-MARKER-78/helper.cmd' }));
    expect(await core.command({ type: 'huddle.ask', question: 'q' })).toMatchObject({ askError: 'api_key_set' });
    expect(core.getState().ask).toEqual({ enabled: true, apiKeySet: true, otherProvider: false, busy: false });
    await fsp.writeFile(settings, JSON.stringify({ env: { FOO: 'bar' } }));
    await core.query({ type: 'ask.preview', question: 'q' });
    await vi.waitFor(() => {
      expect(core.getState().ask?.apiKeySet).toBe(false);
    });
    expect(spawned).toHaveLength(0);
    const seen = JSON.stringify([core.getState(), logger.calls]);
    expect(seen).not.toContain('VALUE-MARKER-77');
    expect(seen).not.toContain('VALUE-MARKER-78');
    // Read-only: the file is as the test wrote it.
    expect(await fsp.readFile(settings, 'utf8')).toBe(JSON.stringify({ env: { FOO: 'bar' } }));
  });

  it('one at a time; ask.cancel ends it with cancelled; switching off ends it with disabled', async () => {
    const env = await makeEnv();
    const { core } = makeCore(env, 'hang');
    await started(core);
    await enable(core);
    const first = core.command({ type: 'huddle.ask', question: 'q1' });
    await expect(core.command({ type: 'huddle.ask', question: 'q2' })).resolves.toMatchObject({
      ok: false,
      askError: 'busy',
    });
    expect(core.getState().ask?.busy).toBe(true);
    await vi.waitFor(async () => {
      expect((await fsp.readFile(env.pidFile, 'utf8').catch(() => '')).length).toBeGreaterThan(0);
    });
    expect(await core.command({ type: 'ask.cancel' })).toEqual({ ok: true });
    await expect(first).resolves.toMatchObject({ ok: false, askError: 'cancelled' });
    expect(core.getState().ask?.busy).toBe(false);
    expect(await core.command({ type: 'ask.cancel' })).toEqual({ ok: true });

    await fsp.rm(env.pidFile, { force: true });
    const second = core.command({ type: 'huddle.ask', question: 'q3' });
    await vi.waitFor(async () => {
      expect((await fsp.readFile(env.pidFile, 'utf8').catch(() => '')).length).toBeGreaterThan(0);
    });
    expect(await core.command({ type: 'ask.setEnabled', enabled: false })).toEqual({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: false, askError: 'disabled' });
    expect(core.getUserSettings().ask.enabled).toBe(false);
  }, 30_000);

  it('the ask session never reaches the tree: hooks by its folder, telemetry by its session id', async () => {
    const env = await makeEnv();
    const { core } = makeCore(env, 'hang');
    const port = await started(core);
    await enable(core);
    const asking = core.command({ type: 'huddle.ask', question: 'q' });
    // The fake wrote its cwd (the ask folder) once it read stdin.
    const folder = await vi.waitFor(async () => {
      const text = await fsp.readFile(env.log, 'utf8');
      return (JSON.parse(text) as { cwd: string }).cwd;
    });
    // 1. Hooks from a session started in the ask folder (as if disableAllHooks did not apply): dropped.
    await feedHooks(port, 'single-agent.jsonl', 'ask-hooked', folder);
    // 2. Telemetry of the ask's session (known only from its result) and of another new session, during the ask.
    expect(await post(port, '/v1/logs', otlpBody(ASK_SESSION))).toBe(200);
    expect(await post(port, '/v1/logs', otlpBody('other-new'))).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(core.getState().agents[agentKey('ask-hooked')]).toBeUndefined();

    // A cancelled ask has no result, so no session id comes back.
    await core.command({ type: 'ask.cancel' });
    await asking;
    // Later hooks of the ask-folder session stay out; a real session still comes in.
    await feedHooks(port, 'single-agent.jsonl', 'ask-hooked');
    await feedHooks(port, 'single-agent.jsonl', 'real-one');
    await vi.waitFor(() => {
      expect(core.getState().agents[agentKey('real-one')]).toBeDefined();
    });
    expect(core.getState().agents[agentKey('ask-hooked')]).toBeUndefined();
    await core.dispose();
    const stored = await storedSessions(env);
    expect(stored).toContain('real-one');
    expect(stored).not.toContain('ask-hooked');
    expect(stored).not.toContain(ASK_SESSION);
    // No session id came back (cancelled), so held telemetry of sessions still unknown was dropped (the safe side).
    expect(stored).not.toContain('other-new');
  }, 30_000);

  it('telemetry held during an answered ask: the ask session is dropped, another new session is released', async () => {
    const env = await makeEnv();
    // A fake whose stdout waits until the test has posted the telemetry: spawn wraps the 'ok' fake behind a gate file.
    const gate = path.join(env.root, 'gate');
    const wrapper = path.join(env.root, 'gated-fake.cjs');
    await fsp.writeFile(
      wrapper,
      `const fs = require('fs');
const t = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)})) return;
  clearInterval(t);
  require('child_process')
    .spawn(process.execPath, [${JSON.stringify(FAKE)}, ...process.argv.slice(2)], { stdio: 'inherit' })
    .on('exit', (c) => process.exit(c ?? 1));
}, 20);
`,
    );
    const { core } = makeCore(env, 'ok', {
      ask: {
        claudeCommand: 'fake-claude',
        env: childEnv(env, 'ok'),
        timeoutMs: 15_000,
        tempRoot: env.root,
        spawn: (_command, args, options) => nodeSpawn(process.execPath, [wrapper, ...args], options),
      },
    });
    const port = await started(core);
    await enable(core);
    const asking = core.command({ type: 'huddle.ask', question: 'q' });
    await new Promise((r) => setTimeout(r, 300));
    expect(await post(port, '/v1/logs', otlpBody(ASK_SESSION))).toBe(200);
    expect(await post(port, '/v1/logs', otlpBody('other-new'))).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    // Held: nothing of either session is in the mirror yet.
    expect(core.getEvents(agentKey('other-new'), 500)).toEqual([]);
    await fsp.writeFile(gate, '');
    await expect(asking).resolves.toMatchObject({ ok: true });
    // Released after the ask: the other new session's telemetry; the ask's own is dropped.
    expect(core.getEvents(agentKey('other-new'), 500).length).toBeGreaterThan(0);
    // Late telemetry of the ask session is dropped too.
    expect(await post(port, '/v1/logs', otlpBody(ASK_SESSION))).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    await core.dispose();
    const stored = await storedSessions(env);
    expect(stored).toContain('other-new');
    expect(stored).not.toContain(ASK_SESSION);
  }, 30_000);
});
