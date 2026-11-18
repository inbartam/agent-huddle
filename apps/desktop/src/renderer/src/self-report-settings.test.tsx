/**
 * Settings → Self-reported progress (M6, F27), rendered to a string: the switch on, off and absent (an older core
 * reads as on), the status while checking / registered / not registered / blocked, a register preview (command, diff,
 * notes), a refusal (Register off with the reason), the Remove confirmation, hostile strings as text, long text
 * clipped. The pure helpers, the query check, the template checkbox, and the progress words
 * for a self-report that gave minutes left only (no bar, never 0%).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  type HuddleState,
  type ProgressView,
  type QueryResult,
  type SelfReportRegistrationPreview,
} from '@huddle/shared';
import { SelfReportSettings, type SelfReportSettingsProps } from './components/SelfReportSettings.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { ProgressSection } from './components/Meters.js';
import { TemplateFields } from './components/LaunchForm.js';
import { loadSelfReportPreview } from './self-report-query.js';
import { interactState, IK, NOW } from './testing/interact-fixture.js';
import { XSS } from './testing/fixture.js';
import {
  applyControl,
  applyOutcome,
  clipChars,
  clipLines,
  registrationCommand,
  registrationStatus,
  selfReportEnabled,
  selfReportEnabledCommand,
  SELF_REPORT_WORDS as W,
} from './view/self-report.js';
import { cardProgress, progressWords, SELF_REPORT_SOURCE } from './view/meters.js';
import { draftFromTemplate, EMPTY_DRAFT, templateFromDraft, templateSummary } from './view/launch.js';

const ok = () => Promise.resolve({ ok: true as const });
const FP = 'f'.repeat(64);

function preview(extra: Partial<SelfReportRegistrationPreview> = {}): SelfReportRegistrationPreview {
  return {
    mode: 'register',
    state: 'absent',
    claudeJsonPath: 'C:\\Users\\me\\.claude.json',
    serverScriptPath: 'C:\\Users\\me\\.claude\\agent-huddle\\huddle-mcp.mjs',
    commands: ['claude mcp add --scope user huddle -- node C:\\Users\\me\\.claude\\agent-huddle\\huddle-mcp.mjs'],
    diff: [],
    diffText: '  "mcpServers": {\n+   "huddle": {\n+     "type": "stdio"\n+   }\n  }',
    notes: ['copy the self-report server to C:\\Users\\me\\.claude\\agent-huddle', 'the first call may ask'],
    refusal: null,
    changed: true,
    fingerprint: FP,
    ...extra,
  };
}

function stateWith(enabled?: boolean): HuddleState {
  const s = interactState();
  s.settings =
    enabled === undefined
      ? { ...DEFAULT_USER_SETTINGS, selfReport: undefined }
      : { ...DEFAULT_USER_SETTINGS, selfReport: { enabled } };
  return s;
}

function html(initial: SelfReportSettingsProps['initial'], state = stateWith(true)): string {
  return renderToStaticMarkup(<SelfReportSettings state={state} onCommand={ok} query={null} initial={initial} />);
}

describe('Self-reported progress: the switch', () => {
  it('is on, off, and on when the core sent no setting', () => {
    expect(html({ status: { kind: 'loading' } }, stateWith(true))).toMatch(/id="self-report-enabled"[^>]*checked=""/);
    expect(html({ status: { kind: 'loading' } }, stateWith(false))).not.toMatch(/id="self-report-enabled"[^>]*checked/);
    expect(html({ status: { kind: 'loading' } }, stateWith(undefined))).toMatch(
      /id="self-report-enabled"[^>]*checked=""/,
    );
    expect(selfReportEnabled(null)).toBe(true);
  });

  it('says what it does in two sentences, with the estimate', () => {
    const out = html({ status: { kind: 'loading' } });
    expect(out).toContain('role="switch"');
    expect(out).toContain(W.help);
    expect(W.help.split('. ').length).toBe(2);
    expect(W.help).toContain('estimate');
  });

  it('sends one settings.update patch', () => {
    expect(selfReportEnabledCommand(false)).toEqual({
      type: 'settings.update',
      patch: { selfReport: { enabled: false } },
    });
  });

  it('sits in Settings with its section title', () => {
    const out = renderToStaticMarkup(
      <SettingsPanel
        state={stateWith(true)}
        onCommand={ok}

        selfReportInitial={{ status: { kind: 'loading' } }}
      />,
    );
    expect(out).toContain('id="settings-self-report"');
    expect(out).toContain(W.section);
  });
});

describe('Self-reported progress: sessions started in a terminal', () => {
  it('explains the user-config change, the missing prompt line and the permission ask', () => {
    const out = html({ status: { kind: 'loading' } });
    expect(out).toContain(W.attachedTitle);
    expect(out).toContain('<code class="code">claude mcp add --scope user huddle …</code>');
    expect(out).toContain('<code class="code">~/.claude.json</code>');
    expect(out).toContain('not the prompt line');
    expect(out).toContain('may ask you for permission');
    expect(out).toContain(W.checking);
  });

  it('not registered: a Preview button; registered: Registered and Remove…', () => {
    const absent = html({ status: { kind: 'loaded', preview: preview() } });
    expect(absent).toContain(W.notRegistered);
    expect(absent).toContain('>Preview</button>');
    expect(absent).not.toContain(W.remove);
    const ours = html({ status: { kind: 'loaded', preview: preview({ state: 'ours', changed: false }) } });
    expect(ours).toContain('●</span> Registered');
    expect(ours).toContain(`>${W.remove}</button>`);
    expect(ours).not.toContain('>Preview</button>');
  });

  it('a check that failed says so, never "not registered"', () => {
    const out = html({ status: { kind: 'error', message: 'Unavailable in this build.' } });
    expect(out).toContain(W.unknownStatus);
    expect(out).toContain('Unavailable in this build.');
    expect(out).not.toContain(W.notRegistered);
  });

  it('a register preview shows the file, the exact command, the diff and the notes, with Register on', () => {
    const p = preview();
    const out = html({ status: { kind: 'loaded', preview: p }, panel: { kind: 'shown', preview: p, notice: null } });
    expect(out).toContain('C:\\Users\\me\\.claude.json');
    expect(out).toContain(W.commandsLead);
    expect(out).toContain(`<code class="code sr-command-text">${p.commands[0] ?? ''}</code>`);
    expect(out).toContain('aria-label="Change to .claude.json"');
    expect(out).toContain('&quot;huddle&quot;: {');
    expect(out).toContain('copy the self-report server');
    expect(out).toMatch(/<button[^>]*class="control control-primary"[^>]*>Register<\/button>/);
    expect(out).toContain('>Close</button>');
  });

  it('a refusal shows as text and turns Register off with the refusal as the reason', () => {
    const refusal = 'An MCP server named "huddle" that is not Agent Huddle\'s is already registered.';
    const p = preview({ state: 'foreign', refusal, changed: false, commands: [], diffText: '', notes: [] });
    const out = html({ status: { kind: 'loaded', preview: p }, panel: { kind: 'shown', preview: p, notice: null } });
    expect(out).toContain('▲</span> Cannot register now');
    expect(out).toContain('class="sr-refusal"');
    expect(out).toContain('An MCP server named &quot;huddle&quot; that is not Agent Huddle&#x27;s');
    expect(out).toMatch(/aria-disabled="true"[^>]*data-reason="An MCP server named/);
    expect(out).toContain(W.noCommand);
  });

  it('an expired preview comes back with the sentence above it', () => {
    const p = preview();
    const out = html({
      status: { kind: 'loaded', preview: p },
      panel: { kind: 'shown', preview: p, notice: W.expired },
    });
    expect(out).toContain('consent-notice');
    expect(out).toContain(W.expired);
  });

  it('Remove shows its own preview and an inline confirmation, no browser dialog', () => {
    const p = preview({
      mode: 'unregister',
      state: 'ours',
      commands: ['claude mcp remove --scope user huddle'],
      diffText: '  "mcpServers": {\n-   "huddle": {}\n  }',
    });
    const out = html({ status: { kind: 'loaded', preview: p }, panel: { kind: 'shown', preview: p, notice: null } });
    expect(out).toContain('aria-label="Remove preview"');
    expect(out).toContain(W.removeQuestion);
    expect(out).toContain('claude mcp remove --scope user huddle');
    expect(out).toMatch(/class="control control-plain control-danger"[^>]*>Remove<\/button>/);
    expect(out).toContain('>Back</button>');
    expect(out).not.toContain('window.confirm');
  });

  it('renders hostile strings from disk as text', () => {
    const p = preview({ claudeJsonPath: XSS, commands: [XSS], notes: [XSS], refusal: XSS, diffText: `+ ${XSS}` });
    const out = html({ status: { kind: 'loaded', preview: p }, panel: { kind: 'shown', preview: p, notice: null } });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('clips long text and long diffs with a Show all control', () => {
    const long = 'x'.repeat(900);
    const diff = Array.from({ length: 60 }, (_, i) => `+ line ${String(i)}`).join('\n');
    const p = preview({ commands: [long], notes: [long], diffText: diff });
    const out = html({ status: { kind: 'loaded', preview: p }, panel: { kind: 'shown', preview: p, notice: null } });
    expect(out).not.toContain(long);
    expect(out).toContain('Show all (900 characters)');
    expect(out).toContain('Show all (60 lines)');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('line 39');
    expect(out).not.toContain('line 40<');
  });
});

describe('Self-reported progress: pure helpers', () => {
  it('maps the preview state to what is registered', () => {
    expect(registrationStatus(preview({ state: 'ours' }))).toBe('registered');
    expect(registrationStatus(preview({ state: 'absent' }))).toBe('not_registered');
    expect(registrationStatus(preview({ state: 'foreign' }))).toBe('blocked');
    expect(registrationStatus(preview({ state: 'unreadable' }))).toBe('blocked');
  });

  it('the confirming button is off with a reason: refusal, nothing to change, busy', () => {
    expect(applyControl(preview(), false)).toEqual({ enabled: true, reason: null });
    expect(applyControl(preview({ refusal: 'No node.' }), false)).toEqual({ enabled: false, reason: 'No node.' });
    expect(applyControl(preview({ changed: false, commands: [] }), false).reason).toBe(W.nothingToRegister);
    expect(applyControl(preview({ mode: 'unregister', changed: false }), false).reason).toBe(W.nothingToRemove);
    expect(applyControl(preview(), true).reason).toBe(W.busy);
  });

  it('sends the fingerprint of the preview the user saw', () => {
    expect(registrationCommand(preview())).toEqual({ type: 'setup.selfReport.register', fingerprint: FP });
    expect(registrationCommand(preview({ mode: 'unregister' }))).toEqual({
      type: 'setup.selfReport.unregister',
      fingerprint: FP,
    });
  });

  it('reads the answer: done, expired, an error', () => {
    expect(applyOutcome('register', { ok: true })).toEqual({ kind: 'done', notice: W.registeredDone });
    expect(applyOutcome('unregister', { ok: true })).toEqual({ kind: 'done', notice: W.removedDone });
    expect(applyOutcome('register', { ok: true, detail: 'Nothing to change.' })).toEqual({
      kind: 'done',
      notice: 'Nothing to change.',
    });
    expect(applyOutcome('register', { ok: false, code: 'expired', message: 'x' })).toEqual({ kind: 'expired' });
    expect(applyOutcome('register', { ok: false, code: 'failed', message: 'claude exited 1' })).toEqual({
      kind: 'error',
      message: 'claude exited 1',
    });
  });

  it('clips by characters and by lines', () => {
    expect(clipChars('abc')).toMatchObject({ text: 'abc', clipped: false });
    expect(clipChars('a'.repeat(500), 10)).toMatchObject({ text: `${'a'.repeat(10)}…`, clipped: true });
    expect(clipLines('a\nb\nc', 2)).toMatchObject({ text: 'a\nb', clipped: true, total: '3 lines' });
  });
});

describe('Self-reported progress: the preview query', () => {
  const q = (r: unknown) => () => Promise.resolve(r as QueryResult);

  it('accepts a well-formed preview for the mode asked', async () => {
    const r = await loadSelfReportPreview(
      q({ ok: true, type: 'setup.selfReportPreview', preview: preview() }),
      'register',
    );
    expect(r).toEqual({ ok: true, preview: preview() });
  });

  it('reads a wrong shape, a wrong mode or an unknown state as failed; no bridge as unavailable', async () => {
    const bad = [
      { ...preview(), mode: 'unregister' },
      { ...preview(), state: 'mystery' },
      { ...preview(), commands: [1] },
      { ...preview(), refusal: 3 },
      { ...preview(), fingerprint: undefined },
    ];
    for (const p of bad) {
      const r = await loadSelfReportPreview(q({ ok: true, type: 'setup.selfReportPreview', preview: p }), 'register');
      expect(r.ok).toBe(false);
    }
    expect((await loadSelfReportPreview(null, 'register')).ok).toBe(false);
    const refused = await loadSelfReportPreview(
      q({ ok: false, code: 'unsupported', message: 'Sample data.' }),
      'register',
    );
    expect(refused).toEqual({ ok: false, code: 'unsupported', message: 'Sample data.' });
  });
});

describe('Template editor: Agents report their progress', () => {
  const base = { ...EMPTY_DRAFT, cwd: 'C:\\p\\x', prompt: 'Go' };

  it('is on by default and writes selfReport:false only when off', () => {
    expect(EMPTY_DRAFT.selfReport).toBe(true);
    expect('selfReport' in templateFromDraft(base, 't1')).toBe(false);
    expect(templateFromDraft({ ...base, selfReport: false }, 't1').selfReport).toBe(false);
    expect(draftFromTemplate(templateFromDraft({ ...base, selfReport: false }, 't1')).selfReport).toBe(false);
    expect(draftFromTemplate(templateFromDraft(base, 't1')).selfReport).toBe(true);
    expect(templateSummary(templateFromDraft({ ...base, selfReport: false }, 't1'))).toContain('no progress reports');
  });

  it('shows the checkbox, and says when the global switch is off', () => {
    const props = { draft: base, errors: {}, onChange: () => undefined, query: null, editor: true };
    const on = renderToStaticMarkup(<TemplateFields {...props} />);
    expect(on).toMatch(/type="checkbox"[^>]*checked=""[^>]*\/><label[^>]*>Agents report their progress<\/label>/);
    expect(on).not.toContain('Off for every run');
    const off = renderToStaticMarkup(<TemplateFields {...props} selfReportOff />);
    expect(off).toContain('Off for every run while Settings, Self-reported progress is off.');
  });
});

describe('Progress words: a self-report with minutes left only', () => {
  const VIEW: ProgressView = {
    fraction: null,
    completedTasks: 0,
    totalTasks: 0,
    etaMs: 360_000,
    etaLowMs: 240_000,
    etaHighMs: 540_000,
    basis: 'self_report',
    confidence: 'low',
    finishedSubagents: 0,
    startedSubagents: 0,
  };

  it('has no bar and the time left as a range, labelled as the agent’s own report', () => {
    const w = progressWords(VIEW, { status: 'working' });
    expect(w.fraction).toBeNull();
    expect(w.eta).toBe('about 4–9 min left');
    expect(w.counted).toContain("agent's own report");
    expect(w.source).toBe(SELF_REPORT_SOURCE);
  });

  it('card: "~4–9 min left, est.", no bar, never 0%', () => {
    const p = cardProgress(VIEW, { status: 'working', tasks: [] });
    expect(p).toMatchObject({ lead: null, text: '~4–9 min left, est.', fraction: null });
    expect(p?.text).not.toContain('%');
    expect(p?.title).toContain(SELF_REPORT_SOURCE);
  });

  it('finished, or no minutes: nothing at all', () => {
    expect(progressWords(VIEW, { status: 'done' }).counted).toBeNull();
    expect(
      cardProgress({ ...VIEW, etaLowMs: null, etaHighMs: null, etaMs: null }, { status: 'working', tasks: [] }),
    ).toBeNull();
  });

  it('hybrid and percent self-reports carry the tooltip; tasks alone do not', () => {
    expect(
      progressWords(
        { ...VIEW, basis: 'hybrid', fraction: 0.4, totalTasks: 4, completedTasks: 1 },
        { status: 'working' },
      ).source,
    ).toBe(SELF_REPORT_SOURCE);
    expect(cardProgress({ ...VIEW, fraction: 0.4 }, { status: 'working', tasks: [] })?.title).toContain(
      SELF_REPORT_SOURCE,
    );
    expect(
      progressWords({ ...VIEW, basis: 'tasks', fraction: 0.4, totalTasks: 4, completedTasks: 1 }, { status: 'working' })
        .source,
    ).toBeNull();
  });

  it('the detail pane, from a real agent with a minutes-only report: percent unknown, time left, est.', () => {
    const state = interactState();
    const agent = state.agents[IK.tester];
    if (agent === undefined) throw new Error('fixture');
    agent.status = 'working';
    agent.tasks = [];
    agent.childKeys = [];
    agent.selfReport = { fraction: null, minutesLeft: 6, note: null, at: NOW - 30_000 };
    const out = renderToStaticMarkup(<ProgressSection state={state} agent={agent} now={NOW} />);
    expect(out).toContain('Percent done: —');
    expect(out).not.toContain('0%');
    expect(out).toMatch(/about \d+–\d+ min left/);
    expect(out).toContain('est.');
    expect(out).toContain(`title="${SELF_REPORT_SOURCE.replace(/'/g, '&#x27;')}"`);
  });
});
