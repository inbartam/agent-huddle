/**
 * HuddleCore + phone access end to end (M6, F26): a real hook server on 127.0.0.1 holding a PermissionRequest the way
 * Claude Code sends it (test/broker-sim.ts payloads), and the phone listener bound to 127.0.0.1 (the address rule is
 * replaced for tests only). Each of the four endings of a held approval is driven while a phone stream is open, and
 * Approve from the phone goes through the broker's own path (`by: 'user', via: 'phone'`).
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentKey,
  CONTROL_REASONS,
  PHONE_CONTROL_REASONS,
  type EventOfType,
  type HuddleCommand,
  type HuddleEvent,
  type PhoneView,
  type PolicyRule,
} from '@huddle/shared';
import { payloads } from '../test/broker-sim.js';
import { readStoredLog } from '../test/stored-log.js';
import { HuddleCore, PHONE_SESSION_ID, type HuddleCoreDeps } from './huddle-core.js';

const TOKEN = 'test-token-0123456789';
const MAIN = agentKey('session-1');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => {
        resolve(p);
      });
    });
  });
}

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

function phoneCall(
  port: number,
  opts: { method?: string; path: string; token?: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const text = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? (text === undefined ? 'GET' : 'POST'),
        path: opts.path,
        agent: false,
        headers: {
          ...(text !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
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

function openStream(port: number, token: string) {
  let text = '';
  const closed = new Promise<void>((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/stream', agent: false, headers: { authorization: `Bearer ${token}` } },
      (r) => {
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('close', resolve);
        r.on('error', () => {
          resolve();
        });
      },
    );
    req.on('error', () => {
      resolve();
    });
  });
  /** The newest view the stream carried. */
  const last = (): PhoneView | null => {
    const frames = text.split('\n\n').filter((f) => f.startsWith('event: view\ndata: '));
    const frame = frames.at(-1);
    return frame === undefined ? null : (JSON.parse(frame.slice('event: view\ndata: '.length)) as PhoneView);
  };
  return { text: () => text, last, closed };
}

