import { describe, expect, it } from 'vitest';
import { selectTree, type HuddleEvent, type HuddleState } from '@huddle/shared';
import { fixtureState, KEYS, SESSION, T0, toolEvents } from '../testing/fixture.js';
import { agentFromHash, linkedAgent, openMainUrl } from './deep-link.js';
import { duration, linkQuality, shortModel } from './format.js';
import { STATUS_LOOK } from './status.js';
import { pinnedItem } from './summary.js';
import { filterTimeline, TIMELINE_CAP, timelineRows } from './timeline.js';
import { agentRows, buildRows, revealToggles, type BuildOptions, type TreeRow } from './tree.js';

const none = new Set<string>();
const rowsOf = (state: HuddleState, options: BuildOptions = { toggled: none }) => buildRows(selectTree(state), options);

describe('tree rows (layout over selectTree)', () => {
  it('nests subagents under the agent that spawned them, finished ones in a group', () => {
    const rows = rowsOf(fixtureState());
    expect(rows.map((r) => (r.kind === 'agent' ? `${String(r.depth)}:${r.key}` : r.kind))).toEqual([
      `0:${KEYS.main}`,
      `1:${KEYS.core}`,
      `2:${KEYS.explore}`,
      'finished-label',
      `0:${KEYS.tester}`,
      `0:${KEYS.doneExplore}`,
    ]);
    expect(
      agentRows(rows)
        .filter((r) => r.finished)
        .map((r) => r.key),
    ).toEqual([KEYS.tester, KEYS.doneExplore]);
  });

  it('uses a solid rail for exact links and a dashed rail for best guesses and unknown links', () => {
    const state = fixtureState({ core: { handoff: null } });
    const byKey = new Map(agentRows(rowsOf(state)).map((r) => [r.key, r]));
    expect(byKey.get(KEYS.main)?.elbow).toBeNull();
    expect(byKey.get(KEYS.core)?.elbow?.link).toBe('heuristic'); // unknown link: still a guess
    expect(byKey.get(KEYS.explore)?.elbow?.link).toBe('heuristic');
    const exact = new Map(agentRows(rowsOf(fixtureState())).map((r) => [r.key, r]));
    expect(exact.get(KEYS.core)?.elbow?.link).toBe('exact');
  });

  it('colours the path to a waiting subagent all the way up to its root', () => {
    const rows = agentRows(rowsOf(fixtureState()));
    const get = (k: string) => rows.find((r) => r.key === k) as TreeRow;
    expect(get(KEYS.explore).elbow?.status).toBe('waiting_approval');
    expect(get(KEYS.core).elbow?.status).toBe('waiting_approval');
    expect(get(KEYS.main).stub).toBe('waiting_approval');
  });

  it('keeps a finished agent in place while it has a live child', () => {
    const rows = agentRows(rowsOf(fixtureState({ core: { status: 'done' } })));
    expect(rows.find((r) => r.key === KEYS.core)?.finished).toBe(false);
    expect(rows.find((r) => r.key === KEYS.explore)?.depth).toBe(2);
  });

  it('collapses an ended session by default and opens it when toggled', () => {
    const state = fixtureState({ main: { status: 'done', endedAt: T0 + 9000 } });
    expect(rowsOf(state)).toHaveLength(1);
    expect(rowsOf(state, { toggled: new Set([KEYS.main]) }).length).toBeGreaterThan(1);
  });

  it('starts sessions collapsed in the widget', () => {
    expect(rowsOf(fixtureState(), { toggled: none, rootsCollapsed: true })).toHaveLength(1);
  });
});

describe('status look', () => {
  it('gives every status a glyph and a distinct label, so colour is never alone', () => {
    for (const look of Object.values(STATUS_LOOK)) {
      expect(look.glyph).not.toBe('');
      expect(look.label).not.toBe('');
    }
    expect(new Set(Object.values(STATUS_LOOK).map((l) => l.label)).size).toBe(9);
  });
});

