import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey, selectTree, type HuddleCommand, type HuddleEvent, type TreeNodeView } from '@huddle/shared';
import { isHuddleHook } from '../setup/install-hooks.js';
import { replay } from '../state/reduce.js';
import { readFixture } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { readStoredLog } from '../test/stored-log.js';
import { HuddleCore, type HuddleCoreDeps, type HuddleLogger } from './huddle-core.js';
import { readHuddleSettings, writeHuddleSettings } from './huddle-settings.js';
import { consentRecord, defaultConsentFingerprint } from '../test/consent.js';

const TOKEN = 'test-token-0123456789';
const FIXTURE = 'parallel-subagents.jsonl';
/** connection.startedAt comes from the real clock in these tests. */
const ANY_TIME: unknown = expect.any(Number);

interface Env {
  root: string;
  dataDir: string;
  claudeDir: string;
  cwd: string;
  forwarder: string;
  settingsPath: string;
  logs: { level: string; message: string }[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-'));
  const env: Env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    cwd: path.join(root, 'project'),
    forwarder: path.join(root, 'forwarder.mjs'),
    settingsPath: path.join(root, 'claude', 'settings.json'),
    logs: [],
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.mkdir(path.join(env.cwd, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  await fsp.writeFile(
    path.join(env.cwd, '.claude', 'agents', 'explore.md'),
    '---\nname: Explore\ndescription: Finds files in the project\n---\nBody\n',
  );
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return env;
}

function makeCore(env: Env, extra: Partial<HuddleCoreDeps> = {}): HuddleCore {
  const logger: HuddleLogger = {
    info: (message) => env.logs.push({ level: 'info', message }),
    warn: (message) => env.logs.push({ level: 'warn', message }),
    error: (message) => env.logs.push({ level: 'error', message }),
  };
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: env.cwd,
    userAgentsDir: path.join(env.claudeDir, 'agents'),
    port: 0,
    forwarderSource: env.forwarder,
    logger,
    newToken: () => TOKEN,
    ...extra,
  });
  cleanups.push(() => core.dispose());
  return core;
}

async function consent(env: Env, consentedFor: string = env.settingsPath): Promise<void> {
  await writeHuddleSettings(env.dataDir, consentRecord(env.claudeDir, consentedFor));
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
}

async function exists(file: string): Promise<boolean> {
  return fsp.access(file).then(
    () => true,
    () => false,
  );
}

/** Every hook entry in settings.json, flattened. */
function hookEntries(settings: Record<string, unknown>): Record<string, unknown>[] {
  const hooks = (settings.hooks ?? {}) as Record<string, { hooks?: Record<string, unknown>[] }[]>;
  return Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks ?? []));
}

/** Port and token exactly as Claude Code would read them from settings.json. */
function endpointFrom(settings: Record<string, unknown>): { port: number; token: string } {
  const entry = hookEntries(settings).find((h) => h.type === 'http');
  if (!entry) throw new Error('no http hook in settings.json');
  const url = new URL(String(entry.url));
  const headers = entry.headers as Record<string, string>;
  return { port: Number(url.port), token: headers['X-Huddle-Token'] ?? '' };
}

function post(port: number, token: string, route: string, body: unknown): Promise<number> {
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
          'x-huddle-token': token,
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

/** Posts every hook and otlp-logs line of a fixture, in order, the way Claude Code would. */
/** Posts a fixture's lines. With `cwd`, hook payloads report that folder as the session's cwd. */
async function postFixture(port: number, token: string, name: string, cwd?: string): Promise<void> {
  for (const line of readFixture(name)) {
    const payload =
      cwd !== undefined && typeof line.payload === 'object' && line.payload !== null
        ? { ...(line.payload as Record<string, unknown>), cwd }
        : line.payload;
    if (line.kind === 'hook') expect(await post(port, token, `/huddle/hooks/${line.event ?? 'x'}`, payload)).toBe(200);
    else if (line.kind === 'otlp-logs') expect(await post(port, token, '/v1/logs', line.payload)).toBe(200);
  }
}

function flatten(
  node: TreeNodeView,
  parent: string | null = null,
): { key: string; parent: string | null; status: string }[] {
  return [{ key: node.key, parent, status: node.status }, ...node.children.flatMap((c) => flatten(c, node.key))];
}

describe('connection.startedAt', () => {
  it('reports when this run started, from the injected clock, so replayed sessions can be marked stale', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env, { now: () => 1_800_000_000_000 });
    expect(core.getState().connection).toBeUndefined();
    await core.start();
    expect(core.getState().connection?.startedAt).toBe(1_800_000_000_000);
  });
});

