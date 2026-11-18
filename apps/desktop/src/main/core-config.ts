/**
 * Which core main hosts, and with what folders. Pure, so the rules are testable without Electron:
 *
 *  - The real HuddleCore always, except in an unpackaged dev run with `HUDDLE_DEV_CANNED=1` (screenshots).
 *    A packaged build ignores the switch, so canned data can never reach a user.
 *  - dataDir: Electron userData. claudeConfigDir: CLAUDE_CONFIG_DIR, else ~/.claude (same rule as Claude Code
 *    and the installer script). userAgentsDir: <claudeConfigDir>/agents. cwd: none yet (no project roles).
 *  - The scripts Claude Code runs with the user's own `node` (the SessionStart forwarder, the status line bridge F9,
 *    the self-report MCP server F27 / ADR-025) and the phone page (F26) must be real files: an external `node` cannot
 *    read inside app.asar, and the core copies and serves them with plain fs. In dev they come from the repo's
 *    scripts/ and out/phone; packaged (P6, electron-builder.json `extraResources`) they sit directly in
 *    process.resourcesPath, next to app.asar. The tray and window icon ships the same way (M1 carry-over).
 *  - The "remove hooks" line the forwarder prints when Huddle is not running: the repo installer in dev; packaged,
 *    the app's own exe with `--remove-hooks` (launch-mode.ts, remove-hooks.ts), in PowerShell form.
 */
import path from 'node:path';
import type { HuddleCoreDeps } from '@huddle/core';
import { REMOVE_HOOKS_FLAG } from './launch-mode.js';

export interface CoreEnv {
  packaged: boolean;
  /** app.getAppPath(): apps/desktop in dev, <resources>/app.asar packaged. */
  appPath: string;
  /** process.resourcesPath. */
  resourcesPath: string;
  /** app.getPath('userData'). */
  userData: string;
  homedir: string;
  env: Readonly<Record<string, string | undefined>>;
  /** process.execPath: the installed exe when packaged (for the "remove hooks" command line). */
  execPath: string;
}

export const FORWARDER_FILE = 'huddle-forward-hook.mjs';
/** Status line bridge wrapper (F9), shipped the same way as the forwarder. */
export const STATUSLINE_FILE = 'huddle-statusline.mjs';
/** Self-report MCP server (F27, ADR-025), shipped the same way as the forwarder. */
export const MCP_SERVER_FILE = 'huddle-mcp.mjs';
/** The phone page's folder name, under out/ in dev and under resources/ when packaged. */
export const PHONE_DIR = 'phone';
/** The tray and window icon: apps/desktop/resources in dev, resources/ (outside app.asar) packaged. */
export const ICON_FILE = 'tray.ico';

export type CoreChoice =
  | { kind: 'canned' }
  | {
      kind: 'huddle';
      deps: Pick<
        HuddleCoreDeps,
        | 'dataDir'
        | 'claudeConfigDir'
        | 'cwd'
        | 'userAgentsDir'
        | 'forwarderSource'
        | 'statuslineSource'
        | 'mcpServerSource'
        | 'uninstallCommand'
        | 'phone'
      >;
    };

/** Pure: the files the app ships, in dev and packaged. */
export interface ShippedFiles {
  forwarder: string;
  statusline: string;
  mcpServer: string;
  /** A folder (index.html inside). */
  phoneDir: string;
  icon: string;
}

export function shippedFiles(e: Pick<CoreEnv, 'packaged' | 'appPath' | 'resourcesPath'>): ShippedFiles {
  if (e.packaged) {
    return {
      forwarder: path.join(e.resourcesPath, FORWARDER_FILE),
      statusline: path.join(e.resourcesPath, STATUSLINE_FILE),
      mcpServer: path.join(e.resourcesPath, MCP_SERVER_FILE),
      phoneDir: path.join(e.resourcesPath, PHONE_DIR),
      icon: path.join(e.resourcesPath, ICON_FILE),
    };
  }
  const repo = path.resolve(e.appPath, '..', '..');
  return {
    forwarder: path.join(repo, 'scripts', FORWARDER_FILE),
    statusline: path.join(repo, 'scripts', STATUSLINE_FILE),
    mcpServer: path.join(repo, 'scripts', MCP_SERVER_FILE),
    phoneDir: path.join(e.appPath, 'out', PHONE_DIR),
    icon: path.join(e.appPath, 'resources', ICON_FILE),
  };
}

/** CLAUDE_CONFIG_DIR when set and not blank, else ~/.claude. */
export function claudeConfigDirOf(e: Pick<CoreEnv, 'homedir' | 'env'>): string {
  const configured = e.env['CLAUDE_CONFIG_DIR'];
  return configured && configured.trim() !== '' ? configured : path.join(e.homedir, '.claude');
}

/**
 * The command the forwarder's "Huddle not running" hint shows. Packaged: PowerShell's call operator form, because the
 * install folder has a space ("Agent Huddle") and PowerShell is the default Windows shell; in cmd the same line works
 * without the leading `& `.
 */
export function uninstallCommandOf(e: Pick<CoreEnv, 'packaged' | 'appPath' | 'execPath'>): string {
  if (e.packaged) return `& ${quotedPath(e.execPath, true)} ${REMOVE_HOOKS_FLAG}`;
  const installer = path.join(path.resolve(e.appPath, '..', '..'), 'scripts', 'install-hooks.mjs');
  return `node ${quotedPath(installer, false)} --uninstall --apply`;
}

/**
 * A path for a shell line the user pastes. Double quotes, unless the path holds a dollar sign or a backtick: Git Bash
 * and PowerShell expand those inside double quotes, and single quotes do not. A single quote in such a path is doubled
 * for PowerShell; the dev line (Bash or PowerShell) keeps double quotes then, because no one form fits both.
 */
function quotedPath(p: string, powershellOnly: boolean): string {
  if (!/[$`]/.test(p)) return `"${p}"`;
  if (powershellOnly) return `'${p.replaceAll("'", "''")}'`;
  return p.includes("'") ? `"${p}"` : `'${p}'`;
}

export function chooseCore(e: CoreEnv): CoreChoice {
  if (!e.packaged && e.env['HUDDLE_DEV_CANNED'] === '1') return { kind: 'canned' };
  const claudeConfigDir = claudeConfigDirOf(e);
  const files = shippedFiles(e);
  return {
    kind: 'huddle',
    deps: {
      dataDir: e.userData,
      claudeConfigDir,
      cwd: null,
      userAgentsDir: path.join(claudeConfigDir, 'agents'),
      forwarderSource: files.forwarder,
      statuslineSource: files.statusline,
      mcpServerSource: files.mcpServer,
      phone: { staticDir: files.phoneDir },
      uninstallCommand: uninstallCommandOf(e),
    },
  };
}
