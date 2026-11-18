/**
 * PhoneHost + PhoneServer over real HTTP on 127.0.0.1 (M6, F26). The address rule is replaced (`addressCheck`) so the
 * test can bind loopback; the production rule refuses loopback, 0.0.0.0 and public addresses (last describe block).
 * The auth matrix: every refusal is 401, 403, 413, 415 or 429 and nothing a phone may not see leaves the server.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIP_LIMITS,
  PHONE_IDLE_OFF_MS,
  PHONE_MAX_DEVICES,
  PHONE_OPTIONS_MAX,
  PHONE_PAIR_CODE_TTL_MS,
  PHONE_QUESTIONS_MAX,
  PHONE_TEXT_MAX,
  type CommandResult,
  type EventOfType,
  type HuddleEvent,
  type PhoneAction,
  type PhoneView,
} from '@huddle/shared';
import { readPhoneDevices, writePhoneDevices, type StoredPhoneDevice } from './devices.js';
import { PhoneHost, type PhoneHostDeps } from './phone-host.js';
import { MAX_ACT_BODY_BYTES, MAX_BODY_BYTES, RATE_LIMITS, SECURITY_HEADERS } from './phone-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const VIEW: PhoneView = { generatedAt: 0, sessions: [], inbox: [] };

interface Harness {
  host: PhoneHost;
  port: number;
  events: HuddleEvent[];
  clock: { t: number };
  dataDir: string;
  decided: { requestId: string; decision: string }[];
  setView: (v: PhoneView) => void;
}

async function setup(extra: Partial<PhoneHostDeps> = {}): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-phone-host-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const www = path.join(root, 'www');
  await fsp.mkdir(www);
  await fsp.writeFile(path.join(www, 'index.html'), '<!doctype html><title>Huddle</title>');
  await fsp.writeFile(path.join(root, 'secret.html'), 'secret');
  const dataDir = path.join(root, 'data');
  const events: HuddleEvent[] = [];
  const clock = { t: 1_800_000_000_000 };
  let view = VIEW;
  let id = 0;
  const decided: { requestId: string; decision: string }[] = [];
  const host = new PhoneHost({
    dataDir,
    now: () => clock.t,
    nextId: () => `id-${String((id += 1))}`,
    accept: (batch) => {
      events.push(...batch);
      return Promise.resolve(true);
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    view: () => ({ ...view, generatedAt: clock.t }),
    decide: (requestId, decision): CommandResult => {
      decided.push({ requestId, decision });
      return requestId === 'held' ? { ok: true } : { ok: false, code: 'expired', message: 'gone' };
    },
    saveChoice: () => Promise.resolve(),
    staticDir: www,
    addressCheck: () => null,
    randomInt: () => 123456,
    server: { heartbeatMs: 30, throttleMs: 0 },
    ...extra,
  });
  cleanups.push(() => host.shutdown());
  await host.start();
  const on = await host.enable('127.0.0.1', await freePort());
  if (!on.ok) throw new Error(on.message);
  const port = host.address()?.port ?? 0;
  return { host, port, events, clock, dataDir, decided, setView: (v) => (view = v) };
}

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

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function call(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/api/state',
        agent: false,
        headers: { host: `127.0.0.1:${String(port)}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function pair(h: Harness, name = 'Pixel'): Promise<{ deviceId: string; token: string }> {
  const code = h.host.pair();
  if (!code.ok || code.phonePairing === undefined) throw new Error('no code');
  const res = await call(h.port, { path: '/api/pair', ...json({ code: code.phonePairing.code, name }) });
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as { deviceId: string; token: string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function openStream(port: number, token: string) {
  let text = '';
  let res: http.IncomingMessage | null = null;
  const closed = new Promise<void>((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/stream', agent: false, headers: bearer(token) },
      (r) => {
        res = r;
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', resolve);
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
  return {
    text: () => text,
    status: () => res?.statusCode ?? 0,
    type: () => res?.headers['content-type'],
    closed,
  };
}

function ofType<T extends HuddleEvent['type']>(events: HuddleEvent[], type: T): EventOfType<T>[] {
  return events.filter((e): e is EventOfType<T> => e.type === type);
}

describe('PhoneHost on loopback', () => {
  it('enable announces the url; the state needs a token; security headers on every answer; no CORS', async () => {
    const h = await setup();
    expect(ofType(h.events, 'phone.access_changed')).toEqual([
      expect.objectContaining({
        enabled: true,
        url: `http://127.0.0.1:${String(h.port)}/`,
        reason: 'user',
        source: 'user',
      }),
    ]);
    const res = await call(h.port);
    expect(res.status).toBe(401);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers[k]).toBe(v);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const { token } = await pair(h);
    const ok = await call(h.port, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ...VIEW, generatedAt: h.clock.t });
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('auth matrix: no token, bad token, malformed header, revoked token are 401', async () => {
    const h = await setup();
    const { token, deviceId } = await pair(h);
    expect((await call(h.port)).status).toBe(401);
    expect((await call(h.port, { headers: bearer('x'.repeat(43)) })).status).toBe(401);
    expect((await call(h.port, { headers: { authorization: `Basic ${token}` } })).status).toBe(401);
    expect((await call(h.port, { headers: { authorization: `Bearer ${token} extra` } })).status).toBe(401);
    expect((await call(h.port, { headers: bearer(token) })).status).toBe(200);
    expect(await h.host.revoke({ deviceId })).toMatchObject({ ok: true });
    expect((await call(h.port, { headers: bearer(token) })).status).toBe(401);
    expect(ofType(h.events, 'phone.device_changed').map((e) => e.change)).toEqual(['paired', 'revoked']);
    expect((await readPhoneDevices(h.dataDir)).devices).toEqual([]);
  });

  it('wrong Host and a foreign Origin are 403; its own Origin and no Origin pass', async () => {
    const h = await setup();
    const { token } = await pair(h);
    const own = `127.0.0.1:${String(h.port)}`;
    for (const host of [
      'evil.example',
      `localhost:${String(h.port)}`,
      '127.0.0.1',
      `127.0.0.1:${String(h.port + 1)}`,
    ]) {
      expect((await call(h.port, { headers: { ...bearer(token), host } })).status, host).toBe(403);
    }
    for (const origin of ['http://evil.example', `https://${own}`, `http://localhost:${String(h.port)}`, 'null']) {
      expect((await call(h.port, { headers: { ...bearer(token), origin } })).status, origin).toBe(403);
    }
    expect((await call(h.port, { headers: { ...bearer(token), origin: `http://${own}` } })).status).toBe(200);
    expect((await call(h.port, { headers: bearer(token) })).status).toBe(200);
    // The page is checked the same way.
    expect((await call(h.port, { path: '/', headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('pairing: the code is single use, expires after 2 minutes, dies after 5 wrong tries; tokens never in events', async () => {
    const h = await setup();
    // No code issued.
    expect((await call(h.port, { path: '/api/pair', ...json({ code: '123456', name: 'x' }) })).status).toBe(403);
    // Single use.
    const first = h.host.pair();
    const code = first.ok ? (first.phonePairing?.code ?? '') : '';
    expect(code).toBe('123456');
    const ok = await call(h.port, { path: '/api/pair', ...json({ code, name: 'Pixel' }) });
    expect(ok.status).toBe(200);
    const paired = JSON.parse(ok.body) as { token: string };
    expect((await call(h.port, { path: '/api/pair', ...json({ code, name: 'Again' }) })).status).toBe(403);
    // Expiry.
    h.host.pair();
    h.clock.t += PHONE_PAIR_CODE_TTL_MS;
    expect((await call(h.port, { path: '/api/pair', ...json({ code, name: 'Late' }) })).status).toBe(403);
    // Five wrong tries void it (a fresh host: the pairing rate limit allows 5 per address).
    const g = await setup();
    g.host.pair();
    for (let i = 0; i < 5; i++) {
      expect((await call(g.port, { path: '/api/pair', ...json({ code: '000000', name: 'x' }) })).status).toBe(401);
    }
    // The right code now finds no code in force (time moves on only enough to refill the pairing rate limit).
    g.clock.t += 13_000;
    expect((await call(g.port, { path: '/api/pair', ...json({ code: '123456', name: 'x' }) })).status).toBe(403);
    // Never a token, a hash or a code in an event.
    const all = JSON.stringify([...h.events, ...g.events]);
    expect(all).not.toContain(paired.token);
    expect(all).not.toContain('123456');
    expect(all).not.toContain('tokenHash');
  });

  it('pairing refuses bad bodies: not JSON 415, too big 413, wrong shape 400, wrong method 405', async () => {
    const h = await setup();
    h.host.pair();
    const pairPath = { path: '/api/pair' };
    expect(
      (await call(h.port, { ...pairPath, method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))
        .status,
    ).toBe(415);
    expect((await call(h.port, { ...pairPath, ...json({ code: '123456', name: 'x'.repeat(5000) }) })).status).toBe(413);
    expect((await call(h.port, { ...pairPath, ...json({ code: '12345', name: 'x' }) })).status).toBe(400);
    expect((await call(h.port, { ...pairPath, method: 'GET' })).status).toBe(405);
  });

  it('rate limit: a flood of bad tokens from one address turns into 429 for that address', async () => {
    const h = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await call(h.port, { headers: bearer('y'.repeat(43)) })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    // It recovers with time.
    h.clock.t += 60_000;
    expect((await call(h.port)).status).toBe(401);
  });

  it('decide: only allow or deny, through the consumer; a late answer is 409', async () => {
    const h = await setup();
    const { token } = await pair(h);
    const post = (body: unknown) =>
      call(h.port, { path: '/api/decide', ...json(body), headers: { ...json(body).headers, ...bearer(token) } });
    expect((await post({ requestId: 'held', decision: 'allow' })).status).toBe(200);
    expect((await post({ requestId: 'gone', decision: 'deny' })).status).toBe(409);
    expect((await post({ requestId: 'held', decision: 'maybe' })).status).toBe(400);
    expect((await post({ requestId: 'held', decision: 'allow', message: 'run rm -rf' })).status).toBe(200);
    expect(h.decided).toEqual([
      { requestId: 'held', decision: 'allow' },
      { requestId: 'gone', decision: 'deny' },
      { requestId: 'held', decision: 'allow' },
    ]);
    // Without a token nothing reaches the consumer.
    expect(
      (await call(h.port, { path: '/api/decide', ...json({ requestId: 'held', decision: 'allow' }) })).status,
    ).toBe(401);
    expect(h.decided).toHaveLength(3);
    // No other action exists.
    for (const p of ['/api/message', '/api/pause', '/api/stop', '/api/answer', '/api/launch', '/api/rules']) {
      expect(
        (await call(h.port, { path: p, ...json({}), headers: { ...json({}).headers, ...bearer(token) } })).status,
        p,
      ).toBe(404);
    }
  });

  it('stream: a phone that stops reading is cut off once its unsent backlog passes the cap', async () => {
    const h = await setup({ server: { heartbeatMs: 60_000, throttleMs: 0, streamBufferBytes: 64 * 1024 } });
    const { token } = await pair(h);
    let received = false;
    const req = http.get(
      { host: '127.0.0.1', port: h.port, path: '/api/stream', agent: false, headers: bearer(token) },
      (r) => {
        received = true;
        r.pause(); // never reads: everything the server writes piles up (and the FIN is never seen here)
      },
    );
    req.on('error', () => undefined);
    cleanups.push(() => {
      req.destroy();
      return Promise.resolve();
    });
    const changes = () => ofType(h.events, 'phone.device_changed').map((e) => e.change);
    await vi.waitFor(() => {
      expect(received).toBe(true);
      expect(changes()).toContain('connected');
    });
    const big = 'x'.repeat(200);
    // The server is the judge: it ends the stream (the device's last stream closed: 'disconnected').
    for (let i = 0; i < 2000 && !changes().includes('disconnected'); i++) {
      h.setView({
        generatedAt: 0,
        sessions: [],
        inbox: Array.from({ length: 250 }, (_, j) => ({
          kind: 'stuck' as const,
          id: `stuck:${String(i)}-${String(j)}`,
          agentKey: 'k',
          agentName: 'main',
          title: big,
          createdAt: 1,
        })),
      });
      h.host.notifyChanged();
      await new Promise((r) => setImmediate(r));
    }
    expect(changes()).toContain('disconnected');
  }, 30_000);

  it('stream: one view larger than the cap does not cut a phone that reads', async () => {
    const h = await setup({ server: { heartbeatMs: 60_000, throttleMs: 0, streamBufferBytes: 1024 } });
    const { token } = await pair(h);
    const s = openStream(h.port, token);
    const changes = () => ofType(h.events, 'phone.device_changed').map((e) => e.change);
    await vi.waitFor(() => {
      expect(s.text()).toContain('event: view');
      expect(changes()).toContain('connected');
    });
    for (let i = 0; i < 3; i++) {
      const title = `big view ${String(i)} ${'x'.repeat(8000)}`; // one frame, about 8x the cap
      h.setView({
        generatedAt: 0,
        sessions: [],
        inbox: [{ kind: 'stuck', id: `stuck:${String(i)}`, agentKey: 'k', agentName: 'main', title, createdAt: 1 }],
      });
      h.host.notifyChanged();
      await vi.waitFor(() => {
        expect(s.text()).toContain(`big view ${String(i)} `);
      });
    }
    expect(changes()).not.toContain('disconnected');
  });

  it('stream: text/event-stream with the view, a heartbeat and changes; revoke closes it at once', async () => {
    const h = await setup();
    const { token, deviceId } = await pair(h);
    const s = openStream(h.port, token);
    await vi.waitFor(() => {
      expect(s.text()).toContain('event: view');
      expect(s.text()).toContain(': heartbeat');
    });
    expect(s.type()).toBe('text/event-stream; charset=utf-8');
    await vi.waitFor(() => {
      expect(ofType(h.events, 'phone.device_changed').map((e) => e.change)).toContain('connected');
    });
    h.setView({
      generatedAt: 0,
      sessions: [],
      inbox: [
        { kind: 'stuck', id: 'stuck:x', agentKey: 'k', agentName: 'main', title: 'main looks stuck', createdAt: 1 },
      ],
    });
    h.host.notifyChanged();
    await vi.waitFor(() => {
      expect(s.text()).toContain('main looks stuck');
    });
    await h.host.revoke({ deviceId });
    await s.closed;
    expect((await call(h.port, { path: '/api/stream', headers: bearer(token) })).status).toBe(401);
  });

  it('static: serves the page without a token, refuses traversal and other files', async () => {
    const h = await setup();
    const page = await call(h.port, { path: '/' });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    for (const p of [
      '/../secret.html',
      '/%2e%2e/secret.html',
      '/..%2fsecret.html',
      '/..\\secret.html',
      '/secret.html',
      '/index.html/..',
    ]) {
      expect((await call(h.port, { path: p })).status, p).toBe(404);
    }
    expect((await call(h.port, { path: '/', method: 'POST' })).status).toBe(405);
  });

  it('a plain refresh or a stream does not count as use; it still updates last seen (owner, 2026-11-16)', async () => {
    const h = await setup();
    const { token } = await pair(h);
    h.clock.t += PHONE_IDLE_OFF_MS - 10;
    expect((await call(h.port, { headers: bearer(token) })).status).toBe(200);
    const s = openStream(h.port, token);
    await vi.waitFor(() => {
      expect(s.text()).toContain('event: view');
    });
    h.clock.t += 10;
    h.host.check();
    await vi.waitFor(() => {
      expect(h.host.url()).toBeNull();
    });
    expect(ofType(h.events, 'phone.access_changed').at(-1)).toMatchObject({ enabled: false, reason: 'idle' });
  });

  it('a refused Allow or Deny (late, or malformed) does not count as use; an accepted one does', async () => {
    const h = await setup();
    const { token } = await pair(h);
    const post = (body: unknown) =>
      call(h.port, { path: '/api/decide', ...json(body), headers: { ...json(body).headers, ...bearer(token) } });
    h.clock.t += PHONE_IDLE_OFF_MS - 1000;
    expect((await post({ requestId: 'gone', decision: 'deny' })).status).toBe(409);
    expect((await post({ requestId: 'held', decision: 'maybe' })).status).toBe(400);
    h.clock.t += 2000;
    h.host.check();
    await vi.waitFor(() => {
      expect(h.host.url()).toBeNull();
    });

    const h2 = await setup();
    const paired = await pair(h2);
    h2.clock.t += PHONE_IDLE_OFF_MS - 1000;
    const ok = await call(h2.port, {
      path: '/api/decide',
      ...json({ requestId: 'held', decision: 'allow' }),
      headers: { ...json({ requestId: 'held', decision: 'allow' }).headers, ...bearer(paired.token) },
    });
    expect(ok.status).toBe(200);
    h2.clock.t += 2000;
    h2.host.check();
    expect(h2.host.url()).not.toBeNull();
  });

  it('auto-off after 8 h without a phone action: closed, nothing listens, and the event says idle', async () => {
    const h = await setup();
    const { token } = await pair(h);
    h.clock.t += PHONE_IDLE_OFF_MS - 1;
    // A fresh page open is an action (as are pairing, Allow and Deny).
    expect((await call(h.port, { path: '/api/state?open=1', headers: bearer(token) })).status).toBe(200);
    h.clock.t += PHONE_IDLE_OFF_MS - 1;
    h.host.check();
    expect(h.host.url()).not.toBeNull();
    h.clock.t += 1;
    h.host.check();
    await vi.waitFor(() => {
      expect(h.host.url()).toBeNull();
    });
    expect(ofType(h.events, 'phone.access_changed').at(-1)).toMatchObject({
      enabled: false,
      reason: 'idle',
      source: 'huddle',
    });
    await expect(call(h.port)).rejects.toThrow();
  });

  it('disable: nothing listens, the code is gone, streams end; enable again works', async () => {
    const h = await setup();
    const { token } = await pair(h);
    const s = openStream(h.port, token);
    await vi.waitFor(() => {
      expect(s.text()).toContain('event: view');
    });
    expect(await h.host.disable()).toEqual({ ok: true });
    await s.closed;
    await expect(call(h.port)).rejects.toThrow();
    expect(h.host.pair()).toMatchObject({ ok: false });
    const changes = h.events.filter((e) => e.type === 'phone.device_changed' || e.type === 'phone.access_changed');
    expect(changes.map((e) => (e.type === 'phone.device_changed' ? e.change : `access:${String(e.enabled)}`))).toEqual([
      'access:true',
      'paired',
      'connected',
      'disconnected',
      'access:false',
    ]);
    const again = await h.host.enable('127.0.0.1', h.port);
    expect(again).toMatchObject({ ok: true });
    expect((await call(h.port, { headers: bearer(token) })).status).toBe(200);
  });

  it('a restart announces the paired phones as known, and their tokens still work', async () => {
    const h = await setup();
    const { token, deviceId } = await pair(h, 'Old phone');
    await h.host.shutdown();
    const again = await setup({ dataDir: h.dataDir });
    expect(ofType(again.events, 'phone.device_changed')[0]).toMatchObject({
      deviceId,
      name: 'Old phone',
      change: 'known',
    });
    expect((await call(again.port, { headers: bearer(token) })).status).toBe(200);
  });

  it('retention revokes phones not seen for that many days; delete all removes the file', async () => {
    const h = await setup();
    const a = await pair(h, 'A');
    h.clock.t += 40 * 86_400_000;
    const b = await pair(h, 'B');
    expect((await call(h.port, { headers: bearer(b.token) })).status).toBe(200);
    expect(await h.host.retention(30)).toBe(1);
    expect(h.host.deviceIds()).toEqual([b.deviceId]);
    expect((await call(h.port, { headers: bearer(a.token) })).status).toBe(401);
    expect(await h.host.deleteAll()).toBe(1);
    await expect(fsp.stat(path.join(h.dataDir, 'phone-devices.json'))).rejects.toThrow();
    expect(
      ofType(h.events, 'phone.device_changed')
        .filter((e) => e.change === 'revoked')
        .map((e) => e.reason),
    ).toEqual(['retention', 'delete_all']);
  });

  it(`refuses a pairing code past ${String(PHONE_MAX_DEVICES)} phones`, async () => {
    const h = await setup();
    for (let i = 0; i < PHONE_MAX_DEVICES; i++) {
      h.clock.t += 13_000; // the pairing rate limit refills one try every 12 s
      await pair(h, `P${String(i)}`);
    }
    expect(h.host.pair()).toMatchObject({ ok: false });
  });
});

describe('PhoneHost actions (ADR-030): the explicit allowlist on POST /api/act', () => {
  async function withAct(answer: (a: PhoneAction) => CommandResult = () => ({ ok: true })) {
    const acted: PhoneAction[] = [];
    const h = await setup({
      act: (action) => {
        acted.push(action);
        return Promise.resolve(answer(action));
      },
    });
    const { token } = await pair(h);
    const post = (body: unknown, headers: Record<string, string> = bearer(token)) =>
      call(h.port, { path: '/api/act', ...json(body), headers: { ...json(body).headers, ...headers } });
    return { h, acted, post, token };
  }

  it('runs each allowed action through the consumer, built field by field (extra fields never pass)', async () => {
    const { acted, post } = await withAct();
    const bodies = [
      { type: 'question.answer', requestId: 'tu-1', answers: [{ choices: [1], other: 'teal', extra: 1 }], x: 'y' },
      { type: 'agent.message', agentKey: 'session-1', text: 'please stop after this', delivery: 'turn_end' },
      { type: 'agent.pause', agentKey: 'session-1', all: true },
      { type: 'agent.resume', agentKey: 'session-1' },
      { type: 'agent.stop', agentKey: 'session-1', force: true },
    ];
    for (const b of bodies) expect((await post(b)).status, b.type).toBe(200);
    expect(acted).toEqual([
      { type: 'question.answer', requestId: 'tu-1', answers: [{ choices: [1], other: 'teal' }] },
      { type: 'agent.message', agentKey: 'session-1', text: 'please stop after this' },
      { type: 'agent.pause', agentKey: 'session-1' },
      { type: 'agent.resume', agentKey: 'session-1' },
      { type: 'agent.stop', agentKey: 'session-1' },
    ]);
  });

  it('refuses a command not on the list with 403 and a wrong shape with 400; neither reaches the core', async () => {
    const { h, acted, post } = await withAct();
    for (const type of [
      'run.launch',
      'all.stop',
      'all.pause',
      'agent.setModel',
      'agent.rename',
      'approval.decide',
      'approval.allowAllMatchingPolicy',
      'policy.upsertRule',
      'budget.set',
      'settings.update',
      'history.deleteAll',
      'huddle.ask',
      'phone.revoke',
      'message.cancel',
      'setup.attach',
    ]) {
      expect((await post({ type, agentKey: 'session-1' })).status, type).toBe(403);
    }
    expect((await post(['agent.pause'])).status).toBe(403);
    expect((await post({ agentKey: 'session-1' })).status).toBe(403);
    // Refused attempts spend the action bucket too; let it refill.
    h.clock.t += 60_000;
    for (const bad of [
      { type: 'agent.pause' },
      { type: 'agent.message', agentKey: 'session-1', text: '' },
      { type: 'agent.message', agentKey: 'session-1', text: 'x'.repeat(PHONE_TEXT_MAX + 1) },
      { type: 'agent.message', agentKey: 'k'.repeat(400), text: 'hi' },
      { type: 'question.answer', requestId: 'tu-1', answers: [] },
      { type: 'question.answer', requestId: 'tu-1', answers: [{ choices: [-1] }] },
      { type: 'question.answer', requestId: 'tu-1', answers: [{ choices: [1.5] }] },
      { type: 'question.answer', requestId: 'tu-1', answers: [{ choices: ['Red'] }] },
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect(acted).toEqual([]);
  });

  it('keeps the auth and origin rules: no token, a revoked token and a foreign origin never reach the core', async () => {
    const { h, acted, post, token } = await withAct();
    const body = { type: 'agent.pause', agentKey: 'session-1' };
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(body, { ...bearer(token), origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(body, { ...bearer(token), origin: `http://127.0.0.1:${String(h.port)}` })).status).toBe(200);
    const notJson = await call(h.port, {
      path: '/api/act',
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      body: JSON.stringify(body),
    });
    expect(notJson.status).toBe(415);
    expect((await call(h.port, { path: '/api/act', headers: bearer(token) })).status).toBe(405);
    await h.host.revoke({ all: true });
    expect((await post(body)).status).toBe(401);
    expect(acted).toHaveLength(1);
  });

  it("answers with the core's words: unsupported 403, not found 404, expired 409, invalid 400", async () => {
    const answers: Record<string, CommandResult> = {
      a: { ok: false, code: 'unsupported', message: "This agent can't be paused from Huddle." },
      b: { ok: false, code: 'not_found', message: 'That is not on this phone any more.' },
      c: { ok: false, code: 'expired', message: "This agent isn't paused." },
      d: { ok: false, code: 'invalid', message: 'The message is empty.' },
      e: { ok: true, detail: 'Already paused.' },
    };
    const { post } = await withAct(
      (a) => (a.type === 'question.answer' ? undefined : answers[a.agentKey]) ?? { ok: true },
    );
    const result = async (key: string) => {
      const r = await post({ type: 'agent.pause', agentKey: key });
      return { status: r.status, body: JSON.parse(r.body) as unknown };
    };
    expect(await result('a')).toEqual({ status: 403, body: { error: "This agent can't be paused from Huddle." } });
    expect(await result('b')).toEqual({ status: 404, body: { error: 'That is not on this phone any more.' } });
    expect(await result('c')).toEqual({ status: 409, body: { error: "This agent isn't paused." } });
    expect(await result('d')).toEqual({ status: 400, body: { error: 'The message is empty.' } });
    expect(await result('e')).toEqual({ status: 200, body: { ok: true, detail: 'Already paused.' } });
  });

  it('accepts the largest valid answer (every question with the longest, worst-escaped text); past it is 413', async () => {
    const { acted, post } = await withAct();
    // A control character is the worst case on the wire: JSON writes it as \u0001, 6 bytes per character.
    const other = '\u0001'.repeat(PHONE_TEXT_MAX);
    const answers = Array.from({ length: PHONE_QUESTIONS_MAX }, () => ({
      choices: Array.from({ length: PHONE_OPTIONS_MAX }, (_, i) => i),
      other,
    }));
    const biggest = { type: 'question.answer', requestId: 'r'.repeat(CLIP_LIMITS.id), answers };
    expect(JSON.stringify(biggest).length).toBeGreaterThan(MAX_BODY_BYTES);
    expect((await post(biggest)).status).toBe(200);
    expect(acted).toHaveLength(1);
    // A body past the /api/act limit is still refused before it is parsed.
    expect(
      (await post({ type: 'agent.resume', agentKey: 'session-1', pad: 'x'.repeat(MAX_ACT_BODY_BYTES) })).status,
    ).toBe(413);
    expect(acted).toHaveLength(1);
  });

  it('keeps the 4 KiB limit on the other routes', async () => {
    const { h, token } = await withAct();
    const body = { requestId: 'r1', decision: 'allow', pad: 'x'.repeat(MAX_BODY_BYTES) };
    const res = await call(h.port, {
      path: '/api/decide',
      ...json(body),
      headers: { ...json(body).headers, ...bearer(token) },
    });
    expect(res.status).toBe(413);
  });

  it('has its own rate limit: a burst of actions turns into 429', async () => {
    const { post } = await withAct();
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMITS.act.capacity + 2; i++) {
      statuses.push((await post({ type: 'agent.resume', agentKey: 'session-1' })).status);
    }
    expect(statuses.slice(0, RATE_LIMITS.act.capacity).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('an action counts as use for the 8-hour auto-off', async () => {
    const { h, post } = await withAct();
    h.clock.t += PHONE_IDLE_OFF_MS - 1000;
    expect((await post({ type: 'agent.resume', agentKey: 'session-1' })).status).toBe(200);
    h.clock.t += 2000;
    h.host.check();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.host.url()).not.toBeNull();
  });

  it('a refused action (403, 400, a core refusal, 429) does not count as use for the auto-off', async () => {
    const { h, acted, post } = await withAct(() => ({ ok: false, code: 'not_found', message: 'gone' }));
    h.clock.t += PHONE_IDLE_OFF_MS - 1000;
    expect((await post({ type: 'run.launch', agentKey: 'session-1' })).status).toBe(403);
    expect((await post({ type: 'agent.pause' })).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMITS.act.capacity; i++) {
      statuses.push((await post({ type: 'agent.resume', agentKey: 'gone' })).status);
    }
    expect(statuses).toContain(404);
    expect(statuses.at(-1)).toBe(429);
    expect(acted.length).toBeGreaterThan(0);
    h.clock.t += 2000;
    h.host.check();
    await vi.waitFor(() => {
      expect(h.host.url()).toBeNull();
    });
    expect(ofType(h.events, 'phone.access_changed').at(-1)).toMatchObject({ enabled: false, reason: 'idle' });
  });

  it('without an action consumer the route does not exist', async () => {
    const h = await setup();
    const { token } = await pair(h);
    const body = { type: 'agent.pause', agentKey: 'session-1' };
    const res = await call(h.port, {
      path: '/api/act',
      ...json(body),
      headers: { ...json(body).headers, ...bearer(token) },
    });
    expect(res.status).toBe(404);
  });
});

describe('PhoneHost address rule (production)', () => {
  it('refuses loopback, any address, public addresses and ports out of range; nothing listens', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-phone-rule-'));
    cleanups.push(() => fsp.rm(root, { recursive: true, force: true }));
    const host = new PhoneHost({
      dataDir: root,
      now: () => 0,
      nextId: () => 'x',
      accept: () => Promise.resolve(true),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      view: () => VIEW,
      decide: () => ({ ok: true }),
      saveChoice: () => Promise.resolve(),
      interfaces: () => ({
        'Wi-Fi': [
          { address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
        ],
      }),
    });
    cleanups.push(() => host.shutdown());
    for (const ip of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '192.168.1.99', '::1']) {
      expect(await host.enable(ip, 47835), ip).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await host.enable('192.168.1.23', 80)).toMatchObject({ ok: false, code: 'invalid' });
    expect(host.url()).toBeNull();
    expect(host.addresses()).toEqual([{ ip: '192.168.1.23', interfaceName: 'Wi-Fi' }]);
    expect(host.pair()).toMatchObject({ ok: false });
  });
});

/**
 * A phone-devices.json writer that can be held: `arm()` makes the next write wait (after taking its list) until
 * `release()`, so a test can revoke while a pairing write is in flight (security review, M6).
 */
