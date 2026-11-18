/**
 * The renderer's one store. It holds the latest HuddleState from the core and the optimistic
 * renames the user typed, and nothing else about agents (components read through selectors).
 *
 * Data flow (WP10): getState() on start; after every pushed event batch (at most one per 100 ms)
 * getState() again. Refreshes never overlap: a batch that lands mid-refresh schedules exactly one more.
 */
import { useSyncExternalStore } from 'react';
import {
  selectAgentLabel,
  type AgentKey,
  type CommandResult,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';
import type { HuddleBridge } from '../../preload/api.js';
import { bridgeQuery, type QueryFn } from './query.js';

export interface Snapshot {
  state: HuddleState | null;
  /** What went wrong talking to the core, in words for the user. */
  error: string | null;
  /** Names the user just typed, shown until the core's state carries them (or the core refuses). */
  renames: ReadonlyMap<AgentKey, string>;
}

export const CORE_UNREACHABLE = "Huddle can't reach its core. Quit Huddle from the tray and start it again.";

type BatchListener = (batch: readonly HuddleEvent[]) => void;

export class HuddleStore {
  private snap: Snapshot = { state: null, error: null, renames: new Map() };
  private readonly listeners = new Set<() => void>();
  private readonly batchListeners = new Set<BatchListener>();
  private inflight = false;
  private again = false;
  private stopEvents: (() => void) | null = null;

  /** The read-only `huddle:query` (M4), or null while this build's preload has none (query.ts). */
  readonly query: QueryFn | null;

  constructor(private readonly bridge: HuddleBridge) {
    this.query = bridgeQuery(bridge);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): Snapshot => this.snap;

  /** Start listening. Returns a stop function (safe to call twice, e.g. under StrictMode). */
  start(): () => void {
    if (!this.stopEvents) {
      this.stopEvents = this.bridge.onEvents((batch) => {
        void this.refresh();
        for (const l of this.batchListeners) l(batch);
      });
      void this.refresh();
    }
    return () => {
      this.stopEvents?.();
      this.stopEvents = null;
    };
  }

  /** Called with every event batch, after the state refresh is requested (timelines use this). */
  onBatch(listener: BatchListener): () => void {
    this.batchListeners.add(listener);
    return () => this.batchListeners.delete(listener);
  }

  getEvents(agentKey: AgentKey, limit: number): Promise<HuddleEvent[]> {
    return this.bridge.getEvents(agentKey, limit);
  }

  async refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return;
    }
    this.inflight = true;
    try {
      do {
        this.again = false;
        try {
          const state = await this.bridge.getState();
          this.set({ state, error: null, renames: settleRenames(this.snap.renames, state) });
        } catch {
          this.set({ ...this.snap, error: CORE_UNREACHABLE });
        }
      } while (this.refreshRequested());
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Rename an agent: show the new name at once, send `agent.rename`, and put the old name back if the
   * core says no. Returns the core's answer so the caller can show why.
   */
  async rename(agentKey: AgentKey, name: string): Promise<CommandResult> {
    const previous = this.snap.renames.get(agentKey);
    this.setRename(agentKey, name);
    let result: CommandResult;
    try {
      result = await this.bridge.command({ type: 'agent.rename', agentKey, name });
    } catch {
      result = { ok: false, code: 'failed', message: CORE_UNREACHABLE };
    }
    if (!result.ok && this.snap.renames.get(agentKey) === name) this.setRename(agentKey, previous);
    return result;
  }

  /**
   * The user pressed Connect on the first-run screen (ADR-017). Sends `setup.attach`, then reads the state
   * again so the screen shows the result at once (on `expired`, the refreshed change).
   */
  async attach(): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await this.bridge.command({ type: 'setup.attach' });
    } catch {
      result = { ok: false, code: 'failed', message: CORE_UNREACHABLE };
    }
    await this.refresh();
    return result;
  }

  /**
   * Send any command (M3: inbox, composer, pause, settings) and read the state again, so a card reflects the result
   * without waiting for the next event batch. Never throws: a failed bridge reads as CORE_UNREACHABLE.
   */
  async command(cmd: HuddleCommand): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await this.bridge.command(cmd);
    } catch {
      result = { ok: false, code: 'failed', message: CORE_UNREACHABLE };
    }
    void this.refresh();
    return result;
  }

  /** Read through a method so the loop sees writes made by batches during the await. */
  private refreshRequested(): boolean {
    return this.again;
  }

  private setRename(agentKey: AgentKey, name: string | undefined): void {
    const renames = new Map(this.snap.renames);
    if (name === undefined) renames.delete(agentKey);
    else renames.set(agentKey, name);
    this.set({ ...this.snap, renames });
  }

  private set(next: Snapshot): void {
    this.snap = next;
    for (const l of this.listeners) l();
  }
}

/** Drop optimistic names the core has caught up with. */
function settleRenames(renames: ReadonlyMap<AgentKey, string>, state: HuddleState): ReadonlyMap<AgentKey, string> {
  if (renames.size === 0) return renames;
  const next = new Map(renames);
  for (const [key, name] of renames) {
    const agent = state.agents[key];
    if (!agent || agent.name === name) next.delete(key);
  }
  return next.size === renames.size ? renames : next;
}

/** The name to show: the user's pending rename, else the core's name. */
export function displayName(agent: { key: AgentKey; name: string }, renames: ReadonlyMap<AgentKey, string>): string {
  return renames.get(agent.key) ?? agent.name;
}

/**
 * The name to show wherever one string names an agent: a main agent's session label (nickname or session title, else
 * its project folder, plus a start time when two sessions would read the same; selectSessionIdentity), a subagent's
 * pending rename or name.
 */
export function agentLabel(
  state: HuddleState,
  agent: { key: AgentKey; name: string },
  renames: ReadonlyMap<AgentKey, string>,
): string {
  return selectAgentLabel(state, agent.key, { renames }) ?? displayName(agent, renames);
}

export function useSnapshot(store: HuddleStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
