// @vitest-environment happy-dom
/**
 * Settings → Self-reported progress (M6, F27) with real DOM events: the switch sends `settings.update`; opening the
 * section checks what is registered; Preview shows the register preview; Register sends its fingerprint; `expired`
 * reads the preview again and shows the new one with a sentence; registered → Remove… shows the unregister preview with
 * an inline confirmation, Remove sends that fingerprint, Back closes it; a refusal keeps Register off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  type CommandResult,
  type HuddleCommand,
  type HuddleQuery,
  type HuddleState,
  type QueryResult,
  type SelfReportRegistrationMode,
  type SelfReportRegistrationPreview,
} from '@huddle/shared';
import { SelfReportSettings } from './components/SelfReportSettings.js';
import { byText, click, flush, key, mount, type Mounted } from './testing/dom.js';
import { interactState } from './testing/interact-fixture.js';
import { SELF_REPORT_WORDS as W } from './view/self-report.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function stateWith(enabled: boolean): HuddleState {
  const s = interactState();
  s.settings = { ...DEFAULT_USER_SETTINGS, selfReport: { enabled } };
  return s;
}

function preview(
  mode: SelfReportRegistrationMode,
  registered: boolean,
  fp: string,
  extra: Partial<SelfReportRegistrationPreview> = {},
): SelfReportRegistrationPreview {
  const changed = mode === 'register' ? !registered : registered;
  return {
    mode,
    state: registered ? 'ours' : 'absent',
    claudeJsonPath: 'C:\\Users\\me\\.claude.json',
    serverScriptPath: 'C:\\Users\\me\\.claude\\agent-huddle\\huddle-mcp.mjs',
    commands: changed
      ? [
          mode === 'register'
            ? 'claude mcp add --scope user huddle -- node x.mjs'
            : 'claude mcp remove --scope user huddle',
        ]
      : [],
    diff: [],
    diffText: changed ? `  "mcpServers": {\n${mode === 'register' ? '+' : '-'}   "huddle": {}\n  }` : '',
    notes: changed ? ['a note'] : ['already registered: nothing to do'],
    refusal: null,
    changed,
    fingerprint: fp.repeat(64),
    ...extra,
  };
}

/** A fake core: what is registered, which fingerprint is current, and what it answers. */
function harness(opts: { registered?: boolean; expireOnce?: boolean; refusal?: string } = {}) {
  let registered = opts.registered ?? false;
  let generation = 'a';
  let expireOnce = opts.expireOnce ?? false;
  const sent: HuddleCommand[] = [];
  const asked: HuddleQuery[] = [];
  const current = (mode: SelfReportRegistrationMode) =>
    preview(mode, registered, generation, opts.refusal ? { refusal: opts.refusal, changed: false, commands: [] } : {});
  return {
    sent,
    asked,
    onCommand: (cmd: HuddleCommand): Promise<CommandResult> => {
      sent.push(cmd);
      if (cmd.type === 'setup.selfReport.register' || cmd.type === 'setup.selfReport.unregister') {
        if (expireOnce) {
          // Something else changed `.claude.json` meanwhile: a new plan, a new fingerprint.
          expireOnce = false;
          generation = 'b';
          return Promise.resolve({ ok: false, code: 'expired', message: 'changed' });
        }
        const mode = cmd.type === 'setup.selfReport.register' ? 'register' : 'unregister';
        if (cmd.fingerprint !== current(mode).fingerprint) {
          return Promise.resolve({ ok: false, code: 'expired', message: 'changed' });
        }
        registered = mode === 'register';
      }
      return Promise.resolve({ ok: true });
    },
    query: (q: HuddleQuery): Promise<QueryResult> => {
      asked.push(q);
      if (q.type !== 'setup.selfReportPreview')
        return Promise.resolve({ ok: false, code: 'unsupported', message: 'no' });
      return Promise.resolve({ ok: true, type: 'setup.selfReportPreview', preview: current(q.mode) });
    },
  };
}

const status = () => mounted?.container.querySelector('#self-report-status')?.textContent ?? '';

