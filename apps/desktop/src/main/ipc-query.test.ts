/**
 * WP7b: the fifth invoke, `huddle:query` (ADR-020), and main's part of `run.openWorktree`. The OS side (dialog, shell)
 * is stubbed through SystemActions; system-actions.test.ts covers the path checks and the vscode:// URL.
 */
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { ASK_HISTORY_ANSWER_MAX, IPC, type CommandResult } from '@huddle/shared';
import { createCannedCore } from './canned-core.js';
import type { CoreHost } from './core-host.js';
import { createIpcHandlers, registerIpc, type IpcMainLike } from './ipc.js';
import type { SystemActions } from './system-actions.js';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }, ipcMain: {} }));

const rule = { id: 'r1', name: 'ls', enabled: true, action: 'allow', match: { commandPrefix: 'ls' } };

function system(over: Partial<SystemActions> = {}): SystemActions {
  return {
    pickFolder: vi.fn(() => Promise.resolve('C:\\chosen')),
    openWorktree: vi.fn(() => Promise.resolve({ ok: true as const, detail: 'Sent to VS Code.' })),
    openReport: vi.fn(() => Promise.resolve({ ok: true as const })),
    copyReportPath: vi.fn((p: string) => Promise.resolve({ ok: true as const, detail: p })),
    copyText: vi.fn(() => Promise.resolve({ ok: true as const })),
    ...over,
  };
}

