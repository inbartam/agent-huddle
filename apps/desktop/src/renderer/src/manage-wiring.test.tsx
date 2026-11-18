/**
 * WP7b decisions in the renderer: the apply-to-attached switch is off with its reason (S15), launching from a stored
 * template sends its id (plus the prompt when only that changed), the widget's budget line shows only at warning or
 * over, an allow rule for a command that can change files warns, and "with the Huddle closed, no rule applies".
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, EMPTY_USAGE } from '@huddle/shared';
import { BudgetChip } from './components/Budget.js';
import { LaunchPanel } from './components/LaunchForm.js';
import { RuleEditor, RulesPanel } from './components/Rules.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { TemplateEditor, TemplatesPanel } from './components/Templates.js';
import { T0 } from './testing/fixture.js';
import { m4State, MK, NOW_M4, TEAM } from './testing/m4-fixture.js';
import { draftFromTemplate, launchCommandFor, TEMPLATE_RULES_REASON } from './view/launch.js';
import {
  ALLOW_RULE_PROBLEMS,
  allowRuleProblem,
  allowsChangingCommands,
  emptyRuleDraft,
  isReadOnlyCommandPrefix,
  RULE_WORDS,
  validateRule,
} from './view/rules.js';
import { APPLY_TO_ATTACHED_WORDS, applyToAttachedControl, TOAST_FIELDS } from './view/settings.js';

const ok = () => Promise.resolve({ ok: true as const });
const noop = () => undefined;
const esc = (s: string) => s.replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

function switchTag(html: string, id: string): string {
  const m = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html);
  if (!m) throw new Error(`no input ${id}`);
  return m[0];
}

describe('settings: apply rules to attached sessions', () => {
  it('is off and disabled, with the S15 reason as tooltip and as visible text', () => {
    const html = renderToStaticMarkup(<SettingsPanel state={m4State()} onCommand={ok} />);
    const tag = switchTag(html, 'policy-applyToAttached');
    expect(tag).toContain('disabled=""');
    expect(tag).not.toContain('checked');
    expect(tag).toContain(`title="${esc(APPLY_TO_ATTACHED_WORDS.disabledReason)}"`);
    expect(html).toContain(esc(APPLY_TO_ATTACHED_WORDS.disabledReason));
    expect(APPLY_TO_ATTACHED_WORDS.disabledReason).toBe(
      'Waits on spike S15 (a late Allow after a terminal No). Until then rules apply only to sessions the Huddle launched.',
    );
    expect(html).toContain(RULE_WORDS.huddleClosed);
  });

  it('can still be turned off when an older settings file has it on', () => {
    expect(applyToAttachedControl(true).enabled).toBe(true);
    expect(applyToAttachedControl(false)).toEqual({ enabled: false, reason: APPLY_TO_ATTACHED_WORDS.disabledReason });
    const state = m4State();
    state.settings = { ...DEFAULT_USER_SETTINGS, policy: { applyToAttached: true } };
    const tag = switchTag(
      renderToStaticMarkup(<SettingsPanel state={state} onCommand={ok} />),
      'policy-applyToAttached',
    );
    expect(tag).not.toContain('disabled');
    expect(tag).toContain('checked');
  });

  it('has a budget toast switch, on by default (F14)', () => {
    expect(TOAST_FIELDS.map((f) => f.key)).toContain('budget');
    const html = renderToStaticMarkup(<SettingsPanel state={m4State()} onCommand={ok} />);
    expect(switchTag(html, 'toast-budget')).toContain('checked');
  });
});

describe('launch from a stored template', () => {
  const base = TEAM;

  it('sends { templateId } when nothing changed and { templateId, promptOverride } when only the prompt did', () => {
    const draft = draftFromTemplate(base);
    expect(launchCommandFor(draft, base, 'inline-1')).toEqual({ type: 'run.launch', templateId: base.id });
    expect(launchCommandFor({ ...draft, prompt: 'Only fix the lexer.' }, base, 'inline-1')).toEqual({
      type: 'run.launch',
      templateId: base.id,
      promptOverride: 'Only fix the lexer.',
    });
  });

  it('sends an inline template when anything besides the prompt changed, or without a base template', () => {
    const draft = draftFromTemplate(base);
    for (const changed of [
      { ...draft, cwd: 'C:\\projects\\other' },
      { ...draft, worktree: false },
      { ...draft, maxTokens: '1000' },
      { ...draft, agents: draft.agents.slice(1) },
    ]) {
      const cmd = launchCommandFor(changed, base, 'inline-1');
      expect(cmd).toMatchObject({ type: 'run.launch', template: { id: 'inline-1' } });
      expect(cmd).not.toHaveProperty('templateId');
    }
    expect(launchCommandFor(draft, null, 'inline-1')).toMatchObject({ template: { id: 'inline-1' } });
  });

  it('never sends the id of a template whose permission mode the dialog does not offer', () => {
    const bypass = { ...base, permissionMode: 'bypassPermissions' };
    expect(launchCommandFor(draftFromTemplate(bypass), bypass, 'inline-1')).toMatchObject({
      template: { id: 'inline-1', permissionMode: 'default' },
    });
  });

  it('shows the picked template as selected in the dialog', () => {
    const html = renderToStaticMarkup(
      <LaunchPanel state={m4State()} onCommand={ok} query={null} onClose={noop} initialTemplateId={TEAM.id} />,
    );
    expect(html).toMatch(new RegExp(`<option value="${TEAM.id}" selected="">`));
    expect(html).toContain('Refactor the tokenizer.');
  });
});

describe('widget budget line', () => {
  const chip = (state: ReturnType<typeof m4State>) =>
    renderToStaticMarkup(<BudgetChip state={state} rootKey={MK.run} now={NOW_M4} />);
  const sessionBudget = (maxTokens: number) => [
    {
      scope: 'session' as const,
      targetKey: MK.run,
      budget: { scope: 'session' as const, maxTokens, warnAtFraction: 0.8, onExceed: 'pause' as const },
      setAt: T0,
    },
  ];

  it('is hidden below the warning line and while nothing is measured', () => {
    expect(chip(m4State({ budgets: sessionBudget(100_000_000) }))).toBe('');
    const unmeasured = m4State({ budgets: sessionBudget(1000) });
    for (const a of Object.values(unmeasured.agents)) a.usage = EMPTY_USAGE;
    expect(chip(unmeasured)).toBe('');
  });

  it('shows at warning and over, with glyph and words', () => {
    expect(chip(m4State())).toContain('budget 86% est.');
    expect(chip(m4State({ budgets: sessionBudget(1000) }))).toMatch(/level-over/);
  });
});

describe('rule editor: allow rules that can change files', () => {
  it('knows the read-only commands, case- and space-insensitively, and --version forms', () => {
    for (const p of [
      'ls',
      'dir',
      'Get-ChildItem',
      'get-childitem',
      'pwd',
      'Get-Location',
      'cat',
      'type',
      'Get-Content',
    ]) {
      expect(isReadOnlyCommandPrefix(p)).toBe(true);
    }
    for (const p of ['git status', 'git  diff', ' git log ', 'node --version', 'npm --version']) {
      expect(isReadOnlyCommandPrefix(p)).toBe(true);
    }
    for (const p of [
      'git',
      'git push',
      'rm',
      'npm',
      'npm install',
      'Remove-Item',
      'ls; rm -rf /',
      'node --version x',
      // Not in the defaults either: a repo's own diff drivers can run programs (security review of the branch, L1).
      'git show',
    ]) {
      expect(isReadOnlyCommandPrefix(p)).toBe(false);
    }
  });

  it('warns for an allow with a changing prefix or a shell tool with no prefix, never for ask or deny', () => {
    const d = (action: 'allow' | 'ask' | 'deny', tool: string, commandPrefix: string) => ({
      ...emptyRuleDraft('r'),
      action,
      match: { ...emptyRuleDraft('r').match, tool, commandPrefix },
    });
    expect(allowsChangingCommands(d('allow', 'Bash', 'npm test'))).toBe(true);
    expect(allowsChangingCommands(d('allow', 'PowerShell', ''))).toBe(true);
    expect(allowsChangingCommands(d('allow', 'Bash', 'git status'))).toBe(false);
    expect(allowsChangingCommands(d('allow', 'Read', ''))).toBe(false);
    expect(allowsChangingCommands(d('deny', 'Bash', 'rm'))).toBe(false);
    expect(allowsChangingCommands(d('ask', 'Bash', 'rm'))).toBe(false);
    // `<tool> --version`: read-only only as the whole command, so an allow that is not exact warns.
    expect(allowsChangingCommands(d('allow', 'Bash', 'sometool --version'))).toBe(true);
    expect(allowsChangingCommands({ ...d('allow', 'Bash', 'sometool --version'), commandExact: true })).toBe(false);
  });

  it('shows the warning in the editor, and the "Huddle closed" line on the rules screen', () => {
    const editor = (commandPrefix: string, action: 'allow' | 'deny' = 'allow') => {
      const draft = { ...emptyRuleDraft('r'), name: 'n', action };
      draft.match.commandPrefix = commandPrefix;
      return renderToStaticMarkup(
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
    };
    expect(editor('npm run build')).toContain(RULE_WORDS.allowChangesFiles);
    expect(editor('git status')).not.toContain(RULE_WORDS.allowChangesFiles);
    expect(editor('npm run build', 'deny')).not.toContain(RULE_WORDS.allowChangesFiles);
    const panel = renderToStaticMarkup(
      <RulesPanel state={m4State()} renames={new Map()} onCommand={ok} query={null} decisions={[]} />,
    );
    expect(panel).toContain(RULE_WORDS.huddleClosed);
  });
});

describe('rule editor: allows core refuses (security review 2026-11-14, M3)', () => {
  const d = (action: 'allow' | 'ask' | 'deny', tool: string, commandPrefix: string, commandExact = false) => ({
    ...emptyRuleDraft('r'),
    name: 'n',
    action,
    commandExact,
    match: { ...emptyRuleDraft('r').match, tool, commandPrefix },
  });

  it('refuses a shell allow with no command, and a single-word allow other than the read-only ones', () => {
    expect(allowRuleProblem(d('allow', 'Bash', ''))?.message).toBe(ALLOW_RULE_PROBLEMS.shellNeedsCommand);
    expect(allowRuleProblem(d('allow', 'PowerShell', ''))?.message).toBe(ALLOW_RULE_PROBLEMS.shellNeedsCommand);
    for (const w of ['git', 'npm', 'node', 'pwsh', 'cmd', 'powershell', 'bash', 'sh', 'python', 'npx', ' Git ']) {
      expect(allowRuleProblem(d('allow', '', w))?.message, w).toBe(ALLOW_RULE_PROBLEMS.singleWord);
      expect(allowRuleProblem(d('allow', 'Bash', w, true))?.message, w).toBe(ALLOW_RULE_PROBLEMS.singleWord);
    }
    expect(allowRuleProblem(d('allow', '', 'git status'))?.message).toBe(ALLOW_RULE_PROBLEMS.nonAscii);
    for (const ok of ['ls', 'DIR', 'pwd', 'Get-ChildItem', 'Get-Location', 'git status', 'npm test']) {
      expect(allowRuleProblem(d('allow', '', ok)), ok).toBeNull();
    }
    expect(allowRuleProblem(d('allow', 'Read', ''))).toBeNull();
    expect(allowRuleProblem(d('deny', 'Bash', ''))).toBeNull();
    expect(allowRuleProblem(d('ask', '', 'git'))).toBeNull();
    expect(validateRule(d('allow', '', 'git'))['commandPrefix']).toBe(ALLOW_RULE_PROBLEMS.singleWord);
  });

  it('refuses launchers, installs, push, discard and delete allows, as core does when saving (AX-05)', () => {
    const cases: [string, string][] = [
      ['bash -c', ALLOW_RULE_PROBLEMS.launcher],
      ['cmd /c', ALLOW_RULE_PROBLEMS.launcher],
      ['powershell -c', ALLOW_RULE_PROBLEMS.launcher],
      ['C:\\Windows\\System32\\cmd.exe /c', ALLOW_RULE_PROBLEMS.launcher],
      ['git -c x=y', ALLOW_RULE_PROBLEMS.launcher],
      ['npm install', ALLOW_RULE_PROBLEMS.install],
      ['pip install', ALLOW_RULE_PROBLEMS.install],
      ['git push', ALLOW_RULE_PROBLEMS.push],
      ['git clean', ALLOW_RULE_PROBLEMS.discard],
      ['git reset --hard', ALLOW_RULE_PROBLEMS.discard],
      ['rm -rf', ALLOW_RULE_PROBLEMS.deletes],
      ['Remove-Item -Recurse', ALLOW_RULE_PROBLEMS.deletes],
    ];
    for (const [prefix, message] of cases) {
      expect(allowRuleProblem(d('allow', 'Bash', prefix))?.message, prefix).toBe(message);
      expect(allowRuleProblem(d('deny', 'Bash', prefix)), prefix).toBeNull();
    }
    expect(allowRuleProblem(d('allow', 'Bash', 'npm test'))).toBeNull();
  });

  it('lets a risky allow be saved switched off, as core does (R-04)', () => {
    const off = { ...d('allow', 'Bash', 'npm install'), enabled: false };
    expect(allowRuleProblem(off)).toBeNull();
    expect(validateRule(off)).toEqual({});
    expect(allowRuleProblem({ ...off, enabled: true })?.message).toBe(ALLOW_RULE_PROBLEMS.install);
  });

  it('shows the refusal in the editor and turns Save off', () => {
    const html = renderToStaticMarkup(
      <RuleEditor
        state={m4State()}
        renames={new Map()}
        rule={null}
        onCommand={ok}
        query={null}
        onDone={noop}
        initialDraft={d('allow', 'Bash', 'git')}
      />,
    );
    expect(html).toContain(esc(ALLOW_RULE_PROBLEMS.singleWord));
    const okHtml = renderToStaticMarkup(
      <RuleEditor
        state={m4State()}
        renames={new Map()}
        rule={null}
        onCommand={ok}
        query={null}
        onDone={noop}
        initialDraft={d('allow', 'Bash', 'git status')}
      />,
    );
    expect(okHtml).not.toContain(esc(ALLOW_RULE_PROBLEMS.singleWord));
  });
});

describe('templates with rules of their own (not launchable in this build)', () => {
  const withRules = { ...TEAM, id: 'tpl-rules', name: 'Guarded team', ruleIds: ['user-npm'] };
  const state = () => {
    const st = m4State();
    st.templates = [TEAM, withRules];
    return st;
  };
  function launchButton(html: string, from: number): string {
    const m = /<button[^>]*>(?:(?!<\/button>).)*Launch(?:(?!<\/button>).)*<\/button>/s.exec(html.slice(from));
    if (!m) throw new Error('no Launch button');
    return m[0];
  }

  it('shows the reason on that template and turns its Launch off with it; other templates stay launchable', () => {
    const html = renderToStaticMarkup(<TemplatesPanel state={state()} onCommand={ok} query={null} />);
    expect(html).toContain(esc(TEMPLATE_RULES_REASON));
    const guarded = launchButton(html, html.indexOf('Guarded team'));
    expect(guarded).toContain('aria-disabled="true"');
    expect(guarded).toContain(`title="${esc(TEMPLATE_RULES_REASON)}"`);
    expect(launchButton(html, html.indexOf('Parser team'))).not.toContain('aria-disabled');
  });

  it('offers no rule picker in the editor, and says why such a template cannot be launched', () => {
    const editor = (t: typeof TEAM) =>
      renderToStaticMarkup(<TemplateEditor template={t} onCommand={ok} query={null} onDone={noop} />);
    expect(editor(TEAM)).not.toMatch(/rule/i);
    expect(editor(withRules)).toContain(esc(TEMPLATE_RULES_REASON));
  });

  it('turns Launch off in the launch dialog started from it', () => {
    const html = renderToStaticMarkup(
      <LaunchPanel state={state()} onCommand={ok} query={null} onClose={noop} initialTemplateId="tpl-rules" />,
    );
    expect(html).toContain(esc(TEMPLATE_RULES_REASON));
    const b = launchButton(html, html.indexOf('form-actions'));
    expect(b).toContain('aria-disabled="true"');
  });
});
