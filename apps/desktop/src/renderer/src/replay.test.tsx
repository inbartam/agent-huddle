/**
 * U2 (M5, F22): the Replay tab of a past run. It says it is not live, has no control anywhere, and nothing breathes;
 * the slider asks `history.stateAt` for the right index and drops late answers; N lands on the stuck marker and the
 * "Why it needs attention" block says what the agent was doing, for how long nothing came, and what happened next;
 * keyboard stepping; hostile run text stays text; the ETA is hidden; failures say so in words.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HuddleQuery, QueryResult } from '@huddle/shared';
import { RunView } from './components/History.js';
import { ProgressSection } from './components/Meters.js';
import { Replay, type ReplayInitial } from './components/Replay.js';
import { StatusGlyph } from './components/Status.js';
import { DRAG_DEBOUNCE_MS, LatestLoader, loadEventsUpTo, loadMoment, type MomentAnswer } from './replay-query.js';
import { KEYS, meteredState, METERED_NOW, XSS } from './testing/fixture.js';
import {
  APPROVAL_INDEX,
  coreEventsPage,
  deferred,
  fakeQuery,
  NOW_M5,
  R0,
  REPLAY_EVENT_COUNT,
  REPLAY_MARKERS,
  REPLAY_SESSION,
  replayHead,
  replayMoment,
  RK,
  STUCK_DETAIL,
  STUCK_INDEX,
  STUCK_TITLE,
  stuckWhy,
} from './testing/m5-fixture.js';
import {
  attentionKey,
  clock,
  currentRow,
  eventWords,
  fateWords,
  gapMarks,
  laterWords,
  layoutMarkers,
  nextAttention,
  positionWords,
  replayFailure,
  REPLAY_WORDS,
  replayToggles,
  scrubKey,
  splitWhy,
  thumbLabel,
  valueText,
} from './view/replay.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function replay(initial: ReplayInitial, head = replayHead()): string {
  return renderToStaticMarkup(<Replay query={null} head={head} initial={initial} trackPx={600} />);
}

/** The stuck moment, as N would land on it, with core-engineer's events. */
const atStuck = (): ReplayInitial => ({
  index: STUCK_INDEX,
  moment: { ok: true, moment: replayMoment(STUCK_INDEX) },
  events: { ok: true, page: coreEventsPage() },
});

/** Every button's visible text and accessible name. */
function buttons(html: string): string[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => {
    const label = /aria-label="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '';
    return `${label} ${(m[2] ?? '').replace(/<[^>]+>/g, '')}`.trim();
  });
}

describe('not live, three ways, and no controls', () => {
  const html = replay(atStuck());

  it('shows the band', () => {
    expect(html).toContain('<span class="rp-band-title">Replay · not live</span>');
    expect(html).toContain('Nothing here can be approved or sent.');
    expect(html).toContain('aria-label="Replay, not live"');
  });

  it('has no action button anywhere: no approve, deny, message, pause, stop, rename, dismiss', () => {
    const all = buttons(html);
    expect(all.length).toBeGreaterThan(5); // stepping, attention, filters, rows
    for (const b of all) {
      expect(b).not.toMatch(/\b(Allow|Deny|Pause|Resume|Stop|Message|Send|Rename|Dismiss|Pass|Answer|Terminal)\b/);
    }
    expect(html).not.toContain('class="control'); // no ControlButton
    expect(html).not.toContain('<textarea');
  });

  it('nothing breathes: the working ● in the tree and the head is still', () => {
    // core-engineer is working at the stuck moment.
    expect(html).toContain('data-status="working"');
    expect(html).not.toContain('is-working');
    expect(html).not.toContain('is-changed');
    expect(renderToStaticMarkup(<StatusGlyph status="working" still />)).not.toContain('is-working');
    expect(renderToStaticMarkup(<StatusGlyph status="working" />)).toContain('is-working');
  });

  it('draws the team at that moment with TeamTree in replay mode', () => {
    expect(html).toContain('class="tree tree-replay"');
    expect(html).toContain('role="tree" aria-label="Team at 15:13"');
    expect(html).toContain('core-engineer #1');
    expect(html).toContain('Explore #2');
    // A link that was still a guess then is dashed.
    expect(html).toContain('data-link="heuristic"');
  });

  it('follows the event by default (a pressed toggle)', () => {
    expect(html).toMatch(/aria-pressed="true">✓ Follow the event</);
  });
});

