/**
 * How this process was started (M6 P6). Pure, so the rules are testable without Electron.
 *
 *  - `app`: the normal Huddle (tray, widget, core).
 *  - `remove-hooks`: `"Agent Huddle.exe" --remove-hooks`. The full clean-up (remove-hooks.ts): the remembered consent, the
 *    self-report MCP registration when it is ours, and everything the Huddle added to Claude Code's
 *    settings.json (hooks, telemetry env vars, the status line bridge) through the core's own installer, shows the
 *    result in a message box and exits. No window, no core, no listener. The packaged answer to the M1 carry-over
 *    "a packaged remove-hooks command": the forwarder's "Huddle not running" hint names it, and the uninstaller asks
 *    the user to run it first (the uninstaller itself never touches ~/.claude).
 *  - `self-check`: `--huddle-self-check=<absolute path>.json` (spike S23). Writes one JSON report about the build
 *    (versions, node:sqlite, where the shipped files are, what PATH lookups find) and exits. Starts no core, opens no
 *    window, writes nothing else; Claude Code's folder is only read (file existence).
 *    The report may only be a NEW file inside the OS temp folder (security review, M6): the path must lie under
 *    `os.tmpdir()` (checked here as written, and again in `selfCheckTargetProblem` with links resolved), must not
 *    be named `.claude.json` or lie in Claude Code's config folder, and is opened with `wx` so an existing file is
 *    never overwritten. Without this, any shortcut or script could make the app overwrite any .json the user can
 *    write, Claude Code's settings.json included. The S23 harness writes into a fresh temp folder, which passes.
 *
 * The two switches are only recognised as whole arguments, and a second launch that carries one is not treated as
 * "show the main window" by the running instance.
 */
import os from 'node:os';
import path from 'node:path';

export const REMOVE_HOOKS_FLAG = '--remove-hooks';
export const SELF_CHECK_FLAG = '--huddle-self-check';

export type LaunchMode =
  | { kind: 'app' }
  | { kind: 'remove-hooks' }
  | { kind: 'self-check'; out: string }
  | {
      kind: 'invalid';
      reason: string;
    };

/** True when `child` is strictly inside `parent` (case-insensitive on Windows, like the file system). */
export function isInsideFolder(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Why this self-check report path is refused, judged on the path as written; null when it is allowed. Pure. */
export function selfCheckPathProblem(out: string, tmpDir: string): string | null {
  if (out === '' || !path.isAbsolute(out) || path.extname(out).toLowerCase() !== '.json') {
    return `${SELF_CHECK_FLAG} needs =<absolute path ending in .json>`;
  }
  if (path.basename(out).toLowerCase() === '.claude.json') {
    return `${SELF_CHECK_FLAG} will not write a file named .claude.json`;
  }
  if (!isInsideFolder(tmpDir, path.normalize(out))) {
    return `${SELF_CHECK_FLAG} writes only inside the temp folder (${tmpDir})`;
  }
  return null;
}

/**
 * The same rule with links resolved, plus Claude Code's config folder, just before the write (index.ts). The report's
 * folder must exist; a junction or symlink in the temp folder that leads elsewhere is refused. `realpath` is injected.
 */
export async function selfCheckTargetProblem(
  out: string,
  opts: { tmpDir: string; claudeConfigDir: string; realpath: (p: string) => Promise<string> },
): Promise<string | null> {
  const lexical = selfCheckPathProblem(out, opts.tmpDir);
  if (lexical !== null) return lexical;
  let dir: string;
  let tmp: string;
  let claude: string | null;
  try {
    dir = await opts.realpath(path.dirname(out));
    tmp = await opts.realpath(opts.tmpDir);
  } catch {
    return `${SELF_CHECK_FLAG}: the report's folder must already exist`;
  }
  try {
    claude = await opts.realpath(opts.claudeConfigDir);
  } catch {
    claude = null; // no Claude Code folder: nothing to protect there
  }
  const target = path.join(dir, path.basename(out));
  if (!isInsideFolder(tmp, target)) return `${SELF_CHECK_FLAG} writes only inside the temp folder (${opts.tmpDir})`;
  for (const folder of [opts.claudeConfigDir, claude]) {
    if (folder !== null && (isInsideFolder(folder, target) || isInsideFolder(folder, out))) {
      return `${SELF_CHECK_FLAG} will not write into Claude Code's folder`;
    }
  }
  return null;
}

/** `tmpDir` defaults to `os.tmpdir()`; tests pass their own. */
export function parseLaunchMode(argv: readonly string[], tmpDir: string = os.tmpdir()): LaunchMode {
  // argv[0] is the exe (and, unpackaged, argv[1] is the app folder); Chromium switches can come in any order.
  const args = argv.slice(1);
  if (args.includes(REMOVE_HOOKS_FLAG)) return { kind: 'remove-hooks' };
  const check = args.find((a) => a === SELF_CHECK_FLAG || a.startsWith(`${SELF_CHECK_FLAG}=`));
  if (check !== undefined) {
    const out = check.slice(SELF_CHECK_FLAG.length + 1);
    const problem = selfCheckPathProblem(out, tmpDir);
    if (problem !== null) return { kind: 'invalid', reason: problem };
    return { kind: 'self-check', out: path.normalize(out) };
  }
  return { kind: 'app' };
}

/** A second launch with one of the tool switches must not open the main window of the running Huddle. */
export function isToolLaunch(argv: readonly string[]): boolean {
  return parseLaunchMode(argv).kind !== 'app';
}
