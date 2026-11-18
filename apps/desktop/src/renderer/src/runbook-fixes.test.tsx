/**
 * The M4 runbook findings, fixed (2026-11-14): Resume all for a budget's paused agents (budget meter, budget inbox
 * item, the root's pause line), Edit budget after launch, Dismiss rules for budget items, "Sent to VS Code", budget
 * caps in the template list, rule preview without a name, and the worktree summary grouping tool state.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  budgetKeyOf,
  budgetOverItemId,
  DISMISS_REASONS,
  type AttentionItem,
  type HuddleEvent,
  type HuddleState,
  type QueryResult,
} from '@huddle/shared';
import { PauseControl } from './components/AgentControls.js';
import { BudgetMeter, BudgetSection } from './components/Budget.js';
import { InboxCard } from './components/Inbox.js';
import { RuleEditor } from './components/Rules.js';
import { RUN_WORDS, RunPanel } from './components/RunPanel.js';
import { TemplatesPanel } from './components/Templates.js';
import { settled } from './testing/arming.js';
import { T0 } from './testing/fixture.js';
import { m4State, MANAGED, MK, NOW_M4, runOf, TEAM } from './testing/m4-fixture.js';
import { itemEnding } from './view/inbox.js';
import { emptyRuleDraft, RULE_WORDS } from './view/rules.js';
import {
  BUDGET_EDIT_WORDS,
  budgetSetCommand,
  groupWorktreeFiles,
  NEW_BUDGET_DRAFT,
  resumeAllCommands,
  templateBudgetWords,
  validateBudgetDraft,
} from './view/runs.js';

const ok = () => Promise.resolve({ ok: true as const });
const noop = () => undefined;
const esc = (s: string) => s.replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

function button(html: string, label: string): string {
  const m = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's').exec(html);
  if (!m) throw new Error(`no button ${label} in ${html}`);
  return m[0];
}
function expectOn(html: string, label: string) {
  expect(button(html, label)).not.toContain('aria-disabled');
}
function expectOff(html: string, label: string, reason: string) {
  const b = button(html, label);
  expect(b).toContain('aria-disabled="true"');
  expect(b).toContain(`title="${esc(reason)}"`);
}

const OVER = budgetOverItemId(budgetKeyOf({ scope: 'session', targetKey: MK.run }));
const HELD = { toolUseId: 't1', since: T0, limitAt: T0 + 595_000 };

/** The runbook state: the session budget paused the root (pending) and the coder (held). */
function pausedState(): HuddleState {
  return m4State({
    root: { pausePending: true, pausedBy: OVER },
    coder: { status: 'paused', hold: HELD, pausedBy: OVER },
  });
}

function overItem(): AttentionItem {
  return {
    id: OVER,
    kind: 'budget',
    severity: 'action_required',
    agentKey: MK.run,
    title: 'The session budget of Parser run is used up',
    detail: '69k of 60k tokens. Paused 2 agents.',
    createdAt: T0,
    resolvedAt: null,
  };
}

function detail(state: HuddleState, key: string, extra: { initialEditing?: boolean } = {}) {
  const agent = state.agents[key];
  if (!agent) throw new Error('fixture');
  return renderToStaticMarkup(
    <BudgetSection state={state} agent={agent} now={NOW_M4} onCommand={ok} initialEditing={extra.initialEditing} />,
  );
}