describe('the scrubber', () => {
  const html = replay(atStuck());

  it('is a native range over the event index with a spoken position', () => {
    expect(html).toMatch(/<input[^>]*type="range"[^>]*min="0"[^>]*max="24"[^>]*step="1"[^>]*value="17"/);
    expect(html).toContain('aria-label="Replay position"');
    expect(html).toContain('aria-valuetext="Event 18 of 25, 15:13:28, looks stuck, core-engineer #1, +12:00 quiet"');
    expect(html).toContain('event 18 of 25');
  });

  it('labels the thumb with time, event words, agent and the quiet stretch before it', () => {
    expect(html).toContain(
      '<span class="rp-thumb-time">15:13:28</span><span class="sep"> · </span><span>looks stuck</span>' +
        '<span class="sep"> · </span><span class="rp-thumb-agent">core-engineer #1</span>' +
        '<span class="muted"> (+12:00 quiet)</span>',
    );
  });

  it('marks ▲ for the approval, ! for the stuck item, ⋯ for the quiet gap, each with words', () => {
    expect(html).toMatch(/class="rp-mark tone-needs-you"[^>]*title="Approval requested at 15:01:15"[^>]*>▲</);
    expect(html).toMatch(/class="rp-mark tone-needs-you"[^>]*title="looks stuck at 15:13:28"[^>]*>!</);
    expect(html).toContain('title="12 min with no events">⋯');
  });

  it('has the stepping buttons, glyph-only with their words as name and tooltip', () => {
    for (const [label, glyph] of [
      ['First event', '|◀'],
      ['Back one event', '◀'],
      ['Forward one event', '▶'],
      ['Last event', '▶|'],
    ] as const) {
      expect(html).toContain(`aria-label="${label}" title="${label}">${glyph}</button>`);
    }
    expect(html).toContain('◂ Previous attention');
    expect(html).toContain('Next attention ▸');
    expect(html).toContain('<option value="stuck">Stuck or looping</option>');
  });

  it('turns Next attention off at the last point, with the reason', () => {
    expect(html).toMatch(/aria-disabled="true"[^>]*title="No more of these after this point\."[^>]*>Next attention ▸/);
    // Previous attention (the approval at 14) is on.
    expect(html).toMatch(/class="quiet-button rp-nav"[^>]*title="Shortcut: Shift\+N"/);
  });

  it('merges markers closer than 6 px into the most urgent one, with a count', () => {
    const close = [
      { index: 100, ts: R0, kind: 'failure' as const, agentKey: RK.core, itemId: null },
      { index: 101, ts: R0, kind: 'approval' as const, agentKey: RK.core, itemId: 'a' },
      { index: 900, ts: R0, kind: 'stuck' as const, agentKey: RK.core, itemId: 's' },
    ];
    const groups = layoutMarkers(close, 1000, 600);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ index: 100, glyph: '▲', count: 2 });
    expect(groups[0]?.title).toMatch(/^2 attention points here: failed at .*; Approval requested at /);
    expect(groups[1]).toMatchObject({ index: 900, glyph: '!', count: 1 });
    // Far apart on a wide track: not merged.
    expect(layoutMarkers(close, 1000, 60_000)).toHaveLength(3);
    expect(gapMarks([{ afterIndex: 0, ms: 90 * 60_000 }], 3)[0]).toMatchObject({
      leftPct: 25,
      title: '1 h 30 min with no events',
    });
  });
});

