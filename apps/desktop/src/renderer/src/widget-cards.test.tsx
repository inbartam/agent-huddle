/**
 * Widget v2 (owner's choice 2026-11-14), rendered: one card per session with a face, status in words and a glyph,
 * the request inline on the right card (with the shared InboxCard buttons), the × that hides a card until the
 * session does something new, the tasks progress line, and agent text as text.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentKey, DEFAULT_USER_SETTINGS, selectTree, type AgentKey, type HuddleState } from '@huddle/shared';
import { agent, fixtureState, KEYS, T0, XSS } from './testing/fixture.js';
import { approvalItem, interactState, NOW, questionItem } from './testing/interact-fixture.js';
import { collapseCommand, connectionWord, savedCollapsed, shownCollapsed } from './view/collapse.js';
import { hide, type HiddenMarks } from './view/hidden.js';
import { settled } from './testing/arming.js';
import { WidgetBody } from './views/WidgetView.js';

const noop = () => undefined;
const ok = () => Promise.resolve({ ok: true as const });

function widget(
  state: HuddleState,
  opts: { hidden?: HiddenMarks; opened?: ReadonlySet<AgentKey>; now?: number; collapsed?: boolean } = {},
): string {
  return renderToStaticMarkup(
    settled(
      <WidgetBody
        state={state}
        error={null}
        renames={new Map()}
        opened={opts.opened ?? new Set()}
        onToggle={noop}
        onOpenMain={noop}
        onCommand={ok}
        now={opts.now ?? NOW}
        hidden={opts.hidden}
        onHide={noop}
        onShowHidden={noop}
        collapsed={opts.collapsed}
        onCollapse={noop}
      />,
    ),
  );
}

/** The markup of each session card, keyed by session id. */
function cards(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = html.split('<article class="scard ').slice(1);
  for (const part of parts) {
    const id = /data-session="([^"]+)"/.exec(part)?.[1];
    if (id) out.set(id, part);
  }
  return out;
}

/** Two sessions: the interact fixture (requests waiting) and a quiet one working on its own. */
function twoSessions(extra: Partial<HuddleState> = {}): HuddleState {
  const base = interactState();
  const quiet = agentKey('quiet-session');
  return {
    ...base,
    agents: {
      ...base.agents,
      [quiet]: agent({
        key: quiet,
        sessionId: 'quiet-session',
        name: 'Quiet session',
        kind: 'main',
        role: 'main',
        status: 'working',
        currentActivity: 'Edit src/a.ts',
        lastEventAt: T0 + 30_000,
      }),
    },
    rootKeys: [...base.rootKeys, quiet],
    ...extra,
  };
}

