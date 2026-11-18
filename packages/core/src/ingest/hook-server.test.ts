import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { listFixtureFiles, readFixture } from '../test/fixtures.js';
import { HookServer, PortInUseError, type HookServerOptions } from './hook-server.js';
import type { ParseHookResult } from './schemas.js';

const TOKEN = 'test-token-0123456789';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface PostOptions {
  port: number;
  path: string;
  body?: string | Buffer;
  headers?: http.OutgoingHttpHeaders;
  method?: string;
  agent?: http.Agent;
  /** Send the body in chunked encoding (no content-length). */
  chunked?: boolean;
  /** Send no X-Huddle-Token header at all. */
  noToken?: boolean;
}

function request(options: PostOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const headers: http.OutgoingHttpHeaders = { 'x-huddle-token': TOKEN, 'content-type': 'application/json' };
    if (!options.chunked) headers['content-length'] = Buffer.byteLength(body);
    if (options.noToken) delete headers['x-huddle-token'];
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'POST',
        agent: options.agent ?? false,
        headers: { ...headers, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function hookLines(): { event: string; payload: unknown }[] {
  const lines: { event: string; payload: unknown }[] = [];
  for (const file of listFixtureFiles()) {
    for (const line of readFixture(file)) {
      if (line.kind === 'hook' && line.event !== null) lines.push({ event: line.event, payload: line.payload });
    }
  }
  return lines;
}

const servers: HookServer[] = [];

async function startServer(overrides: Partial<HookServerOptions> = {}): Promise<{ server: HookServer; port: number }> {
  const server = new HookServer({ token: TOKEN, port: 0, onHook: () => undefined, ...overrides });
  servers.push(server);
  const { port } = await server.start();
  return { server, port };
}

/** Lets setImmediate-dispatched handlers run. */
function nextTicks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const minimalHook = JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' });

describe('HookServer: listener and access', () => {
  it('binds only to 127.0.0.1', async () => {
    const { server, port } = await startServer();
    expect(server.address()).toEqual({ host: '127.0.0.1', port });
  });

  it('refuses to construct without a token', () => {
    expect(() => new HookServer({ token: '', onHook: () => undefined })).toThrow(/token/);
  });

  it('answers 401 to a missing or wrong token', async () => {
    const { server, port } = await startServer();
    const missing = await request({ port, path: '/huddle/hooks/Stop', body: minimalHook, noToken: true });
    const wrong = await request({
      port,
      path: '/huddle/hooks/Stop',
      body: minimalHook,
      headers: { 'x-huddle-token': 'nope' },
    });
    const longer = await request({
      port,
      path: '/huddle/hooks/Stop',
      body: minimalHook,
      headers: { 'x-huddle-token': TOKEN + 'x' },
    });
    for (const reply of [missing, wrong, longer]) {
      expect(reply.status).toBe(401);
      const parsed: unknown = JSON.parse(reply.body);
      expect(parsed).toEqual({ error: 'missing or wrong X-Huddle-Token header' });
    }
    expect(server.stats().unauthorized).toBe(3);
  });

  it('answers 403 to any request with an Origin header, even with the right token', async () => {
    const calls: ParseHookResult[] = [];
    const { server, port } = await startServer({ onHook: (r) => void calls.push(r) });
    const reply = await request({
      port,
      path: '/huddle/hooks/Stop',
      body: minimalHook,
      headers: { origin: 'http://evil.example' },
    });
    expect(reply.status).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    await nextTicks();
    expect(calls).toHaveLength(0);
    expect(server.stats().originRejected).toBe(1);
  });

  it('answers 404 to an unknown route and 405 to a non-POST on a known route', async () => {
    const { port } = await startServer();
    expect((await request({ port, path: '/nope', body: '{}' })).status).toBe(404);
    expect((await request({ port, path: '/huddle/state', method: 'GET' })).status).toBe(404);
    const get = await request({ port, path: '/huddle/hooks/Stop', method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
  });
});

describe('HookServer: hook route', () => {
  it('answers every fixture hook line with an empty 200 and passes ok results to onHook', async () => {
    const lines = hookLines();
    expect(lines.length).toBeGreaterThan(0);
    const calls: { result: ParseHookResult; receivedAt: number }[] = [];
    const { port } = await startServer({
      now: () => 1234,
      onHook: (result, receivedAt) => void calls.push({ result, receivedAt }),
    });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const line of lines) {
        const reply = await request({
          port,
          path: `/huddle/hooks/${line.event}`,
          body: JSON.stringify(line.payload),
          agent,
        });
        expect(reply.status, line.event).toBe(200);
        expect(reply.body).toBe('');
      }
    } finally {
      agent.destroy();
    }
    await nextTicks();
    expect(calls).toHaveLength(lines.length);
    for (const [index, call] of calls.entries()) {
      expect(call.result.ok).toBe(true);
      expect(call.receivedAt).toBe(1234);
      if (call.result.ok) expect(call.result.payload.hook_event_name).toBe(lines[index]?.event);
    }
  });

  it('answers malformed JSON with a clean 400 {error}: no stack, no echo of the body', async () => {
    const calls: ParseHookResult[] = [];
    const { server, port } = await startServer({ onHook: (r) => void calls.push(r) });
    const reply = await request({ port, path: '/huddle/hooks/Stop', body: '{"secret-value": ' });
    expect(reply.status).toBe(400);
    const parsed: unknown = JSON.parse(reply.body);
    expect(parsed).toEqual({ error: 'body is not valid JSON' });
    expect(reply.body).not.toContain('secret-value');
    expect(reply.body).not.toMatch(/at .*\.(ts|js)/);
    await nextTicks();
    expect(calls).toEqual([{ ok: false, error: 'body is not valid JSON' }]);
    expect(server.stats().badRequests).toBe(1);
  });

  it('answers a payload that fails validation with 400 {error} without echoing values', async () => {
    const { port } = await startServer();
    const reply = await request({
      port,
      path: '/huddle/hooks/Stop',
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 12345678 }),
    });
    expect(reply.status).toBe(400);
    const parsed = JSON.parse(reply.body) as { error: string };
    expect(Object.keys(parsed)).toEqual(['error']);
    expect(parsed.error).toContain('session_id');
    expect(reply.body).not.toContain('12345678');
  });

  it('answers a PermissionRequest with an invalid session_id at once with 400, counted, never held or decided', async () => {
    let decided = 0;
    const { server, port } = await startServer({
      decideHook: () => {
        decided += 1;
        return { hold: () => undefined };
      },
    });
    const reply = await request({
      port,
      path: '/huddle/hooks/PermissionRequest',
      body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: '../x', tool_name: 'Bash' }),
    });
    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain('../x');
    await nextTicks();
    expect(decided).toBe(0);
    expect(server.stats().badRequests).toBe(1);
    expect(server.stats().hooksAccepted).toBe(0);
  });

  it('drops an oversized body: 200 with an empty body, counted, onHook not called', async () => {
    const calls: ParseHookResult[] = [];
    const { server, port } = await startServer({ maxBodyBytes: 1024, onHook: (r) => void calls.push(r) });
    const big = JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', pad: 'x'.repeat(4096) });
    const declared = await request({ port, path: '/huddle/hooks/Stop', body: big });
    const chunked = await request({ port, path: '/huddle/hooks/Stop', body: big, chunked: true });
    for (const reply of [declared, chunked]) {
      expect(reply.status).toBe(200);
      expect(reply.body).toBe('');
    }
    await nextTicks();
    expect(calls).toHaveLength(0);
    expect(server.stats().oversizedDropped).toBe(2);
  });

  it('drops a gzip body that inflates past the limit', async () => {
    const { server, port } = await startServer({ maxBodyBytes: 1024 });
    const big = gzipSync(JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', pad: 'x'.repeat(10_000) }));
    expect(big.length).toBeLessThan(1024);
    const reply = await request({
      port,
      path: '/huddle/hooks/Stop',
      body: big,
      headers: { 'content-encoding': 'gzip' },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('');
    expect(server.stats().oversizedDropped).toBe(1);
  });

  it('accepts a gzip hook body', async () => {
    const calls: ParseHookResult[] = [];
    const { port } = await startServer({ onHook: (r) => void calls.push(r) });
    const reply = await request({
      port,
      path: '/huddle/hooks/Stop',
      body: gzipSync(minimalHook),
      headers: { 'content-encoding': 'gzip' },
    });
    expect(reply.status).toBe(200);
    await nextTicks();
    expect(calls[0]?.ok).toBe(true);
  });

  it('answers before a slow onHook finishes', async () => {
    let finished = false;
    const { port } = await startServer({
      onHook: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        finished = true;
      },
    });
    const started = performance.now();
    const reply = await request({ port, path: '/huddle/hooks/Stop', body: minimalHook });
    const elapsed = performance.now() - started;
    expect(reply.status).toBe(200);
    expect(elapsed).toBeLessThan(100);
    expect(finished).toBe(false);
  });

  it('answers 200 when onHook throws or rejects, and counts the errors', async () => {
    const reported: unknown[] = [];
    let call = 0;
    const { server, port } = await startServer({
      onHook: () => {
        call += 1;
        if (call === 1) throw new Error('sync boom');
        return Promise.reject(new Error('async boom'));
      },
      onHandlerError: (error) => reported.push(error),
    });
    expect((await request({ port, path: '/huddle/hooks/Stop', body: minimalHook })).status).toBe(200);
    expect((await request({ port, path: '/huddle/hooks/Stop', body: minimalHook })).status).toBe(200);
    await nextTicks();
    expect(server.stats().handlerErrors).toBe(2);
    expect(reported).toHaveLength(2);
  });
});

