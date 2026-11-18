/**
 * F27 (M6 P2): the reducer keeps each agent's latest self-report, raw, on its own node. Replays
 * fixtures/mcp-progress.jsonl (S19 e2) and hand-built events for the ordering rules.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, selectProgress, type AgentNode, type HuddleEvent } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { initialState, reduce, replay, toHuddleState, type ReducerState } from './reduce.js';

const S = 'session-1';
const MAIN = agentKey(S);
const SUB = agentKey(S, 'agent-1');

function node(state: ReducerState, key: string): AgentNode {
  const found = state.agents[key];
  if (found === undefined) throw new Error(`no node ${key}`);
  return found;
}

describe('mcp-progress.jsonl', () => {
  const events = fixtureEvents('mcp-progress.jsonl');

  it('matches the golden self-report snapshot after each report', async () => {
    let state = initialState();
    const steps: unknown[] = [];
    for (const event of events) {
      state = reduce(state, event);
      if (event.type !== 'progress.reported') continue;
      steps.push({
        event: event.id,
        agentKey: event.agentKey,
        main: node(state, MAIN).selfReport ?? null,
        subagent: state.agents[SUB]?.selfReport ?? null,
      });
    }
    await expect(`${JSON.stringify(steps, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/self-report/mcp-progress.json',
    );
  });

  it('the subagent keeps its own report; the main agent ends on its own last one', () => {
    const state = replay(events);
    expect(node(state, SUB).selfReport).toMatchObject({ fraction: 1, minutesLeft: 0, note: 'subagent task done' });
    expect(node(state, MAIN).selfReport).toMatchObject({ fraction: 1, minutesLeft: 0, note: 'all steps done' });
  });

  it("while the subagent runs, the main agent's bar is not the subagent's fraction 1 (ADR-010: subagents count)", () => {
    let state = initialState();
    let checked = false;
    for (const event of events) {
      state = reduce(state, event);
      if (event.type === 'progress.reported' && event.agentKey === SUB) {
        const view = toHuddleState(state);
        const own = selectProgress(view, SUB, event.ts);
        expect(own).toMatchObject({ basis: 'self_report', fraction: 1 });
        const root = selectProgress(view, MAIN, event.ts);
        expect(root?.basis).toBe('subagents');
        expect(root?.fraction).toBeLessThan(1);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  it('a main agent with no subagent yet shows its own report (self_report)', () => {
    let state = initialState();
    for (const event of events) {
      state = reduce(state, event);
      if (event.type === 'progress.reported' && event.fraction === 0.3) break;
    }
    const view = toHuddleState(state);
    expect(selectProgress(view, MAIN, node(state, MAIN).lastEventAt)).toMatchObject({
      basis: 'self_report',
      fraction: 0.3,
    });
  });
});

describe('progress.reported on hand-built events', () => {
  let n = 0;
  function report(key: string, ts: number, fields: Partial<Record<'fraction' | 'etaMinutes' | 'note', unknown>>) {
    n += 1;
    return {
      id: `e${String(n)}`,
      type: 'progress.reported',
      ts,
      sessionId: S,
      agentKey: key,
      source: 'hook',
      fraction: null,
      etaMinutes: null,
      note: null,
      ...fields,
    } as unknown as HuddleEvent;
  }

  it('creates the root from the first event and stores the raw report with the event time', () => {
    const state = replay([report(MAIN, 5000, { fraction: 0.25, etaMinutes: 3, note: 'n' })]);
    expect(node(state, MAIN).selfReport).toEqual({ fraction: 0.25, minutesLeft: 3, note: 'n', at: 5000 });
    expect(node(state, MAIN).lastEventAt).toBe(5000);
  });

  it('a later report replaces the earlier one entirely (no blending, no carry-over of fields)', () => {
    const state = replay([
      report(MAIN, 1000, { fraction: 0.5, etaMinutes: 4, note: 'a' }),
      report(MAIN, 2000, { note: 'b' }),
    ]);
    expect(node(state, MAIN).selfReport).toEqual({ fraction: null, minutesLeft: null, note: 'b', at: 2000 });
  });

  it('an older report arriving late does not move the kept one back', () => {
    const state = replay([report(MAIN, 2000, { fraction: 0.8 }), report(MAIN, 1000, { fraction: 0.1 })]);
    expect(node(state, MAIN).selfReport?.fraction).toBe(0.8);
  });

  it('a report for an unknown subagent key changes nothing but the root', () => {
    const state = replay([report(agentKey(S, 'ghost'), 1000, { fraction: 0.5 })]);
    expect(state.agents[agentKey(S, 'ghost')]).toBeUndefined();
    expect(node(state, MAIN).selfReport ?? null).toBeNull();
  });

  it('survives a JSON round trip', () => {
    const state = replay([report(MAIN, 1000, { fraction: 0.5 })]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
