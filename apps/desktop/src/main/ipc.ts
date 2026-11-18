/**
 * The IPC channels: four from ADR-015 and the read-only `huddle:query` from ADR-020. Handlers validate every payload
 * with zod and never throw to the renderer: bad input gets `{ ok: false, code: 'invalid' }` or an empty list.
 *
 * Some answers need the operating system and are main's own (system-actions.ts): `pick.folder` opens the system
 * folder picker, `run.openWorktree` opens the worktree the core names, after main checks it is one of the Huddle's
 * own worktree folders, and `report.openFile` / `report.copyPath` (M5) open or copy the report file the core names
 * for the run, after main checks it is a report file inside the Huddle's reports folder.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  ASK_HISTORY_ANSWER_MAX,
  EMPTY_STATE,
  IPC,
  type CommandResult,
  type HuddleEvent,
  type HuddleState,
  type QueryResult,
} from '@huddle/shared';
import type { CoreHost } from './core-host.js';
import { isTrustedSender } from './security.js';
import { worktreePathFor, type SystemActions } from './system-actions.js';
import { parseCommand, parseGetEventsArgs, parseQuery } from './validate.js';

export interface IpcHandlers {
  command(payload: unknown): Promise<CommandResult>;
  getState(): HuddleState;
  getEvents(payload: unknown): HuddleEvent[];
  /** `owner`: the window that asked (the folder picker is parented to it), or null. */
  query(payload: unknown, owner: BrowserWindow | null): Promise<QueryResult>;
}

/** Without system actions (tests, or a host that has none) the OS-backed answers say so instead of failing. */
const NO_SYSTEM: SystemActions = {
  pickFolder: () => Promise.reject(new Error('no system actions')),
  openWorktree: () => Promise.resolve({ ok: false, code: 'unsupported', message: 'This Huddle cannot open folders.' }),
  openReport: () => Promise.resolve({ ok: false, code: 'unsupported', message: 'This Huddle cannot open files.' }),
  copyReportPath: () =>
    Promise.resolve({ ok: false, code: 'unsupported', message: 'This Huddle cannot use the clipboard.' }),
  copyText: () => Promise.resolve({ ok: false, code: 'unsupported', message: 'This Huddle cannot use the clipboard.' }),
};

/** Electron-free handler logic, so it can be unit-tested. */
export function createIpcHandlers(core: CoreHost, system: SystemActions = NO_SYSTEM): IpcHandlers {
  return {
    async command(payload) {
      const cmd = parseCommand(payload);
      if (!cmd) return { ok: false, code: 'invalid', message: 'Command rejected: unknown type or wrong shape.' };
      // Copy answer: the clipboard is main's; the core has nothing to do with it. Clip, then copy.
      if (cmd.type === 'ask.copyAnswer') return system.copyText(cmd.text.slice(0, ASK_HISTORY_ANSWER_MAX));
      try {
        const result = await core.command(cmd);
        if (!result.ok) return result;
        // M5: the core resolved the run's report file (only inside its reports folder); main opens or copies it.
        if (cmd.type === 'report.openFile' || cmd.type === 'report.copyPath') {
          const file = result.detail;
          if (typeof file !== 'string' || file === '') {
            return { ok: false, code: 'not_found', message: "Huddle doesn't know this run's report file." };
          }
          return cmd.type === 'report.openFile' ? await system.openReport(file) : await system.copyReportPath(file);
        }
        if (cmd.type !== 'run.openWorktree') return result;
        // The core checked the run and its worktree; main opens it, and only if it is a Huddle worktree folder.
        const folder = worktreePathFor(result, core.getState(), cmd.runId);
        if (folder === null) {
          return { ok: false, code: 'not_found', message: "Huddle doesn't know this run's worktree folder." };
        }
        return await system.openWorktree(folder);
      } catch {
        return { ok: false, code: 'failed', message: 'The core failed to run this command.' };
      }
    },
    getState: () => core.getState(),
    getEvents(payload) {
      const args = parseGetEventsArgs(payload);
      if (!args) return [];
      try {
        return core.getEvents(args.agentKey, args.limit);
      } catch {
        return [];
      }
    },
    async query(payload, owner) {
      const q = parseQuery(payload);
      if (!q) return { ok: false, code: 'invalid', message: 'Query rejected: unknown type or wrong shape.' };
      if (q.type === 'pick.folder') {
        try {
          return { ok: true, type: 'pick.folder', path: await system.pickFolder(q.defaultPath, owner) };
        } catch {
          return { ok: false, code: 'failed', message: "The folder picker didn't open." };
        }
      }
      try {
        return await core.query(q);
      } catch {
        return { ok: false, code: 'failed', message: 'The core failed to answer this question.' };
      }
    },
  };
}

const UNTRUSTED: CommandResult = { ok: false, code: 'invalid', message: 'Sender is not the Huddle window.' };
const UNTRUSTED_QUERY: QueryResult = { ok: false, code: 'invalid', message: 'Sender is not the Huddle window.' };

/** `ipcMain` as used here (injected so registration is testable without Electron). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface RegisterIpcOptions {
  system?: SystemActions;
  ipc?: IpcMainLike;
  /** The window that sent a message (BrowserWindow.fromWebContents in the app). */
  windowOf?: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  /** Every window to push event batches to. */
  windows?: () => BrowserWindow[];
}

/**
 * Register the invoke handlers and start pushing event batches to every window.
 * Returns a function that unregisters everything.
 */
export function registerIpc(core: CoreHost, appUrl: () => string, options: RegisterIpcOptions = {}): () => void {
  const handlers = createIpcHandlers(core, options.system);
  const ipc = options.ipc ?? ipcMain;
  const windowOf = options.windowOf ?? ((e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender));
  const windows = options.windows ?? (() => BrowserWindow.getAllWindows());
  const trusted = (e: IpcMainInvokeEvent) => isTrustedSender(e.senderFrame?.url, appUrl());

  ipc.handle(IPC.command, (e, payload: unknown) => (trusted(e) ? handlers.command(payload) : UNTRUSTED));
  // getState, getEvents and query are read-only, but agent text is still private: same sender check.
  ipc.handle(IPC.getState, (e) => (trusted(e) ? handlers.getState() : EMPTY_STATE));
  ipc.handle(IPC.getEvents, (e, payload: unknown) => (trusted(e) ? handlers.getEvents(payload) : []));
  ipc.handle(IPC.query, (e, payload: unknown) =>
    trusted(e) ? handlers.query(payload, windowOf(e)) : Promise.resolve(UNTRUSTED_QUERY),
  );

  // One layer batches: the core already sends at most one batch per 100 ms (HuddleCore `batchIntervalMs`),
  // so main forwards each batch as it comes. An empty batch means "connection changed, read the state again".
  const unsubscribe = core.onEvents((batch) => {
    for (const win of windows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.events, batch);
    }
  });

  return () => {
    unsubscribe();
    ipc.removeHandler(IPC.command);
    ipc.removeHandler(IPC.getState);
    ipc.removeHandler(IPC.getEvents);
    ipc.removeHandler(IPC.query);
  };
}