describe('role descriptions from the session folder', () => {
  it('reads <session cwd>/.claude/agents once per (session, cwd), and again when the folder changes', async () => {
    const env = await makeEnv();
    await consent(env);
    const other = path.join(env.root, 'other-project');
    await fsp.mkdir(path.join(other, '.claude', 'agents'), { recursive: true });
    await fsp.writeFile(
      path.join(other, '.claude', 'agents', 'plan.md'),
      '---\nname: Plan\ndescription: Plans the work\n---\nBody\n',
    );
    const core = makeCore(env, { cwd: null });
    const described: HuddleEvent[] = [];
    core.onEvents((batch) => {
      described.push(...batch.filter((e) => e.type === 'role.described'));
    });
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    const { port, token } = endpointFrom(await readJson(env.settingsPath));
    const start = (cwd: string) => ({
      session_id: 'sess-a',
      transcript_path: path.join(cwd, 't.jsonl'),
      cwd,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(await post(port, token, '/huddle/hooks/SessionStart', start(env.cwd))).toBe(200);
    expect(await post(port, token, '/huddle/hooks/SessionStart', start(env.cwd))).toBe(200);
    await vi.waitFor(() => {
      expect(described.map((e) => (e.type === 'role.described' ? e.role : ''))).toEqual(['Explore']);
    });
    expect(await post(port, token, '/huddle/hooks/SessionStart', start(other))).toBe(200);
    await vi.waitFor(() => {
      expect(described.map((e) => (e.type === 'role.described' ? e.role : ''))).toEqual(['Explore', 'Plan']);
    });
  });
});

describe('consent is scoped to one settings.json', () => {
  it('does not attach when consent was given for another Claude config folder', async () => {
    const env = await makeEnv();
    await consent(env, path.join(env.root, 'other-claude', 'settings.json'));
    await fsp.writeFile(env.settingsPath, '{"theme":"dark"}\n');
    const core = makeCore(env);
    const result = await core.start();
    expect(result.ok).toBe(true);
    expect(core.setupStatus().consented).toBe(false);
    expect(core.setupStatus().attached).toBe(false);
    expect(await fsp.readFile(env.settingsPath, 'utf8')).toBe('{"theme":"dark"}\n');
    expect(core.getState().connection?.status).toBe('needs_consent');
  });

  it('treats an older consent without consentedFor as none', async () => {
    const env = await makeEnv();
    await fsp.mkdir(env.dataDir, { recursive: true });
    await fsp.writeFile(path.join(env.dataDir, 'huddle-settings.json'), '{"consentedAt":"2026-11-13T10:00:00.000Z"}');
    const core = makeCore(env);
    await core.start();
    expect(core.setupStatus().consented).toBe(false);
    expect(await exists(env.settingsPath)).toBe(false);
  });

  it('records the settings.json it was given for on Connect', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    await core.start();
    expect(await core.command({ type: 'setup.attach' })).toEqual({ ok: true });
    const saved = await readJson(path.join(env.dataDir, 'huddle-settings.json'));
    expect(saved.consentedFor).toBe(env.settingsPath);
  });
});

describe('consent is tied to the change that was approved (ADR-019 follow-up)', () => {
  it('Connect stores the fingerprint; the next start with the same plan attaches by itself', async () => {
    const env = await makeEnv();
    const first = makeCore(env);
    await first.start();
    expect(await first.command({ type: 'setup.attach' })).toEqual({ ok: true });
    const saved = await readHuddleSettings(env.dataDir);
    expect(saved.consentedFingerprint).toBe(defaultConsentFingerprint(env.claudeDir));
    await first.dispose();

    const second = makeCore(env);
    const started = await second.start();
    expect(started.ok && started.setup.attached).toBe(true);
    expect(second.getState().connection?.status).toBe('attached');
  });

  it('a consent given for another hook table (PreToolUse 5 s) shows the diff again and writes nothing', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.settingsPath, '{"theme":"dark"}\n');
    await writeHuddleSettings(env.dataDir, {
      ...consentRecord(env.claudeDir, env.settingsPath),
      consentedFingerprint: defaultConsentFingerprint(env.claudeDir, {}, { timeouts: { PreToolUse: 5 } }),
    });
    const core = makeCore(env);
    const started = await core.start();
    expect(started.ok && started.setup.attached).toBe(false);
    expect(await fsp.readFile(env.settingsPath, 'utf8')).toBe('{"theme":"dark"}\n');
    const connection = core.getState().connection;
    expect(connection?.status).toBe('needs_consent');
    expect(connection?.preview?.diffText).toMatch(/"timeout": 600/);
    expect(connection?.preview?.diffText).not.toContain(TOKEN);

    // Connect approves the new change: attached, and the new fingerprint replaces the old one.
    expect(await core.command({ type: 'setup.attach' })).toEqual({ ok: true });
    expect((await readHuddleSettings(env.dataDir)).consentedFingerprint).toBe(defaultConsentFingerprint(env.claudeDir));
    expect(core.getState().connection?.status).toBe('attached');
  });

  it('a consent saved before fingerprints existed asks once more', async () => {
    const env = await makeEnv();
    await fsp.mkdir(env.dataDir, { recursive: true });
    await fsp.writeFile(
      path.join(env.dataDir, 'huddle-settings.json'),
      JSON.stringify({ consentedAt: '2026-11-13T10:00:00.000Z', consentedFor: env.settingsPath, theme: 'dark' }),
    );
    const core = makeCore(env);
    const started = await core.start();
    expect(started.ok && started.setup.attached).toBe(false);
    expect(await exists(env.settingsPath)).toBe(false);
    expect(core.getState().connection?.status).toBe('needs_consent');
    expect(await core.command({ type: 'setup.attach' })).toEqual({ ok: true });
    const saved = await readJson(path.join(env.dataDir, 'huddle-settings.json'));
    expect(saved).toMatchObject({ theme: 'dark', consentedFingerprint: defaultConsentFingerprint(env.claudeDir) });
  });

  it('withdrawing consent clears the fingerprint too', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env);
    const started = await core.start();
    expect(started.ok && started.setup.attached).toBe(true);
    expect(await core.withdrawConsent()).toEqual({ ok: true });
    expect(await readHuddleSettings(env.dataDir)).toMatchObject({
      consentedAt: null,
      consentedFor: null,
      consentedFingerprint: null,
    });
    expect(core.getState().connection?.status).toBe('needs_consent');
  });
});