describe('HookServer: telemetry routes', () => {
  it('hands /v1/logs JSON to onTelemetryLogs after answering 200 {}', async () => {
    const received: { body: unknown; at: number }[] = [];
    const { port } = await startServer({
      now: () => 99,
      onTelemetryLogs: (body, at) => void received.push({ body, at }),
    });
    const doc = { resourceLogs: [] };
    const reply = await request({ port, path: '/v1/logs', body: JSON.stringify(doc) });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({});
    await nextTicks();
    expect(received).toEqual([{ body: doc, at: 99 }]);
  });

  it('answers /v1/logs with bad JSON as 400', async () => {
    const { port } = await startServer();
    expect((await request({ port, path: '/v1/logs', body: 'nope' })).status).toBe(400);
  });

  it('accepts and discards /v1/metrics and /v1/traces', async () => {
    const received: unknown[] = [];
    const { port } = await startServer({ onTelemetryLogs: (b) => void received.push(b) });
    expect((await request({ port, path: '/v1/metrics', body: '{"resourceMetrics":[]}' })).status).toBe(200);
    expect((await request({ port, path: '/v1/traces', body: 'not even json' })).status).toBe(200);
    await nextTicks();
    expect(received).toHaveLength(0);
  });
});

describe('HookServer: lifecycle', () => {
  it('rejects start() with PortInUseError naming the port when it is taken', async () => {
    const { port } = await startServer();
    const second = new HookServer({ token: TOKEN, port, onHook: () => undefined });
    servers.push(second);
    const error: unknown = await second.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortInUseError);
    expect((error as PortInUseError).port).toBe(port);
    expect((error as PortInUseError).message).toContain(String(port));
    expect((error as PortInUseError).message).toContain('another Agent Huddle');
  });

  it('close() resolves promptly with an idle keep-alive connection open', async () => {
    const { server, port } = await startServer({ closeTimeoutMs: 10_000 });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const reply = await request({ port, path: '/huddle/hooks/Stop', body: minimalHook, agent });
      expect(reply.headers.connection).toBe('keep-alive');
      const started = performance.now();
      await server.close();
      expect(performance.now() - started).toBeLessThan(1000);
      expect(server.address()).toBeNull();
    } finally {
      agent.destroy();
    }
  });

  it('close() lets an in-flight request finish and get its answer', async () => {
    const { server, port } = await startServer({ closeTimeoutMs: 10_000 });
    const body = Buffer.from(minimalHook);
    const replied = new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/huddle/hooks/Stop',
          method: 'POST',
          agent: false,
          headers: { 'x-huddle-token': TOKEN, 'content-length': body.length },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() });
          });
        },
      );
      req.on('error', reject);
      // Send half the body now, the rest after close() has started.
      req.write(body.subarray(0, 10));
      setTimeout(() => {
        void server.close();
        setTimeout(() => req.end(body.subarray(10)), 50);
      }, 50);
    });
    const reply = await replied;
    expect(reply.status).toBe(200);
    expect(reply.headers.connection).toBe('close');
    await server.close();
  });

  it('cannot be started twice', async () => {
    const { server } = await startServer();
    await expect(server.start()).rejects.toThrow(/cannot start/);
  });
});