async function setup(opts: { settings?: Record<string, unknown> } = {}, extra: Partial<HuddleCoreDeps> = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-phone-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const claudeDir = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(claudeDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  if (opts.settings !== undefined) {
    await fsp.writeFile(path.join(dataDir, 'huddle-settings.json'), JSON.stringify({ preferences: opts.settings }));
  }
  const forwarder = path.join(root, 'forwarder.mjs');
  await fsp.writeFile(forwarder, '// test forwarder\n');
  const core = new HuddleCore({
    dataDir,
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: forwarder,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    phone: { addressCheck: () => null, server: { heartbeatMs: 50, throttleMs: 0 } },
    ...extra,
  });
  cleanups.push(() => core.dispose());
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  const port = started.port;
  expect((await sendHook(port, payloads.sessionStart()).done).status).toBe(200);
  expect((await sendHook(port, payloads.prompt()).done).status).toBe(200);
  return { core, port, dataDir };
}

async function phoneOn(core: HuddleCore): Promise<{ phonePort: number; token: string; deviceId: string }> {
  const phonePort = await freePort();
  const on = await core.command({ type: 'phone.enable', ip: '127.0.0.1', port: phonePort });
  expect(on).toEqual({ ok: true, detail: `http://127.0.0.1:${String(phonePort)}/` });
  const code = await core.command({ type: 'phone.pair' });
  if (!code.ok || code.phonePairing === undefined) throw new Error('no pairing code');
  expect(code.detail).toBe(code.phonePairing.code);
  const res = await phoneCall(phonePort, {
    path: '/api/pair',
    body: { code: code.phonePairing.code, name: 'Test phone' },
  });
  expect(res.status).toBe(200);
  const { token, deviceId } = JSON.parse(res.body) as { token: string; deviceId: string };
  return { phonePort, token, deviceId };
}

function ofType<T extends HuddleEvent['type']>(core: HuddleCore, key: string, type: T): EventOfType<T>[] {
  return core.getEvents(key, 500).filter((e): e is EventOfType<T> => e.type === type);
}

async function held(core: HuddleCore, port: number) {
  const sent = sendHook(port, payloads.permission());
  const requestId = await vi.waitFor(() => {
    const req = ofType(core, MAIN, 'approval.requested')[0];
    if (!req) throw new Error('not yet');
    return req.request.requestId;
  });
  return { sent, requestId };
}

const approvalsIn = (view: PhoneView | null) => (view?.inbox ?? []).filter((i) => i.kind === 'approval');

describe('HuddleCore phone access', () => {
  it('is off at start: nothing listens, no code is handed out, the addresses query answers', async () => {
    const { core } = await setup();
    expect(core.getState().phone).toBeUndefined();
    expect(core.phoneHostForTests().url()).toBeNull();
    expect(await core.command({ type: 'phone.pair' })).toMatchObject({ ok: false });
    expect(await core.query({ type: 'phone.addresses' })).toMatchObject({ ok: true, type: 'phone.addresses' });
    expect(await core.command({ type: 'phone.enable', ip: 'not-an-ip' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await core.command({ type: 'phone.revoke', deviceId: 'nope' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('ending 1 from the phone: Approve resolves the held request by user via phone; a second answer is refused', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    expect(core.getState().phone).toMatchObject({
      enabled: true,
      devices: [expect.objectContaining({ name: 'Test phone' })],
    });
    const stream = openStream(phonePort, token);
    const { sent, requestId } = await held(core, port);
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toEqual([
        expect.objectContaining({ requestId, summary: 'npm view zod version' }),
      ]);
    });
    await vi.waitFor(() => {
      expect(core.getState().phone?.devices[0]?.connected).toBe(true);
    });
    const ok = await phoneCall(phonePort, { path: '/api/decide', token, body: { requestId, decision: 'allow' } });
    expect(ok.status).toBe(200);
    expect(JSON.parse((await sent.done).body)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(ofType(core, MAIN, 'approval.resolved')).toEqual([
      expect.objectContaining({ outcome: 'allowed', by: 'user', via: 'phone', source: 'user' }),
    ]);
    const late = await phoneCall(phonePort, { path: '/api/decide', token, body: { requestId, decision: 'deny' } });
    expect(late.status).toBe(409);
    expect(await core.command({ type: 'approval.decide', requestId, decision: 'allow' })).toMatchObject({
      code: 'expired',
    });
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toEqual([]);
    });
  });

  it('a request whose summary hides part of the command: phone Allow is 400, the hold stays, phone Deny works (AX-01)', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const stream = openStream(phonePort, token);
    const sent = sendHook(
      port,
      payloads.permission({ tool_input: { command: `GITHUB_TOKEN=abc npm view zod version ${'x'.repeat(400)}` } }),
    );
    const requestId = await vi.waitFor(() => {
      const req = ofType(core, MAIN, 'approval.requested')[0];
      if (!req) throw new Error('not yet');
      return req.request.requestId;
    });
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toEqual([expect.objectContaining({ requestId, hidden: true })]);
    });
    const refused = await phoneCall(phonePort, { path: '/api/decide', token, body: { requestId, decision: 'allow' } });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ error: 'Answer this one on the computer.' });
    expect(ofType(core, MAIN, 'approval.resolved')).toEqual([]);
    const denied = await phoneCall(phonePort, { path: '/api/decide', token, body: { requestId, decision: 'deny' } });
    expect(denied.status).toBe(200);
    expect(JSON.parse((await sent.done).body)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
    expect(ofType(core, MAIN, 'approval.resolved')).toEqual([
      expect.objectContaining({ outcome: 'denied', by: 'user', via: 'phone' }),
    ]);
  });

  it('ending 1 from the desktop while a phone watches: the phone sees it go and its late answer is 409', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const stream = openStream(phonePort, token);
    const { sent, requestId } = await held(core, port);
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toHaveLength(1);
    });
    expect(await core.command({ type: 'approval.decide', requestId, decision: 'deny', message: 'no' })).toEqual({
      ok: true,
    });
    await sent.done;
    const resolved = ofType(core, MAIN, 'approval.resolved')[0];
    expect(resolved).toMatchObject({ outcome: 'denied', by: 'user' });
    expect(resolved !== undefined && 'via' in resolved).toBe(false);
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toEqual([]);
    });
    expect(
      (await phoneCall(phonePort, { path: '/api/decide', token, body: { requestId, decision: 'allow' } })).status,
    ).toBe(409);
  });

  it('ending 2 (a rule decides at arrival): nothing is held, the phone never sees it and cannot answer it', async () => {
    const { core, port } = await setup({ settings: { policy: { applyToAttached: true } } });
    const rule: PolicyRule = {
      id: 'npm-view',
      name: 'npm view',
      enabled: true,
      action: 'allow',
      match: { commandPrefix: 'npm view' },
    };
    expect(await core.command({ type: 'policy.upsertRule', rule })).toEqual({ ok: true });
    const { phonePort, token } = await phoneOn(core);
    const stream = openStream(phonePort, token);
    const res = await sendHook(port, payloads.permission()).done;
    expect(JSON.parse(res.body)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    const resolved = ofType(core, MAIN, 'approval.resolved');
    expect(resolved).toEqual([expect.objectContaining({ by: 'policy', policyRuleId: 'npm-view' })]);
    const requestId = resolved[0]?.requestId ?? '';
    await vi.waitFor(() => {
      expect(stream.last()).not.toBeNull();
    });
    expect(approvalsIn(stream.last())).toEqual([]);
    expect(
      (await phoneCall(phonePort, { path: '/api/decide', token, body: { requestId, decision: 'allow' } })).status,
    ).toBe(409);
  });

  it('ending 3 (Claude Code closes the request): answered elsewhere, gone from the phone, a phone answer is 409', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const stream = openStream(phonePort, token);
    const { sent, requestId } = await held(core, port);
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toHaveLength(1);
    });
    sent.abort();
    await sent.done.catch(() => undefined);
    await vi.waitFor(() => {
      expect(ofType(core, MAIN, 'approval.resolved')).toEqual([
        expect.objectContaining({ outcome: 'answered_elsewhere', by: 'claude_code' }),
      ]);
    });
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toEqual([]);
    });
    expect(
      (await phoneCall(phonePort, { path: '/api/decide', token, body: { requestId, decision: 'allow' } })).status,
    ).toBe(409);
  });

  it('ending 4 (the Huddle quits): the hook gets an empty 200, the phone stream ends, both are in the log', async () => {
    const { core, port, dataDir } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const stream = openStream(phonePort, token);
    const { sent } = await held(core, port);
    await vi.waitFor(() => {
      expect(approvalsIn(stream.last())).toHaveLength(1);
    });
    await core.dispose();
    expect(await sent.done).toEqual({ status: 200, body: '' });
    await stream.closed;
    await expect(phoneCall(phonePort, { path: '/api/state', token })).rejects.toThrow();
    const main = await readStoredLog(dataDir, 'session-1');
    expect(main.filter((e) => e.type === 'approval.resolved')).toEqual([
      expect.objectContaining({ outcome: 'passed_through', by: 'shutdown' }),
    ]);
    const phone = await readStoredLog(dataDir, PHONE_SESSION_ID);
    expect(phone.filter((e) => e.type === 'phone.access_changed').map((e) => e.reason)).toEqual(['user', 'shutdown']);
    // Never the token or the pairing code on disk in the log.
    const text = JSON.stringify(phone);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/"code"/);
  });

  it('a renderer cannot claim to be the phone: via on a desktop command is ignored', async () => {
    const { core, port } = await setup();
    const { sent, requestId } = await held(core, port);
    const forged = { type: 'approval.decide', requestId, decision: 'allow', via: 'phone' } as unknown as HuddleCommand;
    expect(await core.command(forged)).toEqual({ ok: true });
    await sent.done;
    const resolved = ofType(core, MAIN, 'approval.resolved')[0];
    expect(resolved !== undefined && 'via' in resolved).toBe(false);
  });

  it('revoke all: the next phone request is 401 and the stream closes; delete all history removes the file', async () => {
    const { core, dataDir } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const stream = openStream(phonePort, token);
    await vi.waitFor(() => {
      expect(stream.last()).not.toBeNull();
    });
    expect(await core.command({ type: 'phone.revoke', deviceId: 'all' })).toMatchObject({ ok: true });
    await stream.closed;
    expect((await phoneCall(phonePort, { path: '/api/state', token })).status).toBe(401);
    expect(core.getState().phone?.devices).toEqual([]);
    // Pair again, then delete all history: the phone is revoked and the file is gone.
    const code = await core.command({ type: 'phone.pair' });
    const pairCode = code.ok ? (code.phonePairing?.code ?? '') : '';
    const again = await phoneCall(phonePort, { path: '/api/pair', body: { code: pairCode, name: 'Second' } });
    const second = JSON.parse(again.body) as { token: string };
    expect(await core.command({ type: 'history.deleteAll', confirm: 'delete' })).toMatchObject({ ok: true });
    expect((await phoneCall(phonePort, { path: '/api/state', token: second.token })).status).toBe(401);
    await expect(fsp.stat(path.join(dataDir, 'phone-devices.json'))).rejects.toThrow();
    expect(core.getState().phone?.devices).toEqual([]);
  });

  it('disable: the listener closes, state says off, and the chosen address is remembered in the settings', async () => {
    const { core } = await setup();
    const { phonePort } = await phoneOn(core);
    expect(await core.command({ type: 'phone.disable' })).toEqual({ ok: true });
    expect(core.getState().phone).toMatchObject({ enabled: false, url: null, reason: 'user' });
    await expect(phoneCall(phonePort, { path: '/' })).rejects.toThrow();
    expect(core.getUserSettings().phone).toEqual({ ip: '127.0.0.1', port: phonePort });
  });
});

