/**
 * The canned dev core's answers for Settings → Self-reported progress (F27, `HUDDLE_DEV_CANNED=1`): a sample
 * register/unregister preview and a pretend registration that only flips a flag in memory, so the whole flow can be
 * looked at in the dev app. Nothing runs and nothing is written: no `claude`, no `.claude.json`.
 */
import type {
  CommandResult,
  HuddleCommand,
  SelfReportRegistrationMode,
  SelfReportRegistrationPreview,
} from '@huddle/shared';

const CLAUDE_JSON = 'C:\\Users\\sample\\.claude.json';
const SCRIPT = 'C:\\Users\\sample\\.claude\\agent-huddle\\huddle-mcp.mjs';
const SAMPLE_NOTE = 'sample data: nothing runs and nothing is written';

export interface CannedSelfReport {
  preview: (mode: SelfReportRegistrationMode) => SelfReportRegistrationPreview;
  /** The answer to a `setup.selfReport.*` command, or null for any other command. */
  command: (cmd: HuddleCommand) => CommandResult | null;
}

export function createCannedSelfReport(): CannedSelfReport {
  let registered = false;
  const preview = (mode: SelfReportRegistrationMode): SelfReportRegistrationPreview => {
    const changed = mode === 'register' ? !registered : registered;
    const entry = [
      '  "huddle": {',
      '    "type": "stdio",',
      '    "command": "C:\\\\Program Files\\\\nodejs\\\\node.exe",',
      `    "args": ["${SCRIPT.replace(/\\/g, '\\\\')}"]`,
      '  }',
    ];
    const sign = mode === 'register' ? '+' : '-';
    const diffLines = changed ? ['  "mcpServers": {', ...entry.map((l) => `${sign} ${l}`), '  }'] : [];
    return {
      mode,
      state: registered ? 'ours' : 'absent',
      claudeJsonPath: CLAUDE_JSON,
      serverScriptPath: SCRIPT,
      commands: !changed
        ? []
        : mode === 'register'
          ? [`claude mcp add --scope user huddle -- "C:\\Program Files\\nodejs\\node.exe" ${SCRIPT}`]
          : ['claude mcp remove --scope user huddle'],
      diff: diffLines.map((l) => ({ op: l.startsWith('+') ? '+' : l.startsWith('-') ? '-' : ' ', text: l.slice(2) })),
      diffText: diffLines.join('\n'),
      notes: changed
        ? mode === 'register'
          ? [
              `copy the self-report server to ${SCRIPT}`,
              `run the command above; Claude Code adds the "huddle" server to ${CLAUDE_JSON}`,
              'attached sessions do not get the prompt line that asks for reports, so their agents report less often than runs the Huddle launches',
              'the first call in a session may ask for permission (mcp__huddle__report_progress), in the terminal or in the Huddle inbox',
              SAMPLE_NOTE,
            ]
          : [
              `run the command above; Claude Code removes the "huddle" server from ${CLAUDE_JSON}`,
              `remove ${SCRIPT}`,
              SAMPLE_NOTE,
            ]
        : [mode === 'register' ? 'already registered: nothing to do' : 'not registered: nothing to do'],
      refusal: null,
      changed,
      fingerprint: (registered ? 'b' : 'a').repeat(64),
    };
  };
  return {
    preview,
    command(cmd) {
      if (cmd.type !== 'setup.selfReport.register' && cmd.type !== 'setup.selfReport.unregister') return null;
      const mode = cmd.type === 'setup.selfReport.register' ? 'register' : 'unregister';
      if (cmd.fingerprint !== preview(mode).fingerprint) {
        return {
          ok: false,
          code: 'expired',
          message: 'What is registered changed since the preview. Look at the new preview and try again.',
        };
      }
      registered = mode === 'register';
      return { ok: true };
    },
  };
}
