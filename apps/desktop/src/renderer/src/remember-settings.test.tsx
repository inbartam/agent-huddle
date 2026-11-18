/**
 * U4 (M5, F22 F25 F17): Settings, History (keep history for n days with the lower-retention confirmation, the stats
 * line, "Delete all history…" with its typed confirmation) and Ask the Huddle (the switch), and the template editor's
 * secret warning and `<redacted>` refusal. Render tests use renderToStaticMarkup (no DOM): the flows are driven through
 * the pure steps in view/remember-settings.ts with a recording `send` and query.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  OVERALL_BUDGET_LOWERED_WORDS,
  type CommandResult,
  type HistoryStats,
  type HuddleCommand,
  type HuddleState,
  type UserSettings,
} from '@huddle/shared';
import { SettingsPanel } from './components/SettingsPanel.js';
import { TemplateEditor } from './components/Templates.js';
import type { HistorySettingsInitial } from './components/HistorySettings.js';
import { loadRetentionPreview, loadStats } from './settings-query.js';
import { XSS } from './testing/fixture.js';
import { interactState } from './testing/interact-fixture.js';
import { TEAM } from './testing/m4-fixture.js';
import { fakeQuery, NOW_M5 } from './testing/m5-fixture.js';
import { draftFromTemplate, saveOutcome, SECRET_WORDS } from './view/launch.js';
import {
  ASK_SETTINGS_WORDS,
  askEnabledCommand,
  commitRetention,
  DELETE_ALL_COMMAND,
  deleteAllControl,
  deleteAllOutcome,
  HISTORY_SETTINGS_WORDS as W,
  retentionPreviewWords,
  retentionStep,
  runDeleteAll,
  retentionCommand,
  saveRetention,
  statsLine,
  storageSize,
  type RetentionPhase,
} from './view/remember-settings.js';

const ESCAPED_XSS = '&lt;img src=x onerror=alert(1)&gt;';
const noop = () => undefined;
const ok = () => Promise.resolve<CommandResult>({ ok: true });

const STATS: HistoryStats = {
  runs: 1284,
  bytes: 212 * 1024 * 1024,
  oldestTs: new Date(2026, 9, 15, 9, 0).getTime(),
  retentionDays: 30,
  migrating: false,
  legacyFolder: 'C:\\Users\\dev\\AppData\\Roaming\\agent-huddle\\events.migrated',
};

function state(more: Partial<UserSettings> = {}): HuddleState {
  const s = interactState();
  s.settings = { ...DEFAULT_USER_SETTINGS, ...more };
  return s;
}

function panel(initial: HistorySettingsInitial = { stats: STATS }, s: HuddleState = state()): string {
  return renderToStaticMarkup(
    <SettingsPanel state={s} onCommand={ok} query={null} now={NOW_M5} historyInitial={initial} />,
  );
}

/** The button with this text, as rendered (`aria-disabled` and `title` show whether it is off and why). */
function button(html: string, text: string): string {
  const m = new RegExp(`<button[^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</button>`).exec(html);
  if (!m) throw new Error(`no button ${text}`);
  return m[0];
}

function recorder(answer: (cmd: HuddleCommand) => CommandResult = () => ({ ok: true })) {
  const sent: HuddleCommand[] = [];
  const send = (cmd: HuddleCommand) => {
    sent.push(cmd);
    return Promise.resolve(answer(cmd));
  };
  return { send, sent };
}

