import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IPC } from '@huddle/shared';

// Capture what the preload hands to contextBridge, without Electron.
const exposed = new Map<string, unknown>();
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const invoke = vi.fn((..._args: unknown[]) => Promise.resolve('ok'));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api),
  },
  ipcRenderer: {
    invoke,
    on: (channel: string, fn: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(fn);
      listeners.set(channel, set);
    },
    removeListener: (channel: string, fn: (...args: unknown[]) => void) => listeners.get(channel)?.delete(fn),
  },
}));

type Api = Record<string, (...args: unknown[]) => unknown>;
let api: Api;

beforeAll(async () => {
  await import('./index.js');
  api = exposed.get('huddle') as Api;
});

describe('preload bridge', () => {
  it('exposes exactly one global, `huddle`', () => {
    expect([...exposed.keys()]).toEqual(['huddle']);
  });

  it('exposes exactly the five functions and nothing else', () => {
    expect(Object.keys(api).sort()).toEqual(['command', 'getEvents', 'getState', 'onEvents', 'query']);
    for (const value of Object.values(api)) expect(typeof value).toBe('function');
  });

  it('maps each function to its IPC channel', async () => {
    await api.command?.({ type: 'all.pause' });
    expect(invoke).toHaveBeenLastCalledWith(IPC.command, { type: 'all.pause' });
    await api.getState?.();
    expect(invoke).toHaveBeenLastCalledWith(IPC.getState);
    await api.getEvents?.('s1', 50);
    expect(invoke).toHaveBeenLastCalledWith(IPC.getEvents, { agentKey: 's1', limit: 50 });
    await api.query?.({ type: 'pick.folder' });
    expect(invoke).toHaveBeenLastCalledWith(IPC.query, { type: 'pick.folder' });
  });

  it('onEvents passes only the batch (no Electron event) and unsubscribes', () => {
    const seen: unknown[][] = [];
    const off = api.onEvents?.((...args: unknown[]) => seen.push(args)) as () => void;
    const fakeSenderEvent = { sender: { send: () => undefined } };
    for (const fn of listeners.get(IPC.events) ?? []) fn(fakeSenderEvent, [{ id: 'e1' }]);
    expect(seen).toEqual([[[{ id: 'e1' }]]]);
    off();
    expect(listeners.get(IPC.events)?.size).toBe(0);
  });
});