describe('fix 1: Resume all for the agents a budget paused', () => {
  it('the budget meter names how many it still holds and offers Resume all', () => {
    const html = detail(pausedState(), MK.run);
    expect(html).toContain('This budget still holds 2 agents paused.');
    expect(html).toContain('Parser run, Code');
    expectOn(html, 'Resume all');
    // Nothing paused: no Resume all line.
    expect(detail(m4State(), MK.run)).not.toContain('Resume all');
  });

  it('Resume all is one agent.resume per paused agent', () => {
    expect(resumeAllCommands([MK.run, MK.coder])).toEqual([
      { type: 'agent.resume', agentKey: MK.run },
      { type: 'agent.resume', agentKey: MK.coder },
    ]);
  });

  it('the budget inbox item lists who is still paused, offers Resume all, and keeps Dismiss off until they resume', () => {
    const state = { ...pausedState(), inbox: [overItem()] };
    const html = renderToStaticMarkup(
      settled(<InboxCard state={state} item={overItem()} renames={new Map()} onCommand={ok} now={NOW_M4} />),
    );
    expect(html).toContain('still paused');
    expectOn(html, 'Resume all');
    expectOff(html, 'Dismiss', DISMISS_REASONS.budgetPaused);

    const free = { ...m4State(), inbox: [overItem()] };
    const after = renderToStaticMarkup(
      settled(<InboxCard state={free} item={overItem()} renames={new Map()} onCommand={ok} now={NOW_M4} />),
    );
    expect(after).not.toContain('Resume all');
    expectOn(after, 'Dismiss');
  });

  it("the root's pause line offers Resume all for the session after Cancel pause left a subagent held", () => {
    // The root was resumed (Cancel pause); the coder is still held by the budget.
    const state = m4State({ coder: { status: 'paused', hold: HELD, pausedBy: OVER, capabilities: MANAGED } });
    const root = state.agents[MK.run];
    const coder = state.agents[MK.coder];
    if (!root || !coder) throw new Error('fixture');
    const html = renderToStaticMarkup(<PauseControl state={state} agent={root} onCommand={ok} now={NOW_M4} />);
    expectOn(html, 'Resume all 1');
    expect(button(html, 'Resume all 1')).toContain('Code');
    // Resume / Pause keeps meaning "this agent".
    expectOn(html, 'Pause');
    // On the subagent itself: its own Resume, no session-wide button.
    const sub = renderToStaticMarkup(<PauseControl state={state} agent={coder} onCommand={ok} now={NOW_M4} />);
    expect(sub).not.toContain('Resume all');
    expectOn(sub, 'Resume');
    // A user pause of a subagent (no pausedBy) is not the budget's to resume.
    const user = m4State({ coder: { status: 'paused', hold: HELD } });
    const userRoot = user.agents[MK.run];
    if (!userRoot) throw new Error('fixture');
    expect(
      renderToStaticMarkup(<PauseControl state={user} agent={userRoot} onCommand={ok} now={NOW_M4} />),
    ).not.toContain('Resume all');
  });
});