describe('HookServer: latency budget (ARCHITECTURE.md §9)', () => {
  it('answers 1,000 fixture POSTs over keep-alive with p99 under 20 ms', async () => {
    const lines = hookLines().map((line) => ({
      path: `/huddle/hooks/${line.event}`,
      body: JSON.stringify(line.payload),
    }));
    let handled = 0;
    const { port } = await startServer({ onHook: () => void (handled += 1) });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const timings: number[] = [];
    try {
      // Warm-up: JIT and the first socket.
      for (let i = 0; i < 50; i++) {
        const line = lines[i % lines.length];
        if (line) await request({ port, path: line.path, body: line.body, agent });
      }
      for (let i = 0; i < 1000; i++) {
        const line = lines[i % lines.length];
        if (!line) continue;
        const started = performance.now();
        const reply = await request({ port, path: line.path, body: line.body, agent });
        timings.push(performance.now() - started);
        expect(reply.status).toBe(200);
      }
    } finally {
      agent.destroy();
    }
    timings.sort((a, b) => a - b);
    const pick = (q: number) => timings[Math.min(timings.length - 1, Math.floor(q * timings.length))] ?? Number.NaN;
    const p50 = pick(0.5);
    const p99 = pick(0.99);
    const max = timings[timings.length - 1] ?? Number.NaN;
    console.log(
      `[hook-server benchmark] n=${String(timings.length)} p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
    );
    expect(timings).toHaveLength(1000);
    expect(p99).toBeLessThan(20);
    await nextTicks();
    expect(handled).toBe(1050);
  }, 60_000);
});
