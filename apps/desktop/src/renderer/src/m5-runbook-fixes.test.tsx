/**
 * The M5 runbook findings on real data, fixed (2026-11-15): History opened during the import asks again until the
 * import is done; Compare models never opens on "model unknown"; a cut match line says so with "…"; the replay's
 * "Later:" line says why an item cleared in that item's own terms; the replay names an agent as its replayed tree does.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentKey, HistoryMatch, HistorySearchHit, Scorecard } from '@huddle/shared';
import { HistoryPanel } from './components/History.js';
import { Replay, replayName } from './components/Replay.js';
import { Scorecards, type ScorecardsInitial } from './components/Scorecards.js';
import type { RunsAnswer } from './history-query.js';
import { migrationPoll, type Scheduler } from './history-refresh.js';
import { agentLabel } from './store.js';
import {
  CANNED_ROWS,
  NOW_M5,
  replayHead,
  replayMoment,
  replayState,
  RK,
  runsList,
  scorecard,
} from './testing/m5-fixture.js';
import { followActive, matchSegments, NO_FILTERS, refreshList, rowParts, type RunsList } from './view/history.js';
import { laterWords } from './view/replay.js';
import { defaultPair, groupScorecards, SCORECARD_WORDS } from './view/scorecards.js';

// ---------------------------------------------------------------------------
// 1. History during the import
// ---------------------------------------------------------------------------

/** A scheduler the test steps by hand: `run()` fires the pending timer. */
function manualScheduler() {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  const s: Scheduler & { pending: () => number[]; run: () => void } = {
    set: (fn, ms) => {
      const id = next++;
      timers.push({ fn, ms, id });
      return id;
    },
    clear: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    pending: () => timers.map((t) => t.ms),
    run: () => {
      const t = timers.shift();
      t?.fn();
    },
  };
  return s;
}

const rows = (n: number) => CANNED_ROWS.slice(0, n);
const answer = (n: number, migrating: boolean): RunsAnswer => ({
  ok: true,
  hits: rows(n).map((row) => ({ row, match: null })),
  total: null,
  next: null,
  migrating,
});
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('History asks again while older history is coming in', () => {
  it('migrating twice, then done: three questions 2 s apart, one in flight at a time, then it stops', async () => {
    const sched = manualScheduler();
    const answers = [answer(2, true), answer(3, true), answer(4, false)];
    let asked = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];
    const poll = migrationPoll({
      load: async () => {
        asked++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        inFlight--;
        return answers[asked - 1] ?? answer(4, false);
      },
      onAnswer: (a) => seen.push(a.hits.length),
      scheduler: sched,
    });

    poll.start();
    expect(asked).toBe(0); // the first answer already came; wait 2 s
    expect(sched.pending()).toEqual([2000]);

    sched.run();
    expect(asked).toBe(1);
    poll.poke(); // window focus while that question is out: not a second one
    expect(asked).toBe(1);
    await flush();
    await flush();
    expect(seen).toEqual([2]);
    expect(sched.pending()).toEqual([2000]);

    sched.run();
    await flush();
    await flush();
    expect(seen).toEqual([2, 3]);
    sched.run();
    await flush();
    await flush();
    expect(seen).toEqual([2, 3, 4]);
    expect(asked).toBe(3);
    expect(maxInFlight).toBe(1);
    // migrating: false: no timer left, and a focus asks nothing more.
    expect(sched.pending()).toEqual([]);
    expect(poll.active).toBe(false);
    poll.poke();
    expect(asked).toBe(3);
  });

  it('a failed question keeps the rows and tries again; stop() ends it; start(true) asks at once (shown again)', async () => {
    const sched = manualScheduler();
    const seen: boolean[] = [];
    let n = 0;
    const poll = migrationPoll({
      load: () => {
        n++;
        return Promise.resolve(n === 1 ? ({ ok: false, code: 'failed', message: 'x' } as const) : answer(2, true));
      },
      onAnswer: (a) => seen.push(a.migrating),
      scheduler: sched,
    });
    poll.start(true);
    expect(n).toBe(1);
    await flush();
    expect(seen).toEqual([]); // the failure is not handed on
    expect(sched.pending()).toEqual([2000]);
    sched.run();
    await flush();
    expect(seen).toEqual([true]);
    poll.stop();
    expect(sched.pending()).toEqual([]);
    poll.poke();
    expect(n).toBe(2);
  });

  it('a fresh page replaces the rows; rows paged in after it stay; the selected run stays selected', () => {
    const [a, b, c, d] = CANNED_ROWS.map((row): HistorySearchHit => ({ row, match: null }));
    if (!a || !b || !c || !d) throw new Error('fixture');
    const filters = { ...NO_FILTERS, text: 'x' };
    const shown: RunsList = { filters, hits: [a, c], total: 2, next: null, migrating: true };
    const whole = refreshList(shown, { hits: [a, b, c], total: 3, next: null, migrating: false });
    expect(whole).toEqual({ filters, hits: [a, b, c], total: 3, next: null, migrating: false });
    // c was selected (index 1); it is now at index 2.
    expect(followActive(shown.hits, whole.hits, 1)).toBe(2);
    // A run that is gone: the same position, clamped.
    expect(followActive([a, d], [a], 1)).toBe(0);

    const cursor = { startTs: 1, sessionId: 's' };
    const paged: RunsList = { filters, hits: [a, b, c, d], total: null, next: cursor, migrating: true };
    const firstPage = refreshList(paged, {
      hits: [a, b],
      total: null,
      next: { startTs: 2, sessionId: 't' },
      migrating: true,
    });
    expect(firstPage.hits.map((h) => h.row.sessionId)).toEqual([a, b, c, d].map((h) => h.row.sessionId));
    expect(firstPage.next).toBe(cursor);
    expect(firstPage.filters).toBe(filters);
  });

  it('the list still says it is bringing history in while migrating, and keeps the typed search', () => {
    const html = renderToStaticMarkup(
      <HistoryPanel
        query={null}
        request={{ tab: 'runs', run: null }}
        retentionDays={30}

        now={NOW_M5}
        initial={{ list: runsList(rows(2), { migrating: true }), input: 'pars' }}
      />,
    );
    expect(html).toContain('Bringing in older history…');
    expect(html).toContain('value="pars"');
  });
});

