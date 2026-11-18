/** HuddleCore and the status line bridge (F9, ADR-018). Temp folders only; never the real ~/.claude. */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey } from '@huddle/shared';
import { isHuddleStatusLine } from '../setup/install-hooks.js';
import { readFixture } from '../test/fixtures.js';
import { HuddleCore } from './huddle-core.js';

const TOKEN = 'test-token-0123456789';
const USER_LINE = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 1 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function makeEnv() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-sl-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const env = {
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    forwarder: path.join(root, 'forwarder.mjs'),
    wrapper: path.join(root, 'statusline.mjs'),
    settingsPath: path.join(root, 'claude', 'settings.json'),
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  await fsp.writeFile(env.wrapper, '// test wrapper\n');
  return env;
}

type Env = Awaited<ReturnType<typeof makeEnv>>;

function makeCore(env: Env): HuddleCore {
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: env.forwarder,
    statuslineSource: env.wrapper,
    newToken: () => TOKEN,
  });
  cleanups.push(() => core.dispose());
  return core;
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

async function readSettings(env: Env): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(env.settingsPath, 'utf8')) as Record<string, unknown>;
}

describe('HuddleCore with the status line bridge', () => {
  it('opt-in shows the bridge in the diff, status line posts reach the state, quit keeps the bridge', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.settingsPath, JSON.stringify({ statusLine: USER_LINE }, null, 2));
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);

    const plain = await core.prepareAttach();
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.preview.diffText).not.toContain('huddle-statusline.mjs');

    const prepared = await core.prepareAttach({ statusLine: true });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.preview.diffText).toMatch(/^\+ .*huddle-statusline\.mjs/m);
    expect(await core.consentAndAttach()).toEqual({ status: 'attached', written: true });
    expect(isHuddleStatusLine((await readSettings(env)).statusLine)).toBe(true);

    const lines = readFixture('statusline-docs-sample.jsonl');
    for (const line of lines) expect(await post(started.port, '/huddle/statusline', line.payload)).toBe(200);
    const payload = lines[0]?.payload as { session_id: string };
    const main = agentKey(payload.session_id);
    await vi.waitFor(() => {
      expect(core.getState().agents[main]?.context).toMatchObject({ usedTokens: 12000, measuredBy: 'statusline' });
    });
    // The last line omits seven_day: it keeps the earlier reading (M4 WP6, windows merge).
    expect(core.getState().rateLimits).toMatchObject({ fiveHourUsedPct: 26, sevenDayUsedPct: 41.5 });

    await core.dispose();
    const after = await readSettings(env);
    expect(isHuddleStatusLine(after.statusLine)).toBe(true); // ADR-018: the bridge stays after quit
    expect(after.hooks).toBeUndefined(); // the hooks are removed as before (ADR-014)
  });

  it('withdrawing consent removes the hooks and restores the original status line exactly', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.settingsPath, JSON.stringify({ statusLine: USER_LINE }, null, 2));
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    await core.prepareAttach({ statusLine: true });
    await core.consentAndAttach();
    const result = await core.withdrawConsent();
    expect(result.ok).toBe(true);
    const settings = await readSettings(env);
    expect(JSON.stringify(settings.statusLine)).toBe(JSON.stringify(USER_LINE));
    expect(settings.hooks).toBeUndefined();
    expect(
      await fsp.access(path.join(env.claudeDir, 'agent-huddle', 'statusline-original.json')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it('withdrawing consent leaves a status line the user changed since, and reports it', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.settingsPath, JSON.stringify({ statusLine: USER_LINE }, null, 2));
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    await core.prepareAttach({ statusLine: true });
    await core.consentAndAttach();
    const mine = { type: 'command', command: 'my-new-line' };
    await fsp.writeFile(env.settingsPath, JSON.stringify({ ...(await readSettings(env)), statusLine: mine }, null, 2));
    const result = await core.withdrawConsent();
    if (!result.ok) throw new Error(result.error);
    expect(result.notes?.join('\n')).toContain('changed after the Huddle installed');
    expect((await readSettings(env)).statusLine).toEqual(mine);
  });

  it('removeStatusLineBridge puts the original line back and keeps the hooks', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.settingsPath, JSON.stringify({ statusLine: USER_LINE }, null, 2));
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    await core.prepareAttach({ statusLine: true });
    await core.consentAndAttach();
    const removed = await core.removeStatusLineBridge();
    if (!removed.ok) throw new Error(removed.error);
    expect(removed.notes?.join(' ')).toContain('restore your status line');
    const settings = await readSettings(env);
    expect(settings.statusLine).toEqual(USER_LINE);
    expect(settings.hooks).toBeDefined();
  });

  it('stores 100 identical status line posts as one reading; a changed value is stored (F9 log bound)', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    const payload = readFixture('statusline-docs-sample.jsonl')[1]?.payload as {
      session_id: string;
      context_window: Record<string, unknown>;
    };
    const main = agentKey(payload.session_id);
    const contextEvents = () => core.getEvents(main, 500).filter((e) => e.type === 'context.measured');
    for (let i = 0; i < 100; i++) expect(await post(started.port, '/huddle/statusline', payload)).toBe(200);
    await vi.waitFor(() => {
      expect(core.getState().agents[main]?.context).toMatchObject({ measuredBy: 'statusline' });
    });
    expect(contextEvents()).toHaveLength(1);
    expect(core.getEvents(main, 500).filter((e) => e.type === 'limits.measured')).toHaveLength(1);

    const changed = {
      ...payload,
      context_window: {
        ...payload.context_window,
        current_usage: { input_tokens: 60_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
    expect(await post(started.port, '/huddle/statusline', changed)).toBe(200);
    await vi.waitFor(() => {
      expect(contextEvents()).toHaveLength(2);
    });
  });
});