describe('Self-reported progress settings, interactions', () => {
  it('the switch sends settings.update with the new value', async () => {
    const h = harness();
    mounted = await mount(<SelfReportSettings state={stateWith(true)} onCommand={h.onCommand} query={h.query} />);
    const sw = mounted.container.querySelector<HTMLInputElement>('#self-report-enabled');
    expect(sw?.checked).toBe(true);
    await click(sw);
    expect(h.sent).toContainEqual({ type: 'settings.update', patch: { selfReport: { enabled: false } } });
  });

  it('checks on open, previews, registers with the fingerprint, then shows Registered and Remove…', async () => {
    const h = harness();
    mounted = await mount(<SelfReportSettings state={stateWith(true)} onCommand={h.onCommand} query={h.query} />);
    await flush();
    expect(h.asked).toEqual([{ type: 'setup.selfReportPreview', mode: 'register' }]);
    expect(status()).toContain(W.notRegistered);
    expect(h.sent).toEqual([]);

    await click(byText(mounted.container, 'button', W.preview));
    await flush();
    const panel = mounted.container.querySelector('[aria-label="Register preview"]');
    expect(panel?.textContent).toContain('claude mcp add --scope user huddle -- node x.mjs');
    expect(panel?.textContent).toContain('"huddle": {}');
    expect(panel?.textContent).toContain('a note');

    await click(byText(mounted.container, 'button', W.register));
    await flush();
    expect(h.sent).toEqual([{ type: 'setup.selfReport.register', fingerprint: 'a'.repeat(64) }]);
    expect(mounted.container.querySelector('[aria-label="Register preview"]')).toBeNull();
    expect(mounted.container.textContent).toContain(W.registeredDone);
    expect(status()).toContain(W.registered);
    expect(byText(mounted.container, 'button', W.remove)).not.toBeNull();
  });

  it('expired: reads the preview again and shows the new one with a sentence; Register then sends the new fingerprint', async () => {
    const h = harness({ expireOnce: true });
    mounted = await mount(<SelfReportSettings state={stateWith(true)} onCommand={h.onCommand} query={h.query} />);
    await flush();
    await click(byText(mounted.container, 'button', W.preview));
    await flush();
    await click(byText(mounted.container, 'button', W.register));
    await flush();
    expect(h.sent).toEqual([{ type: 'setup.selfReport.register', fingerprint: 'a'.repeat(64) }]);
    const panel = mounted.container.querySelector('[aria-label="Register preview"]');
    expect(panel?.textContent).toContain(W.expired);
    // Asked: on open, Preview, and again after expired.
    expect(h.asked.filter((q) => q.type === 'setup.selfReportPreview')).toHaveLength(3);

    await click(byText(mounted.container, 'button', W.register));
    await flush();
    expect(h.sent[1]).toEqual({ type: 'setup.selfReport.register', fingerprint: 'b'.repeat(64) });
    expect(status()).toContain(W.registered);
  });

  it('registered: Remove… shows its preview and a confirmation; Back closes it, Remove sends the unregister fingerprint', async () => {
    const h = harness({ registered: true });
    mounted = await mount(<SelfReportSettings state={stateWith(true)} onCommand={h.onCommand} query={h.query} />);
    await flush();
    expect(status()).toContain(W.registered);

    await click(byText(mounted.container, 'button', W.remove));
    await flush();
    expect(h.asked.at(-1)).toEqual({ type: 'setup.selfReportPreview', mode: 'unregister' });
    expect(mounted.container.textContent).toContain(W.removeQuestion);
    expect(mounted.container.textContent).toContain('claude mcp remove --scope user huddle');

    await click(byText(mounted.container, 'button', W.back));
    expect(mounted.container.querySelector('[aria-label="Remove preview"]')).toBeNull();
    expect(h.sent).toEqual([]);
    expect(document.activeElement?.textContent).toBe(W.remove);

    await click(byText(mounted.container, 'button', W.remove));
    await flush();
    // Esc closes it too.
    await key(mounted.container.querySelector('[aria-label="Remove preview"]'), 'Escape');
    expect(mounted.container.querySelector('[aria-label="Remove preview"]')).toBeNull();

    await click(byText(mounted.container, 'button', W.remove));
    await flush();
    await click(byText(mounted.container, 'button', W.removeConfirm));
    await flush();
    expect(h.sent).toEqual([{ type: 'setup.selfReport.unregister', fingerprint: 'a'.repeat(64) }]);
    expect(mounted.container.textContent).toContain(W.removedDone);
    expect(status()).toContain(W.notRegistered);
  });

  it('a refusal shows as text and Register stays off with the refusal as its tooltip', async () => {
    const refusal = 'node was not found on PATH, and the self-report server needs it.';
    const h = harness({ refusal });
    mounted = await mount(<SelfReportSettings state={stateWith(true)} onCommand={h.onCommand} query={h.query} />);
    await flush();
    await click(byText(mounted.container, 'button', W.preview));
    await flush();
    expect(mounted.container.querySelector('.sr-refusal')?.textContent).toContain(refusal);
    const register = byText(mounted.container, 'button', W.register);
    expect(register?.getAttribute('aria-disabled')).toBe('true');
    expect(register?.getAttribute('title')).toBe(refusal);
    await click(register);
    await flush();
    expect(h.sent).toEqual([]);
  });

  it('Show all expands a clipped command', async () => {
    const long = `claude mcp add --scope user huddle -- node ${'x'.repeat(600)}`;
    const h = harness();
    const query = (q: HuddleQuery): Promise<QueryResult> =>
      q.type === 'setup.selfReportPreview'
        ? Promise.resolve({
            ok: true,
            type: 'setup.selfReportPreview',
            preview: preview(q.mode, false, 'a', { commands: [long] }),
          })
        : h.query(q);
    mounted = await mount(<SelfReportSettings state={stateWith(true)} onCommand={h.onCommand} query={query} />);
    await flush();
    await click(byText(mounted.container, 'button', W.preview));
    await flush();
    const code = () => mounted?.container.querySelector('.sr-command-text')?.textContent ?? '';
    expect(code()).not.toBe(long);
    const more = mounted.container.querySelector('.sr-command .sr-clip');
    expect(more?.getAttribute('aria-expanded')).toBe('false');
    await click(more);
    expect(code()).toBe(long);
  });
});
