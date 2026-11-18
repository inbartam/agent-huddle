/**
 * Simple and Advanced view (owner's request 2026-11-17): the stored choice (default Simple), and what each view
 * shows in the agent panel, the timeline, the palette and the bars. Agent text stays text in both.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HuddleState } from '@huddle/shared';
import { AgentDetail } from './components/AgentDetail.js';
import { Bar } from './components/Meters.js';
import { TasksPanel } from './components/Tasks.js';
import { Timeline } from './components/Timeline.js';
import { KEYS, meteredState, METERED_NOW, toolEvents, XSS } from './testing/fixture.js';
import { ORCH_WORDS } from './view/orch.js';
import { paletteActions } from './view/palette.js';
import { readViewMode, VIEW_MODE_KEY, writeViewMode, type FlagStore, type ViewMode } from './view/prefs.js';
import { effectiveFilter, timelineRows, visibleFilters, withoutFlags } from './view/timeline.js';
import { ViewModeProvider } from './viewMode.js';

const noop = () => undefined;
const ok = () => Promise.resolve({ ok: true as const });

function memoryStore(): FlagStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}
const brokenStore: FlagStore = {
  getItem: () => {
    throw new Error('no storage');
  },
  setItem: () => {
    throw new Error('no storage');
  },
};

function detail(state: HuddleState, key: string, mode: ViewMode, section: 'now' | 'timeline' = 'now') {
  const agent = state.agents[key];
  if (!agent) throw new Error('no agent');
  return renderToStaticMarkup(
    <ViewModeProvider store={null} initial={mode}>
      <AgentDetail
        state={state}
        agent={agent}
        renames={new Map()}
        onRename={ok}
        onSelect={noop}
        section={section}
        onSection={noop}
        timeline={{ rows: timelineRows([], key), loading: false }}
        filter="all"
        onFilter={noop}
        now={METERED_NOW}
      />
    </ViewModeProvider>,
  );
}

describe('the stored choice', () => {
  it('defaults to Simple; a failing or missing store reads Simple too', () => {
    const store = memoryStore();
    expect(readViewMode(store)).toBe('simple');
    expect(writeViewMode(store, 'advanced')).toBe(true);
    expect(store.data.get(VIEW_MODE_KEY)).toBe('advanced');
    expect(readViewMode(store)).toBe('advanced');
    store.data.set(VIEW_MODE_KEY, 'something else');
    expect(readViewMode(store)).toBe('simple');
    expect(readViewMode(null)).toBe('simple');
    expect(readViewMode(brokenStore)).toBe('simple');
    expect(writeViewMode(brokenStore, 'advanced')).toBe(false);
  });
});

describe('agent panel', () => {
  const state = (): HuddleState => {
    const s = meteredState();
    const main = s.agents[KEYS.main];
    if (!main) throw new Error('no main');
    return { ...s, agents: { ...s.agents, [KEYS.main]: { ...main, model: 'claude-opus-5-5' } } };
  };

  it('Simple: model label, a token-share bar and a context bar, no tables or raw ids', () => {
    const html = detail(state(), KEYS.main, 'simple');
    expect(html).toContain('>Opus 5.5<');
    expect(html).not.toContain('>claude-opus-5-5<');
    expect(html).toContain('>Tokens<');
    expect(html).toContain('aria-label="This agent&#x27;s share of the session&#x27;s tokens"');
    expect(html).toContain('aria-label="Context window used"');
    expect(html).not.toContain('usage-table');
    expect(html).not.toContain('Instruction files');
    expect(html).not.toContain('<dt>Folder</dt>');
  });

  it('Advanced: the raw model id, the usage table, the context details', () => {
    const html = detail(state(), KEYS.main, 'advanced');
    expect(html).toContain('<span class="code">claude-opus-5-5</span>');
    expect(html).toContain('usage-table');
    expect(html).toContain('Instruction files');
    expect(html).toContain('<dt>Folder</dt>');
  });

  it('both: the main agent is "Lead agent", never "main" or "reports to you"', () => {
    for (const mode of ['simple', 'advanced'] as const) {
      const html = detail(state(), KEYS.main, mode);
      expect(html).toContain('>Lead agent</h2>');
      expect(html).not.toContain('reports to you');
      expect(html).not.toContain('<dt>Reports to</dt>');
    }
  });

  it('a subagent reports to "Lead agent", with a link', () => {
    const html = detail(state(), KEYS.core, 'simple');
    expect(html).toMatch(/reports to <button[^>]*>Lead agent<\/button>/);
  });
});

describe('timeline', () => {
  const rows = timelineRows(toolEvents(3, KEYS.core, `npm test -- --run ${XSS}`), KEYS.core);

  it('Simple: only All, Failures and Approvals, and only those with rows; commands without flags', () => {
    expect(visibleFilters(rows, 'all', true).map((f) => f.id)).toEqual(['all']);
    expect(visibleFilters(rows, 'all', false).map((f) => f.id)).toEqual(['all', 'tool']);
    // A filter chosen in Advanced reads as All in Simple.
    expect(effectiveFilter('tool', true)).toBe('all');
    expect(effectiveFilter('failure', true)).toBe('failure');
    expect(withoutFlags('npm test -- --run parser -x')).toBe('npm test … parser …');
    expect(withoutFlags('--only-flags')).toBe('--only-flags');
    const html = renderToStaticMarkup(<Timeline rows={rows} filter="tool" onFilter={noop} loading={false} simple />);
    expect(html).not.toContain('>Tools</button>');
    expect(html).not.toContain('>Context</button>');
    // The flags go from the line; the whole command stays in its tooltip.
    expect(html).toContain('>npm test … &lt;img src=x onerror=alert(1)&gt;</span>');
    expect(html).not.toContain('<img');
  });

  it('Simple: a shortened command keeps its destructive flags in sight', () => {
    expect(withoutFlags('git push -u origin main --force')).toBe('git push … origin main --force');
    expect(withoutFlags('git push origin main -f')).toBe('git push origin main -f');
    expect(withoutFlags('git push --force-with-lease origin main')).toBe('git push --force-with-lease origin main');
    expect(withoutFlags('rm -rf build --verbose')).toBe('rm -rf build …');
    expect(withoutFlags('git reset --hard HEAD~1')).toBe('git reset --hard HEAD~1');
    expect(withoutFlags('git branch -D old --quiet')).toBe('git branch -D old …');
    expect(withoutFlags('git commit --no-verify -m wip')).toBe('git commit --no-verify … wip');
    expect(withoutFlags('git clean -fdx')).toBe('git clean -fdx');
  });

  it('Advanced: every filter that has rows, the full command', () => {
    const html = renderToStaticMarkup(<Timeline rows={rows} filter="all" onFilter={noop} loading={false} />);
    expect(html).toContain('>Tools</button>');
    // Filters that would always be empty are not drawn.
    expect(html).not.toContain('>Context</button>');
    expect(html).toContain('>npm test -- --run &lt;img');
  });
});

describe('palette', () => {
  it('offers the other view; nothing when the window has no view switch', () => {
    const s = meteredState();
    const fromSimple = paletteActions(s, new Map(), undefined, 'simple').find((a) => a.id === 'viewMode');
    expect(fromSimple).toMatchObject({
      label: 'Switch to advanced view',
      effect: { kind: 'viewMode', mode: 'advanced' },
    });
    const fromAdvanced = paletteActions(s, new Map(), undefined, 'advanced').find((a) => a.id === 'viewMode');
    expect(fromAdvanced?.label).toBe('Switch to simple view');
    expect(paletteActions(s, new Map()).some((a) => a.id === 'viewMode')).toBe(false);
  });
});

describe('bars', () => {
  it('a known fraction sets aria-valuenow; unknown says so and is never a 0 bar', () => {
    const known = renderToStaticMarkup(<Bar fraction={0.42} label="Progress" />);
    expect(known).toContain('role="progressbar"');
    expect(known).toContain('aria-valuenow="42"');
    const unknown = renderToStaticMarkup(<Bar fraction={null} label="Progress" />);
    expect(unknown).toContain('aria-valuetext="unknown"');
    expect(unknown).not.toContain('aria-valuenow');
    expect(unknown).toContain('bar-unknown');
    expect(unknown).not.toContain('bar-fill');
  });
});

describe('Library tabs follow the same rules', () => {
  it('Tasks: the intro paragraph shows in Advanced only', () => {
    const tasks = (mode: ViewMode) =>
      renderToStaticMarkup(
        <ViewModeProvider store={null} initial={mode}>
          <TasksPanel state={meteredState()} onCommand={ok} />
        </ViewModeProvider>,
      );
    expect(tasks('simple')).not.toContain(ORCH_WORDS.tasksIntro);
    expect(tasks('advanced')).toContain(ORCH_WORDS.tasksIntro);
  });
});
