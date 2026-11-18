/**
 * One agent's recent events: getEvents(agentKey, 500) when the agent is selected, and again when an event
 * batch touches that agent. Fetches never overlap; a batch that lands mid-fetch triggers one more.
 * `useTimeline` turns them into timeline rows; the inbox and the pause line read the raw events (how an item or a
 * hold ended).
 */
import { useEffect, useMemo, useState } from 'react';
import type { AgentKey, HuddleEvent } from '@huddle/shared';
import type { HuddleStore } from './store.js';
import { timelineRows, TIMELINE_CAP, type TimelineRow } from './view/timeline.js';

export interface AgentEvents {
  events: readonly HuddleEvent[];
  loading: boolean;
}

export interface TimelineState {
  rows: readonly TimelineRow[];
  loading: boolean;
  /** The events the rows came from, oldest first. */
  events: readonly HuddleEvent[];
}

const NONE: AgentEvents = { events: [], loading: false };

export function useAgentEvents(store: HuddleStore, agentKey: AgentKey | null): AgentEvents {
  const [state, setState] = useState<AgentEvents>(NONE);

  useEffect(() => {
    if (!agentKey) {
      setState(NONE);
      return;
    }
    let alive = true;
    let inflight = false;
    let again = false;
    setState({ events: [], loading: true });

    // Read through a function so the loop sees writes made by batches during the await.
    const requested = () => again;
    const load = async (): Promise<void> => {
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      do {
        again = false;
        try {
          const events = await store.getEvents(agentKey, TIMELINE_CAP);
          if (alive) setState({ events, loading: false });
        } catch {
          if (alive) setState((s) => ({ ...s, loading: false }));
        }
      } while (requested() && alive);
      inflight = false;
    };

    void load();
    const off = store.onBatch((batch) => {
      if (batch.some((e) => e.agentKey === agentKey)) void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [store, agentKey]);

  return state;
}

export function useTimeline(store: HuddleStore, agentKey: AgentKey | null): TimelineState {
  const { events, loading } = useAgentEvents(store, agentKey);
  const rows = useMemo(() => (agentKey ? timelineRows(events, agentKey) : []), [events, agentKey]);
  return { rows, loading, events };
}
