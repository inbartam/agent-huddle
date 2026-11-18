/**
 * U3 (M5, F24): History's Scorecards tab. Grouped by role (roles and models by runs); values resting on fewer than
 * MIN_PRIOR_SAMPLES finished runs are muted and the row says "few runs"; "Used for estimates" agrees with
 * `priorUnitMsFor` for every card; the comparison shows both models and the difference in neutral words, or "Too few
 * finished runs to compare"; unknown is `—`; empty, loading and not_available say so in words.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MIN_PRIOR_SAMPLES, priorUnitMsFor } from '@huddle/shared';
import { HistoryPanel } from './components/History.js';
import { Scorecards, type ScorecardsInitial } from './components/Scorecards.js';
import { loadScorecards } from './report-query.js';
import { fixtureState, XSS } from './testing/fixture.js';
import { CANNED_SCORECARDS, fakeQuery, NOW_M5, runsList, scorecard } from './testing/m5-fixture.js';
import { paletteActions } from './view/palette.js';
import {
  compareRows,
  groupScorecards,
  perTaskTime,
  SCORECARD_WORDS,
  scorecardsIntro,
  timeDiff,
  tokensDiff,
  usedForEstimates,
} from './view/scorecards.js';

const MIN = 60_000;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function cards(initial: ScorecardsInitial): string {
  return renderToStaticMarkup(<Scorecards query={null} now={NOW_M5} initial={initial} />);
}

const loaded = (list = CANNED_SCORECARDS, comparing: ScorecardsInitial['comparing'] = null): ScorecardsInitial => ({
  load: { ok: true, answer: { scorecards: list, retentionDays: 30 } },
  comparing,
});

/** Each model row's cells as text, tags stripped. */
function modelRows(html: string): string[] {
  return [...html.matchAll(/<tr class="sc-model[^"]*">([\s\S]*?)<\/tr>/g)].map((m) =>
    (m[1] ?? '')
      .replace(/<\/t[dh]>/g, ' | ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

describe('grouping', () => {
  it('roles by runs, models by runs within a role', () => {
    const g = groupScorecards(CANNED_SCORECARDS);
    expect(g.map((x) => [x.role, x.runs])).toEqual([
      ['Explore', 40],
      ['core-engineer', 14],
      ['main', 8],
    ]);
    expect(g[1]?.rows.map((r) => r.model)).toEqual(['Sonnet 5.5', 'Haiku 5.5']);
  });

  it('draws a row group per role with its model count, and "Compare models" only with two or more', () => {
    const html = cards(loaded());
    expect(html).toMatch(
      /<th scope="rowgroup"[^>]*><span class="sc-role-name">core-engineer<\/span><span class="section-note">2 models<\/span>/,
    );
    expect(html).toMatch(/<span class="sc-role-name">Explore<\/span><span class="section-note">1 model<\/span>/);
    expect(html.match(/>Compare models<\/button>/g)?.length).toBe(1);
    expect(html).toContain(esc(scorecardsIntro(30)));
    for (const c of [
      'Role and model',
      'Runs',
      'Tasks',
      'Time per task',
      'Tokens per task',
      'Failed runs',
      'Failed tool calls',
      'Approvals',
      'Stuck',
      'Used for estimates',
    ]) {
      expect(html).toContain(`>${c}</th>`);
    }
  });

  it('model rows: values with n, rates, counts, "Used for estimates"', () => {
    const rows = modelRows(cards(loaded()));
    expect(rows[0]).toBe('Haiku 5.5 | 40 | 0 | 1.1 min n=38 | 6.0k n=38 | 3% | 2% | 0 | 2 | yes |');
    expect(rows[1]).toBe('Sonnet 5.5 | 12 | 41 | 4.2 min n=10 | 18k n=10 | 8% | 3% | 9 | 1 | yes |');
    expect(rows[2]).toBe('Haiku 5.5few runs | 2 | 3 | 2.1 min n=2 | 9.0k n=2 | 0% | 1% | 0 | 0 | needs 3 runs |');
  });
});

describe('small samples', () => {
  const html = cards(loaded());

  it('mutes the values, says "few runs" in words, and explains in the tooltip', () => {
    expect(html).toContain('<tr class="sc-model is-few">');
    expect(html).toContain(`<span class="sc-few">${SCORECARD_WORDS.fewRuns}</span>`);
    expect(html).toContain(
      '<span class="sc-value is-small" title="Only 2 finished runs: one long run can set this number alone.">2.1 min',
    );
    expect(html).toContain('<span class="sc-value">4.2 min');
    expect(SCORECARD_WORDS.needsRuns).toBe(`needs ${String(MIN_PRIOR_SAMPLES)} runs`);
  });

  it('"Used for estimates" says yes exactly when priorUnitMsFor would use that row', () => {
    const list = [
      ...CANNED_SCORECARDS,
      scorecard({ role: 'ui-engineer', model: 'claude-opus-5-5', sampleSize: 3 }),
      scorecard({ role: 'ui-engineer', model: 'claude-sonnet-5-5', sampleSize: 2 }),
      // A second card for the same pair (a core bug): priorUnitMsFor takes the first, so this one is not used.
      scorecard({ role: 'ui-engineer', model: 'claude-opus-5-5', sampleSize: 9, medianTaskMs: 99 * MIN }),
    ];
    for (const card of list) {
      const prior = priorUnitMsFor(list, card.role, card.model);
      const first = list.find((c) => c.role === card.role && c.model === card.model);
      expect(usedForEstimates(list, card) === 'yes').toBe(
        prior !== null && first === card && prior === card.medianTaskMs,
      );
    }
    const at = (i: number) => {
      const c = list[i];
      if (!c) throw new Error('fixture');
      return c;
    };
    expect(usedForEstimates(list, at(4))).toBe('yes'); // n=3 is enough
    expect(usedForEstimates(list, at(5))).toBe('needs_runs');
    expect(usedForEstimates(list, at(6))).toBe('no');
  });
});

describe('unknown is —', () => {
  it('a model never seen, no finished run: "model unknown", — values, n=0', () => {
    const rows = modelRows(cards(loaded()));
    expect(rows[3]).toBe('model unknownfew runs | 8 | 5 | — n=0 | — n=0 | — | — | 0 | 0 | needs 3 runs |');
    expect(perTaskTime(null)).toBe('—');
  });
});

describe('compare models', () => {
  it('the block shows both models, the selects, the too-few text and the caveat', () => {
    const html = cards(loaded(CANNED_SCORECARDS, { role: 'core-engineer' }));
    expect(html).toContain('aria-expanded="true">Compare models</button>');
    expect(html).toContain('<span>Model A</span>');
    expect(html).toContain('<span>Model B</span>');
    expect(html).toContain('<span class="sc-compare-label">A</span> <span class="code">Sonnet 5.5</span>');
    expect(html).toContain('<span class="sc-compare-label">B</span> <span class="code">Haiku 5.5</span>');
    expect(html).toContain('<td>4.2 min n=10</td><td>2.1 min n=2</td>');
    expect(html).toContain(`<td class="muted">${SCORECARD_WORDS.tooFew}</td>`);
    expect(html).toContain(SCORECARD_WORDS.caveat);
    expect(html).toContain('>Close comparison</button>');
    expect(html).not.toMatch(/better|worse/i);
  });

  it('with enough runs on both sides, the difference is plain and neutral', () => {
    const a = scorecard({
      role: 'core-engineer',
      model: 'claude-sonnet-5-5',
      medianTaskMs: 4.2 * MIN,
      tokensPerTask: 18_000,
      failureRate: 0.08,
      runs: 10,
      approvalsRequested: 9,
    });
    const b = scorecard({
      role: 'core-engineer',
      model: 'claude-haiku-5-5',
      medianTaskMs: 2.1 * MIN,
      tokensPerTask: 9_000,
      failureRate: 0,
      runs: 5,
    });
    const rows = compareRows(a, b, NOW_M5);
    const diff = (metric: string) => rows.find((r) => r.metric === metric)?.diff;
    expect(diff('Time per task')).toBe('Haiku 5.5 takes 2.1 min less per task');
    expect(diff('Tokens per task')).toBe('Haiku 5.5 uses 9.0k fewer tokens per task');
    expect(diff('Failed runs')).toBe('8% vs 0%');
    expect(diff('Approvals per run')).toBe('0.9 vs 0.0');
    expect(diff('Runs')).toBeNull();
    expect(rows.map((r) => r.metric)).toEqual([
      'Time per task',
      'Tokens per task',
      'Failed runs',
      'Failed tool calls',
      'Approvals per run',
      'Stuck per run',
      'Runs',
      'First run',
      'Last run',
    ]);
    expect(rows.some((r) => r.tooFew)).toBe(false);

    const html = cards(loaded([a, b], { role: 'core-engineer' }));
    expect(html).toContain('<td class="sc-diff">Haiku 5.5 takes 2.1 min less per task</td>');
    expect(html).toContain('<td class="sc-diff">8% vs 0%</td>');
  });

  it('either side below 3: values still show, every difference says too few', () => {
    const a = scorecard({ role: 'r', model: 'm1', sampleSize: 10 });
    const b = scorecard({ role: 'r', model: 'm2', sampleSize: 2, tokenSampleSize: 2 });
    const rows = compareRows(a, b, NOW_M5);
    expect(rows.filter((r) => r.diff !== null).every((r) => r.diff === SCORECARD_WORDS.tooFew)).toBe(true);
    expect(rows[0]?.b).toBe('3.0 min n=2');
    expect(SCORECARD_WORDS.tooFew).toBe('Too few finished runs to compare (needs 3 each).');
  });

  it('more, same, and unknown differences', () => {
    expect(timeDiff('A', 'B', 60_000, 180_000)).toBe('B takes 2.0 min more per task');
    expect(timeDiff('A', 'B', 30_000, 75_000)).toBe('B takes 45 s more per task');
    expect(timeDiff('A', 'B', 60_000, 60_200)).toBe('B and A take about the same time per task');
    expect(timeDiff('A', 'B', null, 1)).toBe('—');
    expect(tokensDiff('A', 'B', 9_000, 18_000)).toBe('B uses 9.0k more tokens per task');
    expect(tokensDiff('A', 'B', 18_000, 18_200)).toBe('B and A use about the same tokens per task');
  });

  it('picks the two models with the most runs by default, and honours an asked pair', () => {
    const list = [
      scorecard({ role: 'r', model: 'claude-opus-5-5', runs: 1 }),
      scorecard({ role: 'r', model: 'claude-sonnet-5-5', runs: 9 }),
      scorecard({ role: 'r', model: 'claude-haiku-5-5', runs: 5 }),
    ];
    const html = cards(loaded(list, { role: 'r' }));
    expect(html).toContain('<span class="sc-compare-label">A</span> <span class="code">Sonnet 5.5</span>');
    expect(html).toContain('<span class="sc-compare-label">B</span> <span class="code">Haiku 5.5</span>');
    const asked = cards(loaded(list, { role: 'r', a: 2, b: 0 }));
    expect(asked).toContain('<span class="sc-compare-label">A</span> <span class="code">Opus 5.5</span>');
  });
});

describe('states and text', () => {
  it('empty', () => {
    expect(cards(loaded([]))).toContain(SCORECARD_WORDS.empty);
  });

  it('loading draws an empty frame first; not_available and failures say so', () => {
    expect(cards({})).toBe('<div class="scorecards" aria-busy="true"></div>');
    const later = cards({ load: { ok: false, code: 'not_available', message: 'x' } });
    expect(later).toContain(esc(SCORECARD_WORDS.notAvailable));
    expect(later).not.toContain('Try again');
    const failed = cards({ load: { ok: false, code: 'failed', message: 'no db.' } });
    expect(failed).toContain('Couldn&#x27;t work out the scorecards: no db.');
    expect(failed).toContain('>Try again</button>');
  });

  it('role and model names from runs stay text', () => {
    const html = cards(loaded([scorecard({ role: XSS, model: XSS })]));
    expect(html).not.toContain('<img');
    expect(html).toContain(`<span class="sc-role-name">${esc(XSS)}</span>`);
  });

  it('the intro names the retention', () => {
    expect(scorecardsIntro(7)).toContain('(the last 7 days)');
    expect(scorecardsIntro(1)).toContain('(the last day)');
  });

  it('scorecards.get is checked', async () => {
    const good = fakeQuery(() => ({
      ok: true,
      type: 'scorecards.get',
      answer: { scorecards: CANNED_SCORECARDS, retentionDays: 30 },
    }));
    const a = await loadScorecards(good.fn);
    expect(good.asked).toEqual([{ type: 'scorecards.get' }]);
    expect(a.ok && a.answer.scorecards.length).toBe(4);
    const bad = fakeQuery(
      () => ({ ok: true, type: 'scorecards.get', answer: { scorecards: [{ role: 1 }], retentionDays: 30 } }) as never,
    );
    expect(await loadScorecards(bad.fn)).toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('ways in', () => {
  it('palette "Show scorecards" opens History on the real table', () => {
    const action = paletteActions(fixtureState(), new Map()).find((a) => a.label === 'Show scorecards');
    expect(action?.effect).toEqual({ kind: 'history', tab: 'scorecards' });
    const html = renderToStaticMarkup(
      <HistoryPanel
        query={null}
        request={{ tab: 'scorecards', run: null }}
        retentionDays={30}

        now={NOW_M5}
        initial={{ list: runsList([]), scorecards: loaded() }}
      />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>Scorecards</);
    expect(html).toContain('<table class="rep-table sc-table">');
    expect(html).toContain('needs 3 runs');
  });
});
