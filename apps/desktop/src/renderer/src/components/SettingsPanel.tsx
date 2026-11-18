/**
 * Settings (M3): which toasts show (F14), detector thresholds (F21), how long a question waits in Huddle (F11) and
 * the global shortcut (F15). Values come from `HuddleState.settings` (defaults when absent); every change sends one
 * `settings.update` patch. Main validates each patch; a refusal is shown under the field it came from.
 */
import { useEffect, useState } from 'react';
import type { CommandResult, HuddleCommand, HuddleState } from '@huddle/shared';
import {
  currentSettings,
  DETECTOR_FIELDS,
  detectorCommand,
  parseWhole,
  APPLY_TO_ATTACHED_WORDS,
  askLeadOnIdle,
  askLeadOnIdleCommand,
  TEAM_SETTINGS_WORDS,
  applyToAttachedCommand,
  applyToAttachedControl,
  QUESTION_HOLD_FIELD,
  questionHoldCommand,
  shortcutCommand,
  shortcutWords,
  START_WITH_WINDOWS_WORDS,
  startWithWindowsCommand,
  startWithWindowsControl,
  TOAST_FIELDS,
  toastCommand,
  type NumberField,
} from '../view/settings.js';
import { RULE_WORDS } from '../view/rules.js';
import type { QueryFn } from '../query.js';
import { ASK_SETTINGS_WORDS, HISTORY_SETTINGS_WORDS } from '../view/remember-settings.js';
import { AskSettings, HistorySettings, type HistorySettingsInitial } from './HistorySettings.js';
import { PhoneSettings, type PhoneSettingsProps } from './PhoneSettings.js';
import { PHONE_SETTINGS_WORDS } from '../view/phone.js';
import { SelfReportSettings, type SelfReportSettingsProps } from './SelfReportSettings.js';
import { Section } from './Meters.js';
import { ViewModeSwitch } from '../viewMode.js';
import { SELF_REPORT_WORDS } from '../view/self-report.js';

/** The Ask the Huddle section's element id. */
export const ASK_SECTION_ID = 'settings-ask';
/** The Phone access section's element id (M6, F26). */
export const PHONE_SECTION_ID = 'settings-phone';
/** The Self-reported progress section's element id (M6, F27). */
export const SELF_REPORT_SECTION_ID = 'settings-self-report';
/** The Agent teams section's element id. */
export const TEAMS_SECTION_ID = 'settings-teams';

export interface SettingsPanelProps {
  state: HuddleState;
  onCommand: (cmd: HuddleCommand) => Promise<CommandResult>;
  /** The read-only bridge query (M5: history stats, retention preview); null in tests and older builds. */
  query?: QueryFn | null;
  /** Clock for the stats line ("oldest 15 Oct" vs "15 Oct 2025"); tests pass a fixed one. */
  now?: number;
  /** Starting state of the History section (tests). */
  historyInitial?: HistorySettingsInitial;
  /** Starting state of the Phone access section (tests). */
  phoneInitial?: PhoneSettingsProps['initial'];
  /** Starting state of the Self-reported progress section (tests). */
  selfReportInitial?: SelfReportSettingsProps['initial'];
  /** Open scrolled to this section with its first control focused (Ask's "Turn on in Settings"). Changes nothing. */
  initialSection?: 'ask';
}