function holdableWriter() {
  let armed: { enter: () => void; wait: Promise<void> } | null = null;
  const write = async (dataDir: string, devices: readonly StoredPhoneDevice[]): Promise<void> => {
    const hold = armed;
    armed = null;
    if (hold !== null) {
      hold.enter();
      await hold.wait;
    }
    await writePhoneDevices(dataDir, devices);
  };
  const arm = () => {
    let enter: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const wait = new Promise<void>((resolve) => (release = resolve));
    armed = { enter, wait };
    return { entered, release };
  };
  return { write, arm };
}

describe('PhoneHost: a revoke while a pairing is being saved is never undone', () => {
  const cases: {
    name: string;
    act: (h: Harness, oldId: string) => Promise<unknown>;
    reason: string;
  }[] = [
    { name: 'revoke one phone', act: (h, id) => h.host.revoke({ deviceId: id }), reason: 'user' },
    { name: 'revoke all', act: (h) => h.host.revoke({ all: true }), reason: 'user' },
    { name: 'delete all history', act: (h) => h.host.deleteAll(), reason: 'delete_all' },
    { name: 'retention', act: (h) => h.host.retention(30), reason: 'retention' },
  ];

  for (const c of cases) {
    it(`${c.name} during a pairing write: the old token is 401 now and after a restart; the new phone is kept`, async () => {
      const writer = holdableWriter();
      const h = await setup({ writeDevices: writer.write });
      const old = await pair(h, 'Old');
      h.clock.t += 40 * 86_400_000; // old enough for retention; also refills the pairing rate limit
      const issued = h.host.pair();
      if (!issued.ok || issued.phonePairing === undefined) throw new Error('no code');
      const held = writer.arm();
      const pairing = call(h.port, { path: '/api/pair', ...json({ code: issued.phonePairing.code, name: 'New' }) });
      await held.entered; // the pairing write has taken its list (with Old in it) and waits

      const acted = c.act(h, old.deviceId);
      // In force at once, before any write finishes.
      expect((await call(h.port, { headers: bearer(old.token) })).status).toBe(401);
      held.release();

      const res = await pairing;
      expect(res.status).toBe(200);
      const fresh = JSON.parse(res.body) as { deviceId: string; token: string };
      // By the time the pairing answers, the file no longer lists the revoked phone.
      expect((await readPhoneDevices(h.dataDir)).devices.map((d) => d.deviceId)).toEqual([fresh.deviceId]);
      await acted;

      expect(h.host.deviceIds()).toEqual([fresh.deviceId]);
      expect((await call(h.port, { headers: bearer(old.token) })).status).toBe(401);
      expect((await call(h.port, { headers: bearer(fresh.token) })).status).toBe(200);
      const onDisk = (await readPhoneDevices(h.dataDir)).devices;
      expect(onDisk.map((d) => d.deviceId)).toEqual([fresh.deviceId]);
      expect(JSON.stringify(onDisk)).not.toContain(old.deviceId);
      expect(
        ofType(h.events, 'phone.device_changed')
          .filter((e) => e.change === 'revoked')
          .map((e) => [e.deviceId, e.reason]),
      ).toEqual([[old.deviceId, c.reason]]);

      // A restart reads the file: the revoked phone stays revoked, the new one still works.
      await h.host.shutdown();
      const again = await setup({ dataDir: h.dataDir });
      expect(again.host.deviceIds()).toEqual([fresh.deviceId]);
      expect((await call(again.port, { headers: bearer(old.token) })).status).toBe(401);
      expect((await call(again.port, { headers: bearer(fresh.token) })).status).toBe(200);
    });
  }
});
