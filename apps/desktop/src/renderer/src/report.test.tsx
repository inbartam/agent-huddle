/**
 * U3 (M5, F23): the Report tab of a past run. Sections render from the structured report (never the Markdown); agent
 * text in names, titles, results, paths, errors, summaries and tool names stays literal; unknown is `—` and lower
 * bounds say "at least"; the not_ready / none / error states; the commands go by session id with no path; "Show in
 * replay" finds the row's event index among the head's markers and the run view opens Replay there.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CommandResult, HuddleCommand } from '@huddle/shared';
import { HistoryPanel } from './components/History.js';
import { Report, type ReportInitial } from './components/Report.js';
import { loadReport, sendReportCommand } from './report-query.js';
import { XSS } from './testing/fixture.js';
import {
  APPROVAL_INDEX,
  CANNED_ROWS,
  fakeQuery,
  FAILURE_INDEX,
  fixReport,
  HOSTILE_MD,
  hostileReport,
  NOW_M5,
  REPLAY_EVENT_COUNT,
  REPLAY_SESSION,
  REPORT_MARKERS,
  REPORT_PATH,
  replayMoment,
  reportHead,
  RK,
  runRow,
  runsList,
} from './testing/m5-fixture.js';
import { positionWords } from './view/replay.js';
import {
  agentLines,
  eventTime,
  replayIndexes,
  REPORT_WORDS,
  reportCommand,
  shownPath,
  tokensLine,
  worktreeCutWords,
} from './view/report.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const noop = () => undefined;
const FILE = { path: REPORT_PATH, exists: true, writtenAt: NOW_M5 };

function report(initial: ReportInitial, head = reportHead()): string {
  return renderToStaticMarkup(
    <Report query={null} onCommand={null} head={head} onShowInReplay={noop} initial={initial} />,
  );
}

const ready = (r = fixReport(), file: typeof FILE | null = FILE): ReportInitial => ({
  load: { ok: true, answer: { status: 'ready', report: r, file } },
});

/** Visible text with tags stripped and entities decoded enough for matching words. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('failure and approval times', () => {
  // Saturday 14 Nov 2026, 23:50 local: the run starts late in the evening.
  const start = new Date(2026, 10, 14, 23, 50, 0).getTime();

  it('a time on the run’s first day is the clock alone; after midnight it gets the day', () => {
    expect(eventTime(start + 5 * 60_000, start)).toBe('23:55:00');
    expect(eventTime(new Date(2026, 10, 15, 0, 5, 5).getTime(), start)).toBe('Sun 00:05:05');
    expect(eventTime(new Date(2026, 10, 22, 9, 0, 0).getTime(), start)).toBe('22 Nov 09:00:00');
  });

  it('the report draws the day before a failure and an approval that crossed midnight', () => {
    const base = fixReport();
    const after = new Date(2026, 10, 15, 0, 5, 5).getTime();
    const r = {
      ...base,
      summary: { ...base.summary, startedAt: start },
      failures: base.failures.map((f) => ({ ...f, ts: after })),
      approvals: base.approvals.map((a) => ({ ...a, ts: start + 60_000 })),
    };
    const html = report(ready(r));
    expect(html).toContain('<span class="rep-time">Sun 00:05:05</span>');
    expect(html).toContain('<span class="rep-time">23:51:00</span>');
  });
});

describe('sections from the structured report', () => {
  const html = report(ready());
  const t = text(html);

  it('has every section, with counts in the headings', () => {
    for (const s of ['Summary', 'Agents', 'Files changed', 'Failures', 'Approvals']) expect(html).toContain(`>${s}`);
    expect(t).toContain('Agents (3)');
    expect(t).toContain('Files changed (2)');
    expect(t).toContain('Failures (1)');
    expect(t).toContain('Approvals (3)');
  });

  it('summary: outcome, duration, end reason, agents, tasks, activity, tokens, helper line, cost', () => {
    expect(html).toContain('✓</span><span class="status-label">completed</span>');
    expect(t).toContain('21 min 28 s');
    expect(t).toContain('ended: you exited Claude Code');
    expect(t).toContain('3 agents');
    expect(t).toContain('1 task done');
    expect(t).toContain('Tool calls 5 (1 failed) · Approvals 1 · Stuck 1');
    expect(t).toContain('in ≥47k · out ≥7.4k · cache read ≥282k · cache written ≥12k · ≥3 requests');
    expect(html).toContain('at least: some agents have no usage record');
    expect(t).toContain('Helper requests (titles, compaction): 2.1k tokens, not counted above');
    expect(t).toContain('~$0.88 est.');
  });

  it('agents: indented with elbows, tasks done/created or —, tools calls (failures), tokens and cost', () => {
    expect(html).toContain(
      '<span class="rep-elbow" aria-hidden="true">├ </span><span class="rep-name-text">Explore #2',
    );
    expect(html).toContain(
      '<span class="rep-elbow" aria-hidden="true">└ </span><span class="rep-name-text">core-engineer #1',
    );
    expect(html).toContain('<td class="num">1/1</td>');
    expect(html).toContain('<td class="num" title="3 tool calls, 1 failed">3 (1)</td>');
    expect(html).toContain('title="1 tool call">1</td>');
    expect(html).toContain('<td class="num">30k</td>');
    // Explore has no usage record: unknown, not 0.
    expect(html).toMatch(
      /Explore #2[\s\S]*?<td class="num">—<\/td><td class="num"><span title="cost unknown" aria-label="cost unknown">—<\/span>/,
    );
    expect(html).toContain('title="1 tool call">1</td>');
    expect(html).toContain('~$0.48 est. (at least: some requests carried no cost)');
    expect(html).toContain('aria-expanded="false"');
  });

  it('files: relative path with the full one in the tooltip, tools and agents, git state, worktree line', () => {
    expect(html).toContain(
      `title="${esc('C:\\code\\agent-huddle\\packages\\core\\src\\parse\\number.ts')}">${esc('packages\\core\\src\\parse\\number.ts')}</span>`,
    );
    expect(t).toContain('Edit ×3 · core-engineer #1');
    expect(t).toContain('packages/core/src/parse/number.test.ts modified');
    expect(t).toContain('Worktree huddle/run-1a2b · 120 files · +120 −40 · 2 untracked · kept');
    expect(t).toContain('Showing 50 of 120 files (Huddle keeps the first 50).');
    expect(html).not.toContain('diff');
  });

  it('failures: time, agent, kind words, tool, first line of the error that expands to the rest', () => {
    expect(t).toContain('core-engineer #1 tool failed Bash');
    expect(html).toContain('<details><summary>exit code 1: 2 tests failed</summary>');
    expect(html).toContain('at parse-number.test.ts:12');
  });

  it('approvals: the inbox endings, the rule id when a rule answered, and "No answer recorded."', () => {
    expect(t).toContain('npm test -- parser Allowed from Huddle.');
    expect(t).toContain('git status Allowed by a rule. default:git-status');
    expect(t).toContain('https://example.com No answer recorded.');
  });

  it('the file bar shows the path the core wrote, as text', () => {
    expect(html).toContain(`>${esc(REPORT_PATH)}</span>`);
    expect(html).toContain('>Open Markdown file</button>');
    expect(html).toContain('>Copy path</button>');
    expect(html).not.toContain('Write it again');
  });
});

describe('expanded agent row', () => {
  it('shows title from its parent, result as pre-wrapped text, and tools used', () => {
    const html = report({ ...ready(), expanded: [RK.core] });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<dt>Title from its parent</dt><dd class="rep-text">Fix exponent parsing</dd>');
    // A subagent's result is its reply: drawn from its Markdown as elements (2026-11-18).
    expect(html).toContain(
      '<div class="rep-result"><div class="md"><p class="md-p">Exponents now parse; all 41 parser tests pass.</p>',
    );
    expect(html).toContain('Bash 2 (1 failed) · Edit 1');
  });

  it('a long result is cut at 12 lines with "Show all"', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n');
    const r = fixReport();
    const agents = r.agents.map((a) => (a.row.agentKey === RK.explore ? { ...a, result: long } : a));
    const html = report({ ...ready({ ...r, agents }), expanded: [RK.explore] });
    expect(html).toContain('line 11');
    expect(html).not.toContain('line 12<');
    expect(html).not.toContain('line 29');
    expect(html).toContain('>Show all</button>');
  });

  it('orders agents under their parents whatever the start order, and survives a parent cycle', () => {
    const a = fixReport().agents;
    const [main, explore, core] = a;
    if (!main || !explore || !core) throw new Error('fixture');
    expect(agentLines([core, main, explore]).map((l) => [l.agent.name, l.prefix])).toEqual([
      ['Fix parser tests', ''],
      ['core-engineer #1', '├ '],
      ['Explore #2', '└ '],
    ]);
    const x = { ...explore, row: { ...explore.row, parentKey: RK.core } };
    const y = { ...core, row: { ...core.row, parentKey: RK.explore } };
    expect(agentLines([x, y]).length).toBe(2);
  });
});

describe('files list', () => {
  it('more than 50 tool files: "Showing 50 of 60" and "Show all"', () => {
    const files = Array.from({ length: 60 }, (_, i) => ({
      path: `C:\\code\\agent-huddle\\f${String(i)}.ts`,
      source: 'tool' as const,
      agentKeys: [RK.core],
      tools: ['Write'],
      writes: 1,
      worktreeStatus: null,
    }));
    const html = report(ready(fixReport({ filesChanged: files, worktree: null })));
    expect(text(html)).toContain('Showing 50 of 60');
    expect(html).toContain('>Show all</button>');
    expect(html).toContain('f49.ts');
    expect(html).not.toContain('f50.ts');
    expect(report({ ...ready(fixReport({ filesChanged: files, worktree: null })), allFiles: true })).toContain(
      'f59.ts',
    );
  });

  it('paths outside the run folder stay as given; case and separators do not matter', () => {
    expect(shownPath({ path: 'C:\\code\\other\\a.ts', source: 'tool' }, 'C:\\code\\agent-huddle')).toBe(
      'C:\\code\\other\\a.ts',
    );
    expect(shownPath({ path: 'c:/CODE/agent-huddle/src/a.ts', source: 'tool' }, 'C:\\code\\agent-huddle\\')).toBe(
      'src/a.ts',
    );
    expect(shownPath({ path: 'C:\\code\\agent-huddle-2\\a.ts', source: 'tool' }, 'C:\\code\\agent-huddle')).toBe(
      'C:\\code\\agent-huddle-2\\a.ts',
    );
    expect(shownPath({ path: 'src/a.ts', source: 'worktree' }, 'C:\\code')).toBe('src/a.ts');
  });

  it('no cut line when every worktree file is listed; empties say so', () => {
    const w = fixReport().worktree;
    if (!w) throw new Error('fixture');
    expect(worktreeCutWords({ ...w, listed: 9, filesChanged: 9 })).toBeNull();
    const empty = text(report(ready(fixReport({ filesChanged: [], worktree: null, failures: [], approvals: [] }))));
    expect(empty).toContain('No files changed.');
    expect(empty).toContain('No failures.');
    expect(empty).toContain('No approvals asked.');
  });
});

describe('hostile text stays literal', () => {
  const html = report({ ...ready(hostileReport()), expanded: [RK.main, RK.explore, RK.core] });

  it('no link, image, script or page heading is built from agent text', () => {
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href');
    expect(html).not.toContain('<a ');
    expect(html).not.toMatch(/<h1/);
    // No attribute that loads or navigates (a tooltip holding the typed text is fine: it is text).
    expect(html).not.toMatch(/<[a-z]+\s[^>]*\b(?:src|href|action|formaction)="/);
    // Only a subagent's result reads Markdown (bold, code, lists); every other field stays literal.
    expect(html.match(/<strong>/g)?.length ?? 0).toBe(1);
  });

  it('names, titles, results, paths, errors, summaries, tool and rule names show as typed', () => {
    const x = esc(XSS);
    const md = esc(HOSTILE_MD);
    expect(html).toContain(`<span class="rep-name-text">${x}</span>`);
    expect(html).toContain(`<span class="rep-name-text">${md}</span>`);
    expect(html).toContain(`<dd class="rep-text">${x}</dd>`);
    expect(html).toContain(`<dd class="rep-text">${md}</dd>`);
    // The result is drawn from its Markdown: bold becomes an element; the link and the heading mark stay typed.
    expect(html).toContain(`<p class="md-p">[x](javascript:alert(1)) <strong>b</strong> # h\n${x}</p>`);
    expect(html).toContain(`${x} 1`); // tools used
    expect(html).toContain(`>${x}</span>`); // the path, relative
    expect(html).toContain(`${md} ×1`); // tool names on a file
    expect(html).toContain(`<summary>${md}</summary>`); // error first line
    expect(html).toContain(`<span class="rep-tool">${x}</span>`); // failure and approval tool
    expect(html).toContain(`title="${md}">${md}</span>`); // approval summary
    expect(html).toContain(`<span class="code muted">${x}</span>`); // rule id
    expect(html).toContain(`ended: ${x}`);
  });
});

describe('unknown is —, never 0', () => {
  it('no usage, no cost, no duration, no end reason, no end in the log', () => {
    const r = fixReport();
    const html = report(
      ready({
        ...r,
        summary: {
          ...r.summary,
          tokens: null,
          tokensPartial: false,
          helperTokens: null,
          estimatedCostUsd: null,
          durationMs: null,
          endReason: null,
          outcome: 'unknown',
        },
        agents: r.agents.map((a) => ({ ...a, row: runRow({ ...a.row, durationMs: null, outcome: 'unknown' }) })),
      }),
    );
    const t = text(html);
    expect(t).toContain('no usage recorded');
    expect(t).toContain('ended: —');
    expect(t).not.toContain('Helper requests');
    expect(html).toContain('aria-label="cost unknown">—</span>');
    expect(html).toContain('◇</span><span class="status-label">no end recorded</span>');
    expect(t).toContain(REPORT_WORDS.noEnd);
    expect(t).not.toMatch(/\$0\.00/);
    expect(tokensLine(null, true)).toEqual({ text: 'no usage recorded', label: null });
  });
});

describe('states', () => {
  it('not_ready: the run is still going, with "Replay so far"', () => {
    const html = report({ load: { ok: true, answer: { status: 'not_ready' } } });
    expect(html).toContain(esc(REPORT_WORDS.notReady));
    expect(html).toContain('>Replay so far</button>');
    expect(html).not.toContain('Make the report');
  });

  it('none: "No report for this run yet." with "Make the report"', () => {
    const html = report({ load: { ok: true, answer: { status: 'none' } } });
    expect(html).toContain('No report for this run yet.');
    expect(html).toContain('>Make the report</button>');
  });

  it('loading draws an empty frame first (the words wait 300 ms so they do not flash)', () => {
    const html = report({});
    expect(html).toBe('<div class="report"></div>');
  });

  it('not_available says so without "Try again"; a failure names the message and offers it', () => {
    const later = report({ load: { ok: false, code: 'not_available', message: 'not yet' } });
    expect(later).toContain(esc(REPORT_WORDS.notAvailable));
    expect(later).not.toContain('Try again');
    const failed = report({ load: { ok: false, code: 'failed', message: 'disk on fire.' } });
    expect(failed).toContain('Couldn&#x27;t read the report: disk on fire.');
    expect(failed).toContain('>Try again</button>');
  });

  it('a missing file: Open and Copy are off with the reason, and "Write it again" shows', () => {
    const html = report(ready(fixReport(), { ...FILE, exists: false }));
    expect(html).toMatch(
      /aria-disabled="true" title="The file is gone: it was moved or deleted\."[^>]*>Open Markdown file/,
    );
    expect(html).toMatch(/aria-disabled="true" title="The file is gone: it was moved or deleted\."[^>]*>Copy path/);
    expect(html).toContain('>Write it again</button>');
  });

  it('no file written: Open and Copy are off, and "Make the report" writes it', () => {
    const html = report(ready(fixReport(), null));
    expect(html).toMatch(
      /aria-disabled="true" title="No Markdown file was written for this run\."[^>]*>Open Markdown file/,
    );
    expect(html).toContain('>Make the report</button>');
  });

  it('"Copied." shows as a status', () => {
    expect(report({ ...ready(), note: { kind: 'copied' } })).toContain('role="status">Copied.</span>');
  });
});

describe('commands go by session id, never a path', () => {
  const record = () => {
    const sent: HuddleCommand[] = [];
    const fn = (cmd: HuddleCommand): Promise<CommandResult> => {
      sent.push(cmd);
      return Promise.resolve({ ok: true });
    };
    return { sent, fn };
  };

  it('make, open and copy carry only their type and the session id', async () => {
    const { sent, fn } = record();
    await sendReportCommand(fn, 'make', REPLAY_SESSION);
    await sendReportCommand(fn, 'openFile', REPLAY_SESSION);
    await sendReportCommand(fn, 'copyPath', REPLAY_SESSION);
    expect(sent).toEqual([
      { type: 'report.make', sessionId: REPLAY_SESSION },
      { type: 'report.openFile', sessionId: REPLAY_SESSION },
      { type: 'report.copyPath', sessionId: REPLAY_SESSION },
    ]);
    for (const c of sent) {
      expect(Object.keys(c).sort()).toEqual(['sessionId', 'type']);
      expect(JSON.stringify(c)).not.toContain('reports');
      expect(JSON.stringify(c)).not.toContain('.md');
    }
    expect(reportCommand('openFile', 's')).toEqual({ type: 'report.openFile', sessionId: 's' });
  });

  it('no sender, a throw or a strange answer read as a failure in words', async () => {
    expect(await sendReportCommand(null, 'make', 's')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await sendReportCommand(() => Promise.reject(new Error('x')), 'make', 's')).toMatchObject({
      ok: false,
      code: 'failed',
    });
    expect(await sendReportCommand(() => Promise.resolve(42 as unknown as CommandResult), 'make', 's')).toMatchObject({
      ok: false,
      code: 'failed',
    });
  });

  it('report.get asks by session id and checks the answer', async () => {
    const good = fakeQuery(() => ({
      ok: true,
      type: 'report.get',
      answer: { status: 'ready', report: fixReport(), file: FILE },
    }));
    const a = await loadReport(good.fn, REPLAY_SESSION);
    expect(good.asked).toEqual([{ type: 'report.get', sessionId: REPLAY_SESSION }]);
    expect(a.ok && a.answer.status === 'ready' && a.answer.file?.path).toBe(REPORT_PATH);
    const bad = fakeQuery(
      () => ({ ok: true, type: 'report.get', answer: { status: 'ready', report: { nope: 1 } } }) as never,
    );
    expect(await loadReport(bad.fn, REPLAY_SESSION)).toMatchObject({ ok: false, code: 'failed' });
    const wrong = fakeQuery(() => ({
      ok: true,
      type: 'scorecards.get',
      answer: { scorecards: [], retentionDays: 30 },
    }));
    expect(await loadReport(wrong.fn, REPLAY_SESSION)).toMatchObject({ ok: false, code: 'failed' });
    expect(await loadReport(null, REPLAY_SESSION)).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('"Show in replay"', () => {
  it('finds each row among the head markers by kind, agent and time; a row with no marker gets null', () => {
    const r = fixReport();
    expect(replayIndexes(r.failures, 'failure', REPORT_MARKERS)).toEqual([FAILURE_INDEX]);
    expect(replayIndexes(r.approvals, 'approval', REPORT_MARKERS)).toEqual([APPROVAL_INDEX, 15, null]);
    // A failure never takes an approval's marker, even at the same agent and time.
    const at = r.approvals[0];
    if (!at) throw new Error('fixture');
    expect(replayIndexes([{ ts: at.ts, agentKey: at.agentKey }], 'failure', REPORT_MARKERS)).toEqual([null]);
  });

  it("uses the row's own log index when it has one, and the markers only for rows without (M5 WP7)", () => {
    const r = fixReport();
    const [first, second, third] = r.approvals;
    const failure = r.failures[0];
    if (!first || !second || !third || !failure) throw new Error('fixture');
    const rows = [{ ...first, index: 41 }, second, { ...third, index: 0 }];
    // The second row has no index: it still takes its marker; the others ignore theirs (and the missing one).
    expect(replayIndexes(rows, 'approval', REPORT_MARKERS)).toEqual([41, 15, 0]);
    expect(replayIndexes([{ ...failure, index: 7 }], 'failure', [])).toEqual([7]);
  });

  it('two rows at the same agent and millisecond take the two markers in order', () => {
    const markers = [
      { index: 3, ts: 100, kind: 'failure' as const, agentKey: RK.core, itemId: null },
      { index: 4, ts: 100, kind: 'failure' as const, agentKey: RK.core, itemId: null },
    ];
    const rows = [
      { ts: 100, agentKey: RK.core },
      { ts: 100, agentKey: RK.core },
      { ts: 100, agentKey: RK.core },
    ];
    expect(replayIndexes(rows, 'failure', markers)).toEqual([3, 4, null]);
  });

  it('each failure and approval row gets the button; one with no marker is off with the reason', () => {
    const html = report(ready());
    expect(html.match(/>Show in replay<\/button>/g)?.length).toBe(4);
    expect(html.match(/aria-disabled="true"[^>]*>Show in replay/g)?.length).toBe(1);
    expect(html).toContain(`title="${esc(REPORT_WORDS.noReplayIndex)}"`);
  });

  it('a run asked for with an index opens Replay at that event', () => {
    const row = CANNED_ROWS[1];
    if (!row) throw new Error('fixture');
    const html = renderToStaticMarkup(
      <HistoryPanel
        query={null}
        request={{ tab: 'runs', run: { sessionId: row.sessionId, tab: null, index: FAILURE_INDEX } }}
        retentionDays={30}

        now={NOW_M5}
        initial={{
          list: runsList(CANNED_ROWS),
          head: { ok: true, head: reportHead() },
          replay: { moment: { ok: true, moment: replayMoment(FAILURE_INDEX) } },
        }}
      />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>Replay</);
    expect(html).toContain(positionWords(FAILURE_INDEX, REPLAY_EVENT_COUNT));
  });

  it('without an index, a run with a report opens on Report', () => {
    const row = CANNED_ROWS[1];
    if (!row) throw new Error('fixture');
    const html = renderToStaticMarkup(
      <HistoryPanel
        query={null}
        request={{ tab: 'runs', run: { sessionId: row.sessionId, tab: null } }}
        retentionDays={30}

        now={NOW_M5}
        initial={{ list: runsList(CANNED_ROWS), head: { ok: true, head: reportHead() }, report: ready() }}
      />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>Report</);
    expect(html).toContain('>Summary');
  });
});
