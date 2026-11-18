/**
 * Main window redesign, WP3: Home (date line, count cards and their meanings, Today, the Ask card, the explanation),
 * the session view (breadcrumb, status line, Message / Pause / Stop with reasons, tabs, why it is asking, Make a rule
 * from this…), the rule draft from a request, the guide's shown-once rule and the storage fallbacks. Pure helpers and
 * static renders (no DOM).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_REASONS,
  RUN_REASONS,
  selectProjects,
  selectSessionIdentity,
  type AgentKey,
  type HuddleState,
} from '@huddle/shared';
import { Guide, GUIDE_STEPS } from './components/Guide.js';
import { Home, type HomeProps } from './components/Home.js';
import { RulesPanel } from './components/Rules.js';
import { SessionView, type SessionViewProps } from './components/SessionView.js';
import { settled } from './testing/arming.js';
import { fixtureState, KEYS, T0, XSS } from './testing/fixture.js';
import { APPROVAL, approvalItem, IK, interactState, NOW } from './testing/interact-fixture.js';
import { m4State, MK, NOW_M4 } from './testing/m4-fixture.js';
import { previewCovers } from './view/ask.js';
import { homeCountsLine, homeHeading, startOfDay, todayRows } from './view/home.js';
import {
  EXPLAIN_KEYS,
  explainShown,
  GUIDE_KEY,
  markGuideSeen,
  readFlag,
  setExplainShown,
  shouldShowGuide,
  writeFlag,
  type FlagStore,
} from './view/prefs.js';
import { allowsChangingCommands, allowsChangingTool, emptyRuleDraft, validateRule } from './view/rules.js';
import {
  commandPrefixOf,
  makeRuleNote,
  ruleDraftFromRequest,
  sessionActions,
  sessionHead,
  sessionTabs,
  SESSION_WORDS,
  whyAsking,
} from './view/session.js';
import { treeOptions } from './view/summary.js';

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
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

function identityOf(state: HuddleState, now: number) {
  return (key: AgentKey) => selectSessionIdentity(state, key, now, {});
}

function home(state: HuddleState, now: number, extra: Partial<HomeProps> = {}): string {
  const projects = selectProjects(state, treeOptions(state));
  return renderToStaticMarkup(
    <Home
      projects={projects}
      now={now}
      identity={identityOf(state, now)}
      onStart={noop}
      onHistory={noop}
      onOpenSession={noop}
      askEnabled={false}
      askStatus={null}
      query={null}
      onCommand={ok}
      onOpenAskSettings={noop}
      askPrefill={null}
      explainStore={null}
      {...extra}
    />,
  );
}

function session(state: HuddleState, agentKey: AgentKey, now: number, extra: Partial<SessionViewProps> = {}): string {
  return renderToStaticMarkup(
    settled(
      <SessionView
        state={state}
        agentKey={agentKey}
        renames={new Map()}
        now={now}
        query={null}
        onCommand={ok}
        onRename={ok}
        onSelect={noop}
        onHome={noop}
        section="now"
        onSection={noop}
        timeline={{ rows: [], loading: false }}
        filter="all"
        onFilter={noop}
        lastHoldEnding={null}
        onMakeRule={noop}
        {...extra}
      />,
    ),
  );
}

describe('Home helpers', () => {
  it('words the date line', () => {
    const now = new Date(2026, 10, 16, 10, 0).getTime();
    expect(homeHeading(now)).toBe('Monday 16 Nov');
    expect(homeCountsLine(4, 6)).toBe('4 projects · 6 sessions today');
    expect(homeCountsLine(1, 1)).toBe('1 project · 1 session today');
  });

  it('lists the sessions active today, with readable titles and a status shape and word', () => {
    const state = fixtureState();
    const now = T0 + 60_000;
    const rows = todayRows(selectProjects(state, treeOptions(state)), now, identityOf(state, now));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rootKey).toBe(KEYS.main);
    expect(rows[0]?.meta).toMatch(/^fixture · \d+ agents · /);
    // Tomorrow it is not "today" any more.
    expect(
      todayRows(selectProjects(state, treeOptions(state)), startOfDay(now) + 36 * 3_600_000, identityOf(state, now)),
    ).toEqual([]);
  });
});

describe('Home', () => {
  it('has the title, date line, Explain, Start a run, Today first and the Ask card; no copy of the counts', () => {
    const html = home(interactState(), NOW);
    // The heading is the day: the rail already says "Home".
    expect(html).toMatch(/<h1 class="home-h1">\w+day \d+ \w+<\/h1>/);
    expect(html).not.toContain('<h1 class="home-h1">Home</h1>');
    expect(html).toContain('Explain this screen');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Home is the one place to start.');
    expect(html).toContain('>Start a run</button>');
    expect(html).toContain('aria-label="Ask the Huddle"');
    expect(html).toContain('read-only · Haiku');
    expect(html).toContain('Turn on in Settings');
    expect(html).toContain('aria-label="Today"');
    expect(html).toContain('Release notes');
    // The counts live in the title bar only (slop review 2026-11-18).
    expect(html).not.toContain('home-stats');
    expect(html.indexOf('aria-label="Today"')).toBeLessThan(html.indexOf('aria-label="Ask the Huddle"'));
  });

  it('remembers a hidden explanation; empty Today says what to do', () => {
    const store = memoryStore();
    setExplainShown(store, 'home', false);
    const html = home({ agents: {}, rootKeys: [], inbox: [], rateLimits: null }, NOW, { explainStore: store });
    expect(html).not.toContain('Home is the one place to start.');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Nothing has run today.');
  });

  it('hands the palette question to the Ask box without sending it', () => {
    const sent: unknown[] = [];
    const html = home(interactState(), NOW, {
      askEnabled: true,
      askPrefill: { question: `why? ${XSS}`, n: 1 },
      onCommand: (cmd) => {
        sent.push(cmd);
        return ok();
      },
    });
    expect(html).toContain('>why? &lt;img src=x onerror=alert(1)&gt;</textarea>');
    expect(sent).toEqual([]);
  });
});

describe('session view helpers', () => {
  it('heads with project, readable title, status shape and word, and facts', () => {
    const state = interactState();
    const head = sessionHead(state, IK.tester, NOW);
    expect(head).toMatchObject({ rootKey: IK.main, project: 'fixture', title: 'Release notes' });
    expect(head?.label).toBe('needs approval');
    expect(head?.glyph).toBe('▲');
    // Unknown parts (the model here) are left out, never shown as "—".
    expect(head?.facts).toMatch(/^fixture · started .* · 5 agents$/);
    expect(head?.facts).not.toContain('—');
    expect(head?.lastHeard).toBeNull();
    expect(sessionHead(state, 'nobody', NOW)).toBeNull();
  });

  it('Stop is off with a reason for a session started in a terminal, on for a Huddle run', () => {
    const attached = interactState();
    const a = sessionActions(attached, attached.agents[IK.main] ?? fail());
    expect(a.stop).toEqual({ enabled: false, reason: RUN_REASONS.notManaged });
    const managed = m4State();
    const m = sessionActions(managed, managed.agents[MK.run] ?? fail());
    expect(m.stop.enabled).toBe(true);
    expect(m.runId).not.toBeNull();
    // Not connected: everything says why.
    const offline = interactState({ connection: undefined });
    const o = sessionActions(offline, offline.agents[IK.main] ?? fail());
    expect(o.message.reason).toBe(CONTROL_REASONS.notConnected);
    expect(o.pause.reason).toBe(CONTROL_REASONS.notConnected);
  });

  it('why it is asking: generic and true, never a rule name', () => {
    expect(whyAsking(approvalItem())).toBe('Claude Code asks before running this; no Huddle rule answered it.');
    expect(whyAsking(approvalItem({ resolvedAt: NOW }))).toBeNull();
    expect(whyAsking({ ...approvalItem(), kind: 'stuck' })).toBeNull();
  });

  it('a rule draft never wider than the request: allow only a read-only shell prefix, else ask (exact)', () => {
    expect(commandPrefixOf('npm test -- parser\nmore')).toBe('npm test');
    expect(commandPrefixOf('  ls -la ')).toBe('ls');
    expect(commandPrefixOf('   ')).toBeNull();
    const state = interactState();
    const tester = state.agents[IK.tester] ?? null;
    // npm test is not read-only: ask, exactly this command.
    const npm = ruleDraftFromRequest(APPROVAL, tester, 'rule-1');
    expect(npm).toMatchObject({
      id: 'rule-1',
      name: 'Ask before npm test',
      action: 'ask',
      commandExact: true,
      match: { tool: 'Bash', commandPrefix: 'npm test', folder: 'C:\\projects\\fixture' },
    });
    expect(validateRule(npm)).toEqual({});
    // git status is read-only: allow the prefix.
    const git = ruleDraftFromRequest({ ...APPROVAL, toolInput: { command: 'git status --short' } }, tester, 'r');
    expect(git).toMatchObject({ action: 'allow', commandExact: false, match: { commandPrefix: 'git status' } });
    expect(git.name).toBe('Allow git status');
    expect(validateRule(git)).toEqual({});
    // `<tool> --version`: allow, but exactly, so nothing can ride along after it (as the default version rules).
    const version = ruleDraftFromRequest({ ...APPROVAL, toolInput: { command: 'sometool --version' } }, tester, 'r');
    expect(version).toMatchObject({
      action: 'allow',
      commandExact: true,
      match: { commandPrefix: 'sometool --version' },
    });
    expect(allowsChangingCommands(version)).toBe(false);
    // git show is not drafted as an allow (the defaults leave it out too).
    const show = ruleDraftFromRequest({ ...APPROVAL, toolInput: { command: 'git show HEAD' } }, tester, 'r');
    expect(show).toMatchObject({ action: 'ask', commandExact: true, match: { commandPrefix: 'git show HEAD' } });
    // Chaining, substitution, redirection, or several lines: ask, the part before the first such character.
    for (const command of ['git status; rm -rf /', 'ls && curl x', 'ls | sh', 'echo `id`', 'cat $(x)', 'ls > out']) {
      const d = ruleDraftFromRequest({ ...APPROVAL, toolInput: { command } }, null, 'r');
      expect(d.action).toBe('ask');
      expect(d.commandExact).toBe(false);
      expect(d.match.commandPrefix).not.toMatch(/[;&|`$()<>]/);
    }
    expect(ruleDraftFromRequest({ ...APPROVAL, toolInput: { command: 'ls\nrm x' } }, null, 'r').action).toBe('ask');
    // No command in the input: the masked summary.
    const fromSummary = ruleDraftFromRequest({ ...APPROVAL, toolInput: {}, summary: 'pwd' }, null, 'r');
    expect(fromSummary).toMatchObject({ action: 'allow', match: { commandPrefix: 'pwd' } });
    // Other tools: ask on the tool, never allow.
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'mcp__srv__do', 'Read']) {
      const d = ruleDraftFromRequest({ ...APPROVAL, toolName: tool, toolInput: { file_path: 'x' } }, null, 'r');
      expect(d.action).toBe('ask');
      expect(d.match).toEqual({ ...emptyRuleDraft('r').match, tool });
    }
  });

  it('the editor warns on an allow for a tool that can change things with no path pattern', () => {
    const base = emptyRuleDraft('r');
    const allow = (tool: string, pathGlob = '') => ({
      ...base,
      action: 'allow' as const,
      match: { ...base.match, tool, pathGlob },
    });
    expect(allowsChangingTool(allow('Write'))).toBe(true);
    expect(allowsChangingTool(allow('WebFetch'))).toBe(true);
    expect(allowsChangingTool(allow('mcp__srv__do'))).toBe(true);
    expect(allowsChangingTool(allow('Write', 'docs/**'))).toBe(false);
    expect(allowsChangingTool(allow('Read'))).toBe(false);
    expect(allowsChangingTool(allow('Bash'))).toBe(false);
    expect(allowsChangingTool({ ...allow('Write'), action: 'ask' })).toBe(false);
  });

  it('says rules apply only to Huddle runs for a terminal session while the setting is off', () => {
    const attached = interactState();
    expect(makeRuleNote(attached, attached.agents[IK.tester] ?? fail())).toBe(SESSION_WORDS.rulesOnlyLaunched);
    const managed = m4State();
    expect(makeRuleNote(managed, managed.agents[MK.coder] ?? fail())).toBeNull();
  });
});

describe('session view', () => {
  it('one compact head: name with Rename and the actions, one status line, tabs and the agent panel (no second tree)', () => {
    const html = session(interactState(), IK.main, NOW);
    expect(html).toMatch(
      /<h1 class="agent-name" title="Release notes">Release notes<\/h1><button[^>]*>Rename<\/button>/,
    );
    expect(html).toContain('needs approval');
    expect(html).toContain('>Message</button>');
    // A session started in a terminal can never be stopped from here: no Stop and no reason; the status line says so.
    expect(html).not.toContain('>Stop</button>');
    expect(html).not.toContain(`Stop: ${RUN_REASONS.notManaged}`);
    expect(html).toContain('>started in a terminal</span>');
    expect(html).toContain('aria-label="Session sections"');
    expect(html).toContain('>Live</button>');
    expect(html).toContain('>Replay</button>');
    // Report only once the run has ended: before that it would always be empty.
    expect(html).not.toContain('>Report</button>');
    // The session's tree is the sidebar's; Live does not draw it a second time.
    expect(html).not.toContain('role="tree"');
    // Messages still wait to be delivered here, so the lead's message box stays open with them.
    expect(html).toContain('Waiting to be delivered');
    // The lead is "Lead agent" inside its session, never "main"; no explanatory banner, no "reports to you".
    expect(html).toContain('>Lead agent<');
    expect(html).not.toContain('Explain this screen');
    expect(html).not.toContain('One Claude Code session');
    expect(html).not.toContain('reports to you');
  });

  it('an ended run offers Report', () => {
    const state = interactState();
    const main = state.agents[IK.main] ?? fail();
    const ended = {
      ...state,
      agents: { ...state.agents, [IK.main]: { ...main, status: 'done' as const, endedAt: NOW } },
    };
    expect(sessionTabs(true)).toEqual(['live', 'replay', 'report']);
    expect(sessionTabs(false)).toEqual(['live', 'replay']);
    expect(session(ended, IK.main, NOW)).toContain('>Report</button>');
  });

  it('on an approval: why it is asking and Make a rule from this…, with the terminal-session note', () => {
    const html = session(interactState(), IK.tester, NOW);
    expect(html).toContain('Why it is asking');
    expect(html).toContain('Claude Code asks before running this; no Huddle rule answered it.');
    // The request can be answered right here, with the inbox card's own buttons.
    expect(html).toContain('>Allow</button>');
    expect(html).toContain('>Deny…</button>');
    // Nothing queued for this agent: its message box starts closed, as one Message… row.
    expect(html).toContain('>Message…</button>');
    expect(html).not.toContain('composer-text');
    expect(html).toContain('Make a rule from this…');
    expect(html).toContain('Rules apply only to runs Huddle started');
    // No why block on an agent with nothing open.
    expect(session(interactState({ inbox: [] }), IK.tester, NOW)).not.toContain('Why it is asking');
  });

  it('a Huddle run: Stop on; the agent text stays text', () => {
    const state = m4State({ root: { currentActivity: XSS } });
    const html = session(state, MK.run, NOW_M4);
    expect(html).toMatch(/class="control control-quiet"[^>]*>Stop<\/button>/);
    expect(html).not.toMatch(/is-off"[^>]*>Stop<\/button>/);
    expect(html).not.toContain(`Stop: ${RUN_REASONS.notManaged}`);
    expect(html).not.toContain('<img');
  });

  it('Replay and Report read the stored run (History components), Replay offers no action', () => {
    const html = session(interactState(), IK.main, NOW, {
      initialTab: 'replay',
      initialHead: { ok: false, code: 'not_found', message: 'gone' },
    });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('>Allow</button>');
  });

  it('says so when the agent is gone', () => {
    expect(session(interactState(), 'gone', NOW)).toContain(SESSION_WORDS.noSession);
  });
});

describe('Rules editor prefilled from a request', () => {
  it('opens the editor on a new rule with the request filled in; nothing is sent by opening it', () => {
    const state = interactState();
    const sent: unknown[] = [];
    const draft = ruleDraftFromRequest(APPROVAL, state.agents[IK.tester] ?? null, 'rule-x');
    const html = renderToStaticMarkup(
      <RulesPanel
        state={state}
        renames={new Map()}
        onCommand={(cmd) => {
          sent.push(cmd);
          return ok();
        }}
        query={null}
        decisions={null}

        prefill={draft}
      />,
    );
    expect(html).toContain('New rule');
    expect(html).toContain('value="Ask before npm test"');
    expect(html).toContain('value="npm test"');
    expect(html).toMatch(/id="rule-rule-x-exact" type="checkbox" class="checkbox" checked=""/);
    expect(html).toContain('value="C:\\projects\\fixture"');
    expect(html).toContain('What would this have matched?');
    expect(sent).toEqual([]);
  });
});

describe('guide and per-viewer flags', () => {
  it('shows once, never over the consent screen; storage that fails reads as not seen', () => {
    const store = memoryStore();
    expect(shouldShowGuide(store, false)).toBe(true);
    expect(shouldShowGuide(store, true)).toBe(false);
    expect(markGuideSeen(store)).toBe(true);
    expect(store.data.get(GUIDE_KEY)).toBe('1');
    expect(shouldShowGuide(store, false)).toBe(false);
    expect(shouldShowGuide(null, false)).toBe(true);
    expect(shouldShowGuide(brokenStore, false)).toBe(true);
    expect(markGuideSeen(brokenStore)).toBe(false);
  });

  it('explanations show until hidden; a failing store shows them and forgets', () => {
    const store = memoryStore();
    expect(explainShown(store, 'session')).toBe(true);
    setExplainShown(store, 'session', false);
    expect(store.data.get(EXPLAIN_KEYS.session)).toBe('1');
    expect(explainShown(store, 'session')).toBe(false);
    expect(explainShown(store, 'home')).toBe(true);
    expect(explainShown(brokenStore, 'home')).toBe(true);
    expect(setExplainShown(brokenStore, 'home', false)).toBe(false);
    expect(readFlag(null, 'x')).toBeNull();
    expect(writeFlag(null, 'x', true)).toBe(false);
  });

  it('the guide: four steps as a modal dialog, glyph and word in the legend, Skip and Next', () => {
    expect(GUIDE_STEPS).toHaveLength(4);
    const first = renderToStaticMarkup(<Guide onClose={noop} />);
    expect(first).toContain('role="dialog"');
    expect(first).toContain('aria-modal="true"');
    expect(first).toContain('step 1 of 4');
    expect(first).toContain('>Skip</button>');
    expect(first).toContain('>Next</button>');
    const second = renderToStaticMarkup(<Guide onClose={noop} initialStep={1} />);
    expect(second).toContain('needs you');
    expect(second).toContain('!</span> warning');
    const last = renderToStaticMarkup(<Guide onClose={noop} initialStep={3} />);
    expect(last).toContain('>Start using Huddle</button>');
    expect(last).toContain('>Back</button>');
  });
});

function fail(): never {
  throw new Error('fixture agent missing');
}

describe('review fixes (WP3)', () => {
  it('Today: an ended row keeps its status word', () => {
    const now = T0 + 60_000;
    const done = { status: 'done' as const, endedAt: now - 2000 };
    const state = fixtureState({
      main: { status: 'failed', endedAt: now - 1000 },
      core: done,
      explore: done,
      tester: done,
    });
    const rows = todayRows(selectProjects(state, treeOptions(state)), now, identityOf(state, now));
    expect(rows[0]?.meta).toMatch(/ · failed · ended \d\d:\d\d$/);
  });

  it('the preview says what it covers once there is a conversation', () => {
    expect(previewCovers(2)).toBe(
      'For the question in the box, with the last 2 earlier turns. Ask again sends the last question with the turns before it instead.',
    );
  });
});
