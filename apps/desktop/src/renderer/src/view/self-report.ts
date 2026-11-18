/**
 * Settings → Self-reported progress (M6, F27, ADR-025): words and the pure decisions behind the section. The switch is
 * the `selfReport.enabled` user setting (managed runs; on when absent). The opt-in block for attached sessions reads
 * `setup.selfReportPreview` (read-only) and sends `setup.selfReport.register|unregister` with the preview's
 * fingerprint; `expired` means the plan changed, and the screen shows the new preview (like the hook consent).
 *
 * Everything in a preview (commands, paths, the diff, notes, a refusal) comes from files on disk and the PATH: it is
 * shown as text nodes, and long parts are clipped with an expand control.
 */
import type {
  CommandResult,
  ControlState,
  HuddleCommand,
  HuddleState,
  SelfReportRegistrationMode,
  SelfReportRegistrationPreview,
} from '@huddle/shared';

export const SELF_REPORT_WORDS = {
  section: 'Self-reported progress',
  note: 'On by default',
  label: 'Let agents report their own progress in runs Huddle launches',
  help: 'Runs that Huddle launches get a small tool to report how far along they are, and their first prompt asks them to use it. The progress bar shows what they report as an estimate.',
  attachedTitle: 'Also for sessions you start in a terminal',
  /** `backticked` parts are drawn as code (InlineCodeText in Connection.tsx). */
  attachedWhat:
    'Off unless you register it. Registering runs `claude mcp add --scope user huddle …` once, which changes Claude Code’s user config (`~/.claude.json`) for every session you start yourself.',
  attachedLess:
    'Those sessions get the tool but not the prompt line that asks for reports, so they report less often. The first report in a session may ask you for permission.',
  checking: 'Checking what is registered…',
  registered: 'Registered',
  notRegistered: 'Not registered',
  blocked: 'Cannot register now',
  unknownStatus: 'Registration unknown',
  preview: 'Preview',
  previewing: 'Reading…',
  register: 'Register',
  registering: 'Registering…',
  remove: 'Remove…',
  removeConfirm: 'Remove',
  removing: 'Removing…',
  close: 'Close',
  back: 'Back',
  fileLabel: 'File',
  commandsLead: 'Huddle will run',
  noCommand: 'Nothing will run.',
  notesLabel: 'What else happens',
  refusalLabel: 'Why not',
  removeQuestion: 'Remove the Huddle’s “huddle” server from Claude Code’s user config?',
  removeAfter: 'Sessions already running keep the tool until they end.',
  nothingToRegister: 'Already registered: nothing to change.',
  nothingToRemove: 'Not registered: nothing to remove.',
  busy: 'Wait for the last step to finish.',
  expired: 'What is registered changed since that preview. This is the new one: read it and choose again.',
  registeredDone: 'Registered. Sessions you start from now on get the tool.',
  removedDone: 'Removed. Sessions you start from now on do not get the tool.',
  showAll: 'Show all',
  showLess: 'Show less',
} as const;

const W = SELF_REPORT_WORDS;

/** The global switch: on when the core sent no `selfReport` (an older core, the canned dev core). */
export function selfReportEnabled(state: HuddleState | null): boolean {
  return state?.settings?.selfReport?.enabled ?? true;
}

export function selfReportEnabledCommand(enabled: boolean): HuddleCommand {
  return { type: 'settings.update', patch: { selfReport: { enabled } } };
}

export function registrationCommand(preview: SelfReportRegistrationPreview): HuddleCommand {
  return preview.mode === 'register'
    ? { type: 'setup.selfReport.register', fingerprint: preview.fingerprint }
    : { type: 'setup.selfReport.unregister', fingerprint: preview.fingerprint };
}

export type RegistrationStatus = 'registered' | 'not_registered' | 'blocked';

/** What a preview (either mode) says about the user-scope `huddle` server right now. */
export function registrationStatus(preview: SelfReportRegistrationPreview): RegistrationStatus {
  switch (preview.state) {
    case 'ours':
      return 'registered';
    case 'absent':
      return 'not_registered';
    case 'foreign':
    case 'unreadable':
      return 'blocked';
  }
}

export const STATUS_LOOK: Record<RegistrationStatus, { glyph: string; tone: string; words: string }> = {
  registered: { glyph: '●', tone: 'tone-working', words: W.registered },
  not_registered: { glyph: '○', tone: 'tone-idle', words: W.notRegistered },
  blocked: { glyph: '▲', tone: 'tone-needs-you', words: W.blocked },
};

/**
 * The confirming button under a preview (Register, or Remove in the confirmation): off with the refusal when the core
 * refuses, off when there is nothing to change, off while a step runs.
 */
export function applyControl(preview: SelfReportRegistrationPreview, busy: boolean): ControlState {
  if (preview.refusal !== null) return { enabled: false, reason: preview.refusal };
  if (!preview.changed || preview.commands.length === 0) {
    return { enabled: false, reason: preview.mode === 'register' ? W.nothingToRegister : W.nothingToRemove };
  }
  if (busy) return { enabled: false, reason: W.busy };
  return { enabled: true, reason: null };
}

export type ApplyOutcome = { kind: 'done'; notice: string } | { kind: 'expired' } | { kind: 'error'; message: string };

/** What a register/unregister answer means for the screen. */
export function applyOutcome(mode: SelfReportRegistrationMode, r: CommandResult): ApplyOutcome {
  if (r.ok) {
    if (r.detail !== undefined && r.detail.trim() !== '') return { kind: 'done', notice: r.detail };
    return { kind: 'done', notice: mode === 'register' ? W.registeredDone : W.removedDone };
  }
  if (r.code === 'expired') return { kind: 'expired' };
  return { kind: 'error', message: r.message };
}

/** Text longer than this many characters shows its start and a Show all control. */
export const CLIP_CHARS = 400;
/** A diff longer than this many lines shows its start and a Show all control. */
export const CLIP_DIFF_LINES = 40;

export interface Clipped {
  text: string;
  clipped: boolean;
  /** "1,234 characters" / "52 lines": how much there is in all. */
  total: string;
}

export function clipChars(text: string, limit = CLIP_CHARS): Clipped {
  const total = `${text.length.toLocaleString('en-US')} characters`;
  if (text.length <= limit) return { text, clipped: false, total };
  return { text: `${text.slice(0, limit).trimEnd()}…`, clipped: true, total };
}

export function clipLines(text: string, limit = CLIP_DIFF_LINES): Clipped {
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const total = `${lines.length.toLocaleString('en-US')} lines`;
  if (lines.length <= limit) return { text, clipped: false, total };
  return { text: lines.slice(0, limit).join('\n'), clipped: true, total };
}