describe('moving fires history.stateAt; only the newest answer counts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the index the slider moved to', async () => {
    const fake = fakeQuery(() => ({ ok: true, type: 'history.stateAt', moment: replayMoment(5) }));
    const a = await loadMoment(fake.fn, REPLAY_SESSION, 5);
    expect(fake.asked).toEqual([{ type: 'history.stateAt', sessionId: REPLAY_SESSION, index: 5 }]);
    expect(a).toMatchObject({ ok: true, moment: { index: 5 } });
  });

  it('debounces while dragging: one question, for the last position', async () => {
    vi.useFakeTimers();
    const asked: number[] = [];
    const got: number[] = [];
    const loader = new LatestLoader<number, number>(
      (i) => {
        asked.push(i);
        return Promise.resolve(i);
      },
      (a) => {
        got.push(a);
      },
    );
    loader.go(3, 'later');
    loader.go(9, 'later');
    loader.go(12, 'later');
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(DRAG_DEBOUNCE_MS);
    expect(asked).toEqual([12]);
    expect(got).toEqual([12]);
  });

  it('ignores a late answer for an older index', async () => {
    const first = deferred<MomentAnswer>();
    const second = deferred<MomentAnswer>();
    const asked: number[] = [];
    const shown: number[] = [];
    const loader = new LatestLoader<number, MomentAnswer>(
      (i) => {
        asked.push(i);
        return i === 3 ? first.promise : second.promise;
      },
      (a) => {
        if (a.ok) shown.push(a.moment.index);
      },
    );
    loader.go(3);
    loader.go(20);
    second.resolve({ ok: true, moment: replayMoment(20) });
    await second.promise;
    first.resolve({ ok: true, moment: replayMoment(3) }); // arrives last, for the older position
    await first.promise;
    await Promise.resolve();
    expect(asked).toEqual([3, 20]);
    expect(shown).toEqual([20]);
  });

  it('drops answers after the view is gone', async () => {
    const d = deferred<number>();
    const got: number[] = [];
    const loader = new LatestLoader<number, number>(
      () => d.promise,
      (a) => {
        got.push(a);
      },
    );
    loader.go(1);
    loader.dispose();
    d.resolve(1);
    await d.promise;
    expect(got).toEqual([]);
  });

  it('asks for one agent’s whole events from the position back', async () => {
    const fake = fakeQuery(() => ({ ok: true, type: 'history.events', page: coreEventsPage() }));
    const a = await loadEventsUpTo(fake.fn, { sessionId: REPLAY_SESSION, index: 17, agentKey: RK.core, limit: 200 });
    expect(fake.asked).toEqual([
      {
        type: 'history.events',
        sessionId: REPLAY_SESSION,
        fromIndex: 17,
        limit: 200,
        backward: true,
        agentKey: RK.core,
        full: true,
      },
    ]);
    expect(a).toMatchObject({ ok: true, page: { eventCount: REPLAY_EVENT_COUNT } });
  });

  it('reads a wrong-shaped answer as failed and no bridge as unavailable', async () => {
    const bad = fakeQuery(
      () => ({ ok: true, type: 'history.stateAt', moment: { index: 1 } }) as unknown as QueryResult,
    );
    expect(await loadMoment(bad.fn, REPLAY_SESSION, 1)).toMatchObject({ ok: false, code: 'failed' });
    const wrong = fakeQuery(() => ({ ok: true, type: 'history.events', page: coreEventsPage() }));
    expect(await loadMoment(wrong.fn, REPLAY_SESSION, 1)).toMatchObject({ ok: false, code: 'failed' });
    expect(await loadMoment(null, REPLAY_SESSION, 1)).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('a real moment query from the component is history.stateAt with the session id', async () => {
    const q: HuddleQuery[] = [];
    const fn = (x: HuddleQuery) => {
      q.push(x);
      return Promise.resolve<QueryResult>({ ok: false, code: 'not_available', message: 'WP4b' });
    };
    await loadMoment(fn, REPLAY_SESSION, 24);
    expect(q[0]).toEqual({ type: 'history.stateAt', sessionId: REPLAY_SESSION, index: 24 });
  });
});

