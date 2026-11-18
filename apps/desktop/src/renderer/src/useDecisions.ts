/**
 * The decision log's data (M4, F18): what rules decided on their own, from the read-only events channel (ADR-015).
 * `getEvents` reads one agent at a time, so while the Rules pane is open this reads each agent's recent events (the
 * most recently active first, at most DECISION_AGENT_CAP of them) and joins them with the shared pure
 * `selectPolicyDecisions`. It reads again when a batch brings an `approval.resolved`. Reads never overlap.
 */
import { useEffect, useMemo, useState } from 'react';
import { selectPolicyDecisions, type HuddleEvent, type HuddleState, type PolicyDecision } from '@huddle/shared';
import type { HuddleStore } from './store.js';
import { TIMELINE_CAP } from './view/timeline.js';

export const DECISION_AGENT_CAP = 100;

/** The agents to read, most recently active first. */
export function decisionAgentKeys(state: HuddleState | null): string[] {
  if (state === null) return [];
  return Object.values(state.agents)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)
    .slice(0, DECISION_AGENT_CAP)
    .map((a) => a.key);
}

export function useDecisions(store: HuddleStore, state: HuddleState | null, active: boolean): PolicyDecision[] | null {
  const [events, setEvents] = useState<readonly HuddleEvent[] | null>(null);
  const keys = useMemo(() => decisionAgentKeys(state), [state]);
  // Refetch only when the set of agents changes, not on every state refresh. Sorted by key, so a different agent
  // becoming the most recent one is not a change (recency only decides which agents fit under the cap).
  const keyList = [...keys].sort().join('\n');

  useEffect(() => {
    if (!active) {
      setEvents(null);
      return;
    }
    let alive = true;
    let inflight = false;
    let again = false;
    const requested = () => again;
    const wanted = keyList === '' ? [] : keyList.split('\n');
    const load = async (): Promise<void> => {
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      do {
        again = false;
        const parts = await Promise.all(
          wanted.map((k) => store.getEvents(k, TIMELINE_CAP).catch((): HuddleEvent[] => [])),
        );
        if (alive) setEvents(parts.flat());
      } while (requested() && alive);
      inflight = false;
    };
    void load();
    const off = store.onBatch((batch) => {
      if (batch.some((e) => e.type === 'approval.resolved' || e.type === 'approval.requested')) void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [store, keyList, active]);

  const rules = state?.policy;
  return useMemo(() => (events === null ? null : selectPolicyDecisions(events, rules ?? [])), [events, rules]);
}
