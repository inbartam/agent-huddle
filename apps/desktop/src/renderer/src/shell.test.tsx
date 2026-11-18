/**
 * Main window shell (main window redesign, WP2): title bar counts, the icon rail, the sidebar width rule, Library's
 * tabs, the projects sidebar (projects → sessions → agents, Earlier, Show all, + New run) and Needs you (grouped
 * compact cards, full card on Open or deep link, agent text as text).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  selectHiddenSessionCount,
  selectHomeCounts,
  selectProjects,
  selectSessionIdentity,
  type AgentKey,
  type HuddleState,
} from '@huddle/shared';
import type { HuddleBridge } from '../../preload/api.js';
import { Library, Rail, TitleBar } from './components/Shell.js';
import { armControl } from './view/arming.js';
import { Sidebar, type SidebarProps } from './components/Sidebar.js';
import { HuddleStore } from './store.js';
import { settled } from './testing/arming.js';
import { fixtureState, KEYS, XSS } from './testing/fixture.js';
import { APPROVAL, approvalItem, IK, interactState, NOW, STUCK } from './testing/interact-fixture.js';
import {
  clampSidebarWidth,
  compactKeyAction,
  isProjectOpen,
  itemPlace,
  olderWords,
  splitterKey,
  waitedWords,
  countWords,
  earlierWords,
  needsYouGroups,
  railCurrent,
  sessionMeta,
  shellColumns,
  showAllWords,
  SIDEBAR_DEFAULT,
} from './view/shell.js';
import { treeOptions } from './view/summary.js';

const noop = () => undefined;

const bridge: HuddleBridge = {
  getState: () => Promise.reject(new Error('not in this test')),
  command: () => Promise.resolve({ ok: true }),
  getEvents: () => Promise.resolve([]),
  onEvents: () => noop,
  query: () => Promise.resolve({ ok: false, code: 'unsupported', message: 'not in this test' }),
};

function sidebar(state: HuddleState, extra: Partial<SidebarProps> = {}): string {
  const showAll = extra.showAll ?? false;
  const identity = (key: AgentKey) => selectSessionIdentity(state, key, NOW, {});
  return renderToStaticMarkup(
    settled(
      <Sidebar
        store={new HuddleStore(bridge)}
        state={state}
        renames={new Map()}
        selectedKey={null}
        toggled={new Set()}
        onToggle={noop}
        onPick={noop}
        onAgent={noop}
        linkedItemId={null}
        identity={identity}
        projects={selectProjects(state, { ...treeOptions(state), showAll })}
        hidden={selectHiddenSessionCount(state, { ...treeOptions(state), showAll: false })}
        showAll={showAll}
        onShowAll={noop}
        projectChoices={new Map()}
        onProjectOpen={noop}
        onNewRun={noop}
        onEarlier={noop}
        now={NOW}
        {...extra}
      />,
    ),
  );
}

describe('shell rules', () => {
  it('keeps the sidebar between 280 and 420, 312 by default, and gives way at a 960 px window', () => {
    expect(SIDEBAR_DEFAULT).toBe(312);
    expect(clampSidebarWidth(100)).toBe(280);
    expect(clampSidebarWidth(999)).toBe(420);
    expect(clampSidebarWidth(Number.NaN)).toBe(312);
    // 960 − 56 (rail) − 624 (main) = 280: the min() picks 280 at the smallest window, the user's width when wider.
    expect(shellColumns(312)).toBe('56px max(280px, min(312px, calc(100vw - 680px))) 0 minmax(0, 1fr)');
  });

  it('marks Home, History, Library and Settings; nothing for a session or a launch (Guide is a dialog)', () => {
    expect(railCurrent('home')).toBe('home');
    expect(railCurrent('settings')).toBe('settings');
    expect(railCurrent('session')).toBeNull();
    expect(railCurrent('launch')).toBeNull();
  });

  it('words the counts with a glyph each, unknown as —', () => {
    expect(countWords(null).map((w) => `${w.glyph} ${w.text}`)).toEqual(['● — working', '▲ — need you', '! — stuck']);
    const words = countWords({ working: 3, needsYou: 1, stuck: 0 });
    expect(words.map((w) => `${w.glyph} ${w.text}`)).toEqual(['● 3 working', '▲ 1 needs you', '! 0 stuck']);
    expect(words.find((w) => w.key === 'needsYou')?.loud).toBe(true);
    expect(earlierWords(1)).toBe('Earlier · 1 ended session');
    expect(earlierWords(14)).toBe('Earlier · 14 ended sessions');
    expect(showAllWords(false, 2)).toBe('Show all (2 hidden runs)');
    expect(showAllWords(true, 0)).toBe('Hide test and empty runs');
  });

  it('splits open items into Waiting on you and Warnings', () => {
    const g = needsYouGroups(interactState());
    expect(g.waiting.map((i) => i.kind)).toEqual(['approval', 'question', 'question']);
    expect(g.warnings.map((i) => i.kind)).toEqual(['stuck', 'file_conflict']);
  });

  it('the Needs you badge counts only what waits on you (as the title bar); warnings carry their own count', () => {
    const state = interactState();
    const html = sidebar(state);
    expect(html).toMatch(/class="side-badge" aria-label="3 waiting on you">3</);
    expect(html).toMatch(/Warnings <span class="need-sub-count">2</);
    expect(selectHomeCounts(state, treeOptions(state)).needsYou).toBe(3);
    // Only warnings: no badge, the warnings still counted.
    const onlyWarnings = sidebar(interactState({ inbox: [STUCK] }));
    expect(onlyWarnings).not.toContain('side-badge');
    expect(onlyWarnings).toMatch(/Warnings <span class="need-sub-count">1</);
  });

  it('words a session row as model · age', () => {
    const state = fixtureState();
    const who = selectSessionIdentity(state, KEYS.main, NOW, {});
    expect(who).not.toBeNull();
    if (who) expect(sessionMeta({ ...who, model: null })).toBe(`— · ${who.startedAgo}`);
  });
});

describe('title bar and rail', () => {
  it('has the brand, Search Ctrl+K and the live counts, and no pane buttons', () => {
    const state = interactState();
    const html = renderToStaticMarkup(
      <TitleBar counts={selectHomeCounts(state, treeOptions(state))} onSearch={noop} />,
    );
    expect(html).toContain('>Huddle<');
    expect(html).toContain('aria-keyshortcuts="Control+K"');
    expect(html).toContain('Ctrl+K');
    expect(html).toMatch(/needs? you/);
    expect(html).toContain('stuck');
    for (const gone of ['Launch…', 'Templates', 'Rules', '>History<', '>Ask<', '>Settings<'])
      expect(html).not.toContain(gone);
  });

  it('draws every rail button with an icon and a word, Guide last', () => {
    const html = renderToStaticMarkup(<Rail current={null} onPlace={noop} />);
    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html).not.toContain('aria-current');
    expect(html.indexOf('Guide')).toBeGreaterThan(html.indexOf('rail-gap'));
  });

  it('Library: Templates and Rules as tabs', () => {
    const html = renderToStaticMarkup(
      <Library tab="rules" onTab={noop}>
        <p>rules panel</p>
      </Library>,
    );
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Templates</);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Rules</);
    expect(html).toContain('role="tabpanel"');
  });
});

describe('sidebar', () => {
  it('groups sessions under their project with + New run, and the agents on rails', () => {
    const html = sidebar(fixtureState());
    expect(html).toContain('aria-label="Projects and sessions"');
    expect(html).toContain('+ New run');
    expect(html).toMatch(/class="project-name">fixture</);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="tree"');
    expect(html).toContain('class="rails"');
    // No open items: no Needs you section at all.
    expect(html).not.toContain('Needs you');
  });

  it('folds ended sessions into "Earlier", which opens History', () => {
    const state = fixtureState({ main: { status: 'done', endedAt: NOW - 1000 } });
    const html = sidebar(state);
    expect(html).toContain('Earlier · 1 ended session');
    // A project with no live session starts closed and says so in its name.
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-label="fixture, [^"]*no live sessions"/);
    expect(html).not.toContain('role="tree"');
  });

  it('hides test runs until Show all, and says how many', () => {
    const cwd = 'C:\\Users\\me\\AppData\\Local\\Temp\\huddle-s18-work-AbC123';
    const done = { status: 'done' as const, endedAt: NOW - 1000, cwd, sessionCwd: cwd };
    const state = fixtureState({ main: done, core: done, explore: done, tester: done, doneExplore: done });
    expect(sidebar(state)).toContain('Show all (1 hidden run)');
    const all = sidebar(state, { showAll: true });
    expect(all).toContain('aria-pressed="true"');
    expect(all).toContain('Hide test and empty runs');
  });
});

describe('tree row words in the sidebar', () => {
  it('a working session row has no visible "working" but says it first in its tooltip', () => {
    const html = sidebar(fixtureState());
    expect(html).not.toContain('class="tree-state tone-working"');
    expect(html).toMatch(/aria-level="1"[^>]*title="working\n/);
  });
});

describe('Needs you', () => {
  it('draws a warning as one row (no card frame, no body), a request as a card', () => {
    const html = sidebar(interactState({ inbox: [approvalItem(), STUCK] }));
    expect(html).toMatch(/<article class="need-card need-row kind-stuck"/);
    expect(html).toMatch(/<article class="card need-card kind-approval"/);
  });

  it('drops the "Waiting on you" subheading when no Warnings follow ("Needs you" already says it)', () => {
    const html = sidebar(interactState({ inbox: [approvalItem()] }));
    expect(html).toContain('aria-label="Waiting on you"');
    expect(html).not.toContain('<h3 class="need-sub">Waiting on you</h3>');
  });

  it('shows compact cards in two groups: Allow, Deny, Open on an approval, Open on the rest', () => {
    const html = sidebar(interactState({ inbox: [approvalItem(), STUCK] }));
    expect(html).toContain('aria-label="Needs you"');
    expect(html.indexOf('Waiting on you')).toBeLessThan(html.indexOf('Warnings'));
    expect(html).toContain('>Allow<');
    expect(html).toContain('>Deny<');
    expect(html.match(/>Open</g)).toHaveLength(2);
    expect(html).toContain('aria-keyshortcuts="A"');
    expect(html).toContain('npm test -- parser');
    // Where it is: project · session title.
    expect(html).toMatch(/class="need-place need-line"[^>]*>waiting 1m · fixture · Release notes</);
    // The full card's terminal button is not in a compact card.
    expect(html).not.toContain('Pass to terminal');
  });

  it('opens the deep-linked item as the full, highlighted card', () => {
    const html = sidebar(interactState({ inbox: [approvalItem(), STUCK] }), { linkedItemId: 'approval:req-1' });
    expect(html).toContain('is-selected');
    expect(html).toContain('Pass to terminal');
    expect(html).toContain('Show less');
  });

  it('keeps Recently handled behind a link', () => {
    const handled = approvalItem({ id: 'approval:old', resolvedAt: NOW - 5000 });
    const html = sidebar(interactState({ inbox: [approvalItem(), handled] }));
    expect(html).toContain('Recently handled (1)');
    expect(html).toContain('aria-expanded="false"');
  });

  it('renders agent text as text', () => {
    const item = approvalItem({ approval: { ...APPROVAL, summary: XSS }, agentKey: IK.tester });
    const html = sidebar(interactState({ inbox: [item] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('review fixes', () => {
  const on = { enabled: true, reason: null };

  it('compact card keys: A allows, D denies, O opens; nothing while the card is arming', () => {
    expect(compactKeyAction('a', { approve: on, deny: on })).toBe('allow');
    expect(compactKeyAction('D', { approve: on, deny: on })).toBe('deny');
    expect(compactKeyAction('o', { approve: on, deny: on })).toBe('open');
    expect(compactKeyAction('o', null)).toBe('open');
    expect(compactKeyAction('a', null)).toBeNull();
    const arming = { approve: armControl(on, false), deny: armControl(on, false) };
    expect(compactKeyAction('a', arming)).toBeNull();
    expect(compactKeyAction('d', arming)).toBeNull();
    expect(compactKeyAction('x', { approve: on, deny: on })).toBeNull();
  });

  it('splitter keys start from the drawn width and stay in range', () => {
    // Drawn at 280 on a 960 px window though 312 is stored: Right goes to 296, not 328.
    expect(splitterKey('ArrowRight', false, 280)).toBe(296);
    expect(splitterKey('ArrowLeft', true, 300)).toBe(280);
    expect(splitterKey('ArrowRight', true, 400)).toBe(420);
    expect(splitterKey('Home', false, 350)).toBe(280);
    expect(splitterKey('End', false, 350)).toBe(420);
    expect(splitterKey('Enter', false, 350)).toBeNull();
  });

  it("keeps a project's open or closed choice when its last session ends", () => {
    const live = selectProjects(fixtureState(), {})[0];
    const ended = selectProjects(fixtureState({ main: { status: 'done', endedAt: NOW - 1000 } }), {})[0];
    expect(live && ended && live.id === ended.id).toBe(true);
    if (!live || !ended) return;
    expect(isProjectOpen(new Map(), live)).toBe(true);
    expect(isProjectOpen(new Map(), ended)).toBe(false);
    const choices = new Map([[live.id, true]]);
    expect(isProjectOpen(choices, ended)).toBe(true);
    const closed = new Map([[live.id, false]]);
    expect(isProjectOpen(closed, live)).toBe(false);
    // Rendered: the chosen state wins over the default.
    const html = sidebar(fixtureState({ main: { status: 'done', endedAt: NOW - 1000 } }), { projectChoices: choices });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('No live sessions. Ended ones are in History.');
  });

  it('says how long an item has waited on the place line', () => {
    const item = approvalItem();
    expect(waitedWords(item, item.createdAt + 3 * 60_000)).toBe('waiting 3m');
    expect(waitedWords(item, item.createdAt + 10_000)).toBe('just now');
    expect(itemPlace(null, 'waiting 3m')).toBe('waiting 3m');
    expect(itemPlace(null)).toBe('—');
    const html = sidebar(interactState({ inbox: [approvalItem()] }));
    expect(html).toMatch(/class="need-place need-line"[^>]*>waiting 1m · fixture · /);
    // Time left stays in the corner.
    expect(html).toContain('left, est.');
  });

  it('when nothing waits, keeps only a quiet Recently handled line (no header, no groups)', () => {
    const handled = approvalItem({ id: 'approval:old', resolvedAt: NOW - 5000 });
    const html = sidebar(interactState({ inbox: [handled] }));
    expect(html).toContain('Recently handled (1)');
    expect(html).not.toContain('Needs you');
    expect(html).not.toContain('Waiting on you');
    expect(html).not.toContain('Warnings');
  });

  it('a deep link to a handled item opens the list once', () => {
    const handled = approvalItem({ id: 'approval:old', resolvedAt: NOW - 5000 });
    const html = sidebar(interactState({ inbox: [handled] }), { linkedItemId: 'approval:old' });
    expect(html).toContain('Hide recently handled');
    expect(html).toContain('is-selected');
  });

  it('keeps items of stale or ended sessions out of the groups, the badge and the counts, behind one toggle', () => {
    // The Huddle started after the session's last event: the session is stale.
    const later = { status: 'attached' as const, message: null, startedAt: NOW + 60_000 };
    const state = interactState({ inbox: [approvalItem(), STUCK], connection: later });
    const g = needsYouGroups(state, treeOptions(state));
    expect(g.waiting).toHaveLength(0);
    expect(g.warnings).toHaveLength(0);
    expect(g.older.map((i) => i.kind)).toEqual(['approval', 'stuck']);
    expect(selectHomeCounts(state, treeOptions(state))).toMatchObject({ needsYou: 0, stuck: 0 });
    const html = sidebar(state);
    expect(html).not.toContain('Needs you');
    expect(html).toContain('2 older (ended or from before the restart)');
    expect(html).not.toContain('npm test -- parser');
    expect(olderWords(2, true)).toBe('Hide 2 older items');
    // A live session's items stay in the groups and the badge.
    const live = needsYouGroups(interactState({ inbox: [approvalItem(), STUCK] }));
    expect(live.older).toHaveLength(0);
  });

  it("announces counts from the title bar (Home's copy is checked in home.test.tsx)", () => {
    const counts = { working: 1, needsYou: 0, stuck: 0 };
    expect(renderToStaticMarkup(<TitleBar counts={counts} onSearch={noop} />)).toContain('aria-live="polite"');
  });

  it('gives the session title its own tooltip so it can shrink at 280 px', () => {
    expect(sidebar(fixtureState())).toMatch(/class="tree-name" title="[^"]+">/);
  });
});
