import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { replay } from './reduce.js';
import {
  selectAgent,
  selectNeedsYouCount,
  selectStaleSessionIds,
  selectTimeline,
  selectTree,
  TIMELINE_LIMIT,
  type TreeNodeView,
} from '@huddle/shared';

function flatten(view: TreeNodeView): TreeNodeView[] {
  return [view, ...view.children.flatMap(flatten)];
}

describe('selectTree over recorded fixtures', () => {
  it.each(listFixtureFiles())('%s matches the golden tree snapshot', async (name) => {
    const tree = selectTree(replay(fixtureEvents(name)));
    await expect(`${JSON.stringify(tree, null, 2)}\n`).toMatchFileSnapshot(
      `./__snapshots__/tree/${name.replace(/\.jsonl$/, '.json')}`,
    );
  });

  it('nested-subagents: Explore is a child of general-purpose', () => {
    const [session] = selectTree(replay(fixtureEvents('nested-subagents.jsonl')));
    expect(session?.root.children.map((c) => c.role)).toEqual(['general-purpose']);
    expect(session?.root.children[0]?.children.map((c) => [c.role, c.link])).toEqual([['Explore', 'exact']]);
    expect(session?.agentCount).toBe(3);
    expect(session?.ended).toBe(true);
    expect(flatten(session?.root as TreeNodeView).every((n) => n.dimmed)).toBe(true);
  });

  it('interactive-helpers: hidden helpers never appear', () => {
    const tree = selectTree(replay(fixtureEvents('interactive-helpers.jsonl')));
    expect(tree).toHaveLength(1);
    expect(tree[0]?.agentCount).toBe(1);
    expect(tree[0]?.root.model).toBe('claude-opus-5-5');
  });
});

describe('selectTree on hand-built state', () => {
  const S = 's1';
  const MAIN = agentKey(S);
  let n = 0;
  function ev(type: string, key: string, ts: number, fields: Record<string, unknown>, sessionId = S): HuddleEvent {
    n += 1;
    return {
      id: `e${String(n)}`,
      type,
      ts,
      sessionId,
      agentKey: key,
      source: 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  }

  it('orders children by start, keeps finished ones dimmed until the session ends, newest session first', () => {
    const later = agentKey(S, 'b');
    const earlier = agentKey(S, 'a');
    const state = replay([
      ev('agent.started', earlier, 100, { agentId: 'a', role: 'Explore', parentKey: MAIN }),
      ev('agent.started', later, 200, { agentId: 'b', role: 'Plan', parentKey: MAIN }),
      ev('agent.stopped', earlier, 300, { agentId: 'a', result: null }),
      ev('prompt.submitted', 's2', 50, { text: 'x', promptId: null, kind: 'user' }, 's2'),
    ]);
    const tree = selectTree(state);
    expect(tree.map((s) => s.sessionId)).toEqual([S, 's2']);
    const children = tree[0]?.root.children ?? [];
    expect(children.map((c) => [c.key, c.dimmed])).toEqual([
      [earlier, true],
      [later, false],
    ]);
    expect(tree[0]?.root.dimmed).toBe(false);
    expect(tree[0]?.statusCounts.working).toBe(1);
    expect(tree[0]?.statusCounts.done).toBe(1);
    expect(selectAgent(state, later)?.role).toBe('Plan');
    expect(selectAgent(state, 'nope')).toBeNull();
    expect(selectNeedsYouCount(state)).toBe(0);
  });
});

describe('stale sessions after a restart (huddleStartedAt)', () => {
  let n = 0;
  function ev(type: string, sessionId: string, ts: number, fields: Record<string, unknown> = {}): HuddleEvent {
    n += 1;
    return {
      id: 'x' + String(n),
      type,
      ts,
      sessionId,
      agentKey: sessionId,
      source: 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  }
  const waiting = (sessionId: string, ts: number): HuddleEvent =>
    ev('approval.requested', sessionId, ts, {
      request: {
        requestId: 'r-' + sessionId,
        agentKey: sessionId,
        toolName: 'Bash',
        toolInput: {},
        summary: 'npm test',
        receivedAt: ts,
        expiresAt: null,
        channel: 'hook',
      },
    });
  const before = [
    ev('session.started', 'old', 100, {
      cwd: null,
      origin: 'attached',
      startKind: 'startup',
      title: null,
      model: null,
    }),
    waiting('old', 150),
    ev('session.started', 'gone', 120, {
      cwd: null,
      origin: 'attached',
      startKind: 'startup',
      title: null,
      model: null,
    }),
    ev('session.ended', 'gone', 130, { reason: 'exit' }),
  ];
  const START = 1000;

  it('leaves the output unchanged without options', () => {
    const state = replay(before);
    const tree = selectTree(state);
    expect(tree.every((s) => !('stale' in s) && !('stale' in s.root))).toBe(true);
    expect(selectNeedsYouCount(state)).toBe(1);
  });

  it('marks a replayed, not ended session stale and keeps its last status', () => {
    const state = replay(before);
    const tree = selectTree(state, { huddleStartedAt: START });
    const old = tree.find((s) => s.sessionId === 'old');
    expect(old?.stale).toBe(true);
    expect(old?.root.stale).toBe(true);
    expect(old?.root.status).toBe('waiting_approval');
    expect(tree.find((s) => s.sessionId === 'gone')?.stale).toBe(false); // ended: dimmed, not stale
    expect(selectNeedsYouCount(state, { huddleStartedAt: START })).toBe(0);
    expect([...selectStaleSessionIds(state, { huddleStartedAt: START })]).toEqual(['old']);
  });

  it('turns live again with the session’s next event', () => {
    const state = replay([...before, waiting('old', START + 5)]);
    const old = selectTree(state, { huddleStartedAt: START }).find((s) => s.sessionId === 'old');
    expect(old?.stale).toBe(false);
    expect(old?.root.stale).toBe(false);
    expect(selectNeedsYouCount(state, { huddleStartedAt: START })).toBe(1);
  });
});

describe('selectTimeline (F8)', () => {
  it('lists an agent’s rows in order with tool durations, ignoring other agents', () => {
    const events = fixtureEvents('parallel-subagents.jsonl');
    const main = agentKey(events[0]?.sessionId ?? '');
    const rows = selectTimeline(events, main);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.kind)).toContain('prompt');
    expect(rows.filter((r) => r.title === 'Subagent finished')).toHaveLength(2);
    const agentCall = rows.find((r) => r.kind === 'tool' && r.title === 'Agent');
    expect(agentCall?.durationMs).toBe(28);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]?.ts).toBeGreaterThanOrEqual(rows[i - 1]?.ts ?? 0);
    expect(selectTimeline(events, 'unknown')).toEqual([]);
  });

  it(`keeps only the most recent ${String(TIMELINE_LIMIT)} rows`, () => {
    const events: HuddleEvent[] = Array.from({ length: TIMELINE_LIMIT + 50 }, (_, i) => ({
      id: `e${String(i)}`,
      type: 'tool.started',
      ts: i,
      sessionId: 's',
      agentKey: 's',
      source: 'hook',
      toolUseId: null,
      toolName: 'Bash',
      summary: `cmd ${String(i)}`,
      filePath: null,
      inputDigest: 'd',
    }));
    const rows = selectTimeline(events, 's');
    expect(rows).toHaveLength(TIMELINE_LIMIT);
    expect(rows[0]?.detail).toBe('cmd 50');
    expect(selectTimeline(events, 's', 3).map((r) => r.detail)).toEqual(['cmd 547', 'cmd 548', 'cmd 549']);
  });
});