describe('fix 2: Edit budget after launch', () => {
  it('every budget in the detail has Edit budget; the widget meter has none', () => {
    expectOn(detail(m4State(), MK.coder), 'Edit budget');
    const view = {
      scope: 'session' as const,
      targetKey: MK.run,
      budget: { scope: 'session' as const, maxTokens: 1000, warnAtFraction: 0.8, onExceed: 'pause' as const },
      setAt: T0,
      limits: [],
      level: 'unknown' as const,
    };
    expect(renderToStaticMarkup(<BudgetMeter view={view} />)).not.toContain('Edit budget');
  });

  it('the editor shows the budget as set, with the warn percent and what happens at the cap', () => {
    const html = detail(m4State({ budgets: [m4State().budgets?.[0] ?? never()] }), MK.run, { initialEditing: true });
    expect(html).toContain('Edit the budget for this session');
    expect(html).toContain('value="300000"');
    expect(html).toContain('value="80"');
    expect(html).toContain('<option value="pause" selected="">pause the run</option>');
    expectOn(html, 'Save budget');
    expect(html).toContain(BUDGET_EDIT_WORDS.raised);
  });

  it('checks inline: numbers, the warn percent, at least one limit; Save is off with the reason', () => {
    const entry = m4State().budgets?.[0] ?? never();
    const view = {
      scope: entry.scope,
      targetKey: entry.targetKey,
      budget: entry.budget,
      setAt: entry.setAt,
      limits: [],
      level: 'unknown' as const,
    };
    const bad = { ...NEW_BUDGET_DRAFT, maxTokens: '12k', warnPercent: '150' };
    const html = renderToStaticMarkup(
      <BudgetMeter view={view} state={m4State()} onCommand={ok} initialEditing initialDraft={bad} />,
    );
    expect(html).toContain('Enter a whole number above 0, or leave it empty.');
    expect(html).toContain(BUDGET_EDIT_WORDS.warn);
    expect(html).toContain('aria-invalid="true"');
    expectOff(html, 'Save budget', 'Enter a whole number above 0, or leave it empty.');
    expect(validateBudgetDraft(NEW_BUDGET_DRAFT)).toEqual({ limits: BUDGET_EDIT_WORDS.needOne });
  });

  it('warns when a cap is not above what is used (it would trip again at once)', () => {
    // The session has used 156k tokens; 120k does not clear it, 400k does.
    const low = renderToStaticMarkup(
      <BudgetMeter
        view={sessionView()}
        state={m4State()}
        onCommand={ok}
        initialEditing
        initialDraft={{ ...NEW_BUDGET_DRAFT, maxTokens: '120000' }}
      />,
    );
    expect(low).toContain(`Tokens: ${BUDGET_EDIT_WORDS.stillOver}`);
    const high = renderToStaticMarkup(
      <BudgetMeter
        view={sessionView()}
        state={m4State()}
        onCommand={ok}
        initialEditing
        initialDraft={{ ...NEW_BUDGET_DRAFT, maxTokens: '400000' }}
      />,
    );
    expect(high).not.toContain(BUDGET_EDIT_WORDS.stillOver);
  });

  it('builds budget.set for the session (filed under its root), the agent, or everything', () => {
    const d = {
      ...NEW_BUDGET_DRAFT,
      maxTokens: '120000',
      maxCostUsd: '1.5',
      warnPercent: '75',
      onExceed: 'stop' as const,
    };
    expect(budgetSetCommand('session', MK.run, d)).toEqual({
      type: 'budget.set',
      agentKey: MK.run,
      budget: {
        scope: 'session',
        maxTokens: 120_000,
        maxEstimatedCostUsd: 1.5,
        warnAtFraction: 0.75,
        onExceed: 'stop',
      },
    });
    expect(budgetSetCommand('overall', null, d)).toMatchObject({ agentKey: null, budget: { scope: 'overall' } });
    expect(budgetSetCommand('session', MK.run, NEW_BUDGET_DRAFT)).toBeNull();
  });

  it("a launched run's main agent without a session budget gets Set a budget", () => {
    const html = detail(m4State({ budgets: [] }), MK.run);
    expectOn(html, 'Set a budget');
    // Not on a subagent, and not on a session the Huddle did not launch.
    expect(detail(m4State({ budgets: [] }), MK.coder)).toBe('');
    expect(detail(m4State({ budgets: [], run: null }), MK.run)).toBe('');
  });
});

describe('fix 3: a dismissed item ends as dismissed', () => {
  it('says Dismissed for a dismiss and Cleared when the condition went away', () => {
    const item = { ...overItem(), resolvedAt: T0 + 5 };
    const resolved = (reason?: 'dismissed'): HuddleEvent => ({
      id: 'x',
      type: 'attention.resolved',
      ts: T0 + 5,
      sessionId: 's',
      agentKey: MK.run,
      source: reason ? 'user' : 'huddle',
      itemId: OVER,
      ...(reason ? { reason } : {}),
    });
    expect(itemEnding(item, [resolved('dismissed')])?.text).toBe('Dismissed.');
    expect(itemEnding(item, [resolved()])?.text).toBe('Cleared: it no longer applies.');
  });
});

describe('fix 4: Open in VS Code says what it can know', () => {
  it('the hint says VS Code may ask, and keeps the File Explorer fallback', () => {
    const state = m4State();
    const agent = state.agents[MK.run];
    if (!agent) throw new Error('fixture');
    const html = renderToStaticMarkup(<RunPanel state={state} agent={agent} onCommand={ok} />);
    expect(button(html, 'Open in VS Code')).toContain(`title="${esc(RUN_WORDS.openHint)}"`);
    expect(RUN_WORDS.openHint).toMatch(/^Sends the worktree folder to VS Code/);
    expect(RUN_WORDS.openHint).toContain('may ask you to confirm');
    expect(RUN_WORDS.openHint).toContain('File Explorer');
  });
});

