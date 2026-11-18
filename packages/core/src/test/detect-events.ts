/**
 * Test helper for the detector tests: build HuddleEvents tersely and fold them through `step`. Not exported from the
 * package.
 */
import { agentKey, DEFAULT_USER_SETTINGS } from '@huddle/shared';
import type { DetectorSettings, EventOfType, HuddleEvent, HuddleEventType } from '@huddle/shared';
import { emptyDetectorState, step, tick, type DetectorEmit, type DetectorState } from '../detect/index.js';

export const SESSION = 'sess-a';
export const MAIN = agentKey(SESSION);
export const SUB = agentKey(SESSION, 'sub1');
export const SUB2 = agentKey(SESSION, 'sub2');
export const T0 = 1_800_000_000_000;
export const MIN = 60_000;

export const DEFAULTS: DetectorSettings = DEFAULT_USER_SETTINGS.detectors;

type Fields<T extends HuddleEventType> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

/** A fresh builder: ids `e1`, `e2`, ... in call order. */
export function builder(): <T extends HuddleEventType>(
  type: T,
  at: { ts: number; agent?: string; session?: string; source?: HuddleEvent['source'] },
  fields: Fields<T>,
) => HuddleEvent {
  let n = 0;
  return (type, at, fields) => {
    n += 1;
    const sessionId = at.session ?? SESSION;
    // `fields` is typed per event type by the signature; TypeScript cannot follow the generic through the spread.
    const event: unknown = {
      id: `e${String(n)}`,
      type,
      ts: at.ts,
      sessionId,
      agentKey: at.agent ?? agentKey(sessionId),
      source: at.source ?? 'hook',
      ...fields,
    };
    return event as HuddleEvent;
  };
}

export interface Run {
  state: DetectorState;
  emitted: DetectorEmit[];
}

/** Fold events through `step`; optionally `tick` at each event's ts first (as a live timer would). */
export function run(
  events: readonly HuddleEvent[],
  thresholds: DetectorSettings = DEFAULTS,
  options: { tickAtEachEvent?: boolean; from?: DetectorState } = {},
): Run {
  let state = options.from ?? emptyDetectorState();
  const emitted: DetectorEmit[] = [];
  for (const event of events) {
    if (options.tickAtEachEvent === true) {
      const t = tick(state, event.ts, thresholds);
      state = t.state;
      emitted.push(...t.emit);
    }
    const s = step(state, event, thresholds);
    state = s.state;
    emitted.push(...s.emit);
  }
  return { state, emitted };
}

export function raisedIds(emitted: readonly DetectorEmit[]): string[] {
  return emitted.flatMap((e) => (e.type === 'attention.raised' ? [e.item.id] : []));
}

export function resolvedIds(emitted: readonly DetectorEmit[]): string[] {
  return emitted.flatMap((e) => (e.type === 'attention.resolved' ? [e.itemId] : []));
}