describe('HuddleCore with consent on record', () => {
  it('attaches on start, ingests a recorded session into the tree, and reports latency', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env);
    const arrivals: { event: HuddleEvent; at: number }[] = [];
    core.onEvents((batch) => {
      const at = Date.now();
      for (const event of batch) {
        arrivals.push({ event, at });
        // M3: the fixture's PermissionRequests are held now. Answer each the way a user would (pass to the terminal),
        // so the recorded session can go on; Claude Code had answered them in the terminal when it was recorded.
        if (event.type === 'approval.requested') {
          void core.command({ type: 'approval.passThrough', requestId: event.request.requestId });
        }
      }
    });

    const started = await core.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.setup).toMatchObject({ consented: true, attached: true, preparedDiff: null, error: null });
    expect(core.getState().connection).toEqual({ status: 'attached', message: null, startedAt: ANY_TIME });

    const settings = await readJson(env.settingsPath);
    const endpoint = endpointFrom(settings);
    expect(endpoint.port).toBe(started.port);
    expect(endpoint.token).toBe(TOKEN);
    expect((await readJson(path.join(env.claudeDir, 'agent-huddle', 'config.json'))).token).toBe(TOKEN);

    await postFixture(endpoint.port, endpoint.token, FIXTURE, env.cwd);

    const offline = fixtureEvents(FIXTURE);
    await vi.waitFor(
      () => {
        // Not in the offline replay: role descriptions, and the user's pass-through answers (approval.resolved).
        const fromHooks = arrivals.filter((a) => a.event.type !== 'role.described' && a.event.source !== 'user');
        expect(fromHooks.length).toBe(offline.length);
        expect(arrivals.some((a) => a.event.type === 'role.described')).toBe(true);
      },
      { timeout: 5000, interval: 20 },
    );

    const sessions = selectTree(core.getState());
    expect(sessions).toHaveLength(1);
    const root = sessions[0]?.root;
    if (!root) throw new Error('no root');
    const nodes = flatten(root);
    expect(nodes).toHaveLength(3);
    const main = agentKey('session-1');
    expect(nodes[0]).toMatchObject({ key: main, parent: null });
    expect(nodes.slice(1).every((n) => n.parent === main)).toBe(true);
    // Same tree and statuses as replaying the fixture offline.
    const expected = selectTree(replay(offline))[0]?.root;
    if (!expected) throw new Error('no offline root');
    expect(nodes).toEqual(flatten(expected));
    // role.described from <session cwd>/.claude/agents (the folder SessionStart reported) reached the subagents.
    expect(root.children.every((c) => c.roleDescription === 'Finds files in the project')).toBe(true);
    // Bookkeeping never crosses IPC.
    expect('book' in core.getState()).toBe(false);

    const latencies = arrivals.map((a) => a.at - a.event.ts);
    const max = Math.max(...latencies);
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
    console.info(
      `[latency] receivedAt -> listener: n=${String(latencies.length)} p50=${String(p50)}ms max=${String(max)}ms`,
    );
    expect(max).toBeLessThan(1000);

    // getEvents serves one agent's events, oldest first, clamped.
    const mainEvents = core.getEvents(main, 500);
    expect(mainEvents.length).toBeGreaterThan(0);
    expect(mainEvents.every((e) => e.agentKey === main)).toBe(true);
    expect(core.getEvents(main, 0)).toHaveLength(1);
    expect(core.getEvents('nobody', 10)).toEqual([]);
    expect(await core.readEvents(main, 500)).toEqual(mainEvents.slice(-500));
  });

  it('detaches on dispose (telemetry kept), flushes the store, and rebuilds the state with a rename on restart', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.settingsPath, JSON.stringify({ theme: 'dark' }));
    await consent(env);
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    const { port, token } = endpointFrom(await readJson(env.settingsPath));
    await postFixture(port, token, 'single-agent.jsonl');
    const main = agentKey(fixtureEvents('single-agent.jsonl')[0]?.sessionId ?? '');
    await vi.waitFor(() => {
      expect(core.getState().agents[main]).toBeDefined();
    });
    expect(await core.command({ type: 'agent.rename', agentKey: main, name: '  Lead  ' })).toEqual({ ok: true });
    expect(core.getState().agents[main]?.name).toBe('Lead');

    const t0 = performance.now();
    const first = core.dispose();
    expect(core.dispose()).toBe(first);
    await first;
    const before = core.getState();
    expect(performance.now() - t0).toBeLessThan(3000);

    const after = await readJson(env.settingsPath);
    expect(after.theme).toBe('dark');
    expect(hookEntries(after).some((h) => isHuddleHook(h))).toBe(false);
    expect((after.env as Record<string, string>).OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${String(port)}`);
    await expect(post(port, token, '/huddle/hooks/Stop', {})).rejects.toThrow();
    expect((await readStoredLog(env.dataDir)).length).toBeGreaterThan(0);
    expect(await core.command({ type: 'agent.rename', agentKey: main, name: 'x' })).toMatchObject({ ok: false });

    const again = makeCore(env);
    const restarted = await again.start();
    expect(restarted.ok).toBe(true);
    // Same agents and links; connection is setup status, not replayed (absent while shut down).
    expect(before.connection).toBeUndefined();
    expect({ ...again.getState(), connection: undefined }).toEqual({ ...before, connection: undefined });
    expect(again.getState().agents[main]?.name).toBe('Lead');
    expect(again.getEvents(main, 500).some((e) => e.type === 'control.applied')).toBe(true);
    // A replayed session is not described again.
    expect(again.getEvents(main, 500).filter((e) => e.type === 'role.described')).toHaveLength(
      core.getEvents(main, 500).filter((e) => e.type === 'role.described').length,
    );
    // Attached again on the restart, with the same token.
    expect(endpointFrom(await readJson(env.settingsPath)).token).toBe(TOKEN);
  });

  it('answers an in-flight request while closing', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    const payload = readFixture('single-agent.jsonl').find((l) => l.kind === 'hook')?.payload;
    const text = JSON.stringify(payload);
    const status = new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: started.port,
          path: '/huddle/hooks/SessionStart',
          method: 'POST',
          agent: false,
          headers: { 'content-length': Buffer.byteLength(text), 'x-huddle-token': TOKEN },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(text.slice(0, 10));
      setTimeout(() => {
        void core.dispose();
        setTimeout(() => req.end(text.slice(10)), 50);
      }, 50);
    });
    expect(await status).toBe(200);
    await core.dispose();
  });
});

describe('HuddleCore without consent', () => {
  it('writes nothing under the Claude folder until the owner agrees, then attaches', async () => {
    const env = await makeEnv();
    const original = JSON.stringify({ theme: 'dark' }, null, 2);
    await fsp.writeFile(env.settingsPath, original);
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    expect(started.setup.consented).toBe(false);
    expect(started.setup.attached).toBe(false);
    expect(started.setup.preparedDiff?.changed).toBe(true);
    expect(await fsp.readFile(env.settingsPath, 'utf8')).toBe(original);
    expect(await exists(path.join(env.claudeDir, 'agent-huddle'))).toBe(false);

    const prepared = await core.prepareAttach();
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.preview.diff.some((l) => l.op === '+' && l.text.includes('/huddle/hooks/'))).toBe(true);
    expect(prepared.preview.diffText).toContain('<token>');
    expect(prepared.preview.diffText).not.toContain(TOKEN);
    expect(await fsp.readFile(env.settingsPath, 'utf8')).toBe(original);

    expect(await core.consentAndAttach()).toEqual({ status: 'attached', written: true });
    expect((await readHuddleSettings(env.dataDir)).consentedAt).not.toBeNull();
    const settings = await readJson(env.settingsPath);
    expect(settings.theme).toBe('dark');
    expect(endpointFrom(settings)).toEqual({ port: started.port, token: TOKEN });
    expect(core.setupStatus()).toMatchObject({ consented: true, attached: true, preparedDiff: null });
  });

  it('asks again when the Huddle part of the change went stale', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    // The user sets up their own telemetry after the preview: the Huddle now leaves telemetry out.
    await fsp.writeFile(env.settingsPath, JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }));
    const stale = await core.consentAndAttach();
    expect(stale.status).toBe('stale');
    if (stale.status !== 'stale') return;
    expect(stale.preview.warnings.join(' ')).toContain('telemetry');
    expect(await readJson(env.settingsPath)).toEqual({ env: { OTEL_LOGS_EXPORTER: 'console' } });
    expect(await core.consentAndAttach()).toEqual({ status: 'attached', written: true });
  });

  it('shows needs_consent in state.connection (token scrubbed), and setup.attach connects with an empty batch', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const batches: number[] = [];
    core.onEvents((batch) => batches.push(batch.length));
    expect(core.getState().connection).toBeUndefined();
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);

    const connection = core.getState().connection;
    expect(connection).toMatchObject({
      status: 'needs_consent',
      message: "Huddle isn't connected to Claude Code yet. Review the change it makes to your settings.",
      preview: { settingsPath: env.settingsPath, warnings: [] },
    });
    expect(connection?.preview?.diffText).toContain('<token>');
    expect(JSON.stringify(core.getState())).not.toContain(TOKEN);
    // The connection change reached listeners as a batch without events.
    await vi.waitFor(() => {
      expect(batches).toContain(0);
    });
    const seen = batches.length;

    expect(await core.command({ type: 'setup.attach' })).toEqual({ ok: true });
    expect(core.getState().connection).toEqual({ status: 'attached', message: null, startedAt: ANY_TIME });
    expect(endpointFrom(await readJson(env.settingsPath))).toEqual({ port: started.port, token: TOKEN });
    await vi.waitFor(() => {
      expect(batches.length).toBe(seen + 1);
    });
    expect(batches.at(-1)).toBe(0);
    // A second Connect is a no-op success and emits nothing new.
    expect(await core.command({ type: 'setup.attach' })).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(batches.length).toBe(seen + 1);
  });

  it('setup.attach answers expired with the refreshed preview in state, then connects', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    const before = core.getState().connection?.preview?.diffText;
    await fsp.writeFile(env.settingsPath, JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }));

    const result = await core.command({ type: 'setup.attach' });
    expect(result).toMatchObject({ ok: false, code: 'expired' });
    if (result.ok) return;
    expect(result.message).toContain('settings changed');
    const connection = core.getState().connection;
    expect(connection?.status).toBe('needs_consent');
    expect(connection?.preview?.diffText).not.toBe(before);
    expect(connection?.preview?.warnings.join(' ')).toContain('telemetry');
    expect(await core.command({ type: 'setup.attach' })).toEqual({ ok: true });
  });

  it('setup.attach answers failed with a message when settings.json cannot be read', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    await fsp.writeFile(env.settingsPath, '{ not json');
    const result = await core.command({ type: 'setup.attach' });
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain(TOKEN);
    expect(await fsp.readFile(env.settingsPath, 'utf8')).toBe('{ not json');
  });

  it('dispose without attaching leaves settings.json alone', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    await core.start();
    await core.dispose();
    expect(await exists(env.settingsPath)).toBe(false);
  });

  it('a throw while deciding a hook does not lose its events: the later onHook pass accepts them', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    const { port, token } = endpointFrom(await readJson(env.settingsPath));
    const internals = core as unknown as { acceptHook: (...args: unknown[]) => unknown };
    const real = internals.acceptHook.bind(core);
    let calls = 0;
    internals.acceptHook = (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return real(...args);
    };
    const body = {
      session_id: 'sess-throw',
      transcript_path: path.join(env.cwd, 't.jsonl'),
      cwd: env.cwd,
      hook_event_name: 'SessionStart',
      source: 'startup',
    };
    // Fail open: the hook is still answered.
    expect(await post(port, token, '/huddle/hooks/SessionStart', body)).toBe(200);
    await vi.waitFor(() => {
      expect(core.getState().agents[agentKey('sess-throw')]).toBeDefined();
    });
    expect(calls).toBe(2);
  });

  it('drops and counts an event that arrives while the store closes (no store error)', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    await core.start();
    const internals = core as unknown as {
      store: { close: () => Promise<void> };
      accept: (events: readonly HuddleEvent[]) => Promise<boolean>;
    };
    const late: HuddleEvent = {
      id: 'late-1',
      type: 'session.started',
      ts: 1,
      sessionId: 'late-session',
      agentKey: 'late-session',
      source: 'hook',
      origin: 'attached',
      cwd: null,
      title: null,
      model: null,
      startKind: 'startup',
    };
    const realClose = internals.store.close.bind(internals.store);
    let accepted: boolean | null = null;
    internals.store.close = async () => {
      // A handler that answers during close (a late request) hands in one more batch.
      accepted = await internals.accept([late]);
      await realClose();
    };
    await core.dispose();
    expect(accepted).toBe(false);
    expect(core.stats()).toMatchObject({ storeErrors: 0, eventsDroppedAtClose: 1 });
    expect(env.logs.filter((l) => l.level === 'error')).toEqual([]);
  });
});

describe('HuddleCore start failures', () => {
  it('reports a taken port as a typed failure and does not attach', async () => {
    const env = await makeEnv();
    await consent(env);
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen({ port: 0, host: '127.0.0.1' }, resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          blocker.close(() => {
            resolve();
          });
        }),
    );
    const taken = (blocker.address() as net.AddressInfo).port;

    const core = makeCore(env, { port: taken });
    const started = await core.start();
    expect(started).toMatchObject({ ok: false, code: 'port_in_use', port: taken });
    if (started.ok) return;
    expect(started.message).toContain(`Port ${String(taken)} is in use`);
    expect(started.message).toContain('another Agent Huddle');
    expect(await exists(env.settingsPath)).toBe(false);
    expect(core.setupStatus()).toMatchObject({ attached: false, port: null });
    expect(core.getState().connection).toEqual({
      status: 'port_in_use',
      message: `Port ${String(taken)} is in use, probably by another Agent Huddle or another program. Close it and restart Huddle.`,
      startedAt: ANY_TIME,
    });
    expect((await core.prepareAttach()).ok).toBe(false);
    await core.dispose();
  });
});

describe('HuddleCore commands', () => {
  it('renames (trimmed, clipped, empty clears), and refuses unknown agents and unsupported commands', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    await postFixture(started.port, TOKEN, 'single-agent.jsonl');
    const main = agentKey(fixtureEvents('single-agent.jsonl')[0]?.sessionId ?? '');
    await vi.waitFor(() => {
      expect(core.getState().agents[main]).toBeDefined();
    });
    const original = core.getState().agents[main]?.name;

    expect(await core.command({ type: 'agent.rename', agentKey: main, name: 'x'.repeat(1000) })).toEqual({ ok: true });
    expect(core.getState().agents[main]?.name).toHaveLength(300);
    expect(await core.command({ type: 'agent.rename', agentKey: main, name: '   ' })).toEqual({ ok: true });
    expect(core.getState().agents[main]?.name).toBe(original);

    expect(await core.command({ type: 'agent.rename', agentKey: 'nope', name: 'A' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await core.command({ type: 'agent.pause', agentKey: main })).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(await core.command({ type: 'all.stop' })).toMatchObject({ ok: false, code: 'unsupported' });
  });

  // Every M4 command has a handler since WP6 (huddle-core.launch.test.ts); unknown targets are a normal result.
  it('answers M4 commands for unknown templates and runs with not_found (no stubs left)', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const commands: HuddleCommand[] = [
      { type: 'template.remove', templateId: 't' },
      { type: 'run.launch', templateId: 't' },
      { type: 'run.stop', runId: 'r' },
      { type: 'run.end', runId: 'r' },
      { type: 'run.keepWorktree', runId: 'r' },
      { type: 'run.discardWorktree', runId: 'r' },
      { type: 'run.openWorktree', runId: 'r' },
    ];
    for (const cmd of commands) {
      expect(await core.command(cmd)).toMatchObject({ ok: false, code: 'not_found' });
    }
  });

  it('batches events to listeners no more often than the interval, and survives a throwing listener', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env);
    const batches: number[] = [];
    core.onEvents(() => {
      throw new Error('boom');
    });
    const off = core.onEvents(() => batches.push(Date.now()));
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    await postFixture(started.port, TOKEN, 'single-agent.jsonl');
    await vi.waitFor(() => {
      expect(batches.length).toBeGreaterThan(0);
    });
    for (let i = 1; i < batches.length; i++)
      expect((batches[i] ?? 0) - (batches[i - 1] ?? 0)).toBeGreaterThanOrEqual(90);
    expect(core.stats().listenerErrors).toBeGreaterThan(0);
    off();
  });
});
