/**
 * U1 (M5, F22): the History view in the renderer. The list draws the canned rows with outcome glyph and label, `—`
 * for unknown and `≥` for partial tokens; agent text stays text; the search highlight is cut at the core's offsets;
 * "Show 200 more" appends; the filters ask the right questions; `not_available` and `not_found` say so in words;
 * the keyboard path; the title bar order; the palette and live-team ways in.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HISTORY_PAGE_MAX, type HistoryMatch, type QueryResult } from '@huddle/shared';
import { AgentDetail, RunLinks } from './components/AgentDetail.js';
import { Highlighted, HistoryPanel, RunView, type HistoryInitial } from './components/History.js';
import { loadFolders, loadRuns, openRun } from './history-query.js';
import { QUERY_UNAVAILABLE } from './query.js';
import { fixtureState, KEYS } from './testing/fixture.js';
import {
  CANNED_ROWS,
  fakeQuery,
  hits,
  HOSTILE_ROWS,
  manyRows,
  NOW_M5,
  runHead,
  runsList,
} from './testing/m5-fixture.js';
import {
  appendPage,
  dayLabel,
  HISTORY_WORDS,
  historyFailure,
  historyItems,
  isSearchShortcut,
  listKey,
  matchSegments,
  NO_FILTERS,
  runAccessibleName,
  rowParts,
  runsQuery,
  runTitle,
  runTokens,
  splitHighlight,
  type HistoryRequest,
} from './view/history.js';
import { paletteActions } from './view/palette.js';
import { Rail } from './components/Shell.js';
import { RAIL_ITEMS, railCurrent } from './view/shell.js';

const noop = () => undefined;
const RUNS: HistoryRequest = { tab: 'runs', run: null };
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function panel(initial: HistoryInitial, request: HistoryRequest = RUNS, retentionDays: number | null = 30): string {
  return renderToStaticMarkup(
    <HistoryPanel
      query={null}
      request={request}
      retentionDays={retentionDays}

      now={NOW_M5}
      initial={initial}
    />,
  );
}

/** The rendered rows' visible text, one string per `role="option"`, tags stripped. */
function optionTexts(html: string): string[] {
  return [...html.matchAll(/<div[^>]*role="option"[^>]*>([\s\S]*?)<\/div>/g)].map((m) =>
    (m[1] ?? '').replace(/<[^>]+>/g, ''),
  );
}

