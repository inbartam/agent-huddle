/**
 * Sandboxed preload (CommonJS, see electron.vite.config.ts). Exposes exactly the five HuddleBridge
 * functions. ipcRenderer itself is never exposed, and the event listener hands the renderer only the
 * batch, not the Electron event object (which would leak `sender`).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type CommandResult, type HuddleEvent, type HuddleState, type QueryResult } from '@huddle/shared';
import { BRIDGE_KEY, type HuddleBridge } from './api.js';

const bridge: HuddleBridge = {
  command: (cmd) => ipcRenderer.invoke(IPC.command, cmd) as Promise<CommandResult>,
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<HuddleState>,
  getEvents: (agentKey, limit) => ipcRenderer.invoke(IPC.getEvents, { agentKey, limit }) as Promise<HuddleEvent[]>,
  onEvents(listener) {
    const handler = (_event: IpcRendererEvent, batch: HuddleEvent[]): void => {
      listener(batch);
    };
    ipcRenderer.on(IPC.events, handler);
    return () => {
      ipcRenderer.removeListener(IPC.events, handler);
    };
  },
  query: (q) => ipcRenderer.invoke(IPC.query, q) as Promise<QueryResult>,
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
