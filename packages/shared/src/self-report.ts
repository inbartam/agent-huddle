/**
 * Self-reported progress (M6, F27, ADR-025): what the UI shows before the opt-in registration of the Huddle's MCP
 * server for attached sessions, and what it sends back. Types only (ADR-016: the renderer may import them).
 *
 * Flow (like the first-run hook consent, ADR-014/017): the Settings screen asks `setup.selfReportPreview` (read-only:
 * reads `.claude.json` and PATH, runs nothing, writes nothing), shows `commands` (the exact command lines) and `diffText`
 * (the one key of `.claude.json` that changes), and on the user's Yes sends `setup.selfReport.register` or
 * `setup.selfReport.unregister` with the preview's `fingerprint`. The core prepares again and runs only when the
 * fingerprint is the same; otherwise it answers `expired` and the screen shows the new preview.
 */

export type SelfReportRegistrationMode = 'register' | 'unregister';

/**
 * absent:     no user-scope `huddle` MCP server
 * ours:       the Huddle's server is registered (the one the registration step writes)
 * foreign:    a `huddle` server that is not the Huddle's: never replaced or removed
 * unreadable: `.claude.json` exists but is not valid JSON: nothing runs
 */
export type SelfReportRegistrationState = 'absent' | 'ours' | 'foreign' | 'unreadable';

export interface SelfReportDiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

export interface SelfReportRegistrationPreview {
  mode: SelfReportRegistrationMode;
  state: SelfReportRegistrationState;
  /** The file Claude Code keeps user-scope MCP servers in (`~/.claude.json`, or under CLAUDE_CONFIG_DIR). */
  claudeJsonPath: string;
  /** Where the server script is copied (register) or removed from (unregister): `<config dir>/agent-huddle/`. */
  serverScriptPath: string;
  /** The exact command lines that will run, in order, as the user would type them. Empty: nothing to run. */
  commands: string[];
  /** The `mcpServers.huddle` key of `.claude.json` before and after, as unified-style lines. */
  diff: SelfReportDiffLine[];
  diffText: string;
  /** What else happens, in the UI's words (the script copy, its removal, what attached sessions will and will not get). */
  notes: string[];
  /** Why it cannot be done now (a foreign `huddle` server, claude or node not found, an unreadable file); else null. */
  refusal: string | null;
  /** False when there is nothing to do (already registered, or nothing to remove). */
  changed: boolean;
  /** Send this back with the command: it names exactly this change. */
  fingerprint: string;
}
