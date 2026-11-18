/**
 * HuddleCore + approval rules end to end over real HTTP (M4 WP2, F18): an ephemeral port, the token header, payload
 * shapes from fixtures/permission-allow.jsonl (test/broker-sim.ts). A managed session is made by seeding the event log
 * with `run.launched` before start, as the launcher will write it.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey, type HuddleEvent, type PolicyRule } from '@huddle/shared';
import { payloads } from '../test/broker-sim.js';
import { JsonlEventStore } from '../store/jsonl-store.js';
import { HuddleCore } from './huddle-core.js';
import { policyRulesPath, readPolicyRules } from './policy-store.js';

const TOKEN = 'test-token-0123456789';
const MANAGED = 'session-1';
const ATTACHED = 'session-2';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function sendHook(port: number, payload: Record<string, unknown>) {
  let req: http.ClientRequest | null = null;
  const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const text = JSON.stringify(payload);
    req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/huddle/hooks/${String(payload.hook_event_name)}`,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-huddle-token': TOKEN,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
  return { done, abort: () => req?.destroy() };
}

function launched(sessionId: string): HuddleEvent {
  return {
    id: 'launch-1',
    type: 'run.launched',
    ts: Date.now() - 1000,
    sessionId,
    agentKey: agentKey(sessionId),
    source: 'huddle',
    runId: 'run-1',
    claudeSessionId: sessionId,
    templateId: null,
    cwd: 'C:/Users/user/project',
    model: null,
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: null,
  };
}

async function setup(
  opts: {
    rulesFile?: string;
    settings?: Record<string, unknown>;
    runIsLive?: ((runId: string) => boolean) | null;
  } = {},
) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-policy-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const claudeDir = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(claudeDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  const forwarder = path.join(root, 'forwarder.mjs');
  await fsp.writeFile(forwarder, '// test forwarder\n');
  if (opts.rulesFile !== undefined) await fsp.writeFile(policyRulesPath(dataDir), opts.rulesFile);
  if (opts.settings !== undefined) {
    await fsp.writeFile(path.join(dataDir, 'huddle-settings.json'), JSON.stringify({ preferences: opts.settings }));
  }
  const seed = new JsonlEventStore({ baseDir: path.join(dataDir, 'events') });
  await seed.append([launched(MANAGED)]);
  await seed.close();
  const warnings: string[] = [];
  const core = new HuddleCore({
    dataDir,
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: forwarder,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
    // The seeded run-1 stands for a run this Huddle launched and whose process is alive (RunHost.isAlive).
    ...(opts.runIsLive === null ? {} : { runIsLive: opts.runIsLive ?? ((runId: string) => runId === 'run-1') }),
    logger: { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined },
  });
  cleanups.push(() => core.dispose());
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  const port = started.port;
  for (const session of [MANAGED, ATTACHED]) {
    for (const p of [payloads.sessionStart(), payloads.prompt()]) {
      expect((await sendHook(port, { ...p, session_id: session }).done).status).toBe(200);
    }
  }
  expect(core.getState().agents[agentKey(MANAGED)]?.origin).toBe('managed');
  expect(core.getState().agents[agentKey(ATTACHED)]?.origin).toBe('attached');
  return { core, port, dataDir, warnings };
}

function gitStatus(sessionId: string) {
  return payloads.permission({ session_id: sessionId, tool_input: { command: 'git status', description: 'status' } });
}

function resolvedOf(core: HuddleCore, session: string) {
  return core
    .getEvents(agentKey(session), 500)
    .filter((e): e is Extract<HuddleEvent, { type: 'approval.resolved' }> => e.type === 'approval.resolved');
}

describe('HuddleCore approval rules over HTTP', () => {
  it("a managed session's git status is allowed by the default rule in under 50 ms, by policy", async () => {
    const { core, port } = await setup();
    // No listener batch may ever see the rule-decided request as an open item (toasts read the inbox per batch).
    const openSeen: number[] = [];
    core.onEvents(() => {
      openSeen.push(core.getState().inbox.filter((i) => i.kind === 'approval' && i.resolvedAt === null).length);
    });
    const t0 = performance.now();
    const res = await sendHook(port, gitStatus(MANAGED)).done;
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(ms).toBeLessThan(50);
    expect(resolvedOf(core, MANAGED)).toEqual([
      expect.objectContaining({ outcome: 'allowed', by: 'policy', policyRuleId: 'default:git-status' }),
    ]);
    expect(core.stats().server?.heldNow).toBe(0);
    expect(core.getState().inbox.filter((i) => i.resolvedAt === null)).toEqual([]);
    await vi.waitFor(() => {
      expect(openSeen.length).toBeGreaterThan(0);
    });
    expect(openSeen.every((n) => n === 0)).toBe(true);
  });

  it('a managed session whose run is not live (resumed in a terminal, or from before a restart) goes to the inbox (L1)', async () => {
    // null: no stand-in, so the core asks its own RunHost, which never launched the seeded run-1 (as after a restart).
    for (const runIsLive of [() => false, null]) {
      const { core, port } = await setup({ runIsLive });
      expect(core.getState().agents[agentKey(MANAGED)]?.origin).toBe('managed');
      const sent = sendHook(port, gitStatus(MANAGED));
      await vi.waitFor(() => {
        expect(core.stats().server?.heldNow).toBe(1);
      });
      expect(resolvedOf(core, MANAGED)).toEqual([]);
      sent.abort();
      await sent.done.catch(() => undefined);
    }
  });

  it('an attached session goes to the inbox while applyToAttached is false', async () => {
    const { core, port } = await setup();
    const sent = sendHook(port, gitStatus(ATTACHED));
    await vi.waitFor(() => {
      expect(core.stats().server?.heldNow).toBe(1);
    });
    expect(resolvedOf(core, ATTACHED)).toEqual([]);
    expect(core.getState().inbox.some((i) => i.kind === 'approval' && i.resolvedAt === null)).toBe(true);
    sent.abort();
    await sent.done.catch(() => undefined);
  });

  it('with applyToAttached on (from the settings file), an attached git status is allowed by policy', async () => {
    const { core, port } = await setup({ settings: { policy: { applyToAttached: true } } });
    const res = await sendHook(port, gitStatus(ATTACHED)).done;
    expect(JSON.parse(res.body)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    expect(resolvedOf(core, ATTACHED)[0]).toMatchObject({ by: 'policy' });
  });

  it('a saved deny rule answers at once with its own wording; upsert and remove persist and show in the state', async () => {
    const { core, port, dataDir } = await setup();
    const deny: PolicyRule = {
      id: 'no-npm-view',
      name: 'No npm view',
      enabled: true,
      action: 'deny',
      match: { commandPrefix: 'npm view' },
    };
    expect(await core.command({ type: 'policy.upsertRule', rule: deny })).toEqual({ ok: true });
    expect(core.getState().policy?.map((r) => r.id)).toContain('no-npm-view');
    expect((await readPolicyRules(dataDir)).rules.map((r) => r.id)).toContain('no-npm-view');

    const res = await sendHook(port, payloads.permission({ session_id: MANAGED })).done;
    expect(JSON.parse(res.body)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied by Agent Huddle rule "No npm view" (no-npm-view).' },
      },
    });

    expect(await core.command({ type: 'policy.removeRule', ruleId: 'no-npm-view' })).toEqual({ ok: true });
    expect(core.getState().policy?.map((r) => r.id)).not.toContain('no-npm-view');
    expect(await core.command({ type: 'policy.removeRule', ruleId: 'no-npm-view' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('refuses a malformed rule and an allow that names nothing', async () => {
    const { core } = await setup();
    expect(
      await core.command({ type: 'policy.upsertRule', rule: { id: '', name: 'x' } as unknown as PolicyRule }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await core.command({
        type: 'policy.upsertRule',
        rule: { id: 'all', name: 'all', enabled: true, action: 'allow', match: {} },
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a corrupt rules file at start gives the defaults and a warning', async () => {
    const { core, warnings } = await setup({ rulesFile: '{ broken' });
    expect(core.getState().policy?.map((r) => r.id)).toContain('default:git-status');
    expect(warnings.some((w) => w.includes('using the default rules'))).toBe(true);
  });

  it('query: policy.preview over recent requests (approximate); pick.folder is for main', async () => {
    const { core, port } = await setup();
    const sent = sendHook(port, payloads.permission({ session_id: ATTACHED }));
    await vi.waitFor(() => {
      expect(core.stats().server?.heldNow).toBe(1);
    });
    const rule: PolicyRule = {
      id: 'v',
      name: 'npm view',
      enabled: true,
      action: 'allow',
      match: { commandPrefix: 'npm view' },
    };
    const result = await core.query({ type: 'policy.preview', rule });
    expect(result).toMatchObject({
      ok: true,
      type: 'policy.preview',
      preview: { examined: 1, matched: 1, approximate: true },
    });
    expect(await core.query({ type: 'pick.folder' })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await core.query({ type: 'nope' } as never)).toMatchObject({ ok: false, code: 'invalid' });
    // M5 questions are checked, then answered by the history service (WP4b) or, for Ask, by the core (WP6).
    expect(await core.query({ type: 'history.list', limit: 5 })).toMatchObject({ ok: true, type: 'history.list' });
    expect(await core.query({ type: 'scorecards.get' })).toMatchObject({ ok: true, type: 'scorecards.get' });
    expect(await core.query({ type: 'ask.preview', question: 'x' })).toMatchObject({ ok: true, type: 'ask.preview' });
    expect(await core.query({ type: 'ask.preview', question: '   ' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await core.query({ type: 'report.get', sessionId: '../x' })).toMatchObject({ ok: false, code: 'invalid' });
    sent.abort();
    await sent.done.catch(() => undefined);
  });
});

describe('HuddleCore with a bad policy-rules.json (A2-02)', () => {
  it('keeps the original file as .bad-* before the first save and says so in the state', async () => {
    const original = JSON.stringify({
      version: 1,
      rules: [{ id: 'x', name: 'x', enabled: true, action: 'nope', match: {} }],
    });
    const { core, dataDir } = await setup({ rulesFile: original });
    expect(core.getState().policyWarning).toMatch(/using the default rules/);
    const deny: PolicyRule = {
      id: 'no-curl',
      name: 'No curl',
      enabled: true,
      action: 'deny',
      match: { commandPrefix: 'curl' },
    };
    expect(await core.command({ type: 'policy.upsertRule', rule: deny })).toEqual({ ok: true });
    const bad = (await fsp.readdir(dataDir)).filter((f) => f.startsWith('policy-rules.json.bad-'));
    expect(bad).toHaveLength(1);
    expect(await fsp.readFile(path.join(dataDir, bad[0] ?? ''), 'utf8')).toBe(original);
    expect(core.getState().policyWarning).toContain(bad[0]);
    expect((await readPolicyRules(dataDir)).rules.map((r) => r.id)).toContain('no-curl');
  });

  it('refuses to save while the rules file cannot be read, and leaves it alone', async () => {
    const { core, dataDir } = await setup();
    // A folder where the file should be: reading it fails (EISDIR), as EBUSY or EACCES would.
    await fsp.mkdir(policyRulesPath(dataDir));
    await fsp.writeFile(path.join(policyRulesPath(dataDir), 'keep'), 'x');
    const deny: PolicyRule = {
      id: 'no-curl',
      name: 'No curl',
      enabled: true,
      action: 'deny',
      match: { commandPrefix: 'curl' },
    };
    // The core read the file at start (none then); mark it unreadable the way a failed read at start would.
    (core as unknown as { policyReadFailed: boolean }).policyReadFailed = true;
    expect(await core.command({ type: 'policy.upsertRule', rule: deny })).toMatchObject({ ok: false, code: 'failed' });
    expect(await fsp.readFile(path.join(policyRulesPath(dataDir), 'keep'), 'utf8')).toBe('x');
    expect(core.getState().policyWarning).toMatch(/could not be read/);
  });

  it('has no warning for a good file', async () => {
    const { core } = await setup();
    expect(core.getState().policyWarning ?? null).toBeNull();
  });
});

describe('HuddleCore refuses broad allow rules when saved, not when loaded (AX-05)', () => {
  const allow = (id: string, commandPrefix: string): PolicyRule => ({
    id,
    name: id,
    enabled: true,
    action: 'allow',
    match: { tool: 'Bash', commandPrefix },
  });

  it('refuses saving bash -c, npm install and git push, and writes nothing', async () => {
    const { core, dataDir } = await setup();
    for (const prefix of ['bash -c', 'npm install', 'git push', 'rm -rf', 'git clean']) {
      expect(await core.command({ type: 'policy.upsertRule', rule: allow('user:x', prefix) })).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    }
    expect(core.getState().policy?.some((r) => r.id === 'user:x')).toBe(false);
    expect((await fsp.readdir(dataDir)).includes('policy-rules.json')).toBe(false);
  });

  it('a stored npm install allow can be switched off; saving one enabled is still refused (R-04)', async () => {
    const stored = allow('user:npm', 'npm install');
    const { core, dataDir } = await setup({ rulesFile: JSON.stringify({ version: 1, rules: [stored] }) });
    expect(await core.command({ type: 'policy.upsertRule', rule: { ...stored, enabled: false } })).toMatchObject({
      ok: true,
    });
    expect(core.getState().policy?.find((r) => r.id === 'user:npm')?.enabled).toBe(false);
    expect((await readPolicyRules(dataDir)).rules.find((r) => r.id === 'user:npm')?.enabled).toBe(false);
    // A new enabled rule, or the stored one edited beyond its switch, is refused as before.
    expect(await core.command({ type: 'policy.upsertRule', rule: allow('user:new', 'npm install') })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(
      await core.command({ type: 'policy.upsertRule', rule: { ...stored, name: 'renamed', enabled: true } }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(core.getState().policy?.some((r) => r.id === 'user:new')).toBe(false);
    // Switching it on again is a save like any other, so a risky allow cannot be saved off and then switched on.
    expect(await core.command({ type: 'policy.upsertRule', rule: stored })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const off = { ...allow('user:off', 'npm install'), enabled: false };
    expect(await core.command({ type: 'policy.upsertRule', rule: off })).toMatchObject({ ok: true });
    expect(await core.command({ type: 'policy.upsertRule', rule: { ...off, enabled: true } })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(core.getState().policy?.find((r) => r.id === 'user:off')?.enabled).toBe(false);
  });

  it('a rules file that already holds bash -c still loads, without a warning', async () => {
    const rulesFile = JSON.stringify({ version: 1, rules: [allow('user:bash', 'bash -c')] });
    const { core } = await setup({ rulesFile });
    expect(core.getState().policy?.map((r) => r.id)).toEqual(['user:bash']);
    expect(core.getState().policyWarning ?? null).toBeNull();
  });
});