describe('N lands on the stuck item, and the block says why', () => {
  it('N from before the stuck marker goes to it; Shift+N goes back to the approval', () => {
    const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, ctrlKey: false, altKey: false, metaKey: false });
    expect(attentionKey(key('n'), false, REPLAY_MARKERS, 15, 'everything')?.index).toBe(STUCK_INDEX);
    expect(attentionKey(key('N', true), false, REPLAY_MARKERS, STUCK_INDEX, 'everything')?.index).toBe(APPROVAL_INDEX);
    // Only "Stuck or looping": the approval does not count.
    expect(attentionKey(key('n'), false, REPLAY_MARKERS, 0, 'stuck')?.index).toBe(STUCK_INDEX);
    expect(attentionKey(key('N', true), false, REPLAY_MARKERS, STUCK_INDEX, 'stuck')).toBeNull();
    // Not in a text field, not with Ctrl, not other keys.
    expect(attentionKey(key('n'), true, REPLAY_MARKERS, 0, 'everything')).toBeUndefined();
    expect(attentionKey({ ...key('n'), ctrlKey: true }, false, REPLAY_MARKERS, 0, 'everything')).toBeUndefined();
    expect(attentionKey(key('m'), false, REPLAY_MARKERS, 0, 'everything')).toBeUndefined();
    expect(nextAttention(REPLAY_MARKERS, STUCK_INDEX, 'everything', 1)).toBeNull();
    expect(nextAttention(REPLAY_MARKERS, 0, 'failures', 1)).toBeNull();
    expect(nextAttention(REPLAY_MARKERS, 0, 'approvals', 1)?.index).toBe(APPROVAL_INDEX);
  });

  const html = replay(atStuck());

  it('selects the stuck agent (follow the event) and heads the pane with it', () => {
    expect(html).toContain('<h2 class="rp-agent-name">core-engineer #1</h2>');
    expect(html).toMatch(/aria-selected="true"[^>]*aria-label="core-engineer #1, builder, working/);
    expect(html).toContain('reports to Lead agent');
  });

  it('shows the item title and detail, the last tool call and its fate, the quiet time and the later outcome', () => {
    expect(html).toContain('<h2 class="section-title"');
    expect(html).toContain('>Why it needs attention<');
    expect(html).toContain('<span class="rp-why-kind">looks stuck</span>');
    expect(html).toContain(`<span class="rp-why-title">${STUCK_TITLE}</span>`);
    expect(html).toContain(`<p class="rp-why-detail">${STUCK_DETAIL}</p>`);
    expect(html).toContain('<dt>Last tool call</dt>');
    expect(html).toContain('<span class="rp-tool">Bash</span> <span class="code">npm test -- parser</span>');
    expect(html).toContain('started 15:01:28, no result by this point');
    expect(html).toContain('Quiet for 12:00 since this agent&#x27;s last event');
    expect(html).toContain(
      '<span class="rp-later-label">Later:</span> Cleared at 15:19 when the agent reported again.',
    );
  });

  it('lists the agent’s events up to here, newest first, with the current one marked', () => {
    expect(html).toContain('>Events up to here<');
    const rows = [...html.matchAll(/class="tl-row rp-event kind-([a-z]+)( is-current)?"/g)].map(
      (m) => `${m[1] ?? ''}${m[2] ? '*' : ''}`,
    );
    // The stuck item is a row here (DESIGN sketch: "looks stuck  No activity…"), and it is the event at the position.
    expect(rows).toEqual(['agent*', 'tool', 'approval', 'tool']);
    expect(html).toContain('<span class="tl-label">looks stuck</span>');
    expect(html).toContain('npm test -- parser');
  });

  it('a pending request shows its summary and how long it waited', () => {
    const why = stuckWhy({
      itemId: 'approval:req',
      kind: 'approval',
      title: 'core-engineer #1 needs approval',
      detail: '',
      request: { summary: 'npm test -- parser', waitedMs: 72_000 },
      later: { kind: 'approval', index: 15, ts: R0 + 87_000, outcome: 'allowed', by: 'user' },
    });
    const out = replay({ ...atStuck(), moment: { ok: true, moment: replayMoment(STUCK_INDEX, { why: [why] }) } });
    expect(out).toContain('<span class="rp-why-kind">needs approval</span>');
    expect(out).toContain('Waited 1:12 for an answer so far');
    expect(out).toContain('Later:</span> Allowed from Huddle.');
  });

  it('with no open item, one calm line replaces the block', () => {
    const out = replay({ index: 24, moment: { ok: true, moment: replayMoment(24) } });
    expect(out).not.toContain('Why it needs attention');
    expect(out).toContain('rp-calm');
  });
});