describe('fix 5: template rows show the budget caps', () => {
  it('lists tokens, cost and minutes with what happens at the cap', () => {
    const html = renderToStaticMarkup(<TemplatesPanel state={m4State()} onCommand={ok} query={null} />);
    expect(html).toContain('Budget: 200k tokens; then pauses');
    const all = {
      ...TEAM,
      budgets: [
        {
          scope: 'session' as const,
          maxTokens: 120_000,
          maxEstimatedCostUsd: 2,
          maxMinutes: 30,
          warnAtFraction: 0.8,
          onExceed: 'stop' as const,
        },
      ],
    };
    expect(templateBudgetWords(all.budgets)).toBe('Budget: 120k tokens, $2.00 est., 30 min; then stops the run');
    expect(templateBudgetWords(undefined)).toBeNull();
    const none = renderToStaticMarkup(
      <TemplatesPanel state={{ ...m4State(), templates: [{ ...TEAM, budgets: [] }] }} onCommand={ok} query={null} />,
    );
    expect(none).not.toContain('Budget:');
  });
});

describe('fix 6: a rule previews without a name; Save says why it is off', () => {
  it('Preview is on with a match and no name; Save is off with the reason shown inline', () => {
    const draft = { ...emptyRuleDraft('r9'), action: 'allow' as const };
    draft.match.tool = 'Bash';
    draft.match.commandPrefix = 'git log';
    const query = (): Promise<QueryResult> =>
      Promise.resolve({ ok: true, type: 'policy.preview', preview: { examined: 0, matched: 0, samples: [] } });
    const html = renderToStaticMarkup(
      <RuleEditor
        state={m4State()}
        renames={new Map()}
        rule={null}
        onCommand={ok}
        query={query}
        onDone={noop}
        initialDraft={draft}
      />,
    );
    expectOn(html, 'What would this have matched?');
    expectOff(html, 'Save rule', RULE_WORDS.saveNeedsName);
    expect(html).toContain(`<p class="form-note save-reason">${esc(RULE_WORDS.saveNeedsName)}</p>`);
  });
});

describe('fix 7: the worktree summary groups untracked files by top folder', () => {
  const files = [
    { path: 'src/a.ts', status: 'modified' as const },
    { path: '.omc/state/x.json', status: 'untracked' as const },
    { path: '.omc/state/y.json', status: 'untracked' as const },
    { path: '.claude/settings.local.json', status: 'untracked' as const },
    { path: 'docs/new.md', status: 'untracked' as const },
    { path: 'notes.md', status: 'untracked' as const },
  ];

  it('pure: tracked changes one by one, other folders first, root files, tool state last', () => {
    const g = groupWorktreeFiles(files);
    expect(g.changed.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(g.untracked.map((x) => [x.folder, x.toolState, x.files.length])).toEqual([
      ['docs', false, 1],
      [null, false, 1],
      ['.omc', true, 2],
      ['.claude', true, 1],
    ]);
    expect(g.toolStateCount).toBe(3);
  });

  it('renders tool state collapsed with its label, other folders open; the counts stay the core facts', () => {
    const state = m4State({
      run: {
        exited: { at: T0 + 1, exitCode: 0, how: 'completed', error: null },
        worktree: {
          ...(runOf().worktree ?? never()),
          summary: { filesChanged: 6, insertions: 3, deletions: 0, untracked: 5, files, summarizedAt: T0 },
        },
      },
    });
    const agent = state.agents[MK.run];
    if (!agent) throw new Error('fixture');
    const html = renderToStaticMarkup(<RunPanel state={state} agent={agent} onCommand={ok} />);
    expect(html).toContain('6 files changed');
    expect(html).toContain('5 untracked');
    expect(html).toContain('(3 in tool-state folders)');
    expect(html).toMatch(
      /<details class="wt-group" open="">\s*<summary><span class="code">docs\/<\/span> 1 untracked file/,
    );
    expect(html).toMatch(
      /<details class="wt-group"><summary><span class="code">\.omc\/<\/span> 2 untracked files<span class="wt-tool-state muted"> · tool state<\/span>/,
    );
    // Nothing is hidden: the files are in the markup, one click away.
    expect(html).toContain('.omc/state/x.json');
    expect(html).toContain('notes.md');
    expect(html).toContain(RUN_WORDS.toolStateNote);
  });
});

function never(): never {
  throw new Error('fixture');
}

function sessionView() {
  const entry = m4State().budgets?.[0] ?? never();
  return {
    scope: entry.scope,
    targetKey: entry.targetKey,
    budget: entry.budget,
    setAt: entry.setAt,
    limits: [{ kind: 'tokens' as const, cap: 300_000, used: 156_000, fraction: 0.52, level: 'ok' as const }],
    level: 'ok' as const,
  };
}
