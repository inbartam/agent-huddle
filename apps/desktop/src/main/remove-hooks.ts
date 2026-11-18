/**
 * `"Agent Huddle.exe" --remove-hooks` (M6 P6, launch-mode.ts): the packaged full clean-up (owner decision 2026-11-16,
 * after P6). It undoes everything Agent Huddle set up for Claude Code, each step through the code path the app itself
 * uses, so nothing here re-implements it:
 *
 *  1. Forget the remembered consent in the app data folder (`forgetConsent`, the same change as withdrawing consent,
 *     `withoutConsent`). First, as in the app: a crash halfway never attaches by itself on the next start, which asks
 *     again.
 *  2. Remove the hooks, the telemetry env vars and the status line bridge from settings.json through the core's own
 *     installer (`HookInstaller.uninstall`): only the Huddle's entries, a backup first, the file re-read right before the
 *     write (install-hooks.ts `apply`).
 *  3. Remove the self-report MCP server for terminal sessions (ADR-025) through `McpRegistrar.removeIfOurs`, which runs
 *     `claude mcp remove --scope user huddle` only when the registered `huddle` server is the Huddle's. `.claude.json` is
 *     never written here; a foreign `huddle` server is left and named in the result.
 *
 * The user asked for it by running the command, so it passes the installer's consent. It refuses while Agent Huddle is
 * running (the running app would attach again, and its settings writes are not queued with this one).
 */
import type { ApplyResult, Consent, McpApplyResult, UninstallOptions } from '@huddle/core';

export interface RemoveHooksInstaller {
  readonly settingsPath: string;
  uninstall(options: UninstallOptions, consent: Consent): Promise<ApplyResult>;
}

export interface RemoveHooksRegistrar {
  readonly claudeJsonPath: string;
  removeIfOurs(): Promise<McpApplyResult>;
}

export interface RemoveHooksDeps {
  installer: RemoveHooksInstaller;
  registrar: RemoveHooksRegistrar;
  /** `forgetConsent(<app data folder>)` from the core. */
  forgetConsent: () => Promise<{ forgotten: boolean; path: string }>;
}

export interface RemoveHooksResult {
  ok: boolean;
  title: string;
  lines: string[];
}

/** Everything the Huddle added to settings.json, including what a normal quit leaves (ADR-014, ADR-018). */
export const FULL_REMOVAL: UninstallOptions = { removeTelemetry: true, restoreStatusLine: true };

export const REMOVE_HOOKS_WORDS = {
  running:
    'Agent Huddle is running. Quit it from the tray first (right-click the tray icon, Quit), then run this again.',
  removedTitle: 'Agent Huddle removed from Claude Code',
  nothingTitle: 'Nothing to remove',
  partialTitle: 'Not everything was removed',
  consentForgotten:
    'Forgot your consent: the next time Agent Huddle starts, it shows the change again and asks before it adds its hooks.',
  consentNone: 'No consent was remembered.',
  mcpRemoved:
    'Removed the self-report MCP server "huddle" for terminal sessions (claude mcp remove --scope user huddle).',
  mcpNone: 'No self-report MCP server of Agent Huddle was registered.',
  mcpForeign:
    'Left: an MCP server named "huddle" that is not Agent Huddle\'s. It was not changed; remove it yourself if you want (claude mcp remove --scope user huddle).',
} as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Outcome = { removed: string[]; left: string[]; failed: boolean };

function settingsOutcome(result: ApplyResult, settingsPath: string): Outcome {
  switch (result.status) {
    case 'written':
      return {
        removed: [
          `Removed Agent Huddle's hooks, telemetry settings and status line bridge from ${result.settingsPath}.`,
          ...(result.backupPath !== null ? [`Backup of the file before the change: ${result.backupPath}`] : []),
        ],
        left: [],
        failed: false,
      };
    case 'unchanged':
      return {
        removed: [],
        left: [`${result.settingsPath} has no Agent Huddle hooks or telemetry settings.`],
        failed: false,
      };
    case 'stale':
      return {
        removed: [],
        left: [`Left: the hooks. ${settingsPath} changed while Agent Huddle read it. Run this again.`],
        failed: true,
      };
    case 'needs-consent':
      return { removed: [], left: ['Left: the hooks. Nothing was written to settings.json.'], failed: true };
    case 'error':
      return { removed: [], left: [`Left: the hooks. They could not be removed: ${result.error}`], failed: true };
  }
}

function mcpOutcome(result: McpApplyResult, claudeJsonPath: string): Outcome {
  switch (result.status) {
    case 'written':
      return { removed: [REMOVE_HOOKS_WORDS.mcpRemoved], left: [], failed: false };
    case 'unchanged':
      if (result.preview.state === 'foreign')
        return { removed: [], left: [REMOVE_HOOKS_WORDS.mcpForeign], failed: false };
      if (result.preview.state === 'unreadable')
        return {
          removed: [],
          left: [
            `Left: the self-report MCP registration could not be checked, because ${claudeJsonPath} is not valid JSON.`,
          ],
          failed: true,
        };
      return { removed: [], left: [REMOVE_HOOKS_WORDS.mcpNone], failed: false };
    case 'refused':
      return {
        removed: [],
        left: [`Left: the self-report MCP server. ${result.preview.refusal ?? 'It could not be removed.'}`],
        failed: true,
      };
    case 'stale':
    case 'needs-consent':
      return { removed: [], left: ['Left: the self-report MCP server. Run this again.'], failed: true };
    case 'error':
      return { removed: [], left: [`Left: the self-report MCP server. ${result.error}`], failed: true };
  }
}

export async function removeHooks(
  deps: RemoveHooksDeps,
  options: { alreadyRunning: boolean },
): Promise<RemoveHooksResult> {
  if (options.alreadyRunning) {
    return { ok: false, title: 'Agent Huddle is running', lines: [REMOVE_HOOKS_WORDS.running] };
  }

  // 1. The consent first (see the file comment).
  let consent: Outcome;
  try {
    const forgot = await deps.forgetConsent();
    consent = forgot.forgotten
      ? { removed: [REMOVE_HOOKS_WORDS.consentForgotten], left: [], failed: false }
      : { removed: [], left: [REMOVE_HOOKS_WORDS.consentNone], failed: false };
  } catch (error) {
    consent = {
      removed: [],
      left: [`Left: the remembered consent. It could not be cleared: ${errorText(error)}`],
      failed: true,
    };
  }

  // 2. settings.json.
  let settings: ApplyResult;
  try {
    settings = await deps.installer.uninstall(FULL_REMOVAL, { consent: true });
  } catch (error) {
    settings = { status: 'error', error: errorText(error) };
  }
  const hooks = settingsOutcome(settings, deps.installer.settingsPath);

  // 3. The self-report MCP registration, only when it is the Huddle's.
  let mcp: McpApplyResult;
  try {
    mcp = await deps.registrar.removeIfOurs();
  } catch (error) {
    mcp = { status: 'error', error: errorText(error) };
  }
  const server = mcpOutcome(mcp, deps.registrar.claudeJsonPath);

  const steps = [hooks, server, consent];
  const removed = steps.flatMap((s) => s.removed);
  const left = steps.flatMap((s) => s.left);
  const failed = steps.some((s) => s.failed);
  const title = failed
    ? REMOVE_HOOKS_WORDS.partialTitle
    : removed.length > 0
      ? REMOVE_HOOKS_WORDS.removedTitle
      : REMOVE_HOOKS_WORDS.nothingTitle;
  return { ok: !failed, title, lines: [...removed, ...left] };
}
