/**
 * Render tests from fixture-like state with react-dom/server (no DOM library). They check the
 * markup the user sees: nesting, rail style per link, glyph plus label, escaping of agent text,
 * the timeline cap and `—` for unknown.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { selectTree, type HuddleState } from '@huddle/shared';
import { AgentDetail } from './components/AgentDetail.js';
import { TokenShareSection } from './components/Meters.js';
import { TeamTree } from './components/TeamTree.js';
import { Timeline } from './components/Timeline.js';
import {
  fixtureState,
  KEYS,
  MARKUP_BRIEF,
  meteredState,
  METERED_NOW,
  MIN,
  T0,
  toolEvents,
  usageOf,
  XSS,
} from './testing/fixture.js';
import { STALE_LOOK, STATUS_LOOK } from './view/status.js';
import { counts, pinnedItem, treeOptions } from './view/summary.js';
import { timelineRows } from './view/timeline.js';
import { buildRows } from './view/tree.js';
import { WidgetBody } from './views/WidgetView.js';

const noop = () => undefined;
const ok = () => Promise.resolve({ ok: true as const });

function tree(state: HuddleState, mode: 'main' | 'widget' = 'main', toggled: ReadonlySet<string> = new Set()) {
  const rows = buildRows(selectTree(state), { toggled, rootsCollapsed: mode === 'widget' });
  return renderToStaticMarkup(
    <TeamTree
      rows={rows}
      renames={new Map()}
      selectedKey={null}
      onActivate={noop}
      onToggle={noop}
      mode={mode}
      label="Team"
    />,
  );
}

function detail(
  state: HuddleState,
  key: string,
  section: 'now' | 'timeline' = 'now',
  rows = timelineRows([], key),
  now = T0,
) {
  const agent = state.agents[key];
  if (!agent) throw new Error('no agent');
  return renderToStaticMarkup(
    <AgentDetail
      state={state}
      agent={agent}
      renames={new Map()}
      onRename={ok}
      onSelect={noop}
      section={section}
      onSection={noop}
      timeline={{ rows, loading: false }}
      filter="all"
      onFilter={noop}
      now={now}
    />,
  );
}

/** The treeitem element (opening tag up to its closing) for a given aria-label prefix. */
function treeItems(html: string): { level: string; label: string; link: string }[] {
  const out: { level: string; label: string; link: string }[] = [];
  const re =
    /role="treeitem" aria-level="(\d+)"[^>]*aria-label="([^"]*)"[^>]*>(.*?)(?=<div role="treeitem"|<div class="tree-group"|$)/gs;
  for (const m of html.matchAll(re)) {
    const link = /data-link="([a-z]+)"/.exec(m[3] ?? '')?.[1] ?? 'none';
    out.push({ level: m[1] ?? '', label: m[2] ?? '', link });
  }
  return out;
}

