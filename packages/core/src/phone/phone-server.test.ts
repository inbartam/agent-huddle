/**
 * PhoneServer over real HTTP on 127.0.0.1: the live stream's duplicate-frame guard must never leave a phone that
 * (re)opened a stream on a stale view (A3-01).
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { PhoneView } from '@huddle/shared';
import { PhoneServer } from './phone-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const viewA: PhoneView = { generatedAt: 1, sessions: [], inbox: [] };
const viewB: PhoneView = {
  generatedAt: 2,
  sessions: [],
  inbox: [{ kind: 'notice', id: 'n1', agentKey: 'k', agentName: 'n', title: 't', createdAt: 1 }] as never,
};

function openStream(port: number): Promise<{ text: () => string; close: () => void }> {
  return new Promise((resolve) => {
    let body = '';
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/stream', headers: { authorization: 'Bearer good' } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (d: string) => (body += d));
        resolve({ text: () => body, close: () => req.destroy() });
      },
    );
    req.on('error', () => undefined);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 100));
const viewFrames = (text: string) => text.split('event: view\n').length - 1;

describe('PhoneServer stream view dedupe', () => {
  it('a reopened stream still gets the next change back to an earlier view', async () => {
    let current = viewA;
    const server = new PhoneServer({
      host: '127.0.0.1',
      port: 0,
      now: Date.now,
      staticDir: null,
      authenticate: (t) => (t === 'good' ? { deviceId: 'd1' } : null),
      pair: () => Promise.resolve({ ok: false, status: 403, error: 'no', failedAuth: true }),
      view: () => current,
      decide: () => ({ ok: true }),
      throttleMs: 0,
    });
    const { port } = await server.start();
    cleanups.push(() => server.close());

    const first = await openStream(port); // opens on A
    await settle();
    server.notifyChanged(); // flush records A as sent
    await settle();
    first.close(); // the phone drops
    await settle();

    current = viewB;
    server.notifyChanged(); // no stream open: ignored
    const second = await openStream(port); // opens on B
    await settle();
    cleanups.push(() => {
      second.close();
      return Promise.resolve();
    });
    expect(viewFrames(second.text())).toBe(1);

    current = viewA;
    server.notifyChanged();
    await settle();
    expect(viewFrames(second.text())).toBe(2);
    expect(
      second
        .text()
        .trimEnd()
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .pop(),
    ).toBe(`data: ${JSON.stringify(viewA)}`);
  });
});