describe('the moment pane shows the selected agent’s items, and names the others in one line', () => {
  // At the stuck point, main also has an approval open (a second agent with an item).
  const mainApproval = stuckWhy({
    itemId: 'approval:req-main',
    kind: 'approval',
    agentKey: RK.main,
    title: 'Fix parser tests needs approval',
    detail: '',
    raisedIndex: 16,
    request: { summary: 'git push', waitedMs: 1_000 },
    later: { kind: 'still_open' },
  });
  const twoAgents = (more: ReplayInitial = {}): ReplayInitial => ({
    ...atStuck(),
    moment: { ok: true, moment: replayMoment(STUCK_INDEX, { why: [stuckWhy(), mainApproval] }) },
    ...more,
  });

  it('following the event (N), the stuck agent’s block shows in full and main is in the “also” line', () => {
    const html = replay(twoAgents());
    expect(html.match(/<article class="rp-why"/g)).toHaveLength(1);
    expect(html).toContain(`<span class="rp-why-title">${STUCK_TITLE}</span>`);
    expect(html).not.toContain('<span class="rp-why-title">Fix parser tests needs approval</span>');
    expect(html).toContain('<span class="muted">Also needs attention at this point:</span>');
    expect(html).toContain(
      '<button type="button" class="link-button rp-also-agent" aria-label="Select Lead agent: needs approval">',
    );
    expect(html).toContain(
      '<span class="rp-also-name">Lead agent</span> <span class="rp-why-kind">needs approval</span>',
    );
  });

  it('with main picked, main’s approval is the block and the stuck agent moves to the “also” line', () => {
    const html = replay(twoAgents({ follow: false, picked: RK.main }));
    expect(html.match(/<article class="rp-why"/g)).toHaveLength(1);
    expect(html).toContain('<span class="rp-why-title">Fix parser tests needs approval</span>');
    expect(html).toContain('aria-label="Select core-engineer #1: looks stuck"');
    expect(html).not.toContain(`<span class="rp-why-title">${STUCK_TITLE}</span>`);
  });

  it('one agent’s items only: no “also” line', () => {
    expect(replay(atStuck())).not.toContain('Also needs attention');
  });

  it('splitWhy groups the others by agent, in the order their first item was raised', () => {
    const second = { ...mainApproval, itemId: 'loop:main', kind: 'loop' as const, raisedIndex: 18 };
    const { mine, others } = splitWhy([second, stuckWhy(), mainApproval], RK.core);
    expect(mine.map((w) => w.itemId)).toEqual([`stuck:${RK.core}`]);
    expect(others).toHaveLength(1);
    expect(others[0]?.agentKey).toBe(RK.main);
    expect(others[0]?.items.map((w) => w.itemId)).toEqual(['approval:req-main', 'loop:main']);
    expect(splitWhy([stuckWhy()], null)).toEqual({ mine: [], others: [{ agentKey: RK.core, items: [stuckWhy()] }] });
  });

  it('agent text in the “also” line stays text', () => {
    const hostile = { ...mainApproval, agentKey: RK.explore };
    const moment = replayMoment(STUCK_INDEX, { why: [stuckWhy(), hostile] });
    const explore = moment.state.agents[RK.explore];
    if (!explore) throw new Error('fixture');
    moment.state.agents[RK.explore] = { ...explore, name: XSS, handoff: null };
    const html = replay({ ...atStuck(), moment: { ok: true, moment } });
    expect(html).not.toContain('<img');
    expect(html).toContain(`<span class="rp-also-name">${esc(XSS)}</span>`);
  });
});

describe('"Events up to here" highlights the nearest row when the event is not a row', () => {
  const page = coreEventsPage();
  const at13 = (): ReplayInitial => {
    const base = replayMoment(13);
    return {
      index: 13,
      // Index 13 is core-engineer's Edit finishing: not a timeline row.
      moment: {
        ok: true,
        moment: { ...base, event: { ...base.event, type: 'tool.finished', agentKey: RK.core } },
      },
      events: { ok: true, page: { ...page, entries: page.entries.filter((e) => e.index <= 13) } },
    };
  };

  it('fills the row before it and says "nearest" to a screen reader', () => {
    const html = replay(at13());
    expect(html).toMatch(/class="tl-row rp-event kind-tool is-current is-nearest" aria-current="step"/);
    expect(html).toContain('<span class="visually-hidden">, nearest row to this point</span>');
  });

  it('an event that is a row is current without "nearest"', () => {
    const html = replay(atStuck());
    expect(html).toContain('class="tl-row rp-event kind-agent is-current" aria-current="step"');
    expect(html).not.toContain('is-nearest');
    expect(html).not.toContain('nearest row to this point');
  });

  it('currentRow picks the row at the index, else the closest one before it, else none', () => {
    const indexOf = new Map([
      ['a', 12],
      ['b', 16],
      ['c', 17],
    ]);
    const rows = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    expect(currentRow(rows, indexOf, 16)).toEqual({ id: 'b', exact: true });
    expect(currentRow(rows, indexOf, 15)).toEqual({ id: 'a', exact: false });
    expect(currentRow(rows, indexOf, 11)).toBeNull();
  });
});

