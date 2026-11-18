/**
 * What main does with the operating system for the M4 and M5 screens (ADR-020):
 *  - `pick.folder`: the system folder picker for the launch dialog's folder field, parented to the asking window;
 *  - `run.openWorktree`: open a run's worktree in VS Code (`vscode://file/<path>`), or in File Explorer when no app
 *    handles `vscode:` links;
 *  - `report.openFile` / `report.copyPath` (M5, F23): open a run's Markdown report with the system, or put its path
 *    on the clipboard. The core names the file by session id; main opens only a `.md` file directly inside
 *    `<userData>/reports`, checked like a worktree (resolved, then again after following links).
 *
 * Both take a path that came through the renderer or the core, so neither trusts it: a UNC or device path is never
 * touched (stat-ing `\\host\share` would make Windows connect to that host and offer the user's credentials), a default
 * folder is used only when it is an absolute folder that exists, and a worktree opens only when it is a folder
 * directly inside the Huddle's worktrees root (`%LOCALAPPDATA%/agent-huddle/worktrees`), checked on the resolved path
 * and again after following links, case-insensitive on Windows. Electron and the file system come in through
 * `SystemDeps`, so this file is tested without Electron.
 */
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { isLocalAbsolutePath, samePath } from '@huddle/core';
import type { CommandResult, HuddleState } from '@huddle/shared';

export interface FolderDialogOptions {
  title: string;
  properties: ['openDirectory'];
  defaultPath?: string;
}