describe('team tree', () => {
  it('nests agents with the right level and the right rail style per link', () => {
    const items = treeItems(tree(fixtureState()));
    expect(items.map((i) => [i.level, i.label.split(',')[0], i.link])).toEqual([
      ['1', 'Fixture session', 'none'],
      ['2', 'Build ingest', 'exact'],
      ['3', 'Find call sites', 'heuristic'],
      ['1', 'Write tests', 'none'], // Finished group: no rails
      ['1', 'Read the spec', 'none'],
    ]);
  });

  it('draws the dashed path for a guessed link and the solid path for an exact one', () => {
    const html = tree(fixtureState());
    expect(html).toContain('class="rail tone-needs-you rail-dashed" d="M 24 0');
    expect(html).toMatch(/rail-dashed"[^>]*data-on="true"/);
    expect(html).toMatch(/rail-solid"[^>]*data-on="true"/);
  });

  it('shows a glyph and a label for every status', () => {
    const html = tree(fixtureState());
    expect(html).toContain(`data-status="waiting_approval" aria-hidden="true">${STATUS_LOOK.waiting_approval.glyph}<`);
    expect(html).toContain(`>${STATUS_LOOK.waiting_approval.label}</span>`);
    expect(html).toContain(`>${STATUS_LOOK.failed.glyph}<`);
    expect(html).toContain(`>${STATUS_LOOK.failed.label}</span>`);
    expect(html).toContain('Finished');
  });

  it('renders the widget as one row per session with its agent count', () => {
    const items = treeItems(tree(fixtureState(), 'widget'));
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('Fixture session, needs approval, fixture, 4 more agents');
  });
});

describe('agent text is rendered as text', () => {
  const state = fixtureState({
    explore: { name: XSS, currentActivity: XSS, role: XSS, roleDescription: XSS },
  });

  it('escapes a hostile name, role and activity in the tree and the widget', () => {
    for (const html of [tree(state), tree(state, 'widget', new Set([KEYS.main]))]) {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
  });

  it('escapes a hostile name, description, activity and timeline summary in the detail pane', () => {
    const events = toolEvents(1, KEYS.explore, XSS);
    const html = detail(state, KEYS.explore, 'timeline', timelineRows(events, KEYS.explore));
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('escapes hostile text in the widget pinned line', () => {
    const html = renderToStaticMarkup(
      <WidgetBody
        state={state}
        error={null}
        renames={new Map()}
        opened={new Set()}
        onToggle={noop}
        onOpenMain={noop}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('agent detail', () => {
  it('shows — for an unknown description and model, never 0 or blank', () => {
    const html = detail(fixtureState({ explore: { roleDescription: null, model: null } }), KEYS.explore);
    expect(html).toMatch(/<span class="role-desc">—<\/span>/);
    expect(html).toMatch(/<span class="code">—<\/span>/);
    expect(html).toContain('reports to');
    expect(html).toContain('>Build ingest</button>');
  });

  it('shows status as glyph plus label', () => {
    const html = detail(fixtureState(), KEYS.explore);
    expect(html).toContain('<span class="status-label">needs approval</span>');
  });
});

describe('timeline', () => {
  it('caps at 500 rows and windows the DOM', () => {
    const rows = timelineRows(toolEvents(800), KEYS.core);
    const html = renderToStaticMarkup(<Timeline rows={rows} filter="all" onFilter={noop} loading={false} />);
    expect(html).toContain('aria-rowcount="500"');
    expect(html).toContain('500 of 500');
    expect((html.match(/role="row"/g) ?? []).length).toBeLessThan(100);
  });

  it('says so when an agent has no events yet', () => {
    const html = renderToStaticMarkup(<Timeline rows={[]} filter="all" onFilter={noop} loading={false} />);
    expect(html).toContain('Nothing has happened in this agent yet.');
  });
});

describe('empty state', () => {
  it('gives direction when no agents are running', () => {
    const html = renderToStaticMarkup(
      <WidgetBody
        state={{ agents: {}, rootKeys: [], inbox: [], rateLimits: null }}
        error={null}
        renames={new Map()}
        opened={new Set()}
        onToggle={noop}
        onOpenMain={noop}
      />,
    );
    expect(html).toContain('No agents running. Start Claude Code in any terminal and it shows up here.');
  });
});

describe('stale sessions (not seen since Huddle restarted)', () => {
  // The Huddle started an hour after the fixture's last event: the session was only replayed from the log.
  const restarted = (): HuddleState => ({
    ...fixtureState(),
    connection: { status: 'attached', message: null, startedAt: T0 + 3_600_000 },
  });
  const staleTree = (state: HuddleState, mode: 'main' | 'widget') =>
    renderToStaticMarkup(
      <TeamTree
        rows={buildRows(selectTree(state, treeOptions(state)), {
          toggled: new Set(),
          rootsCollapsed: mode === 'widget',
        })}
        renames={new Map()}
        selectedKey={null}
        onActivate={noop}
        onToggle={noop}
        mode={mode}
        label="Team"
      />,
    );

  it('dims the rows, shows the outline glyph and the words instead of the last status', () => {
    const html = staleTree(restarted(), 'main');
    expect(html).toContain('is-stale');
    expect(html).toContain(`data-status="stale" aria-hidden="true">${STALE_LOOK.glyph}<`);
    expect(html).toContain('not seen since Huddle restarted');
    expect(html).not.toContain(`>${STATUS_LOOK.waiting_approval.label}</span>`);
    expect(html).not.toContain('is-working');
    // Finished agents keep their final status: it is not in doubt.
    expect(html).toContain(`>${STATUS_LOOK.failed.label}</span>`);
    // A finished researcher (Explore) says its finish line instead of plain "done" (agent types, 2026-11-18).
    expect(html).toContain('>findings ready</span>');
    // The widget's session row says the same.
    const widget = treeItems(staleTree(restarted(), 'widget'));
    expect(widget[0]?.label).toBe('Fixture session, not seen since Huddle restarted, fixture, 4 more agents');
  });

  it('counts a stale session in neither total, and pins nothing from it', () => {
    const state = restarted();
    expect(counts(state, selectTree(state, treeOptions(state)))).toEqual({ working: 0, needsYou: 0 });
    expect(pinnedItem(state)).toBeNull();
    // Without a start time (replays, tests) nothing is stale.
    const live = fixtureState();
    expect(counts(live, selectTree(live, treeOptions(live))).needsYou).toBe(1);
    expect(pinnedItem(live)?.agentKey).toBe(KEYS.explore);
  });

  it('turns live again once the session has an event after the start', () => {
    const base = restarted();
    const main = base.agents[KEYS.main];
    if (!main) throw new Error('no main');
    const state: HuddleState = {
      ...base,
      agents: { ...base.agents, [KEYS.main]: { ...main, lastEventAt: T0 + 3_600_001 } },
    };
    const html = staleTree(state, 'main');
    expect(html).not.toContain('is-stale');
    expect(html).toContain(`>${STATUS_LOOK.waiting_approval.label}</span>`);
  });

  it('says so in the detail pane, with the last status and when it was seen', () => {
    const html = detail(restarted(), KEYS.explore);
    expect(html).toContain('<span class="status-label">not seen since Huddle restarted</span>');
    // Said once: the status word, then when it was last heard from (no second "last seen" line).
    expect(html.replaceAll('<!-- -->', '')).toMatch(/last heard \d\d:\d\d/);
    expect(html.match(/not seen since Huddle restarted/g)).toHaveLength(1);
    expect(html).toContain('<dt>Last seen doing</dt>');
    expect(detail(fixtureState(), KEYS.explore)).toContain('<dt>Doing now</dt>');
  });
});

describe('reports to, in plain words', () => {
  it('says confirmed for an exact link and best guess otherwise, never the raw value', () => {
    const exact = detail(fixtureState(), KEYS.core);
    expect(exact).toContain('<dt>Reports to</dt>');
    expect(exact).toContain('(confirmed)');
    const guess = detail(fixtureState({ core: { handoff: null } }), KEYS.core);
    expect(guess).toContain('(best guess — matched by order)');
    for (const full of [exact, guess]) {
      // The meter sections below may say "unknown" for a value (context); the link words are checked above them.
      const html = full.replace(/<section class="meter-section".*$/s, '');
      expect(html).not.toContain('Parent link');
      expect(html).not.toMatch(/>exact<|heuristic|>unknown</);
      expect(full).not.toMatch(/>exact<|heuristic</);
    }
    // The lead reports to nobody: no "reports to you" line (owner review 2026-11-17).
    expect(detail(fixtureState(), KEYS.main)).not.toContain('Reports to');
    expect(detail(fixtureState(), KEYS.main)).not.toContain('reports to');
  });
});

describe('meters (M2: progress, usage, context, handoff)', () => {
  /** The markup of one detail section, by its title. */
  const section = (html: string, title: string): string => {
    const start = html.indexOf(`>${title}<`);
    if (start < 0) return '';
    const end = html.indexOf('<section', start);
    return html.slice(start, end < 0 ? undefined : end);
  };
  const widget = (state: HuddleState, opened: ReadonlySet<string> = new Set()) =>
    renderToStaticMarkup(
      <WidgetBody
        state={state}
        error={null}
        renames={new Map()}
        opened={opened}
        onToggle={noop}
        onOpenMain={noop}
        now={METERED_NOW}
      />,
    );

  it('shows unknown usage as — and says so, never 0', () => {
    const html = detail(meteredState(), KEYS.explore, 'now', undefined, METERED_NOW);
    const usage = section(html, 'Usage');
    expect(usage).toContain('usage unknown');
    expect(usage).toContain('<td>—</td>');
    expect(usage).not.toMatch(/<td>0<\/td>|\$0\.00/);
    // The widget row for an agent without requests shows — too.
    const rows = widget(meteredState(), new Set([KEYS.main]));
    expect(rows).toMatch(/title="agent usage unknown: no requests recorded yet">—</);
  });

  it('labels cost as an estimate and shows the subtree roll-up and helper requests separately on a session', () => {
    const usage = section(detail(meteredState(), KEYS.main, 'now', undefined, METERED_NOW), 'Usage');
    expect(usage).toContain('~$1.50 est.');
    expect(usage).toContain('With subagents (5)');
    expect(usage).toContain('Helper requests');
    // explore has no requests: the roll-up says it is partial.
    expect(usage).toContain('Partial:');
  });

  it('with no basis draws no bar at all (never a 0 bar), says why in one line, and shows what the agent is doing', () => {
    const progress = section(detail(meteredState(), KEYS.explore, 'now', undefined, METERED_NOW), 'Progress');
    expect(progress).not.toContain('role="progressbar"');
    expect(progress).not.toContain('aria-valuenow');
    expect(progress).not.toContain('bar-fill');
    expect(progress).toContain('No task list or subagents to measure progress by.');
    expect(progress).toContain('Bash: npm install zod');
  });

  it('shows the ETA as a range with a confidence word, labelled as an estimate', () => {
    const progress = section(detail(meteredState(), KEYS.main, 'now', undefined, METERED_NOW), 'Progress');
    expect(progress).toContain('2 of 3 subagents finished');
    expect(progress).toContain('about 2–9 min left');
    expect(progress).toMatch(/est\., medium confidence/);
    expect(progress).toContain('~50% est.');
  });

  it('keeps a parent that is still running below 100% after all its subagents finished', () => {
    const state = fixtureState({ explore: { status: 'done', endedAt: T0 + MIN } });
    const progress = section(detail(state, KEYS.core, 'now', undefined, T0 + 2 * MIN), 'Progress');
    expect(progress).toContain('1 subagent finished, wrapping up');
    const now = /aria-valuenow="(\d+)"/.exec(progress)?.[1];
    expect(Number(now)).toBeLessThan(100);
    expect(progress).not.toContain('100%');
  });

  it('renders a handoff brief as text: markup in it appears literally', () => {
    const handoff = section(detail(meteredState(), KEYS.core, 'now', undefined, METERED_NOW), 'Handoff');
    expect(handoff).not.toContain('<b>');
    expect(handoff).toContain('Rewrite the &lt;b&gt;tokenizer&lt;/b&gt; &amp; keep tokenize()');
    expect(MARKUP_BRIEF).toContain('<b>');
    // Collapsed by default, and the link quality in words next to the matching rail.
    expect(handoff).toMatch(/<details class="handoff-part">/);
    expect(handoff).toContain('rail-solid');
    expect(handoff).toContain('linked exactly');
    const guess = section(detail(meteredState(), KEYS.explore, 'now', undefined, METERED_NOW), 'Handoff');
    expect(guess).toContain('rail-dashed');
    expect(guess).toContain('best guess — matched by order');
  });

  it('shows context as unknown when not measured, and warns in words when it is high', () => {
    expect(section(detail(meteredState(), KEYS.explore, 'now', undefined, METERED_NOW), 'Context')).toContain(
      '>unknown<',
    );
    const high = section(detail(meteredState(), KEYS.main, 'now', undefined, METERED_NOW), 'Context');
    expect(high).toContain('Nearly full');
    expect(high).toContain('measured by the status line');
    expect(high).toContain('172,000 of 200,000 tokens');
  });

  it('puts compact meters on widget rows and the plan limits under the header', () => {
    const base = meteredState();
    const plain = widget(base);
    expect(plain).not.toContain('Plan usage limits');
    expect(plain).toContain('ctx 86%');
    expect(plain).toContain('role="progressbar"');
    const limited = widget({
      ...base,
      rateLimits: {
        fiveHourUsedPct: 42,
        fiveHourResetsAt: null,
        sevenDayUsedPct: null,
        sevenDayResetsAt: null,
        measuredAt: T0,
      },
    });
    expect(limited).toContain('Plan usage limits');
    expect(limited).toContain('>42%<');
    expect(limited).toMatch(/7d<\/span><span class="rate-limit-pct">—</);
  });
});

describe('tokens in the header and the Usage table', () => {
  it('shows the total, short in the header and exact in the table; unknown says so', () => {
    // 10 requests of usageOf: (1200 + 300 + 9000 + 800) × 10 = 113,000 tokens.
    const known = detail(fixtureState({ core: { usage: usageOf(10, 1.5) } }), KEYS.core);
    expect(known).toContain('113k tokens');
    expect(known).toContain('<th scope="row">Total tokens</th>');
    expect(known).toContain('113,000');
    const unknown = detail(fixtureState({ explore: { usage: usageOf(0, 0) } }), KEYS.explore);
    expect(unknown).toContain('tokens —');
    expect(unknown).not.toContain('0 tokens');
  });
});

describe('tree row words (2026-11-18)', () => {
  it('labels only states other than plain work; working keeps its shape, colour and spoken name', () => {
    const html = tree(fixtureState());
    // No visible "working" word on a row, but every working row still says it to assistive tech and in its tooltip.
    expect(html).not.toContain('class="tree-state tone-working"');
    expect(html).toMatch(/role="treeitem"[^>]*aria-label="[^"]*, working/);
    expect(html).toMatch(/title="working(: [^"]*)?"/);
    // The states that need a look keep their word on the row.
    expect(html).toContain('>needs approval</span>');
    expect(html).toContain('>failed</span>');
  });
});

describe('Simple tokens (2026-11-18)', () => {
  it('count work tokens (input + output, as History does), not the context read again on every request', () => {
    const state = meteredState();
    const main = state.agents[KEYS.main];
    if (!main) throw new Error('fixture');
    // Alone in its session: no "100%" bar, just the count; 10 requests are 15k work tokens (113k with cache reads).
    const { helperUsage: _helper, ...solo } = main;
    const alone: HuddleState = { ...state, agents: { [KEYS.main]: solo } };
    const html = renderToStaticMarkup(<TokenShareSection state={alone} agent={solo} />);
    expect(html).not.toContain('role="progressbar"');
    expect(html).toMatch(/15(\.0)?k tokens/);
    expect(html).not.toMatch(/11[0-9](\.\d)?k/);
  });

  it('keeps the share bar when other agents share the session', () => {
    const state = meteredState();
    const main = state.agents[KEYS.main];
    if (!main) throw new Error('fixture');
    const html = renderToStaticMarkup(<TokenShareSection state={state} agent={main} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('tokens in this session');
  });

  it('a share that rounds to 100% is not shown as a bar or "N of N" (owner, 2026-11-18)', () => {
    const state = meteredState();
    const main = state.agents[KEYS.main];
    if (!main) throw new Error('fixture');
    // 4.5M of the session's ~4.51M: over 99.5%.
    const big = { ...main, usage: usageOf(3000, 1) };
    const html = renderToStaticMarkup(
      <TokenShareSection state={{ ...state, agents: { ...state.agents, [KEYS.main]: big } }} agent={big} />,
    );
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain(' of ');
    expect(html).toMatch(/4\.5M tokens/);
  });
});