describe('HuddleCore phone actions (ADR-030)', () => {
  const act = (phonePort: number, token: string, body: unknown) =>
    phoneCall(phonePort, { path: '/api/act', token, body });

  async function heldQuestion(core: HuddleCore, port: number, questions?: unknown[]) {
    const sent = sendHook(port, payloads.ask('tu-q1', questions));
    await vi.waitFor(() => {
      const q = core.getState().inbox.find((i) => i.kind === 'question' && i.resolvedAt === null);
      if (q === undefined) throw new Error('not yet');
    });
    return sent;
  }

  it('answers a held question by option index: Claude Code gets the label, the log says via phone', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const stream = openStream(phonePort, token);
    const sent = await heldQuestion(core, port);
    await vi.waitFor(() => {
      expect(stream.last()?.inbox.find((i) => i.kind === 'question')).toMatchObject({
        kind: 'question',
        requestId: 'tu-q1',
        answer: { enabled: true, reason: null },
        questions: [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
      });
    });
    // An index past the options, or a missing answer, is refused and the question stays held.
    const bad = await act(phonePort, token, {
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: [{ choices: [5] }],
    });
    expect(bad.status).toBe(400);
    const none = await act(phonePort, token, {
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: [{ choices: [] }],
    });
    expect(none.status).toBe(400);
    const ok = await act(phonePort, token, {
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: [{ choices: [1] }],
    });
    expect(ok.status).toBe(200);
    const reply = JSON.parse((await sent.done).body) as {
      hookSpecificOutput: { updatedInput: { answers: Record<string, string> } };
    };
    expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({ 'Which color?': 'Blue' });
    expect(ofType(core, MAIN, 'question.answered')).toEqual([
      expect.objectContaining({
        requestId: 'tu-q1',
        answers: { 'Which color?': 'Blue' },
        via: 'phone',
        source: 'user',
      }),
    ]);
    // Answered: a second answer is 409, and an unknown question 404.
    const late = await act(phonePort, token, {
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: [{ choices: [0] }],
    });
    expect(late.status).toBe(409);
    const unknown = await act(phonePort, token, {
      type: 'question.answer',
      requestId: 'nope',
      answers: [{ choices: [0] }],
    });
    expect(unknown.status).toBe(404);
  });

  it('answers a multi-select question with choices and a typed answer; the typed words are masked in the log', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const sent = await heldQuestion(core, port, [
      {
        question: 'Which checks?',
        header: 'Checks',
        options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Types' }],
        multiSelect: true,
      },
    ]);
    const typed = 'also e2e with api_key=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const ok = await act(phonePort, token, {
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: [{ choices: [2, 0, 2], other: typed }],
    });
    expect(ok.status).toBe(200);
    const reply = JSON.parse((await sent.done).body) as {
      hookSpecificOutput: { updatedInput: { answers: Record<string, string> } };
    };
    // Option order, no repeats, then the typed words as typed (what the terminal itself sends, S14 b).
    expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({ 'Which checks?': `Lint, Types, ${typed}` });
    const logged = ofType(core, MAIN, 'question.answered')[0];
    expect(logged?.via).toBe('phone');
    expect(JSON.stringify(logged)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('messages an agent at first chance: queued via phone, delivered as a note at the next tool call', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const view = JSON.parse((await phoneCall(phonePort, { path: '/api/state', token })).body) as PhoneView;
    const main = view.sessions[0]?.agents[0];
    expect(main?.controls.message).toEqual({ enabled: true, reason: null });
    expect(main?.messageLands).toBe('after the next tool call or when this turn ends');
    const ok = await act(phonePort, token, { type: 'agent.message', agentKey: MAIN, text: '  use the small model  ' });
    expect(ok.status).toBe(200);
    expect(ofType(core, MAIN, 'message.queued')).toEqual([
      expect.objectContaining({ text: 'use the small model', delivery: 'auto', via: 'phone', source: 'user' }),
    ]);
    const note = await sendHook(port, payloads.preToolUse('tu-1')).done;
    expect(note.body).toContain('use the small model');
    // Not in the phone view: refused before the core's command path.
    const gone = await act(phonePort, token, { type: 'agent.message', agentKey: 'session-9', text: 'hi' });
    expect(gone.status).toBe(404);
  });

  it('pauses and resumes from the phone (control.applied via phone); stop of an attached session is refused with words', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    expect((await act(phonePort, token, { type: 'agent.pause', agentKey: MAIN })).status).toBe(200);
    expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toEqual([
      expect.objectContaining({ via: 'phone', source: 'user' }),
    ]);
    // Pausing: the view says so, and a second pause is refused with the desktop's words.
    const again = await act(phonePort, token, { type: 'agent.pause', agentKey: MAIN });
    expect(again.status).toBe(403);
    expect(JSON.parse(again.body)).toEqual({ error: 'Pausing at the next tool call.' });
    const heldCall = sendHook(port, payloads.preToolUse('tu-2'));
    await vi.waitFor(() => {
      expect(ofType(core, MAIN, 'hold.started')).toHaveLength(1);
    });
    expect((await act(phonePort, token, { type: 'agent.resume', agentKey: MAIN })).status).toBe(200);
    expect((await heldCall.done).status).toBe(200);
    expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'resume')).toEqual([
      expect.objectContaining({ via: 'phone' }),
    ]);
    const stop = await act(phonePort, token, { type: 'agent.stop', agentKey: MAIN });
    expect(stop.status).toBe(403);
    expect((JSON.parse(stop.body) as { error: string }).error).toMatch(/runs Huddle launched/);
    expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'stop')).toEqual([]);
  });

  it('refuses every action type for a target not in the phone view with 404, and reaches nothing', async () => {
    const { core } = await setup();
    const { phonePort, token } = await phoneOn(core);
    const gone = 'session-9';
    const bodies = [
      { type: 'question.answer', requestId: 'tu-none', answers: [{ choices: [0] }] },
      { type: 'agent.message', agentKey: gone, text: 'hi' },
      { type: 'agent.pause', agentKey: gone },
      { type: 'agent.resume', agentKey: gone },
      { type: 'agent.stop', agentKey: gone },
    ];
    for (const body of bodies) {
      const r = await act(phonePort, token, body);
      expect(r.status, body.type).toBe(404);
      expect(JSON.parse(r.body), body.type).toEqual({ error: PHONE_CONTROL_REASONS.notInView });
    }
    expect(ofType(core, MAIN, 'control.applied')).toEqual([]);
    expect(ofType(core, MAIN, 'message.queued')).toEqual([]);
  });

  it('refuses every action type whose control is off (capabilities or state) with 403 and the reason', async () => {
    const { core, port } = await setup();
    const { phonePort, token } = await phoneOn(core);
    // question.answer: two options with one label cannot be told apart, so its answer control is off.
    const sent = sendHook(
      port,
      payloads.ask('tu-same', [
        { question: 'Pick one', header: 'Pick', options: [{ label: 'Same' }, { label: 'Same' }], multiSelect: false },
      ]),
    );
    await vi.waitFor(() => {
      const q = core.getState().inbox.find((i) => i.kind === 'question' && i.resolvedAt === null);
      if (q === undefined) throw new Error('not yet');
    });
    const answer = await act(phonePort, token, {
      type: 'question.answer',
      requestId: 'tu-same',
      answers: [{ choices: [0] }],
    });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toEqual({ error: CONTROL_REASONS.ambiguousChoice });
    expect(ofType(core, MAIN, 'question.answered')).toEqual([]);
    void sent.done.catch(() => undefined); // still held: the Huddle answers it when it quits (ending 4)
    // agent.resume: not paused, so its control is off.
    const resume = await act(phonePort, token, { type: 'agent.resume', agentKey: MAIN });
    expect(resume.status).toBe(403);
    // agent.stop: an attached root the Huddle did not launch has no stop capability.
    const stop = await act(phonePort, token, { type: 'agent.stop', agentKey: MAIN });
    expect(stop.status).toBe(403);
    expect((JSON.parse(stop.body) as { error: string }).error).toMatch(/runs Huddle launched/);
    // A subagent that finished is still shown under its session, with every control off.
    const SUB = agentKey('session-1', 'ag-1');
    expect((await sendHook(port, payloads.subagentStart('ag-1')).done).status).toBe(200);
    expect((await sendHook(port, payloads.subagentStop('ag-1')).done).status).toBe(200);
    for (const body of [
      { type: 'agent.message', agentKey: SUB, text: 'hi' },
      { type: 'agent.pause', agentKey: SUB },
      { type: 'agent.resume', agentKey: SUB },
      { type: 'agent.stop', agentKey: SUB },
    ]) {
      const r = await act(phonePort, token, body);
      expect(r.status, body.type).toBe(403);
      expect(JSON.parse(r.body), body.type).toEqual({ error: CONTROL_REASONS.ended });
    }
    expect(ofType(core, MAIN, 'control.applied')).toEqual([]);
    expect(ofType(core, SUB, 'control.applied')).toEqual([]);
    expect(ofType(core, SUB, 'message.queued')).toEqual([]);
  });

  it('a renderer cannot claim to be the phone: via on a desktop message is ignored', async () => {
    const { core } = await setup();
    const cmd = { type: 'agent.message', agentKey: MAIN, text: 'hi', delivery: 'auto', via: 'phone' };
    expect(await core.command(cmd as unknown as HuddleCommand)).toEqual({ ok: true });
    expect(ofType(core, MAIN, 'message.queued')[0]?.via).toBeUndefined();
  });
});