describe('session cards', () => {
  it('renders one card per session with a face and the status as glyph and words', () => {
    const html = widget(twoSessions());
    const byId = cards(html);
    expect([...byId.keys()].sort()).toEqual(['fixture-session', 'quiet-session']);
    const quiet = byId.get('quiet-session') ?? '';
    expect(quiet).toMatch(/<svg class="face face-hue-\d is-breathing"[^>]*aria-hidden="true"[^>]*data-mood="focused"/);
    expect(quiet).toContain('data-status="working" aria-hidden="true">●<');
    expect(quiet).toContain('<span class="scard-status tone-working">working</span>');
    expect(quiet).toContain('<span class="scard-activity">Edit src/a.ts</span>');
    // The quiet card can be hidden; the card that needs the user cannot.
    expect(quiet).toContain('title="Hide until it does something new"');
    expect(byId.get('fixture-session')).not.toContain('Hide until it does something new');
  });

  it('renders the approval inline on the card of the session it came from, with the shared buttons', () => {
    const byId = cards(widget(twoSessions()));
    const asking = byId.get('fixture-session') ?? '';
    expect(asking.startsWith('tone-needs-you needs-you"')).toBe(true);
    expect(asking).toContain(
      '<span class="scard-need-words">needs approval</span><span class="scard-who">Tests</span>',
    );
    expect(asking).toContain('<article class="card kind-approval is-compact is-inline"');
    expect(asking).toMatch(/<button[^>]*class="control control-primary"[^>]*aria-keyshortcuts="A"[^>]*>Allow</);
    expect(asking).toContain('>Deny…</button>');
    expect(asking).toContain('>Terminal</button>');
    expect(asking).toContain('2 more waiting in this session');
    expect(byId.get('quiet-session')).not.toContain('scard-request');
  });

  it('renders a single question with options to pick and a Send that waits for a pick', () => {
    const state = interactState({ inbox: [questionItem()] });
    const html = widget(state);
    expect(html).toContain('<p class="question-header">Tone</p>');
    expect(html).toMatch(/class="control control-plain option"[^>]*aria-pressed="false"[^>]*><span class="option-dot"/);
    const send = /<button[^>]*>Send<\/button>/.exec(html)?.[0] ?? '';
    expect(send).toContain('aria-disabled="true"');
    expect(send).toContain('title="Pick an answer or type one first."');
    expect(html).toContain('>Answer in terminal</button>');
  });

  it('hides a card with ×, and a new event brings it back', () => {
    const state = twoSessions();
    const quiet = selectTree(state).find((s) => s.sessionId === 'quiet-session');
    if (!quiet) throw new Error('fixture');
    const marks = hide(new Map(), quiet);
    const hidden = widget(state, { hidden: marks });
    expect(cards(hidden).has('quiet-session')).toBe(false);
    expect(hidden).toContain('1 session hidden until they do something new');
    expect(hidden).toContain('>Show</button>');

    const quietKey = agentKey('quiet-session');
    const moved: HuddleState = {
      ...state,
      agents: {
        ...state.agents,
        [quietKey]: { ...(state.agents[quietKey] ?? agent({ key: quietKey, name: '' })), lastEventAt: T0 + 50_000 },
      },
    };
    const back = widget(moved, { hidden: marks });
    expect(cards(back).has('quiet-session')).toBe(true);
    expect(back).not.toContain('hidden until they do something new');
  });

  it('a hidden card that starts needing the user comes back', () => {
    const state = twoSessions();
    const asking = selectTree(state).find((s) => s.sessionId === 'fixture-session');
    if (!asking) throw new Error('fixture');
    expect(cards(widget(state, { hidden: hide(new Map(), asking) })).has('fixture-session')).toBe(true);
  });

  it('shows "3/5" and the next task for a session working through tasks, with a bar of done/total', () => {
    const tasks = ['Outline', 'Facts', 'Shots', 'Drafting', 'Proofread'].map((subject, i) => ({
      id: String(i),
      subject,
      status: i < 3 ? ('completed' as const) : ('pending' as const),
      createdAt: T0,
      ...(i < 3 ? { completedAt: T0 + (i + 1) * 10_000 } : {}),
    }));
    const state: HuddleState = {
      agents: {
        [KEYS.main]: agent({ key: KEYS.main, name: 'Launch post', kind: 'main', role: 'main', tasks }),
      },
      rootKeys: [KEYS.main],
      inbox: [],
      rateLimits: null,
    };
    const html = widget(state, { now: T0 + 60_000 });
    expect(html).toContain('<span class="scard-lead">3/5</span><span class="scard-progress-text">Drafting</span>');
    expect(html).toMatch(/class="bar tone-working bar-thin scard-pbar" role="progressbar"[^>]*aria-valuenow="60"/);
    expect(html).toContain('<span class="bar-fill" style="width:60%">');
    // Opened in place: the task list with done and to-do marks.
    const opened = widget(state, { now: T0 + 60_000, opened: new Set([KEYS.main]) });
    expect(opened).toContain('aria-label="Tasks"');
    expect(opened).toMatch(
      /class="is-done"><span class="task-mark" aria-hidden="true">✓<\/span><span class="task-subject">Outline/,
    );
    expect(opened).toContain('<span class="task-mark" aria-hidden="true">○</span><span class="task-subject">Drafting');
  });

  it('shows the task in progress on the card and marks it in the list with a shape and words', () => {
    const tasks = ['Outline', 'Facts', 'Shots', 'Drafting', 'Proofread'].map((subject, i) => ({
      id: String(i),
      subject,
      status: i < 3 ? ('completed' as const) : ('pending' as const),
      createdAt: T0,
      ...(i < 3 ? { completedAt: T0 + (i + 1) * 10_000 } : {}),
      // Proofread was started (TaskUpdate in_progress) before Drafting: it is the one in progress.
      ...(i === 4 ? { startedAt: T0 + 40_000 } : {}),
    }));
    const state: HuddleState = {
      agents: { [KEYS.main]: agent({ key: KEYS.main, name: 'Launch post', kind: 'main', role: 'main', tasks }) },
      rootKeys: [KEYS.main],
      inbox: [],
      rateLimits: null,
    };
    const html = widget(state, { now: T0 + 60_000, opened: new Set([KEYS.main]) });
    expect(html).toContain('<span class="scard-lead">3/5</span><span class="scard-progress-text">Proofread</span>');
    expect(html).toContain(
      '<li class="is-current"><span class="task-mark" aria-hidden="true">◐</span><span class="task-subject">Proofread</span><span class="task-state">in progress</span></li>',
    );
    expect(html).toContain(
      '<li class=""><span class="task-mark" aria-hidden="true">○</span><span class="task-subject">Drafting</span><span class="visually-hidden">, to do</span></li>',
    );
    expect(html).toContain('<span class="task-subject">Outline</span><span class="visually-hidden">, done</span>');
  });

  it('draws no bar and no progress words for a session without a basis', () => {
    const state = fixtureState({ explore: { status: 'working' }, main: { status: 'idle' } });
    const html = widget(state);
    expect(html).not.toContain('scard-bar');
    expect(html).not.toContain('scard-lead');
  });

  it('opens the subagent tree inside the card', () => {
    const html = widget(fixtureState(), { opened: new Set([KEYS.main]) });
    expect(html).toContain('aria-label="Agents in Fixture session"');
    expect(html).toContain('>Build ingest<');
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders agent text in a card as text', () => {
    const state = fixtureState({
      main: { name: XSS, currentActivity: XSS },
      explore: { name: XSS, status: 'working' },
    });
    const html = widget(state, { opened: new Set([KEYS.main]) });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('keeps a request with no card reachable at the bottom', () => {
    const lost = approvalItem({ id: 'approval:lost', agentKey: agentKey('gone-session') });
    const html = widget(interactState({ inbox: [lost] }));
    expect(html).toContain('<section class="pinned" aria-label="Waiting on you">');
    expect(html).toContain('data-item="approval:lost"');
  });
});

describe('collapsed to one line', () => {
  /** The chevron button's markup. */
  const chevron = (html: string) => /<button[^>]*aria-expanded="(?:true|false)"[^>]*>/.exec(html)?.[0] ?? '';

  it('renders only the header line, with the counts, and no cards, limits or connection row', () => {
    const state: HuddleState = {
      ...twoSessions(),
      rateLimits: {
        fiveHourUsedPct: 42,
        fiveHourResetsAt: null,
        sevenDayUsedPct: 18,
        sevenDayResetsAt: null,
        measuredAt: T0,
      },
    };
    const html = widget(state, { collapsed: true });
    expect(html).toMatch(/^<div class="widget is-collapsed"><header class="widget-head">.*<\/header><\/div>$/);
    expect(html).not.toContain('scard');
    expect(html).not.toContain('Plan usage limits');
    expect(html).toContain('<span class="widget-working">2 working</span>');
    // The needs-you count stays visible while collapsed, in the needs-you colour.
    expect(html).toContain('<span class="widget-needs tone-needs-you">');
    expect(html).toMatch(/3<!-- --> need<!-- -->\s*<!-- -->you|3 need you/);
    expect(chevron(html)).toContain('aria-expanded="false"');
    expect(chevron(html)).toContain('title="Expand"');
    // The counts expand the widget on a click.
    expect(html).toMatch(/<button type="button" class="widget-counts" title="Expand"/);
  });

  it('expanded shows the cards again, and the chevron says it collapses', () => {
    const html = widget(twoSessions(), { collapsed: false });
    expect(html).toContain('<div id="widget-content" class="widget-content">');
    expect(cards(html).size).toBe(2);
    expect(chevron(html)).toContain('aria-expanded="true"');
    expect(chevron(html)).toContain('aria-controls="widget-content"');
    expect(chevron(html)).toContain('title="Collapse to one line"');
  });

  it('still shows a connection that is not attached on the one line', () => {
    const html = widget(
      { ...twoSessions(), connection: { status: 'port_in_use', message: 'Port 47821 is in use.' } },
      { collapsed: true },
    );
    expect(html).toContain('<span class="widget-conn-word tone-failed">');
    expect(html).toContain('port in use');
    expect(html).not.toContain('Port 47821 is in use.');
  });
});

describe('collapsed state is saved as a setting', () => {
  it('reads the saved value from the settings, false when there are none', () => {
    expect(savedCollapsed(null)).toBe(false);
    expect(savedCollapsed(interactState())).toBe(false);
    const settings = { ...DEFAULT_USER_SETTINGS, widgetCollapsed: true };
    expect(savedCollapsed({ ...interactState(), settings })).toBe(true);
  });

  it('shows a click at once, then follows the saved value', () => {
    expect(shownCollapsed(false, true)).toBe(true);
    expect(shownCollapsed(true, null)).toBe(true);
    expect(shownCollapsed(false, null)).toBe(false);
  });

  it('saves the choice with settings.update, a patch the IPC schema accepts', () => {
    expect(collapseCommand(true)).toEqual({ type: 'settings.update', patch: { widgetCollapsed: true } });
    expect(collapseCommand(false)).toEqual({ type: 'settings.update', patch: { widgetCollapsed: false } });
  });

  it('names a connection problem in a few words, nothing when attached', () => {
    expect(connectionWord(undefined)).toBeNull();
    expect(connectionWord({ status: 'attached', message: null })).toBeNull();
    expect(connectionWord({ status: 'needs_consent', message: null })).toEqual({
      word: 'not connected',
      tone: 'needs-you',
    });
    expect(connectionWord({ status: 'error', message: 'x' })?.word).toBe('connection error');
  });
});
