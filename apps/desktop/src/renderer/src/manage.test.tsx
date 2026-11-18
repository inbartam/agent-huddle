/**
 * M4 surfaces (WP7a): the launch dialog's checks and notes, the template editor with three agents, the rule editor
 * and its approximate preview, the decision log, budget meters (unknown is `—`, never 0), the run and worktree panel
 * (Stop, End and Discard from capabilities and the run's state, Discard confirmed inline), the queries' fallback when
 * the preload has none, and agent text with markup staying text everywhere.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_REASONS,
  RUN_REASONS,
  selectPolicyDecisions,
  type AttentionItem,
  type HuddleQuery,
  type QueryResult,
} from '@huddle/shared';
import { BudgetChip, BudgetSection } from './components/Budget.js';
import { LaunchPanel } from './components/LaunchForm.js';
import { DecisionLog, PreviewPanel, RuleEditor, RulesPanel } from './components/Rules.js';
import { RunPanel } from './components/RunPanel.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { TemplateEditor, TemplatesPanel } from './components/Templates.js';
import { bridgeQuery, pickFolder, previewRule, QUERY_FAILED, QUERY_UNAVAILABLE } from './query.js';
import { T0, XSS } from './testing/fixture.js';
import { decisionEvents, m4State, MK, NOW_M4, RULES, TEAM } from './testing/m4-fixture.js';
import { kindWords } from './view/inbox.js';
import {
  EMPTY_AGENT,
  EMPTY_DRAFT,
  LAUNCH_WORDS,
  MAX_TEMPLATE_AGENTS,
  draftFromTemplate,
  launchCommand,
  templateFromDraft,
  validateDraft,
} from './view/launch.js';
import { paletteActions } from './view/palette.js';
import { draftFromRule, emptyRuleDraft, matchWords, ruleFromDraft, RULE_WORDS } from './view/rules.js';
import { applyToAttachedCommand, APPLY_TO_ATTACHED_WORDS } from './view/settings.js';

const ok = () => Promise.resolve({ ok: true as const });
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('fixture');
  return v;
}
const noop = () => undefined;
const esc = (s: string) => s.replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const ESCAPED_XSS = '&lt;img src=x onerror=alert(1)&gt;';

function button(html: string, label: string): string {
  const m = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's').exec(html);
  if (!m) throw new Error(`no button ${label}`);
  return m[0];
}
function expectOff(html: string, label: string, reason: string) {
  const b = button(html, label);
  expect(b).toContain('aria-disabled="true"');
  expect(b).toContain(`title="${esc(reason)}"`);
}
function expectOn(html: string, label: string) {
  expect(button(html, label)).not.toContain('aria-disabled');
}
function noRawMarkup(html: string) {
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<b>');
}

describe('launch dialog', () => {
  const launch = (props: Partial<Parameters<typeof LaunchPanel>[0]> = {}) =>
    renderToStaticMarkup(
      <LaunchPanel state={m4State()} onCommand={ok} query={null} onClose={noop} initialChecked {...props} />,
    );

  it('shows its checks inline, under the fields', () => {
    const html = launch();
    expect(html).toContain('Choose the folder the run works in.');
    expect(html).toContain('Write the first prompt.');
    expect(html).toMatch(/aria-invalid="true" aria-describedby="[^"]*-cwd-error"/);
    expect(html).toContain('Fix the fields marked above.');
  });

  it('says what launching loads and what a worktree leaves out', () => {
    const html = launch();
    expect(html).toContain(esc(LAUNCH_WORDS.hooksNote));
    expect(html).toContain(LAUNCH_WORDS.worktreeNote);
    expect(html).toContain(LAUNCH_WORDS.budgetNote);
  });

  it('defaults to the default mode, leaves bypassPermissions out, and warns for modes that never ask', () => {
    const html = launch();
    expect(html).toMatch(/<option value="default" selected="">default<\/option>/);
    expect(html).not.toContain('bypassPermissions');
    expect(html).not.toContain(LAUNCH_WORDS.modeBypasses);
    for (const mode of ['plan', 'auto', 'dontAsk']) {
      expect(launch({ initialDraft: { ...EMPTY_DRAFT, permissionMode: mode } })).toContain(LAUNCH_WORDS.modeBypasses);
    }
    expect(launch({ initialDraft: { ...EMPTY_DRAFT, permissionMode: 'acceptEdits' } })).not.toContain(
      LAUNCH_WORDS.modeBypasses,
    );
  });

  it('turns Launch off while Huddle is not attached, and Choose… off without the query', () => {
    const state = m4State();
    state.connection = undefined;
    const html = launch({ state });
    expectOff(html, 'Launch', CONTROL_REASONS.notConnected);
    expectOff(html, 'Choose…', QUERY_UNAVAILABLE);
    expectOn(launch({ query: () => Promise.resolve({ ok: true, type: 'pick.folder', path: null }) }), 'Choose…');
  });

  it('checks budgets and agents, and builds the run.launch command', () => {
    const draft = {
      ...EMPTY_DRAFT,
      cwd: 'C:\\projects\\fixture',
      prompt: 'Go',
      maxTokens: '12.5',
      maxCostUsd: '-1',
      agents: [
        { ...EMPTY_AGENT, name: '-x' },
        { ...EMPTY_AGENT, name: 'a b' },
      ],
    };
    const e = validateDraft(draft, false);
    expect(e['maxTokens']).toMatch(/whole number/);
    expect(e['maxCostUsd']).toMatch(/above 0/);
    expect(e['agents.0.name']).toBe('An agent name cannot start with "-".');
    expect(e['agents.1.name']).toBe('An agent name has no spaces.');
    expect(e['agents.0.description']).toBeDefined();

    const good = { ...EMPTY_DRAFT, cwd: ' C:\\projects\\fixture ', prompt: 'Go', maxTokens: '50000', model: 'sonnet' };
    expect(validateDraft(good, false)).toEqual({});
    expect(validateDraft(good, true)['name']).toBe('Give the template a name.');
    expect(launchCommand(templateFromDraft(good, 'inline-1'))).toEqual({
      type: 'run.launch',
      template: {
        id: 'inline-1',
        name: 'Run in fixture',
        prompt: 'Go',
        cwd: 'C:\\projects\\fixture',
        mainAgent: null,
        model: 'sonnet',
        permissionMode: 'default',
        worktree: true,
        budgets: [{ scope: 'session', maxTokens: 50000, warnAtFraction: 0.8, onExceed: 'pause' }],
      },
    });
  });
});

describe('templates', () => {
  it('edits a three-agent template, each agent with name, description, prompt, tools and model', () => {
    const html = renderToStaticMarkup(<TemplateEditor template={TEAM} onCommand={ok} query={null} onDone={noop} />);
    for (const n of [1, 2, 3]) expect(html).toContain(`aria-label="Agent ${String(n)}"`);
    expect(html).not.toContain('aria-label="Agent 4"');
    for (const v of ['planner', 'coder', 'tester', 'Plans the change', 'Read, Grep', 'opus', 'haiku']) {
      expect(html).toContain(`value="${v}"`);
    }
    expect(html).toContain('Run the tests.');
    expectOn(html, 'Add agent');
    expect(html).toContain(`value="Parser team ${ESCAPED_XSS.replace(/&gt;/, '&gt;')}"`);
    noRawMarkup(html);
  });

  it('round-trips a template through the editor draft', () => {
    expect(templateFromDraft(draftFromTemplate(TEAM), TEAM.id)).toEqual(TEAM);
  });

  it(`stops adding agents at ${String(MAX_TEMPLATE_AGENTS)}, with the reason`, () => {
    const draft = {
      ...draftFromTemplate(TEAM),
      agents: Array.from({ length: MAX_TEMPLATE_AGENTS }, () => EMPTY_AGENT),
    };
    const html = renderToStaticMarkup(
      <TemplateEditor template={TEAM} onCommand={ok} query={null} onDone={noop} initialDraft={draft} />,
    );
    expectOff(html, 'Add agent', `A template can define up to ${String(MAX_TEMPLATE_AGENTS)} agents.`);
  });

  it('lists templates with Launch, Edit, Duplicate and Delete…', () => {
    const html = renderToStaticMarkup(<TemplatesPanel state={m4State()} onCommand={ok} query={null} />);
    for (const b of ['Launch', 'Edit', 'Duplicate', 'Delete…']) expectOn(html, b);
    expect(html).toContain('fixture, asks before edits, 3 agents, own worktree');
    noRawMarkup(html);
  });
});

describe('rules', () => {
  const panel = (state = m4State()) =>
    renderToStaticMarkup(<RulesPanel state={state} renames={new Map()} onCommand={ok} query={null} decisions={[]} />);

  it('shows why the rules file was not used (A2-02), and nothing when it was', () => {
    const warning = 'policy-rules.json has an invalid rule; using the default rules';
    expect(panel({ ...m4State(), policyWarning: warning })).toContain(warning);
    expect(panel()).not.toContain('using the default rules');
  });

  it('marks defaults, shows the action as a word, and says rules only apply to launched sessions', () => {
    const html = panel();
    expect(html).toContain(RULE_WORDS.onlyLaunched);
    expect(html).toContain('class="default-mark"');
    expect(html.match(/class="default-mark"/g)).toHaveLength(1);
    expect(html).toContain('</span> allow</span>');
    expect(html).toContain('</span> deny</span>');
    expect(html).toContain('</span> ask me</span>');
    expect(html).toContain(esc(RULE_WORDS.precedence));
    // A shipped rule has no Delete (its switch turns it off); the user's rules keep theirs.
    const rows = html.split('<li class="manage-row rule-row').slice(1);
    const shipped = rows.filter((r) => r.includes('class="default-mark"'));
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).not.toContain('Delete…');
    expect(rows.filter((r) => !r.includes('class="default-mark"')).every((r) => r.includes('Delete…'))).toBe(true);
    noRawMarkup(html);
  });

  it('says rules apply to every session once applyToAttached is on', () => {
    const state = m4State();
    state.settings = {
      ...(state.settings ?? {
        detectors: {
          stuckMinutes: 5,
          stuckOpenToolMinutes: 15,
          loopRepeat: 5,
          loopFailures: 3,
          conflictWindowMinutes: 10,
        },
        toasts: {
          approval: true,
          question: true,
          stuck: true,
          loop: true,
          conflict: true,
          doneOrError: true,
          budget: true,
        },
        questionHoldSeconds: 120,
        globalShortcut: 'Control+Alt+H',
        widgetCollapsed: false,
        history: { retentionDays: 30 },
        ask: { enabled: false },
        nicknames: {},
      }),
      policy: { applyToAttached: true },
    };
    expect(panel(state)).toContain(RULE_WORDS.appliesToAll);
  });

  it('builds a rule from the editor, keeps commandExact, and words the match', () => {
    const d = { ...emptyRuleDraft('r1'), name: 'ls only', action: 'allow' as const, commandExact: true };
    d.match.commandPrefix = ' ls ';
    expect(ruleFromDraft(d)).toEqual({
      id: 'r1',
      name: 'ls only',
      enabled: true,
      action: 'allow',
      match: { commandPrefix: 'ls', commandExact: true },
    });
    expect(matchWords(ruleFromDraft(d))).toBe('command is exactly ls');
    expect(draftFromRule(ruleFromDraft(d)).commandExact).toBe(true);
  });

  it('warns that an allow rule with no match fields allows everything', () => {
    const draft = { ...emptyRuleDraft('r2'), name: 'too wide', action: 'allow' as const };
    const html = renderToStaticMarkup(
      <RuleEditor
        state={m4State()}
        renames={new Map()}
        rule={null}
        onCommand={ok}
        query={null}
        onDone={noop}
        initialDraft={draft}
      />,
    );
    expect(html).toContain(RULE_WORDS.allowEverything);
    expect(html).toContain(RULE_WORDS.editorNote);
  });

  it('shows the preview as approximate, with its samples as text', () => {
    const preview = {
      examined: 40,
      matched: 2,
      samples: [
        { agentKey: MK.coder, toolName: 'Bash', summary: `git push --force ${XSS}`, receivedAt: T0 },
        { agentKey: 'gone', toolName: 'Bash', summary: 'git push --force-with-lease', receivedAt: T0 + 1 },
      ],
    };
    const html = renderToStaticMarkup(
      <PreviewPanel
        state={m4State()}
        renames={new Map()}
        rule={RULES[1] ?? null}
        query={null}
        initialPreview={preview}
      />,
    );
    expect(html).toContain('Would have matched 2 of the last 40 requests.');
    expect(html).toContain('approximate');
    expect(html).toContain(esc(RULE_WORDS.previewApprox));
    expect(html).toContain(ESCAPED_XSS);
    expect(html).toContain('Code');
    noRawMarkup(html);
    expectOff(html, 'What would this have matched\\?', QUERY_UNAVAILABLE);
  });
});

describe('queries without the preload function', () => {
  it('answer "unavailable in this build"', async () => {
    expect(bridgeQuery({ command: noop })).toBeNull();
    expect(await pickFolder(null)).toEqual({ ok: false, code: 'unsupported', message: QUERY_UNAVAILABLE });
    expect((await previewRule(null, must(RULES[0]))).ok).toBe(false);
  });

  it('pass a typed query through, and read a wrong answer or a throw as failed', async () => {
    const seen: HuddleQuery[] = [];
    const bridge = {
      query: (q: HuddleQuery): Promise<QueryResult> => {
        seen.push(q);
        return Promise.resolve(
          q.type === 'pick.folder'
            ? { ok: true, type: 'pick.folder', path: 'C:\\x' }
            : { ok: true, type: 'policy.preview', preview: { examined: 1, matched: 0, samples: [] } },
        );
      },
    };
    const q = bridgeQuery(bridge);
    expect(await pickFolder(q, 'C:\\start')).toEqual({ ok: true, path: 'C:\\x' });
    expect(seen[0]).toEqual({ type: 'pick.folder', defaultPath: 'C:\\start' });
    const rule = RULES[0];
    if (!rule) throw new Error('fixture');
    expect(await previewRule(q, rule)).toEqual({ ok: true, preview: { examined: 1, matched: 0, samples: [] } });
    const wrong = bridgeQuery({ query: () => Promise.resolve({ ok: true, type: 'pick.folder', path: 1 }) });
    expect(await pickFolder(wrong)).toMatchObject({ ok: false, message: QUERY_FAILED });
    const mixed = bridgeQuery({ query: () => Promise.resolve({ ok: true, type: 'pick.folder', path: null }) });
    expect(await previewRule(mixed, rule)).toMatchObject({ ok: false, message: QUERY_FAILED });
    const throws = bridgeQuery({ query: () => Promise.reject(new Error('x')) });
    expect(await pickFolder(throws)).toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('decision log', () => {
  const decisions = selectPolicyDecisions(decisionEvents(), RULES);

  it('lists automatic decisions newest first with rule, tool, summary, time and agent', () => {
    const html = renderToStaticMarkup(<DecisionLog state={m4State()} renames={new Map()} decisions={decisions} />);
    const rows = html.match(/<li class="decision-row">/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(html.indexOf('git status --short')).toBeLessThan(html.indexOf('git push --force'));
    expect(html).toContain('by Read-only git');
    expect(html).toContain(`by Never force-push ${ESCAPED_XSS}`);
    expect(html).toContain('</span> denied</span>');
    expect(html).toContain('>Code<');
    noRawMarkup(html);
  });

  it('filters by rule, and says so when nothing was decided or while reading', () => {
    const html = renderToStaticMarkup(
      <DecisionLog state={m4State()} renames={new Map()} decisions={decisions} initialRule="user-no-force" />,
    );
    expect(html.match(/<li class="decision-row">/g)).toHaveLength(1);
    expect(html).toContain('<option value="user-no-force" selected="">');
    expect(renderToStaticMarkup(<DecisionLog state={m4State()} renames={new Map()} decisions={[]} />)).toContain(
      RULE_WORDS.noDecisions,
    );
    expect(renderToStaticMarkup(<DecisionLog state={m4State()} renames={new Map()} decisions={null} />)).toContain(
      'Reading the log',
    );
  });
});

describe('budget meters', () => {
  const section = (key: string, state = m4State()) => {
    const agent = state.agents[key];
    if (!agent) throw new Error('fixture');
    return renderToStaticMarkup(<BudgetSection state={state} agent={agent} now={NOW_M4} />);
  };

  it('shows used / cap with the scope, labeled an estimate, and the warning state', () => {
    const html = section(MK.coder);
    expect(html).toContain('estimate; can overshoot by about one tool call');
    expect(html).toContain('Budget for this agent, then pauses');
    expect(html).toContain('86k / 100k tokens');
    expect(html).toContain('near the cap');
    expect(html).toContain('Budget for this session, then pauses');
    // Session roll-up: 50k + 20k + 86k (cache reads excluded).
    expect(html).toContain('156k / 300k tokens');
  });

  it('shows — when nothing is measured, never 0', () => {
    const state = m4State({ root: { usage: { ...must(m4State().agents[MK.run]).usage, requests: 0 } } });
    state.budgets = [
      {
        scope: 'agent',
        targetKey: MK.run,
        budget: { scope: 'agent', maxTokens: 100_000, maxEstimatedCostUsd: 2, warnAtFraction: 0.8, onExceed: 'notify' },
        setAt: T0,
      },
    ];
    const html = section(MK.run, state);
    expect(html).toContain('— / 100k tokens');
    expect(html).toContain('— / $2.00 est.');
    expect(html).toContain('not measured yet');
    expect(html).not.toMatch(/>0 \//);
    expect(html).not.toContain('role="progressbar"');
  });

  it('renders nothing for an agent without budgets', () => {
    expect(section(MK.planner, m4State({ budgets: [] }))).toBe('');
  });

  it('gives the widget one line with the worst budget, and words the budget inbox item', () => {
    const state = m4State({ coder: { usage: { ...must(m4State().agents[MK.coder]).usage, inputTokens: 300_000 } } });
    state.budgets = [
      {
        scope: 'session',
        targetKey: MK.run,
        budget: { scope: 'session', maxTokens: 400_000, warnAtFraction: 0.8, onExceed: 'stop' },
        setAt: T0,
      },
    ];
    const html = renderToStaticMarkup(<BudgetChip state={state} rootKey={MK.run} now={NOW_M4} />);
    expect(html).toContain('▲</span> budget 98% est.');
    expect(html).toContain('then stops the run');
    // The overall budget would repeat on every card: the widget leaves it to the detail.
    const overallOnly = m4State({
      budgets: [
        {
          scope: 'overall',
          targetKey: null,
          budget: { scope: 'all', maxEstimatedCostUsd: 1, warnAtFraction: 0.8, onExceed: 'notify' },
          setAt: T0,
        },
      ],
    });
    expect(renderToStaticMarkup(<BudgetChip state={overallOnly} rootKey={MK.run} now={NOW_M4} />)).toBe('');
    // An agent budget inside the session counts: the coder is past its warning line.
    expect(renderToStaticMarkup(<BudgetChip state={m4State()} rootKey={MK.run} now={NOW_M4} />)).toContain(
      'budget 86% est.',
    );
    const item: AttentionItem = {
      id: 'b',
      kind: 'budget',
      severity: 'warning',
      agentKey: MK.coder,
      title: 't',
      detail: 'd',
      createdAt: T0,
      resolvedAt: null,
    };
    expect(kindWords(item)).toBe('near its budget');
    expect(kindWords({ ...item, severity: 'action_required' })).toBe('over budget');
  });
});

describe('run and worktree panel', () => {
  const runPanel = (state = m4State(), confirm = false) => {
    const agent = state.agents[MK.run];
    if (!agent) throw new Error('fixture');
    return renderToStaticMarkup(
      <RunPanel state={state} agent={agent} onCommand={ok} initialConfirmDiscard={confirm} />,
    );
  };

  it('shows the template, mode, agents, result totals labeled estimates, and the diff summary', () => {
    const html = runPanel();
    expect(html).toContain(`Parser team ${ESCAPED_XSS}`);
    expect(html).toContain('planner, coder, tester');
    expect(html).toContain('4 min 12 s, 6 turns, ~$0.61 est., 1 tool call denied');
    expect(html).toContain('3 files changed');
    expect(html).toContain('+120');
    expect(html).toContain('−14');
    expect(html).toContain('1 untracked');
    expect(html).toContain('huddle/run-1');
    expect(html).toContain(`notes ${ESCAPED_XSS}.md`);
    noRawMarkup(html);
  });

  it('enables Stop and End for a live managed run, and turns Discard off while it is alive', () => {
    const html = runPanel();
    expectOn(html, 'Stop');
    expectOn(html, 'End after this turn');
    expectOn(html, 'Keep');
    expectOn(html, 'Open in VS Code');
    expectOff(html, 'Discard…', RUN_REASONS.alive);
  });

  it('turns Stop and End off without the stop capability, with the reason', () => {
    const html = runPanel(
      m4State({ root: { capabilities: { ...must(m4State().agents[MK.run]).capabilities, stop: false } } }),
    );
    expectOff(html, 'Stop', RUN_REASONS.noStop);
    expectOff(html, 'End after this turn', RUN_REASONS.noStop);
  });

  it('after the run exits: Stop off, Discard on and confirmed inline (not window.confirm)', () => {
    const exited = m4State({ run: { exited: { at: T0 + 1, exitCode: 0, how: 'completed', error: null } } });
    const before = runPanel(exited);
    expectOff(before, 'Stop', RUN_REASONS.exited);
    expectOn(before, 'Discard…');
    expect(before).toContain('waiting for you: keep or discard');
    const asking = runPanel(exited, true);
    expect(asking).toContain('role="group" aria-label="Confirm discard"');
    expect(asking).toContain('Discard removes the worktree folder and the branch');
    expectOn(asking, 'Discard');
    expectOn(asking, 'Back');
    expect(asking).not.toContain('Discard…');
  });

  it('does not open the confirmation while the run is alive', () => {
    expect(runPanel(m4State(), true)).not.toContain('Confirm discard');
  });

  it('renders nothing for an agent the Huddle did not launch', () => {
    expect(runPanel(m4State({ run: null }))).toBe('');
  });
});

describe('palette and settings', () => {
  it('offers Launch…, Templates and Rules', () => {
    const actions = paletteActions(m4State(), new Map());
    expect(actions.filter((a) => ['launch', 'templates', 'rules'].includes(a.id)).map((a) => a.effect.kind)).toEqual([
      'launch',
      'templates',
      'rules',
    ]);
  });

  it('has the apply-to-attached switch, off by default, saying it waits on S15', () => {
    const html = renderToStaticMarkup(<SettingsPanel state={m4State()} onCommand={ok} />);
    expect(html).toMatch(/id="policy-applyToAttached" type="checkbox" role="switch" class="switch"/);
    expect(html).not.toMatch(/id="policy-applyToAttached"[^>]*checked/);
    expect(html).toContain(APPLY_TO_ATTACHED_WORDS.label);
    expect(html).toContain('spike S15');
    expect(applyToAttachedCommand(true)).toEqual({
      type: 'settings.update',
      patch: { policy: { applyToAttached: true } },
    });
  });
});