describe('the words', () => {
  it('fates, endings and clocks', () => {
    expect(fateWords({ state: 'finished', endedTs: R0, durationMs: 120 }, R0)).toBe('finished in 120 ms');
    expect(fateWords({ state: 'failed', endedTs: R0, error: 'exit 1\nmore', interrupted: false }, R0)).toBe(
      'failed: exit 1',
    );
    expect(fateWords({ state: 'failed', endedTs: R0, error: null, interrupted: true }, R0)).toBe('failed: interrupted');
    expect(laterWords({ kind: 'still_open' }, 'stuck')).toBe('Still open when the log ends.');
    expect(laterWords({ kind: 'question_closed', index: 1, ts: R0, outcome: 'expired' }, 'question')).toBe(
      'Time limit reached. Answer it in the terminal.',
    );
    expect(laterWords({ kind: 'approval', index: 1, ts: R0, outcome: 'allowed', by: 'policy' }, 'approval')).toBe(
      'Allowed by a rule.',
    );
    expect(clock(724_000)).toBe('12:04');
    expect(clock(72_000)).toBe('1:12');
    expect(clock(3_723_000)).toBe('1:02:03');
    expect(positionWords(411, 1280)).toBe('event 412 of 1,280');
    expect(eventWords({ index: 3, type: 'tool.started' }, [])).toBe('Tool started');
    expect(eventWords({ index: APPROVAL_INDEX, type: 'approval.requested' }, REPLAY_MARKERS)).toBe(
      'Approval requested',
    );
  });

  it('the thumb adds the date when the event is not on the run’s first day, and quiet only after a gap', () => {
    const next = new Date(2026, 10, 15, 0, 12, 3).getTime();
    const l = thumbLabel({ index: 3, ts: next, type: 'tool.started', agentKey: RK.core }, R0, [], [], 1000, 'x');
    expect(l).toEqual({ time: '15 Nov 00:12:03', what: 'Tool started', agent: 'x', quiet: null });
    expect(valueText(3, 10, l)).toBe('Event 4 of 10, 15 Nov 00:12:03, Tool started, x');
    expect(valueText(3, 10, null)).toBe('Event 4 of 10');
  });

  it('replay opens every row, ended sessions too', () => {
    expect([...replayToggles([RK.main], new Set())]).toEqual([RK.main]);
    expect([...replayToggles([RK.main], new Set([RK.main]))]).toEqual([]);
  });
});

describe('keyboard steps', () => {
  it('arrows step one, Shift ten, Home and End jump, clamped to the run', () => {
    expect(scrubKey('ArrowRight', false, 5, 25)).toBe(6);
    expect(scrubKey('ArrowLeft', false, 5, 25)).toBe(4);
    expect(scrubKey('ArrowRight', true, 5, 25)).toBe(15);
    expect(scrubKey('ArrowLeft', true, 5, 25)).toBe(0);
    expect(scrubKey('ArrowRight', true, 20, 25)).toBe(24);
    expect(scrubKey('ArrowUp', false, 5, 25)).toBe(6);
    expect(scrubKey('ArrowDown', false, 0, 25)).toBe(0);
    expect(scrubKey('Home', false, 9, 25)).toBe(0);
    expect(scrubKey('End', false, 9, 25)).toBe(24);
    expect(scrubKey('PageUp', false, 9, 25)).toBe(19);
    expect(scrubKey('a', false, 9, 25)).toBeNull();
  });

  it('the first and last events turn their buttons off', () => {
    const atFirst = replay({ index: 0, moment: { ok: true, moment: replayMoment(0) } });
    expect(atFirst).toContain('aria-label="First event" title="First event" aria-disabled="true"');
    expect(atFirst).toContain('aria-label="Back one event" title="Back one event" aria-disabled="true"');
    expect(atFirst).not.toContain('aria-label="Forward one event" title="Forward one event" aria-disabled');
  });
});

