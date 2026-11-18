/**
 * HuddleCore + the lead check on idle teammates (M6 P5b, ADR-027), end to end over real HTTP: a teammate's
 * SubagentStop + TeammateIdle (S20 shapes) -> one message from the Huddle in the lead's outbox -> delivered on the lead's
 * next PreToolUse without the "from the user" prefix -> the lead's report_teammate answer marks the teammate done.
 * "Server available" for this attached session = the Huddle's user-scope registration, read from a temp `.claude.json`
 * (CLAUDE_CONFIG_DIR points at a temp folder; the real `~/.claude.json` is never read here).
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { NOTE_PREFIX } from '../ingest/hook-replies.js';
import { payloads, SESSION } from '../test/broker-sim.js';
import { HuddleCore } from './huddle-core.js';
import { leadCheckText } from './lead-check.js';

const TOKEN = 'test-token-0123456789';
const MAIN = agentKey(SESSION);
const MATE_ID = 'amate-0123456789abcdef';
const MATE = agentKey(SESSION, MATE_ID);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function sendHook(port: number, payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(payload);
    const req = http.request(
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
}

const base = payloads.prompt();
const mate = {
  start: () => ({
    ...base,
    hook_event_name: 'SubagentStart',
    prompt: undefined,
    agent_id: MATE_ID,
    agent_type: 'mate',
  }),
  stop: () => ({
    ...base,
    prompt: undefined,
    hook_event_name: 'SubagentStop',
    agent_id: MATE_ID,
    agent_type: 'mate',
    stop_hook_active: false,
  }),
  idle: () => ({
    ...base,
    prompt: undefined,
    hook_event_name: 'TeammateIdle',
    teammate_name: 'mate',
    team_name: 'session-session-',
    agent_id: MATE_ID,
    agent_type: 'mate',
  }),
  tool: () =>
    payloads.preToolUse('tu-mate', { agent_id: MATE_ID, agent_type: 'mate', tool_name: 'Read', tool_input: {} }),
};

async function setup(opts: { registered: boolean }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-leadcheck-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const claudeDir = path.join(root, 'claude');
  await fsp.mkdir(claudeDir, { recursive: true });
  const forwarder = path.join(root, 'forwarder.mjs');
  await fsp.writeFile(forwarder, '// test forwarder\n');
  const serverScript = path.join(claudeDir, 'agent-huddle', 'huddle-mcp.mjs');
  const servers = opts.registered
    ? { huddle: { type: 'stdio', command: process.execPath, args: [serverScript.replace(/\\/g, '/')] } }
    : { huddle: { type: 'stdio', command: 'node', args: ['C:/someone-else/server.mjs'] } };
  await fsp.writeFile(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: servers }));
  const core = new HuddleCore({
    dataDir: path.join(root, 'data'),
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: forwarder,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    selfReportRegistrar: {
      homeDir: path.join(root, 'home'),
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
      claudeCommand: path.join(root, 'claude.exe'),
      nodeCommand: process.execPath,
      runClaude: () => Promise.reject(new Error('no claude command runs in this test')),
    },
  });
  cleanups.push(() => core.dispose());
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  // The registration is read in the background after start; a preview reads it again and settles the cache.
  const preview = await core.query({ type: 'setup.selfReportPreview', mode: 'register' });
  expect(preview).toMatchObject({ ok: true, preview: { state: opts.registered ? 'ours' : 'foreign' } });
  const port = started.port;
  expect((await sendHook(port, payloads.sessionStart())).status).toBe(200);
  expect((await sendHook(port, payloads.prompt())).status).toBe(200);
  return { core, port };
}

function ofType<T extends HuddleEvent['type']>(core: HuddleCore, type: T): Extract<HuddleEvent, { type: T }>[] {
  return core.getEvents(MAIN, 500).filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
}

async function teammateGoesIdle(port: number, first = true) {
  if (first) expect((await sendHook(port, mate.start())).status).toBe(200);
  expect((await sendHook(port, mate.stop())).status).toBe(200);
  expect((await sendHook(port, mate.idle())).status).toBe(200);
}

describe('HuddleCore lead check (M6 P5b)', () => {
  it('queues one Huddle message to the lead, delivers it without the user prefix, and the answer marks the teammate done', async () => {
    const { core, port } = await setup({ registered: true });
    await teammateGoesIdle(port);
    const queued = await vi.waitFor(() => {
      const q = ofType(core, 'message.queued');
      if (q.length === 0) throw new Error('not yet');
      return q;
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      agentKey: MAIN,
      source: 'huddle',
      delivery: 'auto',
      text: leadCheckText('mate'),
    });
    expect(core.getState().agents[MAIN]?.outbox).toEqual([expect.objectContaining({ author: 'huddle' })]);

    // A second TeammateIdle in the same idle period sends nothing more.
    expect((await sendHook(port, mate.idle())).status).toBe(200);
    expect(ofType(core, 'message.queued')).toHaveLength(1);

    // The lead's next tool call carries it, labelled by the Huddle, not as a note from the user.
    const res = await sendHook(port, payloads.preToolUse('tu-lead'));
    const context = (JSON.parse(res.body) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(context).toBe(leadCheckText('mate'));
    expect(context.startsWith(NOTE_PREFIX)).toBe(false);
    expect(ofType(core, 'message.delivered')).toHaveLength(1);

    // The lead answers with report_teammate: the teammate is done.
    const answer = payloads.postToolUse('tu-r', {
      tool_name: 'mcp__huddle__report_teammate',
      tool_input: { name: 'mate', status: 'finished' },
    });
    expect((await sendHook(port, answer)).status).toBe(200);
    await vi.waitFor(() => {
      expect(core.getState().agents[MATE]?.status).toBe('done');
    });
  });

  it('sends nothing when the huddle server is not the registered one (attached session without the tool)', async () => {
    const { core, port } = await setup({ registered: false });
    await teammateGoesIdle(port);
    await vi.waitFor(() => {
      expect(core.getState().agents[MATE]?.status).toBe('idle');
    });
    expect(ofType(core, 'message.queued')).toEqual([]);
  });

  it('sends nothing with the setting off (teams.askLeadOnIdle false)', async () => {
    const { core, port } = await setup({ registered: true });
    expect(await core.command({ type: 'settings.update', patch: { teams: { askLeadOnIdle: false } } })).toMatchObject({
      ok: true,
    });
    await teammateGoesIdle(port);
    await vi.waitFor(() => {
      expect(core.getState().agents[MATE]?.status).toBe('idle');
    });
    expect(ofType(core, 'message.queued')).toEqual([]);
  });

  it('asks again only after the lead answered and the teammate worked again', async () => {
    const { core, port } = await setup({ registered: true });
    await teammateGoesIdle(port);
    await vi.waitFor(() => {
      expect(ofType(core, 'message.queued')).toHaveLength(1);
    });
    await sendHook(port, payloads.preToolUse('tu-lead')); // delivered
    // Work before the answer (the lead's own check woke the teammate) does not count.
    await sendHook(port, mate.tool());
    await teammateGoesIdle(port, false);
    expect(ofType(core, 'message.queued')).toHaveLength(1);
    await sendHook(
      port,
      payloads.postToolUse('tu-r', {
        tool_name: 'mcp__huddle__report_teammate',
        tool_input: { name: 'mate', status: 'waiting' },
      }),
    );
    await sendHook(port, mate.tool());
    await teammateGoesIdle(port, false);
    await vi.waitFor(() => {
      expect(ofType(core, 'message.queued')).toHaveLength(2);
    });
  });
});