function NumberRow({
  field,
  value,
  onSave,
}: {
  field: NumberField<string>;
  value: number;
  onSave: (value: number) => Promise<CommandResult>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = `setting-${field.key}`;
  const commit = () => {
    if (draft === null) return;
    const parsed = parseWhole(draft, field);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    if (parsed.value === value) {
      setDraft(null);
      setError(null);
      return;
    }
    void onSave(parsed.value).then((r) => {
      if (r.ok) {
        setDraft(null);
        setError(null);
      } else setError(r.message);
    });
  };
  return (
    <div className="setting-row">
      <label htmlFor={id} className="setting-label">
        {field.label}
      </label>
      <span className="setting-value">
        <input
          id={id}
          className="text-input number-input"
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          step={1}
          value={draft ?? String(value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft(null);
              setError(null);
            }
          }}
        />
        <span className="setting-unit">{field.unit}</span>
      </span>
      {error && (
        <p className="inline-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsPanel({
  state,
  onCommand,
  query = null,
  now: nowProp,
  historyInitial,
  phoneInitial,
  selfReportInitial,
  initialSection,
}: SettingsPanelProps) {
  const now = nowProp ?? Date.now();
  useEffect(() => {
    if (initialSection !== 'ask') return;
    document.getElementById(ASK_SECTION_ID)?.scrollIntoView({ block: 'start' });
    // Focus only: the switch stays as it is until the user changes it.
    document.getElementById('ask-enabled')?.focus({ preventScroll: true });
  }, [initialSection]);
  const settings = currentSettings(state);
  const [toastError, setToastError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const askLead = askLeadOnIdle(state.settings);
  const status = shortcutWords(state.shortcut);
  const login = startWithWindowsControl(state.settings);
  const attachedControl = applyToAttachedControl(settings.policy.applyToAttached);

  const saveShortcut = () => {
    if (shortcutDraft === null) return;
    const cmd = shortcutCommand(shortcutDraft);
    if ('error' in cmd) {
      setShortcutError(cmd.error);
      return;
    }
    void onCommand(cmd).then((r) => {
      if (r.ok) {
        setShortcutDraft(null);
        setShortcutError(null);
      } else setShortcutError(r.message);
    });
  };

  return (
    <article className="detail settings" aria-label="Settings">
      <header className="detail-head">
        <div className="name-block">
          <h1 className="visually-hidden">Settings</h1>
        </div>
        {state.settings === undefined && (
          <p className="muted">Showing the defaults: Huddle hasn't sent its settings.</p>
        )}
      </header>
      <div className="panel">
        <Section className="settings-section" title="View" note="how much detail the main window shows">
          <ViewModeSwitch />
          <p className="form-note">
            Simple: plain names, bars instead of token tables, the main timeline filters. Advanced: every detail,
            including model ids and Claude Code terms. Also in the palette (Ctrl+K).
          </p>
        </Section>
        <Section className="settings-section" title="Notifications" note="A Windows toast when…">
          <ul className="switches">
            {TOAST_FIELDS.map((f) => {
              const id = `toast-${f.key}`;
              return (
                <li key={f.key} className="switch-row">
                  <input
                    id={id}
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={settings.toasts[f.key] !== false}
                    onChange={(e) => {
                      setToastError(null);
                      void onCommand(toastCommand(f.key, e.target.checked)).then((r) => {
                        if (!r.ok) setToastError(r.message);
                      });
                    }}
                  />
                  <label htmlFor={id}>{f.label}</label>
                </li>
              );
            })}
          </ul>
          {toastError && (
            <p className="inline-error" role="alert">
              {toastError}
            </p>
          )}
        </Section>

        <Section
          className="settings-section"
          title="Warnings"
          note="when an agent counts as stuck, looping or in a file conflict"
        >
          {DETECTOR_FIELDS.map((f) => (
            <NumberRow
              key={f.key}
              field={f}
              value={settings.detectors[f.key]}
              onSave={(v) => onCommand(detectorCommand(f.key, v))}
            />
          ))}
        </Section>

        <Section className="settings-section" title="Questions">
          <NumberRow
            field={QUESTION_HOLD_FIELD}
            value={settings.questionHoldSeconds}
            onSave={(v) => onCommand(questionHoldCommand(v))}
          />
          <p className="setting-help">
            Then Huddle steps aside and Claude Code shows its own question box in the terminal. 0 sends questions
            straight to the terminal.
          </p>
        </Section>

        <Section className="settings-section" title="Rules" note="answer approvals for you">
          <ul className="switches">
            <li className="switch-row">
              <input
                id="policy-applyToAttached"
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings.policy.applyToAttached}
                disabled={!attachedControl.enabled}
                title={attachedControl.reason}
                aria-describedby="policy-applyToAttached-help"
                onChange={(e) => {
                  // Only ever off (see applyToAttachedControl): the switch is disabled while it is off.
                  if (e.target.checked) return;
                  setPolicyError(null);
                  void onCommand(applyToAttachedCommand(false)).then((r) => {
                    if (!r.ok) setPolicyError(r.message);
                  });
                }}
              />
              <label htmlFor="policy-applyToAttached" title={attachedControl.reason}>
                {APPLY_TO_ATTACHED_WORDS.label}
              </label>
            </li>
          </ul>
          <p id="policy-applyToAttached-help" className="setting-help">
            {attachedControl.reason}
          </p>
          <p className="setting-help">{RULE_WORDS.huddleClosed}</p>
          {policyError && (
            <p className="inline-error" role="alert">
              {policyError}
            </p>
          )}
        </Section>

        <Section
          className="settings-section"
          title={SELF_REPORT_WORDS.section}
          note={SELF_REPORT_WORDS.note}
          id={SELF_REPORT_SECTION_ID}
        >
          <SelfReportSettings
            state={state}
            onCommand={onCommand}
            query={query}
            {...(selfReportInitial ? { initial: selfReportInitial } : {})}
          />
        </Section>

        <Section className="settings-section" title={TEAM_SETTINGS_WORDS.section} id={TEAMS_SECTION_ID}>
          <ul className="switches">
            <li className="switch-row">
              <input
                id="teams-ask-lead"
                type="checkbox"
                role="switch"
                className="switch"
                checked={askLead}
                aria-describedby="teams-ask-lead-what teams-ask-lead-where"
                onChange={(e) => {
                  setTeamsError(null);
                  void onCommand(askLeadOnIdleCommand(e.target.checked)).then((r) => {
                    if (!r.ok) setTeamsError(r.message);
                  });
                }}
              />
              <label htmlFor="teams-ask-lead">{TEAM_SETTINGS_WORDS.label}</label>
            </li>
          </ul>
          <p id="teams-ask-lead-what" className="setting-help">
            {TEAM_SETTINGS_WORDS.what}
          </p>
          <p id="teams-ask-lead-where" className="setting-help">
            {TEAM_SETTINGS_WORDS.where}
          </p>
          {teamsError && (
            <p className="inline-error" role="alert">
              {teamsError}
            </p>
          )}
        </Section>

        <Section className="settings-section" title={HISTORY_SETTINGS_WORDS.section} note={HISTORY_SETTINGS_WORDS.note}>
          <HistorySettings
            retentionDays={settings.history.retentionDays}
            onCommand={onCommand}
            query={query}
            now={now}
            {...(historyInitial ? { initial: historyInitial } : {})}
          />
        </Section>

        <Section
          className="settings-section"
          title={ASK_SETTINGS_WORDS.section}
          note={ASK_SETTINGS_WORDS.note}
          id={ASK_SECTION_ID}
        >
          <AskSettings enabled={settings.ask.enabled} onCommand={onCommand} />
        </Section>

        <Section
          className="settings-section"
          title={PHONE_SETTINGS_WORDS.section}
          note={PHONE_SETTINGS_WORDS.note}
          id={PHONE_SECTION_ID}
        >
          <PhoneSettings
            state={state}
            onCommand={onCommand}
            query={query}
            {...(nowProp !== undefined ? { now: nowProp } : {})}
            {...(phoneInitial ? { initial: phoneInitial } : {})}
          />
        </Section>

        <Section className="settings-section" title="Shortcut" note="Works from any app">
          <div className="setting-row">
            <label htmlFor="setting-shortcut" className="setting-label">
              Show or hide the widget
            </label>
            <span className="setting-value">
              <input
                id="setting-shortcut"
                className="text-input code shortcut-input"
                value={shortcutDraft ?? settings.globalShortcut}
                spellCheck={false}
                aria-describedby="setting-shortcut-status"
                onChange={(e) => {
                  setShortcutDraft(e.target.value);
                  setShortcutError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveShortcut();
                  }
                }}
              />
              <button
                type="button"
                className="control control-plain"
                aria-disabled={shortcutDraft === null ? true : undefined}
                title={shortcutDraft === null ? 'Change the keys first.' : undefined}
                onClick={saveShortcut}
              >
                Save
              </button>
            </span>
          </div>
          <p id="setting-shortcut-status" className={`setting-help shortcut-${status.tone}`} role="status">
            {status.text}
          </p>
          {shortcutError && (
            <p className="inline-error" role="alert">
              {shortcutError}
            </p>
          )}
        </Section>

        <Section className="settings-section" title={START_WITH_WINDOWS_WORDS.section}>
          <ul className="switches">
            <li className="switch-row">
              <input
                id="start-with-windows"
                type="checkbox"
                role="switch"
                className="switch"
                checked={login.on}
                disabled={!login.enabled}
                title={login.reason}
                aria-describedby="start-with-windows-help"
                onChange={(e) => {
                  setLoginError(null);
                  void onCommand(startWithWindowsCommand(e.target.checked)).then((r) => {
                    if (!r.ok) setLoginError(r.message);
                  });
                }}
              />
              <label htmlFor="start-with-windows" title={login.reason}>
                {START_WITH_WINDOWS_WORDS.label}
              </label>
            </li>
          </ul>
          <p id="start-with-windows-help" className="setting-help">
            {login.reason ?? START_WITH_WINDOWS_WORDS.help}
          </p>
          {loginError && (
            <p className="inline-error" role="alert">
              {loginError}
            </p>
          )}
          <h3 className="phone-devices-title">{START_WITH_WINDOWS_WORDS.uninstallTitle}</h3>
          <p className="setting-help">{START_WITH_WINDOWS_WORDS.uninstall}</p>
        </Section>
      </div>
    </article>
  );
}