// ---------------------------------------------------------------------------
// 2. Compare models skips "model unknown"
// ---------------------------------------------------------------------------

function cards(initial: ScorecardsInitial): string {
  return renderToStaticMarkup(<Scorecards query={null} now={NOW_M5} initial={initial} />);
}
const loaded = (list: Scorecard[], role: string): ScorecardsInitial => ({
  load: { ok: true, answer: { scorecards: list, retentionDays: 30 } },
  comparing: { role },
});

describe('Compare models opens on the two known models with the most runs', () => {
  const unknownFirst = [
    scorecard({ role: 'main', model: null, runs: 30 }),
    scorecard({ role: 'main', model: 'claude-opus-5-5', runs: 12 }),
    scorecard({ role: 'main', model: 'claude-haiku-5-5', runs: 4 }),
    scorecard({ role: 'main', model: 'claude-sonnet-5-5', runs: 9 }),
  ];

  it('skips the unknown row even when it has the most runs', () => {
    const [g] = groupScorecards(unknownFirst);
    if (!g) throw new Error('no group');
    expect(g.rows.map((r) => r.model)).toEqual(['model unknown', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(defaultPair(g)).toEqual([1, 2]);
    const html = cards(loaded(unknownFirst, 'main'));
    expect(html).toContain('<span class="sc-compare-label">A</span> <span class="code">Opus 5.5</span>');
    expect(html).toContain('<span class="sc-compare-label">B</span> <span class="code">Sonnet 5.5</span>');
    expect(html).not.toContain(
      `<span class="sc-compare-label">A</span> <span class="code">${SCORECARD_WORDS.modelUnknown}`,
    );
    expect(html).not.toContain(
      `<span class="sc-compare-label">B</span> <span class="code">${SCORECARD_WORDS.modelUnknown}`,
    );
    expect(html).not.toContain(`<option value="0" selected="">`);
    // Still there to choose by hand.
    expect(html).toContain(`<option value="0">${SCORECARD_WORDS.modelUnknown}</option>`);
    expect(html).not.toContain(`<p class="muted sc-too-few">`);
  });

  it('with one known model: no pair, the "too few" words, A on the known model, B not chosen, no table', () => {
    const one = [
      scorecard({ role: 'main', model: null, runs: 30 }),
      scorecard({ role: 'main', model: 'claude-opus-5-5', runs: 12 }),
    ];
    const [g] = groupScorecards(one);
    if (!g) throw new Error('no group');
    expect(defaultPair(g)).toBeNull();
    const html = cards(loaded(one, 'main'));
    expect(html).toContain(`<p class="muted sc-too-few">${SCORECARD_WORDS.tooFew}</p>`);
    expect(html).not.toContain('sc-compare-table');
    // A: opus selected; B: the "—" placeholder; unknown is an option, not a choice made for the user.
    expect(html).toMatch(/<option value="1" selected="">Opus 5\.5<\/option>/);
    expect(html).toMatch(/<option value="" disabled="" selected="">—<\/option>/);
    expect(html).not.toMatch(/<option value="0" selected="">/);
  });

  it('with no known model at all: neither select is chosen', () => {
    const none = [scorecard({ role: 'main', model: null, runs: 3 }), scorecard({ role: 'main', model: null, runs: 2 })];
    const html = cards(loaded(none, 'main'));
    expect(html).toContain(SCORECARD_WORDS.tooFew);
    expect([...html.matchAll(/<option value="" disabled="" selected="">/g)]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. A cut match line says so
// ---------------------------------------------------------------------------

describe('the match line shows where the text was cut', () => {
  const match = (cutStart: boolean, cutEnd: boolean): HistoryMatch => ({
    field: 'prompt',
    text: 'huddle-scratch is stated.',
    cutStart,
    cutEnd,
    ranges: [{ start: 7, end: 14 }],
  });
  const line = (m: HistoryMatch) =>
    matchSegments(m)
      .map((s) => s.text)
      .join('');

  it('cutStart begins with …, cutEnd ends with …, neither has none', () => {
    expect(line(match(true, false))).toBe('…huddle-scratch is stated.');
    expect(line(match(false, true))).toBe('huddle-scratch is stated.…');
    expect(line(match(true, true))).toBe('…huddle-scratch is stated.…');
    expect(line(match(false, false))).toBe('huddle-scratch is stated.');
  });

  it('in the row: the match line under a row starts with … when the core cut the start', () => {
    const [row] = CANNED_ROWS;
    if (!row) throw new Error('fixture');
    const hit: HistorySearchHit = { row, match: match(true, true) };
    expect(rowParts(hit).line).not.toBeNull();
    const html = renderToStaticMarkup(
      <HistoryPanel
        query={null}
        request={{ tab: 'runs', run: null }}
        retentionDays={30}

        now={NOW_M5}
        initial={{
          list: { ...runsList([]), filters: { ...NO_FILTERS, text: 'scratch' }, hits: [hit], total: 1 },
          input: 'scratch',
        }}
      />,
    );
    expect(html).toContain(
      'prompt: <span>…</span><span>huddle-</span><mark>scratch</mark><span> is stated.</span><span>…</span>',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. "Later: Cleared …" in the item's own terms
// ---------------------------------------------------------------------------

describe('the replay says why an item cleared, by kind', () => {
  const ts = new Date(2026, 10, 14, 18, 13).getTime();
  const cleared = { kind: 'cleared', index: 3, ts, reason: 'condition_cleared' } as const;

  it('stuck, budget, loop, file conflict, and anything else', () => {
    expect(laterWords(cleared, 'stuck')).toBe('Cleared at 18:13 when the agent reported again.');
    expect(laterWords(cleared, 'budget')).toBe(
      'Cleared at 18:13 when usage was no longer over the budget, or the budget was set again or removed.',
    );
    expect(laterWords(cleared, 'loop')).toBe(
      'Cleared at 18:13 when the agent moved on: a different or successful tool call, a new prompt, or the end of its turn.',
    );
    expect(laterWords(cleared, 'file_conflict')).toBe(
      'Cleared at 18:13 when the conflict window passed with no new edit, or fewer than two of the agents were still running.',
    );
    expect(laterWords(cleared, 'context_high')).toBe('Cleared at 18:13 by Huddle.');
    expect(laterWords({ ...cleared, reason: 'dismissed' }, 'budget')).toBe('Dismissed at 18:13.');
  });
});

// ---------------------------------------------------------------------------
// 5. The replay names an agent as its tree does
// ---------------------------------------------------------------------------

describe('the replay names the main agent as the replayed tree does', () => {
  // As on real data: the main agent is called "main", and its session has a project folder and no title.
  const index = 15;
  const base = replayState(replayMoment(index).event.ts);
  const main = base.agents[RK.main];
  if (!main) throw new Error('fixture');
  const scratch = 'C:\\code\\huddle-scratch';
  const state = {
    ...base,
    agents: { ...base.agents, [RK.main]: { ...main, name: 'main', cwd: scratch, sessionCwd: scratch } },
  };
  const NO_RENAMES: ReadonlyMap<AgentKey, string> = new Map();

  it('replayName calls the main agent "Lead agent", as the live session view does', () => {
    const node = state.agents[RK.main];
    if (!node) throw new Error('fixture');
    expect(replayName(state, RK.main)).toBe('Lead agent');
    // The label the live views use would say the folder: that is what the moment head said before.
    expect(agentLabel(state, node, NO_RENAMES)).not.toBe('main');
    expect(replayName(state, RK.core)).toBe('core-engineer #1');
    expect(replayName(state, 'nobody')).toBe('—');
  });

  it('the moment head and the tree row say "Lead agent", never "main"', () => {
    const html = renderToStaticMarkup(
      <Replay
        query={null}
        head={replayHead()}
        initial={{ index, moment: { ok: true, moment: replayMoment(index, { state }) } }}
        trackPx={600}
      />,
    );
    expect(html).toContain('<h2 class="rp-agent-name">Lead agent</h2>');
    expect(html).toContain('<span class="tree-name">Lead agent</span>');
    expect(html).not.toContain('>main<');
    expect(html).not.toContain('<h2 class="rp-agent-name">huddle-scratch');
  });

  it('a subagent "reports to Lead agent"', () => {
    const html = renderToStaticMarkup(
      <Replay
        query={null}
        head={replayHead()}
        initial={{ index: 17, moment: { ok: true, moment: replayMoment(17, { state }) } }}
        trackPx={600}
      />,
    );
    expect(html).toContain('<h2 class="rp-agent-name">core-engineer #1</h2>');
    expect(html).toContain('reports to Lead agent');
  });
});