describe('huddle:query handler', () => {
  it('rejects anything that is not a known query shape, without asking the core or the system', async () => {
    const core = createCannedCore();
    const ask = vi.spyOn(core, 'query');
    const sys = system();
    const h = createIpcHandlers(core, sys);
    const bad: unknown[] = [
      undefined,
      null,
      'pick.folder',
      { type: 'fs.read', path: 'C:\\x' },
      { type: 'policy.preview' },
      { type: 'policy.preview', rule: { id: 'r1' } },
      { type: 'pick.folder', defaultPath: 42 },
    ];
    for (const payload of bad) {
      await expect(h.query(payload, null)).resolves.toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(ask).not.toHaveBeenCalled();
    expect(sys.pickFolder).not.toHaveBeenCalled();
  });

  it('pick.folder opens the (stubbed) dialog for the asking window and returns the folder, or null on cancel', async () => {
    const sys = system();
    const owner = {} as never;
    const h = createIpcHandlers(createCannedCore(), sys);
    await expect(h.query({ type: 'pick.folder', defaultPath: 'C:\\projects' }, owner)).resolves.toEqual({
      ok: true,
      type: 'pick.folder',
      path: 'C:\\chosen',
    });
    expect(sys.pickFolder).toHaveBeenCalledWith('C:\\projects', owner);

    const cancelled = createIpcHandlers(createCannedCore(), system({ pickFolder: () => Promise.resolve(null) }));
    await expect(cancelled.query({ type: 'pick.folder' }, null)).resolves.toEqual({
      ok: true,
      type: 'pick.folder',
      path: null,
    });
    const broken = createIpcHandlers(
      createCannedCore(),
      system({ pickFolder: () => Promise.reject(new Error('no dialog')) }),
    );
    await expect(broken.query({ type: 'pick.folder' }, null)).resolves.toMatchObject({ ok: false, code: 'failed' });
  });

  it('policy.preview is forwarded to the core after parsing, and a core failure is "failed"', async () => {
    const core = createCannedCore();
    const ask = vi.spyOn(core, 'query');
    const h = createIpcHandlers(core, system());
    const r = await h.query({ type: 'policy.preview', rule }, null);
    expect(ask).toHaveBeenCalledWith({ type: 'policy.preview', rule });
    expect(r).toMatchObject({ ok: true, type: 'policy.preview', preview: { approximate: true } });

    const failing: CoreHost = { ...createCannedCore(), query: () => Promise.reject(new Error('boom')) };
    await expect(createIpcHandlers(failing).query({ type: 'policy.preview', rule }, null)).resolves.toMatchObject({
      ok: false,
      code: 'failed',
    });
  });
});

describe('registerIpc', () => {
  function fakeIpc() {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    };
    return { ipc, handlers };
  }
  const APP = 'http://localhost:5173/';
  const from = (url: string | undefined) =>
    ({ senderFrame: url === undefined ? null : { url }, sender: {} }) as unknown as IpcMainInvokeEvent;

  it('registers the query channel next to the other three invokes and removes all four', () => {
    const { ipc, handlers } = fakeIpc();
    const off = registerIpc(createCannedCore(), () => APP, { ipc, windows: () => [] });
    expect([...handlers.keys()].sort()).toEqual([IPC.command, IPC.getEvents, IPC.getState, IPC.query].sort());
    off();
    expect(handlers.size).toBe(0);
  });

  it('answers a query only from the app window, and passes the asking window to the folder picker', async () => {
    const { ipc, handlers } = fakeIpc();
    const pickFolder = vi.fn(() => Promise.resolve('C:\\chosen'));
    const owner = { id: 7 } as never;
    registerIpc(createCannedCore(), () => APP, {
      ipc,
      windows: () => [],
      windowOf: () => owner,
      system: system({ pickFolder }),
    });
    const query = handlers.get(IPC.query);
    if (!query) throw new Error('no query handler');
    for (const url of [
      'https://evil.example/',
      'file:///C:/elsewhere/index.html',
      'http://localhost:6666/',
      undefined,
    ]) {
      await expect(query(from(url), { type: 'pick.folder' })).resolves.toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(pickFolder).not.toHaveBeenCalled();
    await expect(query(from(`${APP}?view=main`), { type: 'pick.folder' })).resolves.toEqual({
      ok: true,
      type: 'pick.folder',
      path: 'C:\\chosen',
    });
    expect(pickFolder).toHaveBeenCalledWith(undefined, owner);
  });
});

describe('run.openWorktree in main', () => {
  const RUN_PATH = 'C:\\Users\\dev\\AppData\\Local\\agent-huddle\\worktrees\\run-canned-0001';
  const cmd = { type: 'run.openWorktree', runId: 'run-canned-0001' };

  it('asks the core first, then opens the folder the core named in detail (the WP6 shape)', async () => {
    const sys = system();
    const named = 'C:\\Users\\me\\AppData\\Local\\agent-huddle\\worktrees\\run-canned-0001';
    const core: CoreHost = {
      ...createCannedCore(),
      // HuddleCore answers { ok: true, detail: <worktree folder> } after checking its registry (runs.ts).
      command: () => Promise.resolve({ ok: true, detail: named } satisfies CommandResult),
    };
    await expect(createIpcHandlers(core, sys).command(cmd)).resolves.toEqual({
      ok: true,
      detail: 'Sent to VS Code.',
    });
    expect(sys.openWorktree).toHaveBeenCalledWith(named);
  });

  it('opens nothing when the core refuses', async () => {
    const sys = system();
    // The canned core answers run.openWorktree `unsupported` (sample data has no folder).
    await expect(createIpcHandlers(createCannedCore(), sys).command(cmd)).resolves.toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(sys.openWorktree).not.toHaveBeenCalled();
  });

  it("uses the run's worktree in state when the core's answer has no path, and says so when there is none", async () => {
    const sys = system();
    const core: CoreHost = { ...createCannedCore(), command: () => Promise.resolve({ ok: true }) };
    const h = createIpcHandlers(core, sys);
    await h.command(cmd);
    expect(sys.openWorktree).toHaveBeenCalledWith(RUN_PATH);
    await expect(h.command({ type: 'run.openWorktree', runId: 'run-unknown' })).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('report.openFile and report.copyPath in main (M5)', () => {
  const FILE = 'C:\\Users\\me\\AppData\\Roaming\\agent-huddle\\reports\\sess-1.md';

  it('asks the core for the file by session id, then opens or copies what it named', async () => {
    const sys = system();
    const core: CoreHost = {
      ...createCannedCore(),
      command: () => Promise.resolve({ ok: true, detail: FILE } satisfies CommandResult),
    };
    const h = createIpcHandlers(core, sys);
    await expect(h.command({ type: 'report.openFile', sessionId: 'sess-1' })).resolves.toEqual({ ok: true });
    expect(sys.openReport).toHaveBeenCalledWith(FILE);
    await expect(h.command({ type: 'report.copyPath', sessionId: 'sess-1' })).resolves.toEqual({
      ok: true,
      detail: FILE,
    });
    expect(sys.copyReportPath).toHaveBeenCalledWith(FILE);
  });

  it('opens and copies nothing when the core refuses or names no file', async () => {
    const sys = system();
    const refusing: CoreHost = {
      ...createCannedCore(),
      command: () => Promise.resolve({ ok: false, code: 'not_found', message: 'gone' } satisfies CommandResult),
    };
    await expect(
      createIpcHandlers(refusing, sys).command({ type: 'report.openFile', sessionId: 'sess-1' }),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
    const silent: CoreHost = { ...createCannedCore(), command: () => Promise.resolve({ ok: true }) };
    await expect(
      createIpcHandlers(silent, sys).command({ type: 'report.copyPath', sessionId: 'sess-1' }),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
    expect(sys.openReport).not.toHaveBeenCalled();
    expect(sys.copyReportPath).not.toHaveBeenCalled();
  });

  it('never takes a path from the renderer: a command with one is refused by validation', async () => {
    const sys = system();
    const h = createIpcHandlers(createCannedCore(), sys);
    await expect(h.command({ type: 'report.openFile', sessionId: '../x' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(sys.openReport).not.toHaveBeenCalled();
  });
});

describe('ask.copyAnswer in main (the clipboard goes through main, not the renderer)', () => {
  it('copies the text through the system, clipped, without asking the core', async () => {
    const sys = system();
    const core = createCannedCore();
    const run = vi.spyOn(core, 'command');
    const h = createIpcHandlers(core, sys);
    await expect(h.command({ type: 'ask.copyAnswer', text: 'an answer' })).resolves.toEqual({ ok: true });
    expect(sys.copyText).toHaveBeenCalledWith('an answer');
    await h.command({ type: 'ask.copyAnswer', text: 'x'.repeat(ASK_HISTORY_ANSWER_MAX * 3) });
    expect(vi.mocked(sys.copyText).mock.calls[1]?.[0]).toHaveLength(ASK_HISTORY_ANSWER_MAX);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a wrong shape without touching the clipboard', async () => {
    const sys = system();
    const h = createIpcHandlers(createCannedCore(), sys);
    for (const bad of [
      { type: 'ask.copyAnswer' },
      { type: 'ask.copyAnswer', text: '' },
      { type: 'ask.copyAnswer', text: 5 },
    ]) {
      await expect(h.command(bad)).resolves.toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(sys.copyText).not.toHaveBeenCalled();
  });
});