describe('timeline presentation (over selectTimeline)', () => {
  it('shows the newest first with durations', () => {
    const rows = timelineRows(toolEvents(3), KEYS.core);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.ts).toBeGreaterThan(rows[1]?.ts ?? Infinity);
    expect(rows.every((r) => r.durationMs === 12)).toBe(true);
  });

  it(`caps at ${String(TIMELINE_CAP)} rows, keeping the most recent`, () => {
    const events = toolEvents(700);
    const rows = timelineRows(events, KEYS.core);
    expect(rows).toHaveLength(500);
    expect(rows[0]?.ts).toBe(Math.max(...events.map((e) => e.ts)) - 12);
  });

  it('groups kinds into filters and keeps only the first line of long text', () => {
    const events: HuddleEvent[] = [
      ...toolEvents(1),
      {
        id: 'p1',
        ts: T0 - 10,
        type: 'prompt.submitted',
        sessionId: SESSION,
        agentKey: KEYS.core,
        source: 'hook',
        text: 'Do it\nsecond line',
        promptId: null,
      },
      {
        id: 'f2',
        ts: T0 + 51_000,
        type: 'tool.failed',
        sessionId: SESSION,
        agentKey: KEYS.core,
        source: 'hook',
        toolUseId: 'u2',
        toolName: 'Bash',
        error: 'exit 1',
        interrupted: false,
      },
    ];
    const rows = timelineRows(events, KEYS.core);
    expect(filterTimeline(rows, 'failure').map((r) => r.line)).toEqual(['exit 1']);
    expect(filterTimeline(rows, 'prompt').map((r) => r.line)).toEqual(['Do it']);
    expect(filterTimeline(rows, 'tool').every((r) => r.code)).toBe(true);
  });
});

describe('format', () => {
  it('shows unknown as a dash, never 0', () => {
    expect(duration(null)).toBe('—');
    expect(shortModel(null)).toBe('—');
    // Same casing as the rest of the app, for full ids and bare aliases alike.
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(shortModel('haiku')).toBe('Haiku');
    expect(shortModel('gpt-x')).toBe('gpt-x');
    expect(duration(120)).toBe('120 ms');
    expect(duration(6400)).toBe('6.4 s');
  });
});

describe('pinned item', () => {
  it('falls back to the first agent waiting on the user', () => {
    expect(pinnedItem(fixtureState())).toMatchObject({ agentKey: KEYS.explore, what: 'needs approval' });
  });
});

describe('selecting an agent from the widget (URL fragment)', () => {
  const key = KEYS.explore;

  it('builds the open request the main process accepts', () => {
    const widget = 'file:///C:/app/out/renderer/index.html?view=widget';
    expect(openMainUrl(widget)).toBe('file:///C:/app/out/renderer/index.html?view=main');
    expect(openMainUrl(widget, key)).toBe(
      `file:///C:/app/out/renderer/index.html?view=main&agent=${encodeURIComponent(key)}`,
    );
    expect(openMainUrl(`${widget}#x`, '<img src=x>')).toBe('file:///C:/app/out/renderer/index.html?view=main');
  });

  it('reads only a well-formed #agent=<key> fragment', () => {
    expect(agentFromHash(`#agent=${encodeURIComponent(key)}`)).toBe(key);
    for (const hash of [
      '',
      '#',
      '#agent=',
      `#agent=${encodeURIComponent('<script>')}`,
      '#agent=%E0%A4%A',
      `#agent=${key}&agent=other`,
      `#x=1&agent=${key}`,
      `#agent=${'a'.repeat(300)}`,
    ]) {
      expect(agentFromHash(hash)).toBeNull();
    }
  });

  it('selects only an agent the state knows', () => {
    const state = fixtureState();
    expect(linkedAgent(`#agent=${encodeURIComponent(key)}`, state)).toBe(key);
    expect(linkedAgent('#agent=someone-else', state)).toBeNull();
    expect(linkedAgent('#agent=toString', state)).toBeNull(); // no prototype keys
    expect(linkedAgent(`#agent=${encodeURIComponent(key)}`, null)).toBeNull();
  });

  it('opens every collapsed row above the selected agent, and only those', () => {
    const sessions = selectTree(fixtureState());
    // The user collapsed core-engineer; selecting its child opens it again.
    expect([...revealToggles(sessions, KEYS.explore, new Set([KEYS.core]))]).toEqual([]);
    // Widget-style collapsed roots: the session opens.
    expect([...revealToggles(sessions, KEYS.explore, new Set(), true)]).toEqual([KEYS.main]);
    // Already visible, or unknown: the same set comes back.
    const same = new Set<string>();
    expect(revealToggles(sessions, KEYS.explore, same)).toBe(same);
    expect(revealToggles(sessions, 'nope', same)).toBe(same);
  });

  it('words the parent link plainly', () => {
    expect(linkQuality('exact')).toBe('confirmed');
    expect(linkQuality('heuristic')).toBe('best guess — matched by order');
    expect(linkQuality('unknown')).toBe('best guess — matched by order');
    expect(linkQuality(null)).toBe('best guess — matched by order');
  });
});
