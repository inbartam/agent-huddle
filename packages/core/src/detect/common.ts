/**
 * Helpers shared by the detectors (F21): building fully formed attention events with deterministic ids, and
 * clipping the text they carry. Pure: no clock, no randomness, no I/O.
 */
import type { AgentKey, AttentionItem, AttentionRaised, AttentionResolved } from '@huddle/shared';

/** What a detector emits. */
export type DetectorEmit = AttentionRaised | AttentionResolved;

export const MINUTE_MS = 60_000;

/** Envelope of an event a detector emits: whose problem it is and when. */
export interface EmitTarget {
  sessionId: string;
  agentKey: AgentKey;
  ts: number;
}

/**
 * Event id of a raise. Derived from the item id and the id of the event that triggered it, so the same input always
 * gives the same id (replays and tests are exact) and two episodes of one item get different ids.
 */
export function raisedEventId(itemId: string, triggerEventId: string): string {
  return `det:${itemId}:raised:${triggerEventId}`;
}

export function resolvedEventId(itemId: string, triggerEventId: string): string {
  return `det:${itemId}:resolved:${triggerEventId}`;
}

export function raisedEvent(target: EmitTarget, item: AttentionItem, triggerEventId: string): AttentionRaised {
  return {
    id: raisedEventId(item.id, triggerEventId),
    type: 'attention.raised',
    ts: target.ts,
    sessionId: target.sessionId,
    agentKey: target.agentKey,
    source: 'huddle',
    item,
  };
}

export function resolvedEvent(target: EmitTarget, itemId: string, triggerEventId: string): AttentionResolved {
  return {
    id: resolvedEventId(itemId, triggerEventId),
    type: 'attention.resolved',
    ts: target.ts,
    sessionId: target.sessionId,
    agentKey: target.agentKey,
    source: 'huddle',
    itemId,
  };
}

/** A whole number of at least `min`; settings are validated upstream, this only guards the arithmetic. */
export function atLeast(value: number, min: number): number {
  return Number.isFinite(value) ? Math.max(min, value) : min;
}

/** "1 min", "12 min", "2 h 5 min". */
export function minutesText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${String(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${String(h)} h` : `${String(h)} h ${String(m)} min`;
}

/** Copy of a record without one key. */
export function without<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  const copy: Record<string, V> = {};
  for (const [k, v] of Object.entries(record)) if (k !== key) copy[k] = v;
  return copy;
}
