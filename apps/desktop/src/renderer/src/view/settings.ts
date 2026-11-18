/**
 * The settings panel (M3: F14 toasts, F21 detector thresholds, F11 question hold, F15 shortcut) as fields, words
 * and `settings.update` patches. Pure. The ranges here are hints for the inputs; Electron main validates every patch
 * with core's schema and refuses one out of range (they mirror `runtime/huddle-settings.ts`).
 */
import {
  DEFAULT_TEAM_SETTINGS,
  DEFAULT_USER_SETTINGS,
  type DetectorSettings,
  type HuddleCommand,
  type HuddleState,
  type ShortcutStatus,
  type ToastSettings,
  type UserSettings,
} from '@huddle/shared';

export function currentSettings(state: HuddleState | null): UserSettings {
  return state?.settings ?? DEFAULT_USER_SETTINGS;
}

export const TOAST_FIELDS: readonly { key: keyof ToastSettings; label: string }[] = [
  { key: 'approval', label: 'An agent needs approval' },
  { key: 'question', label: 'An agent asked a question' },
  { key: 'stuck', label: 'An agent looks stuck' },
  { key: 'loop', label: 'An agent may be in a loop' },
  { key: 'conflict', label: 'Two agents edited the same file' },
  { key: 'doneOrError', label: 'An agent finished or failed' },
  { key: 'budget', label: 'A budget is nearly or fully used' },
  { key: 'roleDrift', label: 'A reviewer or researcher started editing files' },
];

export interface NumberField<K extends string> {
  key: K;
  label: string;
  unit: string;
  min: number;
  max: number;
}

export const DETECTOR_FIELDS: readonly NumberField<keyof DetectorSettings>[] = [
  { key: 'stuckMinutes', label: 'Stuck after no activity for', unit: 'min', min: 1, max: 240 },
  { key: 'stuckOpenToolMinutes', label: 'Stuck while a tool is running after', unit: 'min', min: 1, max: 1440 },
  { key: 'loopRepeat', label: 'Loop: the same tool call in a row', unit: 'times', min: 2, max: 100 },
  { key: 'loopFailures', label: 'Loop: failed tool calls in a row', unit: 'times', min: 2, max: 100 },
  {
    key: 'conflictWindowMinutes',
    label: 'File conflict: two agents edit a file within',
    unit: 'min',
    min: 1,
    max: 1440,
  },
];

export const QUESTION_HOLD_FIELD: NumberField<'questionHoldSeconds'> = {
  key: 'questionHoldSeconds',
  label: 'Hold a question in Huddle for',
  unit: 's',
  min: 0,
  max: 590,
};

/** A whole number in range, or the words that say what is wrong. */
export function parseWhole(raw: string, field: NumberField<string>): { value: number } | { error: string } {
  const text = raw.trim();
  const range = `${String(field.min)} to ${String(field.max)}`;
  if (!/^\d+$/.test(text)) return { error: `Enter a whole number from ${range}.` };
  const value = Number(text);
  if (value < field.min || value > field.max) return { error: `Enter a whole number from ${range}.` };
  return { value };
}

export function toastCommand(key: keyof ToastSettings, on: boolean): HuddleCommand {
  return { type: 'settings.update', patch: { toasts: { [key]: on } } };
}

export function detectorCommand(key: keyof DetectorSettings, value: number): HuddleCommand {
  return { type: 'settings.update', patch: { detectors: { [key]: value } } };
}

/** M4 (F18, ADR-020 §3): apply approval rules to attached sessions too. */
export function applyToAttachedCommand(on: boolean): HuddleCommand {
  return { type: 'settings.update', patch: { policy: { applyToAttached: on } } };
}

export const APPLY_TO_ATTACHED_WORDS = {
  label: 'Apply rules to sessions you started in a terminal too',
  disabledReason:
    'Waits on spike S15 (a late Allow after a terminal No). Until then rules apply only to sessions the Huddle launched.',
  turnOffOnly: 'On from an earlier setting. You can turn it off; it cannot be turned back on until spike S15 is run.',
} as const;

/**
 * Owner decision (M4): rules stay off for attached sessions until spike S15 is run, so the switch is off with the
 * reason. A settings file that already has it on can still be switched off (never stranded on).
 */
export function applyToAttachedControl(on: boolean): { enabled: boolean; reason: string } {
  return on
    ? { enabled: true, reason: APPLY_TO_ATTACHED_WORDS.turnOffOnly }
    : { enabled: false, reason: APPLY_TO_ATTACHED_WORDS.disabledReason };
}

