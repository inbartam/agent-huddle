/** `POST /huddle/statusline` (F9): the same edge rules as the hook routes. */
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readFixture } from '../test/fixtures.js';
import { HookServer, STATUSLINE_PATH, type HookServerOptions } from './hook-server.js';
import type { ParseStatuslineResult } from './statusline-schema.js';

const TOKEN = 'statusline-test-token-0123';

interface Reply {
  status: number;
  body: string;
}

function post(
  port: number,
  body: string | Buffer,
  headers: Record<string, string | number | undefined> = {},
  { method = 'POST', path = STATUSLINE_PATH, host = '127.0.0.1' } = {},
): Promise<Reply> {
  const all: Record<string, string | number | undefined> = {
    'x-huddle-token': TOKEN,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method,
        agent: false,
        // A header given as undefined is left out (to test a missing token).
        headers: Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const servers: HookServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(overrides: Partial<HookServerOptions> = {}) {
  const received: ParseStatuslineResult[] = [];
  const server = new HookServer({
    token: TOKEN,
    port: 0,
    onHook: () => undefined,
    onStatusline: (result) => {
      received.push(result);
    },
    ...overrides,
  });
  servers.push(server);
  const { port, host } = await server.start();
  return { server, port, host, received };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const sample = JSON.stringify(readFixture('statusline-docs-sample.jsonl')[1]?.payload);

describe('POST /huddle/statusline', () => {
  it('binds loopback only', async () => {
    const { host } = await start();
    expect(host).toBe('127.0.0.1');
  });

  it('accepts a valid body with an empty 200, then hands over only the kept fields', async () => {
    const { port, server, received } = await start();
    const reply = await post(port, sample);
    expect(reply).toEqual({ status: 200, body: '' });
    await settle();
    expect(received).toHaveLength(1);
    const first = received[0];
    expect(first?.ok).toBe(true);
    expect(JSON.stringify(first)).not.toContain('transcript_path');
    expect(server.stats().statuslineAccepted).toBe(1);
  });

  it('accepts gzip', async () => {
    const { port, received } = await start();
    const reply = await post(port, gzipSync(sample), { 'content-encoding': 'gzip' });
    expect(reply.status).toBe(200);
    await settle();
    expect(received[0]?.ok).toBe(true);
  });

  it('refuses a request without the token (401) and never calls the handler', async () => {
    const { port, received } = await start();
    expect((await post(port, sample, { 'x-huddle-token': undefined })).status).toBe(401);
    expect((await post(port, sample, { 'x-huddle-token': 'wrong-token-0000000000' })).status).toBe(401);
    await settle();
    expect(received).toHaveLength(0);
  });

  it('refuses any Origin header (403), even with the right token', async () => {
    const { port, received, server } = await start();
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:47821']) {
      expect((await post(port, sample, { origin })).status).toBe(403);
    }
    await settle();
    expect(received).toHaveLength(0);
    expect(server.stats().originRejected).toBe(3);
  });

  it('drops an oversized body like a hook (200, empty, counted) without calling the handler', async () => {
    const { port, received, server } = await start({ maxBodyBytes: 1024 });
    const big = JSON.stringify({ session_id: 's', pad: 'x'.repeat(5000) });
    const reply = await post(port, big);
    expect(reply).toEqual({ status: 200, body: '' });
    await settle();
    expect(received).toHaveLength(0);
    expect(server.stats().oversizedDropped).toBe(1);
  });

  it('answers malformed JSON and non-object bodies with a clean 400 (no echo)', async () => {
    const { port, received, server } = await start();
    const bad = await post(port, '{"session_id": "secret-looking-value"');
    expect(bad.status).toBe(400);
    expect(bad.body).not.toContain('secret-looking-value');
    expect((await post(port, '[1,2]')).status).toBe(400);
    await settle();
    expect(received.map((r) => r.ok)).toEqual([false, false]);
    expect(server.stats().badRequests).toBe(2);
  });

  it('only POST; other paths under /huddle/statusline are not found', async () => {
    const { port } = await start();
    expect((await post(port, '', {}, { method: 'GET' })).status).toBe(405);
    expect((await post(port, sample, {}, { path: '/huddle/statusline/x' })).status).toBe(404);
  });

  it('answers even without a handler, and a throwing handler cannot reach the caller', async () => {
    const errors: unknown[] = [];
    const { port, server } = await start({
      onStatusline: () => {
        throw new Error('boom');
      },
      onHandlerError: (e) => errors.push(e),
    });
    expect((await post(port, sample)).status).toBe(200);
    await settle();
    expect(server.stats().handlerErrors).toBe(1);
    expect(errors).toHaveLength(1);

    const bare = await start({ onStatusline: undefined });
    expect((await post(bare.port, sample)).status).toBe(200);
  });
});