describe('the runs list', () => {
  const html = panel({ list: runsList(CANNED_ROWS), folders: ['C:\\code\\agent-huddle', 'C:\\code\\voice-scout'] });

  it('draws every canned run under its day header, newest first', () => {
    const rows = optionTexts(html);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('Widget polish');
    expect(rows[1]).toContain('Fix parser tests');
    expect(rows[2]).toContain('Migrate store');
    expect(rows[3]).toContain('“summarize the repo”');
    const days = [...html.matchAll(/class="hist-day"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(days).toEqual(['Today', 'Yesterday', 'Thu 12 Nov']);
    expect(html).toContain('aria-label="History"');
    expect(html).toContain('role="listbox"');
  });

  it('shows the outcome glyph and label together, ◇ for no end recorded', () => {
    const rows = optionTexts(html);
    expect(rows[0]).toContain('●running');
    expect(rows[1]).toContain('✓completed');
    expect(rows[2]).toContain('✕failed');
    expect(rows[3]).toContain('◇no end recorded');
    // The live run breathes like a working agent.
    expect(html).toMatch(/class="glyph is-working" data-status="working"[^>]*>●</);
  });

  it('shows unknown as —, partial tokens with ≥, the time so far of a running run', () => {
    const rows = optionTexts(html);
    expect(rows[0]).toContain('≥61k');
    // Outcome says running; Took says how long so far instead of repeating it.
    expect(rows[0]).toMatch(/running.*so far/);
    expect(rows[1]).toContain('182k');
    expect(rows[1]).toContain('Opus 5.5 +2');
    expect(rows[1]).toContain('21 min 28 s');
    expect(rows[2]).toContain('1.2M');
    expect(rows[3]).toContain('—');
    expect(html).toContain(esc('at least 61k tokens (at least: some agents have no usage record)'));
    expect(runTokens(null).text).toBe('—');
  });

  it('puts the folder name in mono with the full path in the tooltip, and the topic after the title', () => {
    expect(html).toContain(`class="hc-folder code" title="${esc('C:\\code\\voice-scout')}"><span>voice-scout</span><`);
    expect(html).toContain('<span class="hc-topic"><span>“fix the failing parser tests”</span></span>');
    expect(runTitle({ title: null, topic: null }).title).toBe('Untitled run');
  });

  it('has the toolbar, the filters from history.folders, and the retention footer', () => {
    expect(html).toContain('placeholder="Search title, folder or prompt…"');
    expect(html).toContain('>Search runs</label>');
    expect(html).toContain('<option value="no_end">No end recorded</option>');
    expect(html).toContain(`<option value="${esc('C:\\code\\voice-scout')}"`);
    expect(html).toContain('Runs older than 30 days are deleted. Change this in Settings.');
    expect(panel({ list: runsList(CANNED_ROWS) }, RUNS, 7)).toContain('Runs older than 7 days are deleted.');
    expect(html).not.toContain(HISTORY_WORDS.clearFilters);
  });

  it('gives each row an accessible name with every column and its unit', () => {
    const [first] = hits(CANNED_ROWS.slice(1, 2));
    if (!first) throw new Error('no row');
    expect(runAccessibleName(first, 'Today')).toBe(
      'Fix parser tests “fix the failing parser tests”, completed, folder agent-huddle, started Today 15:00, ' +
        'took 21 min 28 s, model Opus 5.5 +2, 182k tokens, 3 agents',
    );
  });

  it('draws only the rows in view (windowing), not every stored run', () => {
    const big = panel({ list: runsList(manyRows(600)) });
    const drawn = optionTexts(big).length;
    expect(drawn).toBeGreaterThan(20);
    expect(drawn).toBeLessThan(60);
    expect(big).toContain('aria-setsize="600"');
  });
});

describe('agent text is text', () => {
  const html = panel({ list: runsList(HOSTILE_ROWS) });

  it('escapes markup in titles, topics and folders', () => {
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows Markdown as typed', () => {
    expect(html).toContain('**bold** # heading');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<h1>bold');
  });

  it('keeps a hostile run title as text in the run view head', () => {
    const row = HOSTILE_ROWS[0];
    if (!row) throw new Error('no row');
    const run = renderToStaticMarkup(
      <RunView
        query={null}
        sessionId={row.sessionId}
        tab={null}
        now={NOW_M5}
        onBack={noop}
        initialHead={{ ok: true, head: runHead(row) }}
      />,
    );
    expect(run).not.toContain('<img src=x');
    expect(run).toContain('&lt;img src=x onerror=alert(1)&gt;</h1>');
  });
});

describe('search highlight', () => {
  it('splits the plain text at the returned offsets', () => {
    expect(splitHighlight('fix the failing parser tests', [{ start: 16, end: 22 }])).toEqual([
      { text: 'fix the failing ', mark: false },
      { text: 'parser', mark: true },
      { text: ' tests', mark: false },
    ]);
    expect(
      splitHighlight('aa bb cc', [
        { start: 6, end: 8 },
        { start: 0, end: 2 },
      ]),
    ).toEqual([
      { text: 'aa', mark: true },
      { text: ' bb ', mark: false },
      { text: 'cc', mark: true },
    ]);
  });

  it('survives bad ranges: out of bounds, empty, overlapping', () => {
    expect(
      splitHighlight('abcdef', [
        { start: -3, end: 2 },
        { start: 1, end: 4 },
        { start: 4, end: 4 },
        { start: 5, end: 99 },
      ]),
    ).toEqual([
      { text: 'ab', mark: true },
      { text: 'cde', mark: false },
      { text: 'f', mark: true },
    ]);
    expect(splitHighlight('abc', [])).toEqual([{ text: 'abc', mark: false }]);
  });

  it('adds … where the snippet was cut and renders marks as elements around text nodes', () => {
    const match: HistoryMatch = {
      field: 'prompt',
      text: 'run <b>parser</b> now',
      cutStart: true,
      cutEnd: true,
      ranges: [{ start: 7, end: 13 }],
    };
    expect(matchSegments(match).map((s) => s.text)).toEqual(['…', 'run <b>', 'parser', '</b> now', '…']);
    const html = renderToStaticMarkup(<Highlighted segments={matchSegments(match)} />);
    expect(html).toBe(
      '<span>…</span><span>run &lt;b&gt;</span><mark>parser</mark><span>&lt;/b&gt; now</span><span>…</span>',
    );
  });

  it('shows the match line under the row and the count on a search page', () => {
    const [row] = CANNED_ROWS.slice(1, 2);
    if (!row) throw new Error('no row');
    const list = {
      ...runsList([]),
      filters: { ...NO_FILTERS, text: 'parser' },
      hits: [
        {
          row,
          match: {
            field: 'prompt' as const,
            text: 'then rerun the parser suite',
            cutStart: true,
            cutEnd: false,
            ranges: [{ start: 15, end: 21 }],
          },
        },
      ],
      total: 1,
    };
    const html = panel({ list, input: 'parser' });
    expect(html).toContain('1 run matches');
    // The row grows to two lines; the match line is the row's last cell, after the agents column.
    expect(html).toMatch(/class="hist-row[^"]* has-match"/);
    expect(html).toMatch(
      /<span class="hc-agents"[^>]*>\d+<\/span><span class="hc-match" title="…then rerun the parser suite">prompt: <span>…<\/span><span>then rerun the <\/span><mark>parser<\/mark><span> suite<\/span><\/span><\/div>/,
    );
    // The topic stays in the title cell, plain.
    expect(html).toContain('<span class="hc-topic"><span>“fix the failing parser tests”</span></span>');
    // The list's height counts the 44 px row: a day header (28) and the row (44).
    expect(html).toContain('style="height:72px"');
    expect(panel({ list: { ...list, total: 12 } })).toContain('12 runs match');
    expect(panel({ list: { ...list, total: null } })).toContain('— runs match');
  });
});

describe('where a match is marked', () => {
  const [, fix, migrate, untitled] = CANNED_ROWS;
  if (!fix || !migrate || !untitled) throw new Error('no row');
  const whole = (text: string, start: number, end: number, field: HistoryMatch['field']): HistoryMatch => ({
    field,
    text,
    cutStart: false,
    cutEnd: false,
    ranges: [{ start, end }],
  });
  const marked = (segs: readonly { text: string; mark: boolean }[]) => segs.filter((s) => s.mark).map((s) => s.text);
  const one = (hit: { row: (typeof CANNED_ROWS)[number]; match: HistoryMatch | null }) =>
    panel({ list: { ...runsList([]), hits: [hit], total: 1 } });

  it('a topic match goes on the match line, even when it is the whole topic (the title cell ellipsizes)', () => {
    const m = whole('move the event store to SQLite and keep the JSONL reader', 24, 30, 'topic');
    const parts = rowParts({ row: migrate, match: m });
    expect(parts.line).toBe(m);
    expect(marked(parts.title)).toEqual([]);
    expect(parts.topic?.map((s) => s.text).join('')).toBe('“move the event store to SQLite and keep the JSONL reader”');
    expect(one({ row: migrate, match: m })).toContain(
      'prompt: <span>move the event store to </span><mark>SQLite</mark><span> and keep the JSONL reader</span>',
    );
  });

  it('an untitled run keeps its quoted topic as the title and gets the match line', () => {
    const m = whole('summarize the repo', 14, 18, 'topic');
    const parts = rowParts({ row: untitled, match: m });
    expect(parts.title.map((s) => s.text).join('')).toBe('“summarize the repo”');
    expect(parts.line).toBe(m);
  });

  it('a title match is marked inside the title cell, with no match line', () => {
    const m = whole('Fix parser tests', 4, 10, 'title');
    expect(rowParts({ row: fix, match: m })).toMatchObject({
      title: [
        { text: 'Fix ', mark: false },
        { text: 'parser', mark: true },
        { text: ' tests', mark: false },
      ],
      line: null,
    });
    const html = one({ row: fix, match: m });
    expect(html).toContain(
      '<span class="hc-title-text"><span>Fix </span><mark>parser</mark><span> tests</span></span>',
    );
    expect(html).not.toContain('has-match');
    expect(html).not.toContain('hc-match');
  });

  it('a folder match is marked inside the folder cell when the words are in the folder name', () => {
    const m = whole('C:\\code\\agent-huddle', 14, 20, 'folder'); // "huddle"
    const parts = rowParts({ row: fix, match: m });
    expect(parts.folder).toEqual([
      { text: 'agent-', mark: false },
      { text: 'huddle', mark: true },
    ]);
    expect(parts.line).toBeNull();
    const html = one({ row: fix, match: m });
    expect(html).toContain(
      '<span class="hc-folder code" title="C:\\code\\agent-huddle"><span>agent-</span><mark>huddle</mark></span>',
    );
    expect(html).not.toContain('hc-match');
  });

  it('a folder match only in the parent path, a cut snippet or a text that does not line up gets the match line', () => {
    const parent = whole('C:\\code\\agent-huddle', 3, 7, 'folder'); // "code"
    expect(rowParts({ row: fix, match: parent }).line).toBe(parent);
    expect(marked(rowParts({ row: fix, match: parent }).folder)).toEqual([]);
    expect(one({ row: fix, match: parent })).toContain('folder: <span>C:\\</span><mark>code</mark>');
    const cut = { ...whole('Fix parser', 4, 10, 'title'), cutEnd: true };
    expect(rowParts({ row: fix, match: cut }).line).toBe(cut);
    const other = whole('Another title', 0, 7, 'title');
    expect(rowParts({ row: fix, match: other }).line).toBe(other);
    expect(rowParts({ row: fix, match: null })).toMatchObject({
      line: null,
      folder: [{ text: 'agent-huddle', mark: false }],
    });
  });

  it('hostile text in a match stays literal in the title cell, the folder cell and the match line', () => {
    const [h1, h2] = HOSTILE_ROWS;
    if (!h1 || !h2 || h1.title === null || h2.folder === null) throw new Error('no hostile row');
    const folder = h2.folder;
    const html = panel({
      list: {
        ...runsList([]),
        hits: [
          { row: h1, match: whole(h1.title, 0, 4, 'title') }, // "<img"
          { row: h2, match: whole(folder, folder.length - 2, folder.length, 'folder') }, // "b>", the name shown
          {
            row: { ...h1, sessionId: 'hostile-3' },
            match: {
              field: 'prompt',
              text: 'x <script>alert(1)</script> y',
              cutStart: false,
              cutEnd: false,
              ranges: [{ start: 2, end: 10 }],
            },
          },
        ],
        total: 3,
      },
    });
    expect(html).not.toMatch(/<(script|img|b)[\s>]/);
    expect(html).toContain('<mark>&lt;img</mark>');
    expect(html).toContain('<mark>b&gt;</mark>');
    expect(html).toContain('<mark>&lt;script&gt;</mark>');
  });
});

describe('paging', () => {
  it('appends the next page after the rows shown and does not repeat a row', () => {
    const first = runsList(manyRows(200), { next: { startTs: NOW_M5 - 199 * 60_000, sessionId: 'run-0199' } });
    const page = { hits: hits([...manyRows(1, 199), ...manyRows(50, 200)]), total: null, next: null, migrating: false };
    const after = appendPage(first, page);
    expect(after.hits).toHaveLength(250);
    expect(after.hits[200]?.row.sessionId).toBe('run-0200');
    expect(after.next).toBeNull();
    expect(after.filters).toBe(first.filters);
  });

  it('asks for the next page from the cursor, with the same filters', async () => {
    const cursor = { startTs: 123, sessionId: 'run-0199' };
    const fake = fakeQuery(() => ({
      ok: true,
      type: 'history.list',
      page: { rows: [], next: null, migrating: false },
    }));
    await loadRuns(fake.fn, { text: '', outcome: 'failed', folder: null }, cursor);
    expect(fake.asked).toEqual([{ type: 'history.list', limit: HISTORY_PAGE_MAX, before: cursor, outcome: 'failed' }]);
  });

  it('shows "Show 200 more" only while there is a next page', () => {
    const next = { startTs: 1, sessionId: 'x' };
    expect(panel({ list: runsList(CANNED_ROWS, { next }) })).toContain('>Show 200 more</button>');
    expect(panel({ list: runsList(CANNED_ROWS) })).not.toContain('Show 200 more');
  });
});

describe('filters and the questions they send', () => {
  it('lists without search text, searches with it', () => {
    expect(runsQuery(NO_FILTERS)).toEqual({ type: 'history.list', limit: 200 });
    expect(runsQuery({ text: '   ', outcome: null, folder: null })).toEqual({ type: 'history.list', limit: 200 });
    expect(runsQuery({ text: ' parser ', outcome: 'completed', folder: 'C:\\code\\agent-huddle' })).toEqual({
      type: 'history.search',
      text: 'parser',
      limit: 200,
      outcome: 'completed',
      folder: 'C:\\code\\agent-huddle',
    });
    expect(runsQuery({ text: 'x'.repeat(500), outcome: null, folder: null })).toMatchObject({ text: 'x'.repeat(200) });
  });

  it('sends the query through the bridge and reads a search page', async () => {
    const [row] = CANNED_ROWS;
    if (!row) throw new Error('no row');
    const fake = fakeQuery(() => ({
      ok: true,
      type: 'history.search',
      page: { hits: [{ row, match: null }], total: 1, next: null, migrating: true },
    }));
    const r = await loadRuns(fake.fn, { text: 'widget', outcome: 'running', folder: null });
    expect(fake.asked).toEqual([{ type: 'history.search', text: 'widget', limit: 200, outcome: 'running' }]);
    expect(r).toMatchObject({ ok: true, total: 1, migrating: true });
  });

  it('reads the folder list and the run head', async () => {
    const fake = fakeQuery((q) =>
      q.type === 'history.folders'
        ? { ok: true, type: 'history.folders', folders: ['C:\\a', 'C:\\b'] }
        : { ok: false, code: 'not_found', message: 'no such run' },
    );
    expect(await loadFolders(fake.fn)).toEqual({ ok: true, folders: ['C:\\a', 'C:\\b'] });
    expect(await openRun(fake.fn, 'gone')).toEqual({ ok: false, code: 'not_found', message: 'no such run' });
    expect(fake.asked[1]).toEqual({ type: 'history.open', sessionId: 'gone' });
  });

  it('reads an answer of the wrong type or shape as failed, and a missing bridge as unavailable', async () => {
    const wrong = fakeQuery(() => ({ ok: true, type: 'history.folders', folders: [] }));
    expect(await loadRuns(wrong.fn, NO_FILTERS)).toMatchObject({ ok: false, code: 'failed' });
    const bad = fakeQuery(
      () => ({ ok: true, type: 'history.list', page: { rows: [{ nope: 1 }] } }) as unknown as QueryResult,
    );
    expect(await loadRuns(bad.fn, NO_FILTERS)).toMatchObject({ ok: false, code: 'failed' });
    expect(await loadRuns(null, NO_FILTERS)).toEqual({ ok: false, code: 'unsupported', message: QUERY_UNAVAILABLE });
  });

  it('shows Clear filters while a filter is set, and words for a filtered empty list', () => {
    const filtered = runsList([], { filters: { text: '', outcome: 'failed', folder: null } });
    const html = panel({ list: filtered });
    expect(html).toContain('>Clear filters</button>');
    expect(html).toContain('No runs match these filters.');
    expect(html).toContain('<option value="failed" selected="">Failed</option>');
  });
});

describe('states', () => {
  it('empty: names the retention', () => {
    expect(panel({ list: runsList([]) }, RUNS, 30)).toContain(
      'No runs stored yet. Every session that reports to Huddle is kept here for 30 days.',
    );
  });

  it('no match: names the query and offers Clear search', () => {
    const html = panel({ list: runsList([], { filters: { ...NO_FILTERS, text: 'zebra' }, total: 0 }), input: 'zebra' });
    expect(html).toContain('No runs match “zebra”.');
    expect(html).toContain('>Clear search</button>');
    // One message: the head does not also say "0 runs match".
    expect(html).not.toMatch(/\d+ runs match|— runs match/);
    expect(html.match(/No runs match/g)).toHaveLength(1);
  });

  it('migrating: a muted line above the rows that have arrived', () => {
    const html = panel({ list: runsList(CANNED_ROWS, { migrating: true }) });
    expect(html).toContain('Bringing in older history…');
    expect(optionTexts(html)).toHaveLength(4);
  });

  it('loading is not shown at once (it waits 300 ms so it does not flash)', () => {
    expect(panel({})).not.toContain('Loading history…');
  });

  it('not_available: says so in plain words, no Try again', () => {
    const html = panel({ listError: { ok: false, code: 'not_available', message: 'WP4b' } });
    expect(html).toContain('History isn&#x27;t available yet in this build.');
    expect(html).not.toContain('Try again');
    expect(html).not.toContain('WP4b');
  });

  it('error: what happened and Try again', () => {
    const html = panel({ listError: { ok: false, code: 'failed', message: 'database is locked.' } });
    expect(html).toContain('Couldn&#x27;t read the history: database is locked. The live team is not affected.');
    expect(html).toContain('>Try again</button>');
    expect(historyFailure({ ok: false, code: 'unsupported', message: QUERY_UNAVAILABLE })).toBe(
      HISTORY_WORDS.notAvailable,
    );
  });

  it('Scorecards tab: shows the scorecard view (U3), not the runs list', () => {
    const html = panel({ list: runsList(CANNED_ROWS) }, { tab: 'scorecards', run: null });
    expect(html).toContain('class="scorecards"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Scorecards</);
    expect(html).not.toContain('role="listbox"');
  });
});

describe('the run view', () => {
  const row = CANNED_ROWS[1];
  if (!row) throw new Error('no row');
  const view = (initialHead: Parameters<typeof RunView>[0]['initialHead'], tab: 'report' | 'replay' | null = null) =>
    renderToStaticMarkup(
      <RunView query={null} sessionId={row.sessionId} tab={tab} now={NOW_M5} onBack={noop} initialHead={initialHead} />,
    );

  it('shows the shared head: back, tabs, title, folder, start, duration, outcome, origin, topic', () => {
    const html = view({ ok: true, head: runHead(row, { hasReport: true }) });
    expect(html).toContain('>← All runs</button>');
    expect(html).toContain('<h1 class="agent-name">Fix parser tests</h1>');
    expect(html).toContain(`>${esc('C:\\code\\agent-huddle')}</span>`);
    expect(html).toContain('Today 15:00');
    expect(html).toContain('21 min 28 s');
    expect(html).toContain('✓</span><span class="status-label">completed</span>');
    expect(html).toContain('launched by Huddle');
    expect(html).toContain('“fix the failing parser tests”');
  });

  it('opens on Report when the run has a report, else on Replay, unless a tab was asked for', () => {
    const selected = (html: string) => /aria-selected="true"[^>]*>(Report|Replay)</.exec(html)?.[1];
    expect(selected(view({ ok: true, head: runHead(row, { hasReport: true }) }))).toBe('Report');
    expect(selected(view({ ok: true, head: runHead(row, { hasReport: false }) }))).toBe('Replay');
    expect(selected(view({ ok: true, head: runHead(row, { hasReport: true }) }, 'replay'))).toBe('Replay');
    expect(view({ ok: true, head: runHead(row) })).toContain('Replay · not live');
  });

  it('not_found and not_available say so in words, with the way back', () => {
    const gone = view({ ok: false, code: 'not_found', message: 'no such run' });
    expect(gone).toContain(esc(HISTORY_WORDS.notFound));
    expect(gone).toContain('← All runs');
    expect(gone).not.toContain('role="tab"');
    const later = view({ ok: false, code: 'not_available', message: 'not yet' });
    expect(later).toContain('History isn&#x27;t available yet in this build.');
  });

  it('opens straight on a run asked for from the live team', () => {
    const html = panel(
      { list: runsList(CANNED_ROWS), head: { ok: true, head: runHead(row) } },
      { tab: 'runs', run: { sessionId: row.sessionId, tab: 'report' } },
    );
    expect(html).toContain('<h1 class="agent-name">Fix parser tests</h1>');
    expect(html).toMatch(/aria-selected="true"[^>]*>Report</);
    expect(html).not.toContain('role="listbox"');
  });
});

describe('keyboard', () => {
  it('moves, jumps, pages, opens, and goes back up to the search', () => {
    expect(listKey('ArrowDown', 0, 5)).toEqual({ kind: 'move', index: 1 });
    expect(listKey('ArrowDown', 4, 5)).toEqual({ kind: 'move', index: 4 });
    expect(listKey('ArrowUp', 3, 5)).toEqual({ kind: 'move', index: 2 });
    expect(listKey('ArrowUp', 0, 5)).toEqual({ kind: 'search' });
    expect(listKey('Home', 3, 5)).toEqual({ kind: 'move', index: 0 });
    expect(listKey('End', 0, 5)).toEqual({ kind: 'move', index: 4 });
    expect(listKey('PageDown', 1, 50, 10)).toEqual({ kind: 'move', index: 11 });
    expect(listKey('PageDown', 45, 50, 10)).toEqual({ kind: 'move', index: 49 });
    expect(listKey('PageUp', 5, 50, 10)).toEqual({ kind: 'move', index: 0 });
    expect(listKey('Enter', 2, 5)).toEqual({ kind: 'open', index: 2 });
    expect(listKey('Enter', 9, 5)).toEqual({ kind: 'open', index: 4 });
    expect(listKey('x', 0, 5)).toEqual({ kind: 'none' });
    expect(listKey('Enter', 0, 0)).toEqual({ kind: 'none' });
  });

  it('Ctrl+F always and / outside a text field focus the search', () => {
    const k = (key: string, ctrlKey = false) => ({ key, ctrlKey, altKey: false, metaKey: false });
    expect(isSearchShortcut(k('f', true), true)).toBe(true);
    expect(isSearchShortcut(k('F', true), false)).toBe(true);
    expect(isSearchShortcut(k('/'), false)).toBe(true);
    expect(isSearchShortcut(k('/'), true)).toBe(false);
    expect(isSearchShortcut(k('f'), false)).toBe(false);
  });

  it('marks the active row for aria-activedescendant; day headers are not focus stops', () => {
    const html = panel({ list: runsList(CANNED_ROWS), active: 2 });
    const id = /aria-activedescendant="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`id="${id ?? ''}" role="option" aria-selected="true" aria-posinset="3"`);
    expect(html).toMatch(/class="hist-day" role="presentation" aria-hidden="true"/);
    expect(html.match(/tabindex="0"/g)?.length).toBe(2); // the Runs tab and the list, not each row
  });

  it('day headers: Today, Yesterday, weekday within a week, then the full date', () => {
    const at = (d: number, h = 9) => new Date(2026, 10, d, h).getTime();
    expect(dayLabel(at(14), NOW_M5)).toBe('Today');
    expect(dayLabel(at(13, 23), NOW_M5)).toBe('Yesterday');
    expect(dayLabel(at(12), NOW_M5)).toBe('Thu 12 Nov');
    expect(dayLabel(at(8), NOW_M5)).toBe('Sun 8 Nov');
    expect(dayLabel(at(7), NOW_M5)).toBe('7 Nov 2026');
    expect(historyItems(hits(CANNED_ROWS), NOW_M5).map((i) => i.kind)).toEqual([
      'day',
      'run',
      'run',
      'day',
      'run',
      'day',
      'run',
    ]);
  });
});

describe('ways in', () => {
  it('rail: Home, History, Library, Settings, then Guide at the bottom; History current', () => {
    expect(RAIL_ITEMS.map((b) => b.label)).toEqual(['Home', 'History', 'Library', 'Settings', 'Guide']);
    const html = renderToStaticMarkup(<Rail current="history" onPlace={noop} />);
    expect([...html.matchAll(/class="rail-word" aria-hidden="true">([^<]+)</g)].map((m) => m[1])).toEqual([
      'Home',
      'History',
      'Library',
      'Settings',
      'Guide',
    ]);
    expect(html).toMatch(/aria-current="page" aria-label="History: past runs and scorecards"/);
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    // Scorecards stay a tab of History; Templates and Rules are Library's tabs.
    expect(railCurrent('history')).toBe('history');
    expect(railCurrent('library')).toBe('library');
  });

  it('palette: Show history and Show scorecards', () => {
    const actions = paletteActions(fixtureState(), new Map());
    const pick = (id: string) => actions.find((a) => a.id === id);
    expect(pick('history')).toMatchObject({ label: 'Show history', effect: { kind: 'history', tab: 'runs' } });
    expect(pick('scorecards')).toMatchObject({
      label: 'Show scorecards',
      effect: { kind: 'history', tab: 'scorecards' },
    });
  });

  it('live team: a main agent offers Replay this run, and Open the report once the session ended', () => {
    const state = fixtureState();
    const main = state.agents[KEYS.main];
    const core = state.agents[KEYS.core];
    if (!main || !core) throw new Error('fixture');
    const live = renderToStaticMarkup(<RunLinks agent={{ ...main, endedAt: null }} onOpenRun={noop} />);
    expect(live).toContain('>Replay this run</button>');
    expect(live).not.toContain('Open the report');
    const ended = renderToStaticMarkup(<RunLinks agent={{ ...main, endedAt: NOW_M5 }} onOpenRun={noop} />);
    expect(ended).toContain('>Open the report</button>');
    expect(renderToStaticMarkup(<RunLinks agent={core} onOpenRun={noop} />)).toBe('');
  });

  it('the agent detail head carries the links only when it can open a run', () => {
    const state = fixtureState();
    const main = state.agents[KEYS.main];
    if (!main) throw new Error('fixture');
    const props = {
      state,
      agent: main,
      renames: new Map(),
      onRename: () => Promise.resolve({ ok: true as const }),
      onSelect: noop,
      section: 'now' as const,
      onSection: noop,
      timeline: { rows: [], loading: false },
      filter: 'all' as const,
      onFilter: noop,
      now: NOW_M5,
    };
    expect(renderToStaticMarkup(<AgentDetail {...props} onOpenRun={noop} />)).toContain('Replay this run');
    expect(renderToStaticMarkup(<AgentDetail {...props} />)).not.toContain('Replay this run');
  });
});

describe('prompt titles (cleanPromptTitle)', () => {
  it('a topic loses Claude Code tag blocks; one that is only tags reads "Untitled run"', () => {
    expect(runTitle({ title: null, topic: '<pasted_content id="1">x</pasted_content> fix the parser' })).toEqual({
      title: '“fix the parser”',
      topic: null,
    });
    expect(runTitle({ title: null, topic: '<command-name>/clear</command-name>' })).toEqual({
      title: HISTORY_WORDS.untitled,
      topic: null,
    });
    expect(runTitle({ title: 'Parser', topic: '<system-reminder>x</system-reminder>go' })).toEqual({
      title: 'Parser',
      topic: '“go”',
    });
  });

  it('the search row cells use the same cleaned topic', () => {
    const row = HOSTILE_ROWS[0];
    if (!row) throw new Error('no row');
    const parts = rowParts({
      row: { ...row, title: null, topic: '<command-message>m</command-message>add paging' },
      match: null,
    });
    expect(parts.title.map((s) => s.text).join('')).toBe('“add paging”');
  });
});