export const START_WITH_WINDOWS_WORDS = {
  section: 'Windows',
  label: 'Start Agent Huddle when Windows starts',
  help: 'Off by default. When on, Agent Huddle starts in the tray with the widget after you sign in.',
  unavailable: 'Only in the installed app. This copy runs from the source folder, so Windows cannot start it.',
  uninstallTitle: 'Before you uninstall',
  uninstall:
    'Quit Agent Huddle from the tray first: quitting removes its Claude Code hooks. To also remove the telemetry settings and the status line bridge it added, its self-report MCP server for terminal sessions and your remembered consent, run "Agent Huddle.exe" --remove-hooks from the install folder. The uninstaller does not change your Claude Code settings.',
} as const;

/**
 * P6: the login item switch. Main fills `settings.startWithWindows` only in the installed Windows app (read from
 * Windows each time); absent means the switch cannot work here, so it is disabled with the reason.
 */
export function startWithWindowsControl(settings: UserSettings | undefined): {
  on: boolean;
  enabled: boolean;
  reason: string | undefined;
} {
  const value = settings?.startWithWindows;
  return value === undefined
    ? { on: false, enabled: false, reason: START_WITH_WINDOWS_WORDS.unavailable }
    : { on: value, enabled: true, reason: undefined };
}

export function startWithWindowsCommand(on: boolean): HuddleCommand {
  return { type: 'settings.update', patch: { startWithWindows: on } };
}

export function questionHoldCommand(seconds: number): HuddleCommand {
  return { type: 'settings.update', patch: { questionHoldSeconds: seconds } };
}

/** An accelerator as main accepts it: printable ASCII, no spaces (Electron checks the rest). */
export function shortcutCommand(raw: string): HuddleCommand | { error: string } {
  const accelerator = raw.trim();
  if (!/^[\x21-\x7E]{1,100}$/.test(accelerator)) {
    return { error: 'Use keys joined by +, for example Control+Alt+H.' };
  }
  return { type: 'settings.update', patch: { globalShortcut: accelerator } };
}

/** "Control+Alt+H" as Windows writes it: "Ctrl+Alt+H". */
export function shortcutLabel(accelerator: string): string {
  return accelerator.replace(/\b(Control|CommandOrControl|CmdOrCtrl)\b/g, 'Ctrl');
}

export interface ShortcutWords {
  text: string;
  tone: 'ok' | 'problem' | 'unknown';
}

/** The line under the shortcut field, from `HuddleState.shortcut`. */
export function shortcutWords(status: ShortcutStatus | undefined): ShortcutWords {
  if (status === undefined) return { text: "Huddle hasn't set up the shortcut yet.", tone: 'unknown' };
  if (status.registered) return { text: `${shortcutLabel(status.accelerator)} shows or hides the widget.`, tone: 'ok' };
  const base = status.message ?? `${shortcutLabel(status.accelerator)} couldn't be set up.`;
  const kept =
    status.activeAccelerator !== undefined
      ? ` ${shortcutLabel(status.activeAccelerator)} still works.`
      : ' No shortcut works right now.';
  return { text: `${base}${kept}`, tone: 'problem' };
}

/** Settings, Agent teams (M6 P5b, ADR-027; owner decision 2026-11-16). */
export const TEAM_SETTINGS_WORDS = {
  section: 'Agent teams',
  label: 'Ask the lead about idle teammates',
  what: 'When a teammate goes idle, Agent Huddle sends its lead one message, labelled "Automatic check by Agent Huddle", asking whether that teammate is finished or waiting for a result; the lead answers with the report_teammate tool, and a finished teammate then counts as done.',
  where:
    'It works only where the progress server is registered, in practice terminal sessions you registered under Self-reported progress; each check may cost a few tokens and may wake a stopped lead for one turn.',
} as const;

/** `teams.askLeadOnIdle`; an older core or the canned dev core sends no `teams`: the default (on). */
export function askLeadOnIdle(settings: UserSettings | undefined): boolean {
  return settings?.teams?.askLeadOnIdle ?? DEFAULT_TEAM_SETTINGS.askLeadOnIdle;
}

export function askLeadOnIdleCommand(on: boolean): HuddleCommand {
  return { type: 'settings.update', patch: { teams: { askLeadOnIdle: on } } };
}
