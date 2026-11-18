/** Security review M1, finding 10: the hook server holds at most MAX_CONNECTIONS sockets. */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HookServer, MAX_CONNECTIONS } from './hook-server.js';

const sockets: net.Socket[] = [];
let server: HookServer | null = null;
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await server?.close();
  server = null;
});

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      resolve(socket);
    });
    socket.on('error', reject);
    sockets.push(socket);
  });
}

/** Resolves true when the server closes the socket within `ms`, false when it stays open. */
function closedWithin(socket: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed || socket.readableEnded) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    socket.once('end', done);
    socket.once('close', done);
    socket.once('error', done);
  });
}

describe('HookServer connection limit', () => {
  it('is 256', () => {
    expect(MAX_CONNECTIONS).toBe(256);
  });

  it('closes connections over the limit and keeps the ones under it', async () => {
    server = new HookServer({ token: 'test-token-0123456789', port: 0, onHook: () => undefined });
    const { port } = await server.start();
    const held: net.Socket[] = [];
    for (let i = 0; i < MAX_CONNECTIONS; i++) held.push(await connect(port));
    const extra = await connect(port);
    expect(await closedWithin(extra, 1000)).toBe(true);
    expect(await closedWithin(held[0] as net.Socket, 100)).toBe(false);
  });
});
