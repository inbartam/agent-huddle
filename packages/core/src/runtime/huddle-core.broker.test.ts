/**
 * HuddleCore + broker end to end over real HTTP (M3 WP5): an ephemeral port, the token header, payload shapes from
 * fixtures/permission-allow.jsonl (see test/broker-sim.ts). Each test drives one ending or delivery path the way
 * Claude Code would: a held request is an HTTP request whose response has not come yet.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { DENY_PREFIX, NOTE_PREFIX } from '../ingest/hook-replies.js';
import { FOLLOW_UP_PREFIX } from '../broker/outbox.js';
import { payloads } from '../test/broker-sim.js';
import { readStoredLog } from '../test/stored-log.js';
import { HuddleCore, type HuddleCoreDeps } from './huddle-core.js';
import { readHuddleSettings, userSettingsOf, withUserSettings, writeHuddleSettings } from './huddle-settings.js';
import { repeatItemId } from '../detect/loop.js';
import { stuckItemId } from '../detect/stuck.js';

const TOKEN = 'test-token-0123456789';
const MAIN = agentKey('session-1');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Sent {
  /** Resolves with the status and body once the response arrives (or rejects when aborted). */
  done: Promise<{ status: number; body: string }>;
  abort: () => void;
}

function sendHook(port: number, payload: Record<string, unknown>): Sent {
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
  return {
    done,
    abort: () => {
      req?.destroy();
    },
  };
}

async function setup(extra: Partial<HuddleCoreDeps> = {}, root?: string, seed = true) {
  root ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-broker-'));
  const dir = root;
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const claudeDir = path.join(root, 'claude');
  await fsp.mkdir(claudeDir, { recursive: true });
  const forwarder = path.join(root, 'forwarder.mjs');
  await fsp.writeFile(forwarder, '// test forwarder\n');
  const warnings: string[] = [];
  const core = new HuddleCore({
    dataDir: path.join(root, 'data'),
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: forwarder,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
    logger: { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined },
    ...extra,
  });
  cleanups.push(() => core.dispose());
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  const port = started.port;
  // The session is known before anything is held.
  if (seed) {
    expect((await sendHook(port, payloads.sessionStart()).done).status).toBe(200);
    expect((await sendHook(port, payloads.prompt()).done).status).toBe(200);
  }
  return { core, port, root, warnings };
}

function events(core: HuddleCore): HuddleEvent[] {
  return core.getEvents(MAIN, 500);
}

function ofType<T extends HuddleEvent['type']>(core: HuddleCore, type: T): Extract<HuddleEvent, { type: T }>[] {
  return events(core).filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
}

async function heldApproval(core: HuddleCore, port: number) {
  const sent = sendHook(port, payloads.permission());
  const requestId = await vi.waitFor(() => {
    const req = ofType(core, 'approval.requested')[0];
    if (!req) throw new Error('not yet');
    return req.request.requestId;
  });
  return { sent, requestId };
}