describe('settings, History: keep history for n days', () => {
  it('shows the field with its range, the help text, and the stats line', () => {
    const html = panel({ stats: STATS }, state({ history: { retentionDays: 30 } }));
    expect(html).toContain('">History<span class="section-note">Stored on this computer');
    expect(html).toMatch(/id="setting-retentionDays"[^>]*min="1" max="365"[^>]*value="30"/);
    expect(html).toContain('Keep history for');
    expect(html).toContain('>days<');
    expect(html).toContain(W.help);
    expect(html).toContain('1,284 runs · 212 MB · oldest 15 Oct');
    // History sits after Rules and before Shortcut; Ask the Huddle follows History.
    const at = (t: string) => html.indexOf(`">${t}<`);
    expect(at('Rules')).toBeLessThan(at('History'));
    expect(at('History')).toBeLessThan(at('Ask the Huddle'));
    expect(at('Ask the Huddle')).toBeLessThan(at('Shortcut'));
  });

  it('shows — for unknown stats and says when the import is running', () => {
    expect(statsLine(null, NOW_M5)).toBe('— runs · — · oldest —');
    expect(statsLine({ ...STATS, bytes: null, oldestTs: null, runs: 0 }, NOW_M5)).toBe('0 runs · — · oldest —');
    expect(statsLine({ ...STATS, runs: 1, oldestTs: new Date(2025, 9, 15).getTime() }, NOW_M5)).toBe(
      '1 run · 212 MB · oldest 15 Oct 2025',
    );
    expect(storageSize(4.25 * 1024 * 1024)).toBe('4.3 MB');
    expect(storageSize(900 * 1024)).toBe('900 KB');
    expect(storageSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(panel({ stats: null })).toContain('— runs · — · oldest —');
    expect(panel({ stats: { ...STATS, migrating: true } })).toContain(
      '<p class="setting-help" role="status">Bringing in older history from the JSONL folder.</p>',
    );
  });

  it('raises at once, asks before lowering, and refuses numbers out of range', () => {
    expect(retentionStep(30, '60')).toEqual({ kind: 'save', days: 60 });
    expect(retentionStep(30, '7')).toEqual({ kind: 'confirm', days: 7 });
    expect(retentionStep(30, ' 30 ')).toEqual({ kind: 'same' });
    expect(retentionStep(30, '0')).toEqual({ kind: 'error', error: 'Enter a whole number from 1 to 365.' });
    expect(retentionStep(30, '366')).toHaveProperty('kind', 'error');
    expect(retentionStep(30, '2.5')).toHaveProperty('kind', 'error');
  });

  it('lowering shows the preview count and sends history.setRetention only after "Delete them"', async () => {
    const { send, sent } = recorder(() => ({ ok: true, deleted: { runs: 212, reports: 3, folders: 0 } }));
    const q = fakeQuery(() => ({ ok: true, type: 'history.retentionPreview', preview: { days: 7, runs: 212 } }));
    const phases: RetentionPhase[] = [];
    const preview = (days: number) => loadRetentionPreview(q.fn, days);

    const confirm = await commitRetention({ send, preview }, 30, '7', (p) => phases.push(p));
    expect(confirm).toEqual({ phase: 'confirm', days: 7, runs: 212 });
    expect(phases.map((p) => p.phase)).toEqual(['counting', 'confirm']);
    expect(q.asked).toEqual([{ type: 'history.retentionPreview', days: 7 }]);
    expect(sent).toEqual([]);

    const html = panel({ stats: STATS, draft: '7', retention: confirm });
    expect(html).toContain('role="group" aria-label="Confirm keeping less history"');
    expect(html).toContain('Runs older than 7 days will be deleted (212 runs).');
    expect(button(html, 'Delete them')).not.toContain('aria-disabled');
    expect(button(html, 'Back')).not.toContain('aria-disabled');

    // "Delete them" sends the count the user read (L4): the core refuses a lower value without it, or with another.
    const saved = await saveRetention(send, 7, noop, confirm.phase === 'confirm' ? confirm.runs : null);
    expect(sent).toEqual([{ type: 'history.setRetention', days: 7, confirm: 212 }]);
    expect(saved).toEqual({ phase: 'saved', days: 7, words: 'Saved. 212 runs older than 7 days were deleted.' });
    expect(panel({ stats: STATS, retention: saved })).toContain(
      '<p class="form-sent" role="status">Saved. 212 runs older than 7 days were deleted.</p>',
    );
  });

  it('raising sends at once with no confirmation; an unknown count shows —; a refusal is shown', async () => {
    const { send, sent } = recorder();
    const preview = () => Promise.resolve({ ok: true as const, runs: null });
    const raised = await commitRetention({ send, preview }, 30, '90', noop);
    expect(sent).toEqual([{ type: 'history.setRetention', days: 90 }]);
    expect(raised).toEqual({ phase: 'saved', days: 90, words: null });

    const unknown = await commitRetention({ send, preview }, 30, '1', noop);
    expect(unknown).toEqual({ phase: 'confirm', days: 1, runs: null });
    expect(retentionPreviewWords(1, null)).toBe('Runs older than 1 day will be deleted (— runs).');
    expect(retentionPreviewWords(7, 1)).toBe('Runs older than 7 days will be deleted (1 run).');

    // An unknown count sends no confirm; the core then refuses the lower value and says why.
    const blind = recorder();
    await saveRetention(blind.send, 1, noop, null);
    expect(blind.sent).toEqual([{ type: 'history.setRetention', days: 1 }]);
    expect(retentionCommand(7, 0)).toEqual({ type: 'history.setRetention', days: 7, confirm: 0 });

    const refused = recorder(() => ({ ok: false, code: 'failed', message: 'Settings could not be saved.' }));
    expect(await saveRetention(refused.send, 7, noop)).toEqual({
      phase: 'error',
      error: 'Settings could not be saved.',
    });
    expect(
      panel({ stats: STATS, draft: '7', retention: { phase: 'error', error: 'Settings could not be saved.' } }),
    ).toContain('role="alert">Settings could not be saved.</p>');
  });
});

describe('settings, History: delete all history', () => {
  const open = (more: HistorySettingsInitial = {}) => panel({ stats: STATS, deleteOpen: true, ...more });

  it('opens an inline group with the exact text and the folder path in mono, never window.confirm', () => {
    const closed = panel();
    expect(button(closed, 'Delete all history…')).toContain('control-danger');
    expect(closed).not.toContain('role="group" aria-labelledby');

    const html = open();
    expect(html).toMatch(/role="group" aria-labelledby="[^"]+-title"/);
    expect(html).toContain('<strong id="');
    expect(html).toContain(
      'Delete all history?</strong> This deletes from this computer: every stored event, every run report and its Markdown file, and the older JSONL history folder (<span class="code">C:\\Users\\dev\\AppData\\Roaming\\agent-huddle\\events.migrated</span>).',
    );
    expect(html).toContain(
      'It keeps: settings, templates, rules, agent nicknames, and the overall budget. Sessions running now keep what they have logged so far, so the team view and budgets stay right. If an overall budget is set, its usage will count only what is left. This cannot be undone.',
    );
    expect(html).toContain('Type delete to confirm');
    expect(html).not.toContain('confirm(');
    // No folder: the clause goes; unknown stats: "if there is one".
    expect(open({ stats: { ...STATS, legacyFolder: null } })).toContain('every run report and its Markdown file.</p>');
    expect(open({ stats: null })).toContain('and the older JSONL history folder if there is one.');
  });

  it('stays off with "Type delete first." until the field holds delete (trimmed, any case)', () => {
    expect(button(open(), 'Delete all history')).toContain('aria-disabled="true"');
    expect(button(open(), 'Delete all history')).toContain('title="Type delete first."');
    expect(button(open({ typed: 'delet' }), 'Delete all history')).toContain('aria-disabled="true"');
    expect(button(open({ typed: '  DeLeTe ' }), 'Delete all history')).not.toContain('aria-disabled');
    expect(deleteAllControl(' delete', false)).toEqual({ enabled: true, reason: null });
    expect(deleteAllControl('delete', true)).toEqual({ enabled: false, reason: W.whileImporting });
    expect(open({ typed: 'delete', deleting: true })).toMatch(/aria-busy="true"[^>]*>Deleting…<\/button>/);
  });

  it('sends {confirm: delete} only once typed, and shows the counts and the budget words when flagged', async () => {
    const { send, sent } = recorder(() => ({
      ok: true,
      deleted: { runs: 1284, reports: 12, folders: 1, overallBudgetLowered: true },
      detail: 'ignored',
    }));
    expect(await runDeleteAll(send, 'nope')).toEqual({ ok: false, error: 'Type delete first.' });
    expect(sent).toEqual([]);
    const outcome = await runDeleteAll(send, ' Delete ');
    expect(sent).toEqual([{ type: 'history.deleteAll', confirm: 'delete' }]);
    expect(DELETE_ALL_COMMAND).toEqual({ type: 'history.deleteAll', confirm: 'delete' });
    expect(outcome).toEqual({
      ok: true,
      lines: ['History deleted: 1,284 runs, 12 reports, 1 older history folder.', OVERALL_BUDGET_LOWERED_WORDS],
    });
    const html = panel({ stats: STATS, outcome });
    expect(html).toContain('role="status"');
    expect(html).toContain('History deleted: 1,284 runs, 12 reports, 1 older history folder.');
    expect(html).toContain(OVERALL_BUDGET_LOWERED_WORDS.replace("'", '&#x27;'));

    const plain = deleteAllOutcome({ ok: true, deleted: { runs: 1, reports: 0, folders: 0 } });
    expect(plain).toEqual({ ok: true, lines: ['History deleted: 1 run, 0 reports.'] });
  });

  it('shows the core refusals in plain words (import running, JSONL fallback)', () => {
    const importing = deleteAllOutcome({
      ok: false,
      code: 'failed',
      message: 'Huddle is still bringing in older history. Try again when the History view no longer says so.',
    });
    expect(importing.ok).toBe(false);
    const html = panel({ stats: STATS, outcome: importing });
    expect(html).toContain('<p class="inline-error" role="alert">Huddle is still bringing in older history.');
    const fallback = deleteAllOutcome({ ok: false, code: 'unsupported', message: 'History is kept in JSONL files.' });
    expect(fallback).toEqual({ ok: false, error: 'History is kept in JSONL files.' });
  });

  it('renders a hostile folder path and core message as text', () => {
    const html = panel({
      stats: { ...STATS, legacyFolder: `C:\\x\\${XSS}` },
      deleteOpen: true,
      outcome: { ok: false, error: XSS },
    });
    expect(html).toContain(`<span class="code">C:\\x\\${ESCAPED_XSS}</span>`);
    expect(html).toContain(`role="alert">${ESCAPED_XSS}</p>`);
    expect(html).not.toContain('<img');
  });
});

describe('settings, Ask the Huddle', () => {
  it('is a switch, off by default, with the help text word for word', () => {
    const html = panel();
    expect(html).toContain('">Ask the Huddle<span class="section-note">Off by default');
    expect(html).toMatch(
      /id="ask-enabled" type="checkbox" role="switch" class="switch" aria-describedby="ask-enabled-help"\/>/,
    );
    expect(html).toContain(ASK_SETTINGS_WORDS.label);
    expect(html).toContain(
      'When you ask, Huddle runs <span class="code">claude -p</span> with Haiku on your Claude Code login',
    );
    expect(html).toContain('It never sends file contents or tool output.');
    expect(html).toContain('This is the one Huddle feature that sends anything off this computer;');
    expect(panel({ stats: STATS }, state({ ask: { enabled: true } }))).toMatch(/id="ask-enabled"[^>]*checked=""/);
  });

  it('sends ask.setEnabled', () => {
    expect(askEnabledCommand(true)).toEqual({ type: 'ask.setEnabled', enabled: true });
    expect(askEnabledCommand(false)).toEqual({ type: 'ask.setEnabled', enabled: false });
  });
});

describe('settings queries', () => {
  it('reads history.stats and checks its shape', async () => {
    const good = fakeQuery(() => ({ ok: true, type: 'history.stats', stats: STATS }));
    expect(await loadStats(good.fn)).toEqual({ ok: true, stats: STATS });
    expect(good.asked).toEqual([{ type: 'history.stats' }]);
    const bad = fakeQuery(() => ({ ok: true, type: 'history.stats', stats: { ...STATS, runs: '9' } }) as never);
    expect(await loadStats(bad.fn)).toHaveProperty('code', 'failed');
    const off = fakeQuery(() => ({ ok: false, code: 'not_available', message: 'Not in this build.' }));
    expect(await loadStats(off.fn)).toEqual({ ok: false, code: 'not_available', message: 'Not in this build.' });
    expect(await loadStats(null)).toHaveProperty('code', 'unsupported');
  });
});

describe('templates: secrets in prompts', () => {
  const masked = { ...TEAM, prompt: 'Use API_KEY=<redacted> for the staging run.' };

  it('marks a masked prompt in words, so it is not silently editable', () => {
    const html = renderToStaticMarkup(<TemplateEditor template={masked} onCommand={ok} query={null} onDone={noop} />);
    expect(html).toContain('text-input form-prompt has-mask');
    expect(html).toContain(SECRET_WORDS.masked.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(html).toContain('Use API_KEY=&lt;redacted&gt; for the staging run.');
    const plain = renderToStaticMarkup(<TemplateEditor template={TEAM} onCommand={ok} query={null} onDone={noop} />);
    expect(plain).not.toContain('has-mask');
  });

  it('keeps the editor open with the warning near the prompt after a save that warns', () => {
    const draft = draftFromTemplate(TEAM);
    const warning = 'This prompt looks like it holds a secret; it is stored as typed in templates.json.';
    expect(saveOutcome({ ok: true, warning }, draft)).toEqual({ kind: 'warning', warning });
    expect(saveOutcome({ ok: true }, draft)).toEqual({ kind: 'done' });
    const html = renderToStaticMarkup(
      <TemplateEditor template={TEAM} onCommand={ok} query={null} onDone={noop} initialWarning={warning} />,
    );
    const prompt = html.indexOf('form-prompt');
    const note = html.indexOf(`role="status">Template saved. ${warning}`);
    expect(note).toBeGreaterThan(prompt);
    expect(note).toBeLessThan(html.indexOf('Main agent'));
    expect(button(html, 'Close')).toBeTruthy();
  });

  it('shows the <redacted> refusal in plain words; other refusals keep the core message', () => {
    const draft = draftFromTemplate(masked);
    const refusal = { ok: false as const, code: 'invalid', message: 'This prompt still shows <redacted>…' };
    expect(saveOutcome(refusal, draft)).toEqual({ kind: 'error', error: SECRET_WORDS.refused });
    expect(SECRET_WORDS.refused).toBe(
      'Huddle hides secrets in prompts. Delete the hidden part and type it again, or leave it untouched.',
    );
    expect(saveOutcome(refusal, draftFromTemplate(TEAM))).toEqual({ kind: 'error', error: refusal.message });
    expect(saveOutcome({ ok: false, code: 'failed', message: 'Disk full.' }, draft)).toEqual({
      kind: 'error',
      error: 'Disk full.',
    });
    const html = renderToStaticMarkup(
      <TemplateEditor
        template={masked}
        onCommand={ok}
        query={null}
        onDone={noop}
        initialError={SECRET_WORDS.refused}
      />,
    );
    expect(html).toContain(`role="alert">${SECRET_WORDS.refused}</p>`);
  });

  it('renders a hostile warning as text', () => {
    const html = renderToStaticMarkup(
      <TemplateEditor template={TEAM} onCommand={ok} query={null} onDone={noop} initialWarning={XSS} />,
    );
    expect(html).toContain(`Template saved. ${ESCAPED_XSS}`);
    expect(html).not.toContain('<img');
  });
});