export interface SystemDeps {
  /** `<worktree data dir>/worktrees`; the only folder whose children may be opened. */
  worktreesRoot: string;
  platform: NodeJS.Platform;
  /** Electron `dialog.showOpenDialog`, parented to `owner` when there is one. */
  showOpenDialog(
    owner: BrowserWindow | null,
    options: FolderDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
  /** True for an existing folder; false for anything else, never throws. */
  isDirectory(p: string): Promise<boolean>;
  /** `fs.promises.realpath`; rejects for a path that does not exist. */
  realpath(p: string): Promise<string>;
  /** Electron `app.getApplicationNameForProtocol`: '' when no app handles the scheme. */
  protocolHandler(url: string): string;
  /** Electron `shell.openExternal`. */
  openExternal(url: string): Promise<void>;
  /** Electron `shell.openPath`: '' on success, else an error message. */
  openPath(p: string): Promise<string>;
  /** `<userData>/reports` (M5): the only folder whose files `openReport` opens. */
  reportsRoot: string;
  /** True for an existing regular file; false for anything else, never throws. */
  isFile(p: string): Promise<boolean>;
  /** Electron `clipboard.writeText`. */
  writeClipboard(text: string): Promise<void>;
}

export interface SystemActions {
  /** The chosen folder, or null when the user cancelled. */
  pickFolder: (defaultPath: string | undefined, owner: BrowserWindow | null) => Promise<string | null>;
  /** Open a worktree folder; refuses anything that is not a run folder inside the worktrees root. */
  openWorktree: (worktreePath: string) => Promise<CommandResult>;
  /** Open a run's report file with the system; refuses anything that is not a `.md` file inside the reports folder. */
  openReport: (reportPath: string) => Promise<CommandResult>;
  /** Put a report file's path on the clipboard (`{ ok: true, detail: <path> }`). */
  copyReportPath: (reportPath: string) => Promise<CommandResult>;
  /** Put already validated, clipped text (an Ask answer) on the clipboard. */
  copyText: (text: string) => Promise<CommandResult>;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * A path main may touch: the core's one checker (`isLocalAbsolutePath`, security review L3). A string, not too long,
 * no control characters, absolute, and never a UNC (`\\host\share`, `//host/share`), device (`\\?\`, `\\.\`) or NT
 * (`\??\UNC\host\…`) path; on Windows it starts with a drive (`C:\`).
 */
export function isPlainAbsolutePath(p: unknown, platform: NodeJS.Platform): p is string {
  return isLocalAbsolutePath(p, platform);
}

/**
 * `vscode://file/<path>` for a folder: forward slashes, percent-encoded (`encodeURI`, plus `#` and `?`, which
 * `encodeURI` leaves alone and which would otherwise end the path). `C:\Users\A B\x` -> `vscode://file/C:/Users/A%20B/x`.
 */
export function vscodeFileUrl(folder: string): string {
  const slashed = folder.replace(/\\/g, '/');
  const encoded = encodeURI(slashed).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `vscode://file/${encoded.replace(/^\/+/, '')}`;
}

/**
 * Pure: is `candidate` a folder directly inside `root` (one level down, not the root itself)? Both are resolved first,
 * so `..` cannot climb out; case-insensitive on Windows.
 */
export function isWorktreeFolder(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const resolved = api.resolve(candidate);
  if (samePath(resolved, api.resolve(root), platform)) return false;
  return samePath(api.dirname(resolved), root, platform);
}

/**
 * The worktree path for `run.openWorktree`. HuddleCore (WP6) answers `{ ok: true, detail: <worktree folder> }` after
 * checking its registry. A detail that is not an
 * absolute path (another host's words) falls back to the run's root in state. Whatever comes out is checked again by
 * `openWorktree` before anything opens.
 */
export function worktreePathFor(
  result: CommandResult,
  state: HuddleState,
  runId: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!result.ok) return null;
  if (isPlainAbsolutePath(result.detail, platform)) return result.detail;
  for (const node of Object.values(state.agents)) {
    if (node.run?.runId === runId) return node.run.worktree?.path ?? null;
  }
  return null;
}

/** What the panel says after the vscode: link was handed to Windows. */
export const VSCODE_SENT = 'Sent to VS Code. If VS Code asks whether to open the folder, answer there.';

const REFUSED: CommandResult = {
  ok: false,
  code: 'invalid',
  message: "Huddle opens only the worktree folders it made, and this isn't one of them.",
};

const REPORT_REFUSED: CommandResult = {
  ok: false,
  code: 'invalid',
  message: "Huddle opens only the report files it wrote, and this isn't one of them.",
};

const COPY_REFUSED: CommandResult = {
  ok: false,
  code: 'invalid',
  message: "Huddle copies only the paths of report files it wrote, and this isn't one of them.",
};

const REPORT_MISSING: CommandResult = {
  ok: false,
  code: 'not_found',
  message: 'The report file is missing. Write it again first.',
};

/** A Markdown file name (the core writes `<sessionId>.md`). */
function isReportName(p: string): boolean {
  return p.toLowerCase().endsWith('.md');
}

export function createSystemActions(deps: SystemDeps): SystemActions {
  const api = pathApi(deps.platform);
  return {
    async pickFolder(defaultPath, owner) {
      const options: FolderDialogOptions = { title: 'Choose the folder to run in', properties: ['openDirectory'] };
      if (isPlainAbsolutePath(defaultPath, deps.platform) && (await deps.isDirectory(defaultPath))) {
        options.defaultPath = api.resolve(defaultPath);
      }
      const r = await deps.showOpenDialog(owner, options);
      const chosen = r.filePaths[0];
      return r.canceled || chosen === undefined ? null : chosen;
    },

    async openWorktree(worktreePath) {
      if (!isPlainAbsolutePath(worktreePath, deps.platform)) return REFUSED;
      if (!isWorktreeFolder(deps.worktreesRoot, worktreePath, deps.platform)) return REFUSED;
      // Again after following links: the run folder itself must not be a junction to somewhere else.
      let real: string;
      try {
        const [realRoot, realFolder] = await Promise.all([
          deps.realpath(deps.worktreesRoot),
          deps.realpath(api.resolve(worktreePath)),
        ]);
        if (!isWorktreeFolder(realRoot, realFolder, deps.platform)) return REFUSED;
        real = realFolder;
      } catch {
        return { ok: false, code: 'not_found', message: 'The worktree folder is gone.' };
      }
      if (!(await deps.isDirectory(real))) {
        return { ok: false, code: 'not_found', message: 'The worktree folder is gone.' };
      }

      const fallback = async (why: string): Promise<CommandResult> => {
        const error = await deps.openPath(real).catch(() => 'failed');
        return error === ''
          ? { ok: true, detail: `${why} The folder opened in File Explorer instead.` }
          : { ok: false, code: 'failed', message: `${why} File Explorer couldn't open the folder either.` };
      };

      if (deps.protocolHandler('vscode://') === '') return fallback("VS Code isn't installed.");
      try {
        await deps.openExternal(vscodeFileUrl(real));
        // Handing the link over is all main can see: VS Code may still ask its own "open this folder?" question, and
        // the user may say No there (M4 runbook, 2026-11-14). So the words say sent, not opened.
        return { ok: true, detail: VSCODE_SENT };
      } catch {
        return fallback("VS Code didn't open.");
      }
    },

    async openReport(reportPath) {
      if (!isPlainAbsolutePath(reportPath, deps.platform) || !isReportName(reportPath)) return REPORT_REFUSED;
      // A file directly inside the reports folder: the same one-level check as a worktree folder.
      if (!isWorktreeFolder(deps.reportsRoot, reportPath, deps.platform)) return REPORT_REFUSED;
      let real: string;
      try {
        const [realRoot, realFile] = await Promise.all([
          deps.realpath(deps.reportsRoot),
          deps.realpath(api.resolve(reportPath)),
        ]);
        if (!isWorktreeFolder(realRoot, realFile, deps.platform) || !isReportName(realFile)) return REPORT_REFUSED;
        real = realFile;
      } catch {
        return REPORT_MISSING;
      }
      if (!(await deps.isFile(real))) return REPORT_MISSING;
      const error = await deps.openPath(real).catch(() => 'failed');
      return error === ''
        ? { ok: true }
        : { ok: false, code: 'failed', message: "The report didn't open. Copy its path and open it yourself." };
    },

    async copyText(text) {
      try {
        await deps.writeClipboard(text);
      } catch {
        return { ok: false, code: 'failed', message: "The answer couldn't be copied." };
      }
      return { ok: true };
    },

    async copyReportPath(reportPath) {
      // Only text goes to the clipboard, but still only what looks like the core's report path.
      if (!isPlainAbsolutePath(reportPath, deps.platform) || !isReportName(reportPath)) return COPY_REFUSED;
      // The same containment as openReport (M5 security review nit): directly inside the reports folder, checked before
      // and after following links, so the clipboard never gets a path that leads somewhere else.
      if (!isWorktreeFolder(deps.reportsRoot, reportPath, deps.platform)) return COPY_REFUSED;
      try {
        const [realRoot, realFile] = await Promise.all([
          deps.realpath(deps.reportsRoot),
          deps.realpath(api.resolve(reportPath)),
        ]);
        if (!isWorktreeFolder(realRoot, realFile, deps.platform) || !isReportName(realFile)) return COPY_REFUSED;
      } catch {
        return REPORT_MISSING;
      }
      try {
        await deps.writeClipboard(reportPath);
      } catch {
        return { ok: false, code: 'failed', message: "The path couldn't be copied." };
      }
      return { ok: true, detail: reportPath };
    },
  };
}