describe('HuddleCore broker over HTTP', () => {
  it('holds a PermissionRequest and answers allow', async () => {
    const { core, port } = await setup();
    const { sent, requestId } = await heldApproval(core, port);
    expect(core.stats().server?.heldNow).toBe(1);
    expect(await core.command({ type: 'approval.decide', requestId, decision: 'allow' })).toEqual({ ok: true });
    const res = await sent.done;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(ofType(core, 'approval.resolved')).toEqual([expect.objectContaining({ outcome: 'allowed', by: 'user' })]);
    expect(await core.command({ type: 'approval.decide', requestId, decision: 'allow' })).toMatchObject({
      code: 'expired',
    });
  });

  it('denies with a message the agent reads', async () => {
    const { core, port } = await setup();
    const { sent, requestId } = await heldApproval(core, port);
    await core.command({ type: 'approval.decide', requestId, decision: 'deny', message: 'Use pnpm instead.' });
    expect(JSON.parse((await sent.done).body)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: DENY_PREFIX + 'Use pnpm instead.' },
      },
    });
    expect(ofType(core, 'approval.resolved')[0]).toMatchObject({ outcome: 'denied', message: 'Use pnpm instead.' });
  });

  it('client aborts while held -> answered_elsewhere, and a late decision is expired', async () => {
    const { core, port } = await setup();
    const { sent, requestId } = await heldApproval(core, port);
    sent.abort();
    await expect(sent.done).rejects.toThrow();
    await vi.waitFor(() => {
      expect(ofType(core, 'approval.resolved')).toEqual([
        expect.objectContaining({ outcome: 'answered_elsewhere', by: 'claude_code' }),
      ]);
    });
    expect(await core.command({ type: 'approval.decide', requestId, decision: 'allow' })).toMatchObject({
      code: 'expired',
    });
  });

  it('dispose while held -> empty 200, and by: shutdown is in the log on disk', async () => {
    const { core, port, root } = await setup();
    const { sent } = await heldApproval(core, port);
    await core.dispose();
    const res = await sent.done;
    expect(res).toEqual({ status: 200, body: '' });
    const lines = await readStoredLog(path.join(root, 'data'), 'session-1');
    expect(lines.filter((e) => e.type === 'approval.resolved')).toEqual([
      expect.objectContaining({ outcome: 'passed_through', by: 'shutdown' }),
    ]);
  });

  it('pause holds the next PreToolUse; resume releases it', async () => {
    const { core, port } = await setup();
    expect(await core.command({ type: 'agent.pause', agentKey: MAIN })).toEqual({ ok: true });
    const sent = sendHook(port, payloads.preToolUse('tu-1'));
    await vi.waitFor(() => {
      expect(ofType(core, 'hold.started')).toHaveLength(1);
    });
    expect(core.getState().agents[MAIN]?.status).toBe('paused');
    let answered = false;
    void sent.done.then(() => (answered = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);
    expect(await core.command({ type: 'agent.resume', agentKey: MAIN })).toEqual({ ok: true });
    expect(await sent.done).toEqual({ status: 200, body: '' });
    expect(ofType(core, 'hold.ended')).toEqual([expect.objectContaining({ why: 'resumed', toolUseId: 'tu-1' })]);
  });

  it('a pause still pending from an earlier run is called off at start, so the next PreToolUse is not held', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-broker-'));
    const first = await setup({}, root);
    expect(await first.core.command({ type: 'agent.pause', agentKey: MAIN })).toEqual({ ok: true });
    expect(first.core.getState().agents[MAIN]?.pausePending).toBe(true);
    await first.core.dispose();

    const second = await setup({}, root, false);
    expect(second.core.getState().agents[MAIN]?.pausePending).toBe(false);
    expect(ofType(second.core, 'control.applied').filter((e) => e.action === 'resume')).toEqual([
      expect.objectContaining({ source: 'huddle', detail: null }),
    ]);
    // Answered at once with no decision: nothing is held.
    expect(await sendHook(second.port, payloads.preToolUse('tu-after-restart')).done).toEqual({
      status: 200,
      body: '',
    });
    expect(ofType(second.core, 'hold.started')).toHaveLength(0);
    // The call-off is in the log, so a third start replays to the same state and writes nothing new.
    await second.core.dispose();
    const third = await setup({}, root, false);
    expect(third.core.getState().agents[MAIN]?.pausePending).toBe(false);
    expect(ofType(third.core, 'control.applied').filter((e) => e.action === 'resume')).toHaveLength(1);
  });

  it('delivers a queued note on the next PreToolUse, at once', async () => {
    const { core, port } = await setup();
    expect(
      await core.command({
        type: 'agent.message',
        agentKey: MAIN,
        text: 'Run the tests first.',
        delivery: 'next_tool',
      }),
    ).toEqual({ ok: true });
    const res = await sendHook(port, payloads.preToolUse('tu-1')).done;
    expect(JSON.parse(res.body)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `${NOTE_PREFIX}Run the tests first.` },
    });
    expect(ofType(core, 'message.delivered')).toEqual([expect.objectContaining({ via: 'pre_tool_context' })]);
  });

  it('blocks Stop once with the follow-up; the continuing Stop passes through', async () => {
    const { core, port } = await setup();
    await core.command({ type: 'agent.message', agentKey: MAIN, text: 'Now update the docs.', delivery: 'turn_end' });
    const first = await sendHook(port, payloads.stop(false)).done;
    expect(JSON.parse(first.body)).toEqual({ decision: 'block', reason: `${FOLLOW_UP_PREFIX}Now update the docs.` });
    const second = await sendHook(port, payloads.stop(true)).done;
    expect(second).toEqual({ status: 200, body: '' });
  });

  describe('answered in the terminal while held (2.1.325 does not close the request, SPIKES S1 2026-11-14)', () => {
    const LODASH = {
      tool_name: 'PowerShell',
      tool_input: { command: 'npm view lodash version', description: 'Check the lodash version' },
    };

    async function heldLodash(port: number, core: HuddleCore) {
      expect((await sendHook(port, payloads.preToolUse('toolu_013x', LODASH)).done).status).toBe(200);
      const sent = sendHook(port, payloads.permission(LODASH));
      const requestId = await vi.waitFor(() => {
        const req = ofType(core, 'approval.requested')[0];
        if (!req) throw new Error('not yet');
        return req.request.requestId;
      });
      expect(core.stats().server?.heldNow).toBe(1);
      expect((await sendHook(port, payloads.notification()).done).status).toBe(200);
      return { sent, requestId };
    }

    function approvalItem(core: HuddleCore, requestId: string) {
      return core.getState().inbox.find((i) => i.id === `approval:${requestId}`);
    }

    it('PostToolUse of the same command -> held response gets an empty 200, approval.resolved answered elsewhere', async () => {
      const { core, port } = await setup();
      const { sent, requestId } = await heldLodash(port, core);
      expect(approvalItem(core, requestId)?.resolvedAt).toBeNull();
      const post = await sendHook(port, payloads.postToolUse('toolu_013x', { ...LODASH, duration_ms: 11_364 })).done;
      expect(post).toEqual({ status: 200, body: '' });
      expect(await sent.done).toEqual({ status: 200, body: '' });
      expect(core.stats().server?.heldNow).toBe(0);
      expect(ofType(core, 'approval.resolved')).toEqual([
        expect.objectContaining({ requestId, outcome: 'answered_elsewhere', by: 'claude_code', message: null }),
      ]);
      expect(approvalItem(core, requestId)?.resolvedAt).not.toBeNull();
      expect(core.getState().agents[MAIN]?.status).toBe('working');
    });

    it('Stop of the session main agent ends it the same way', async () => {
      const { core, port } = await setup();
      const { sent, requestId } = await heldLodash(port, core);
      expect(await sendHook(port, payloads.stop()).done).toEqual({ status: 200, body: '' });
      expect(await sent.done).toEqual({ status: 200, body: '' });
      expect(ofType(core, 'approval.resolved')).toEqual([
        expect.objectContaining({ requestId, outcome: 'answered_elsewhere', by: 'claude_code' }),
      ]);
      expect(approvalItem(core, requestId)?.resolvedAt).not.toBeNull();
      expect(core.getState().agents[MAIN]?.status).toBe('idle');
    });

    it('an unrelated tool call of the same agent finishing leaves it held', async () => {
      const { core, port } = await setup();
      const { sent, requestId } = await heldLodash(port, core);
      let answered = false;
      void sent.done.then(() => (answered = true));
      const read = { tool_name: 'Read', tool_input: { file_path: 'C:/Users/user/project/README.md' } };
      await sendHook(port, payloads.preToolUse('toolu_read', read)).done;
      await sendHook(port, payloads.postToolUse('toolu_read', read)).done;
      await new Promise((r) => setTimeout(r, 50));
      expect(answered).toBe(false);
      expect(core.stats().server?.heldNow).toBe(1);
      expect(ofType(core, 'approval.resolved')).toEqual([]);
      expect(approvalItem(core, requestId)?.resolvedAt).toBeNull();
      // Still the user's to answer.
      expect(await core.command({ type: 'approval.decide', requestId, decision: 'allow' })).toEqual({ ok: true });
      expect(JSON.parse((await sent.done).body)).toMatchObject({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
    });

    it('PermissionRequest(AskUserQuestion) is answered at once with no decision and opens no approval', async () => {
      const { core, port } = await setup();
      const ask = payloads.ask('tu-q1');
      const res = await sendHook(
        port,
        payloads.permission({ tool_name: 'AskUserQuestion', tool_input: ask.tool_input }),
      ).done;
      expect(res).toEqual({ status: 200, body: '' });
      expect(core.stats().server?.heldNow).toBe(0);
      expect(ofType(core, 'approval.requested')).toEqual([]);
      expect(core.getState().inbox.filter((i) => i.kind === 'approval')).toEqual([]);
    });
  });

  it('rejects a malformed broker command with invalid', async () => {
    const { core } = await setup();
    expect(await core.command({ type: 'agent.message', agentKey: MAIN, text: '', delivery: 'auto' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});

describe('HuddleCore settings ownership (two writers)', () => {
  it('keeps preferences main wrote after start when it records consent', async () => {
    const { core, root } = await setup();
    const dataDir = path.join(root, 'data');
    // Desktop main saves a preference while the core runs.
    const file = await readHuddleSettings(dataDir);
    const prefs = { ...userSettingsOf(file), questionHoldSeconds: 30 };
    await writeHuddleSettings(dataDir, {
      ...withUserSettings(file, prefs),
      extra: { ...withUserSettings(file, prefs).extra, futureKey: 1 },
    });
    expect(await core.command({ type: 'setup.attach' })).toEqual({ ok: true });
    const after = await readHuddleSettings(dataDir);
    expect(after.consentedAt).not.toBeNull();
    expect(userSettingsOf(after).questionHoldSeconds).toBe(30);
    expect(after.extra.futureKey).toBe(1);
    // The core re-read the file, so the broker now uses the new window.
    expect(core.getUserSettings().questionHoldSeconds).toBe(30);
  });

  it('settings.update in core patches the file as it is now and applies live', async () => {
    const { core, root } = await setup();
    expect(await core.command({ type: 'settings.update', patch: { questionHoldSeconds: 45 } })).toEqual({ ok: true });
    expect(core.getUserSettings().questionHoldSeconds).toBe(45);
    expect(userSettingsOf(await readHuddleSettings(path.join(root, 'data'))).questionHoldSeconds).toBe(45);
    expect(await core.command({ type: 'settings.update', patch: { questionHoldSeconds: 10_000 } })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('settings.update saves the collapsed widget to the file and keeps the other settings', async () => {
    const { core, root } = await setup();
    expect(core.getUserSettings().widgetCollapsed).toBe(false);
    expect(await core.command({ type: 'settings.update', patch: { questionHoldSeconds: 45 } })).toEqual({ ok: true });
    expect(await core.command({ type: 'settings.update', patch: { widgetCollapsed: true } })).toEqual({ ok: true });
    const saved = userSettingsOf(await readHuddleSettings(path.join(root, 'data')));
    expect(saved).toMatchObject({ widgetCollapsed: true, questionHoldSeconds: 45 });
    expect(core.getUserSettings().widgetCollapsed).toBe(true);
    // An untrusted renderer could send anything; the core rejects a non-boolean.
    const bad = JSON.parse('{"type":"settings.update","patch":{"widgetCollapsed":"yes"}}') as Parameters<
      typeof core.command
    >[0];
    expect(await core.command(bad)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});

describe('HuddleCore detectors', () => {
  it('raises a loop item from live events', async () => {
    const { core, port } = await setup();
    for (let i = 0; i < 5; i++) await sendHook(port, payloads.preToolUse('tu-' + String(i))).done;
    await vi.waitFor(() => {
      expect(core.getState().inbox.some((item) => item.kind === 'loop' && item.agentKey === MAIN)).toBe(true);
    });
    const raised = ofType(core, 'attention.raised')[0];
    expect(raised?.item.id.startsWith(repeatItemId(MAIN, ''))).toBe(true);
  });

  it('does not flag sessions replayed from before this run as stuck', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-broker-'));
    let clock = Date.now();
    const first = await setup({ now: () => clock }, root);
    await sendHook(first.port, payloads.preToolUse('tu-1')).done;
    await first.core.dispose();
    // Twenty minutes later the Huddle starts again; the old session is still working in the log.
    clock += 20 * 60_000;
    const second = await setup({ now: () => clock, detectTickMs: 20 }, root, false);
    expect(second.core.getState().agents[MAIN]?.status).toBe('working');
    await new Promise((r) => setTimeout(r, 120));
    expect(second.core.getState().inbox.some((i) => i.id === stuckItemId(MAIN))).toBe(false);
  });
});
