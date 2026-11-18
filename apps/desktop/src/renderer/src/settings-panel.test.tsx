/**
 * The settings panel (M3): values from HuddleState.settings (defaults when absent), one `settings.update` patch per
 * change, input checks, and the shortcut's status from HuddleState.shortcut.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type HuddleState } from '@huddle/shared';
import { SettingsPanel } from './components/SettingsPanel.js';
import { interactState } from './testing/interact-fixture.js';
import {
  DETECTOR_FIELDS,
  detectorCommand,
  parseWhole,
  QUESTION_HOLD_FIELD,
  questionHoldCommand,
  shortcutCommand,
  shortcutWords,
  START_WITH_WINDOWS_WORDS,
  startWithWindowsCommand,
  startWithWindowsControl,
  toastCommand,
} from './view/settings.js';

const ok = () => Promise.resolve({ ok: true as const });

function panel(state: HuddleState) {
  return renderToStaticMarkup(<SettingsPanel state={state} onCommand={ok} />);
}

describe('settings panel', () => {
  it('shows each toast switch from the settings', () => {
    const state = interactState();
    state.settings = { ...DEFAULT_USER_SETTINGS, toasts: { ...DEFAULT_USER_SETTINGS.toasts, loop: false } };
    const html = panel(state);
    expect(html).toMatch(/id="toast-approval" type="checkbox" role="switch" class="switch" checked=""/);
    expect(html).toMatch(/id="toast-loop" type="checkbox" role="switch" class="switch"\/>/);
    expect(html).toContain('An agent may be in a loop');
  });

  it('shows the detector thresholds and question hold, with units and ranges', () => {
    const state = interactState();
    state.settings = { ...DEFAULT_USER_SETTINGS, questionHoldSeconds: 45 };
    const html = panel(state);
    expect(html).toMatch(/id="setting-stuckMinutes"[^>]*min="1" max="240"[^>]*value="5"/);
    expect(html).toMatch(/id="setting-questionHoldSeconds"[^>]*value="45"/);
    expect(html).toContain('0 sends questions');
  });

  it('says it shows the defaults when Huddle sent no settings', () => {
    expect(panel(interactState())).toContain('Showing the defaults');
  });

  it('disables "Start with Windows" with its reason when main offers no login item (dev run)', () => {
    const state = interactState();
    state.settings = { ...DEFAULT_USER_SETTINGS };
    const html = panel(state);
    expect(html).toMatch(/id="start-with-windows" type="checkbox" role="switch" class="switch" disabled=""/);
    expect(html).toContain(START_WITH_WINDOWS_WORDS.unavailable);
    expect(html).toContain(START_WITH_WINDOWS_WORDS.uninstallTitle);
    expect(html).toContain('--remove-hooks');
  });

  it('shows "Start with Windows" off by default and on when Windows says so', () => {
    const state = interactState();
    state.settings = { ...DEFAULT_USER_SETTINGS, startWithWindows: false };
    expect(panel(state)).toMatch(/id="start-with-windows"(?![^>]*checked)(?![^>]*disabled)[^>]*\/>/);
    state.settings = { ...DEFAULT_USER_SETTINGS, startWithWindows: true };
    expect(panel(state)).toMatch(/id="start-with-windows"[^>]*checked=""/);
    expect(startWithWindowsControl(state.settings)).toEqual({ on: true, enabled: true, reason: undefined });
    expect(startWithWindowsCommand(false)).toEqual({ type: 'settings.update', patch: { startWithWindows: false } });
  });

  it('shows the shortcut status: working, failed with the old one kept, or not set up', () => {
    const state = interactState();
    state.shortcut = { accelerator: 'Control+Alt+H', registered: true, message: null };
    expect(panel(state)).toContain('Ctrl+Alt+H shows or hides the widget.');
    expect(
      shortcutWords({
        accelerator: 'Control+Q',
        registered: false,
        message: 'Another app already uses Ctrl+Q.',
        activeAccelerator: 'Control+Alt+H',
      }),
    ).toEqual({ text: 'Another app already uses Ctrl+Q. Ctrl+Alt+H still works.', tone: 'problem' });
    expect(shortcutWords(undefined).tone).toBe('unknown');
  });
});

describe('settings commands', () => {
  it('sends one-field patches in the settings.update shape', () => {
    expect(toastCommand('stuck', false)).toEqual({ type: 'settings.update', patch: { toasts: { stuck: false } } });
    expect(detectorCommand('loopRepeat', 7)).toEqual({
      type: 'settings.update',
      patch: { detectors: { loopRepeat: 7 } },
    });
    expect(questionHoldCommand(0)).toEqual({ type: 'settings.update', patch: { questionHoldSeconds: 0 } });
    expect(shortcutCommand(' Control+Alt+J ')).toEqual({
      type: 'settings.update',
      patch: { globalShortcut: 'Control+Alt+J' },
    });
  });

  it('refuses numbers out of range or not whole, and shortcuts with spaces', () => {
    const stuck = DETECTOR_FIELDS[0];
    if (!stuck) throw new Error('fields');
    expect(parseWhole('5', stuck)).toEqual({ value: 5 });
    expect(parseWhole('0', stuck)).toEqual({ error: 'Enter a whole number from 1 to 240.' });
    expect(parseWhole('2.5', stuck)).toHaveProperty('error');
    expect(parseWhole('', stuck)).toHaveProperty('error');
    expect(parseWhole('590', QUESTION_HOLD_FIELD)).toEqual({ value: 590 });
    expect(parseWhole('591', QUESTION_HOLD_FIELD)).toHaveProperty('error');
    expect(shortcutCommand('Control Alt H')).toHaveProperty('error');
  });
});
