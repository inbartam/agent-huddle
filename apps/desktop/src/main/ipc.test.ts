import { describe, expect, it, vi } from 'vitest';
import { cannedState, createCannedCore } from './canned-core.js';
import type { CoreHost } from './core-host.js';
import { createIpcHandlers } from './ipc.js';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: {} }));

describe('IPC handlers', () => {
  it('answers invalid commands with code "invalid" and never throws', async () => {
    const core = createCannedCore();
    const run = vi.spyOn(core, 'command');
    const h = createIpcHandlers(core);
    await expect(h.command({ type: 'nope' })).resolves.toMatchObject({ ok: false, code: 'invalid' });
    await expect(h.command(undefined)).resolves.toMatchObject({ ok: false, code: 'invalid' });
    expect(run).not.toHaveBeenCalled();
  });

  it('passes valid commands to the core', async () => {
    const h = createIpcHandlers(createCannedCore());
    await expect(h.command({ type: 'agent.stop', agentKey: 'x' })).resolves.toMatchObject({ ok: true });
  });

  it('turns a core failure into code "failed"', async () => {
    const core: CoreHost = {
      ...createCannedCore(),
      command: () => Promise.reject(new Error('boom')),
      getEvents: () => {
        throw new Error('boom');
      },
    };
    const h = createIpcHandlers(core);
    await expect(h.command({ type: 'all.stop' })).resolves.toMatchObject({ ok: false, code: 'failed' });
    expect(h.getEvents({ agentKey: 'x', limit: 5 })).toEqual([]);
  });

  it('returns [] for bad getEvents args and respects the limit', () => {
    const h = createIpcHandlers(createCannedCore());
    expect(h.getEvents({ agentKey: 'canned-session-0001', limit: 9999 })).toEqual([]);
    expect(h.getEvents({ agentKey: 'canned-session-0001', limit: 1 })).toHaveLength(1);
  });
});

describe('canned core', () => {
  it('is a JSON-safe forest: five sessions, the first with three children and two nested grandchildren', () => {
    const state = cannedState();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.rootKeys).toHaveLength(5);
    const root = state.agents[state.rootKeys[0] ?? ''];
    expect(root?.childKeys).toHaveLength(3);
    const nested = Object.values(state.agents).filter(
      (a) => a.sessionId === root?.sessionId && a.parentKey && a.parentKey !== root.key,
    );
    expect(nested).toHaveLength(2);
    for (const agent of Object.values(state.agents)) {
      for (const child of agent.childKeys) expect(state.agents[child]?.parentKey).toBe(agent.key);
    }
  });

  it('has the M3 samples WP9 builds against', () => {
    const state = cannedState();
    const kinds = state.inbox.map((i) => i.kind).sort();
    expect(kinds).toEqual(['approval', 'file_conflict', 'loop', 'question', 'question', 'stuck']);
    const questions = state.inbox.flatMap((i) => i.question?.questions ?? []);
    expect(questions.map((q) => q.multiSelect).sort()).toEqual([false, true]);
    expect(state.inbox.find((i) => i.kind === 'approval')?.approval?.toolName).toBe('Bash');
    const agents = Object.values(state.agents);
    const paused = agents.find((a) => a.status === 'paused');
    expect(paused?.hold?.limitAt).toBeGreaterThan(paused?.hold?.since ?? Infinity);
    const outbox = agents.flatMap((a) => a.outbox ?? []);
    expect(outbox.map((m) => m.delivery)).toEqual(['next_tool', 'turn_end']);
    for (const i of state.inbox) expect(state.agents[i.agentKey]).toBeDefined();
  });
});