describe('hostile run text renders as text', () => {
  const evil = '<script>alert(1)</script> **bold** # head';
  const why = stuckWhy({
    title: XSS,
    detail: `${evil}\nsecond line`,
    lastToolCall: {
      toolName: '<b>Bash</b>',
      summary: XSS,
      startedTs: R0,
      fate: { state: 'failed', endedTs: R0, error: '<img src=y onerror=alert(2)>', interrupted: false },
    },
  });
  const moment = replayMoment(STUCK_INDEX, { why: [why] });
  const named = { ...moment.state.agents[RK.core], name: XSS };
  const state = { ...moment.state, agents: { ...moment.state.agents, [RK.core]: named } };
  const html = replay({
    index: STUCK_INDEX,
    moment: { ok: true, moment: { ...moment, state: state as typeof moment.state } },
  });

  it('escapes markup in why, detail, summary, error and the agent name', () => {
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<img src=y');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Bash</b>');
    expect(html).toContain(esc(XSS));
    expect(html).toContain('&lt;b&gt;Bash&lt;/b&gt;');
    expect(html).toContain(`failed: ${esc('<img src=y onerror=alert(2)>')}`);
    expect(html).toContain(`<h2 class="rp-agent-name">${esc(XSS)}</h2>`);
  });

  it('keeps Markdown as typed and line breaks as text', () => {
    expect(html).toContain('**bold** # head\nsecond line');
    expect(html).not.toContain('<strong>');
  });
});

describe('the ETA is hidden', () => {
  it('drops the time left and says why, in the replay pane and in the section itself', () => {
    const state = meteredState();
    const main = state.agents[KEYS.main];
    if (!main) throw new Error('fixture');
    const live = renderToStaticMarkup(<ProgressSection state={state} agent={main} now={METERED_NOW} />);
    expect(live).toContain('min left');
    const past = renderToStaticMarkup(<ProgressSection state={state} agent={main} now={METERED_NOW} replay />);
    expect(past).not.toContain('min left');
    expect(past).toContain('Time left isn&#x27;t shown in a replay.');
    expect(past).toContain('~50% est.');
    const pane = replay(atStuck());
    expect(pane).not.toContain(' left</');
  });
});

describe('states', () => {
  it('not_available shows its message, with no Try again', () => {
    const html = replay({ moment: { ok: false, code: 'not_available', message: 'WP4b' } });
    expect(html).toContain('Replay isn&#x27;t available yet in this build.');
    expect(html).not.toContain('WP4b');
    expect(html).not.toContain('Try again');
    expect(html).toContain('Replay · not live');
  });

  it('not_found says the run was deleted; invalid and failed say so with Try again', () => {
    expect(replay({ moment: { ok: false, code: 'not_found', message: 'gone' } })).toContain(
      'This run was deleted by the history setting.',
    );
    const bad = replay({ moment: { ok: false, code: 'invalid', message: 'index out of range.' } });
    expect(bad).toContain('Couldn&#x27;t read this run&#x27;s events: index out of range.');
    expect(bad).toContain('>Try again</button>');
    expect(replayFailure({ ok: false, code: 'unsupported', message: 'x' })).toBe(REPLAY_WORDS.notAvailable);
  });

  it('loading is not shown at once; an empty run says so', () => {
    expect(replay({})).not.toContain('Loading');
    expect(replay({}, replayHead({ eventCount: 0, markers: [], quietGaps: [] }))).toContain(
      'This run has no stored events.',
    );
  });

  it('a live run is a snapshot, with Load newer events and Show live', () => {
    const head = replayHead({ row: { ...replayHead().row, outcome: 'running' }, lastTs: NOW_M5 - 20 * 60_000 });
    const html = renderToStaticMarkup(
      <Replay
        query={null}
        head={head}
        initial={atStuck()}
        onShowLive={() => undefined}
        onLoadNewer={() => undefined}
      />,
    );
    expect(html).toContain('Still running. Showing events up to 17:40.');
    expect(html).toContain('>Load newer events</button>');
    expect(html).toContain('>Show live</button>');
  });

  it('a log that starts late says so', () => {
    expect(replay(atStuck(), replayHead({ startsWithSession: false }))).toContain(
      'The log starts after the session began: Huddle wasn&#x27;t running before 15:00.',
    );
  });

  it('the run view shows Replay in place of the placeholder', () => {
    const head = replayHead({ hasReport: false });
    const html = renderToStaticMarkup(
      <RunView
        query={null}
        sessionId={REPLAY_SESSION}
        tab={null}
        now={NOW_M5}
        onBack={() => undefined}
        initialHead={{ ok: true, head }}
        initialReplay={atStuck()}
      />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>Replay</);
    expect(html).toContain('Replay · not live');
    expect(html).toContain('Why it needs attention');
  });
});
