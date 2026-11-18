/**
 * Self-reported progress for managed runs (M6 P4, F27, ADR-025): the per-run files a launch passes to `claude`.
 *
 * For each run with self-report on, the launcher makes `<dataDir>/run-mcp/<runId>/` (owner-only) holding
 *   - `huddle-mcp.mjs`: a copy of the server script (a real file, outside any asar archive, that cannot change under a
 *     running run when the app updates),
 *   - `mcp.json`: the `--mcp-config` file naming that copy, started with `node` as an absolute path (M2),
 *   - `settings.json`: the per-run `--settings` file with `permissions.allow` naming the two report tools
 *     (`mcp__huddle__report_progress` and `mcp__huddle__report_teammate`) and
 *     nothing else (the exit harness's own settings are merged in when it passes them).
 * The folder is removed when the run exits or fails to start, and every folder of a run that is not live is swept at
 * core start (a crash leaves them behind). Nothing is written under the Claude config folder (`~/.claude`).
 *
 * No `--strict-mcp-config` (ADR-025): it would drop the user's own MCP servers for the run, which a template's agents
 * may rely on. S19 used it only to isolate the spike.
 *
 * Self-report is optional, so every failure here is reported to the caller, which launches without it (fail open).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { TeamTemplate } from '@huddle/shared';
import { HUDDLE_MCP_FILENAME, huddleMcpConfigJson, progressRunSettingsJson } from '../ingest/huddle-mcp.js';

/** Folder (under the app data folder) for the per-run self-report files. */
export const RUN_MCP_DIRNAME = 'run-mcp';
export const RUN_MCP_CONFIG_FILENAME = 'mcp.json';
export const RUN_SETTINGS_FILENAME = 'settings.json';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/** A run id as RunHost makes it (a UUID); anything else in the folder is not ours and is left alone. */
const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: is self-report on for this template's run? The global switch wins; a template can only turn it off. */
export function selfReportOn(template: Pick<TeamTemplate, 'selfReport'>, globalEnabled: boolean): boolean {
  return globalEnabled && template.selfReport !== false;
}

export function runMcpRoot(dataDir: string): string {
  return path.join(path.resolve(dataDir), RUN_MCP_DIRNAME);
}

export function runMcpDir(dataDir: string, runId: string): string {
  if (!RUN_DIR.test(runId)) throw new Error('invalid run id');
  return path.join(runMcpRoot(dataDir), runId);
}

export interface SelfReportRunFiles {
  dir: string;
  serverScript: string;
  mcpConfigFile: string;
  settingsFile: string;
}

export interface WriteSelfReportInput {
  dataDir: string;
  runId: string;
  /** The server script shipped with the app (scripts/huddle-mcp.mjs in dev). */
  serverSource: string;
  /** `node` as an absolute path (claude-path.ts `resolveNodeExecutable`). */
  nodeCommand: string;
  /** Exit harness only: its `--settings` file, merged into the per-run one. Null for the product. */
  baseSettingsFile: string | null;
}

/** Forward slashes: what S19 ran with, and the form that reads the same in JSON, PowerShell and Git Bash. */
function forwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Writes the run's folder (see the file comment). Every file is created new (`wx`), owner-only. On any failure the
 * folder is removed again and the error is thrown.
 */
export async function writeSelfReportFiles(input: WriteSelfReportInput): Promise<SelfReportRunFiles> {
  const dir = runMcpDir(input.dataDir, input.runId);
  const files: SelfReportRunFiles = {
    dir,
    serverScript: path.join(dir, HUDDLE_MCP_FILENAME),
    mcpConfigFile: path.join(dir, RUN_MCP_CONFIG_FILENAME),
    settingsFile: path.join(dir, RUN_SETTINGS_FILENAME),
  };
  await fsp.mkdir(runMcpRoot(input.dataDir), { recursive: true, mode: PRIVATE_DIR_MODE });
  // A folder left by an earlier run with the same id would be a bug; refuse rather than reuse it.
  await fsp.mkdir(dir, { mode: PRIVATE_DIR_MODE });
  try {
    const base: unknown =
      input.baseSettingsFile === null ? null : JSON.parse(await fsp.readFile(input.baseSettingsFile, 'utf8'));
    const settings = progressRunSettingsJson(base);
    const mcp = huddleMcpConfigJson({
      serverScript: forwardSlashes(files.serverScript),
      nodeCommand: input.nodeCommand,
    });
    const source = await fsp.readFile(input.serverSource);
    const create = { flag: 'wx', mode: PRIVATE_FILE_MODE } as const;
    await fsp.writeFile(files.serverScript, source, create);
    await fsp.writeFile(files.mcpConfigFile, mcp, { ...create, encoding: 'utf8' });
    await fsp.writeFile(files.settingsFile, settings, { ...create, encoding: 'utf8' });
    return files;
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Removes one run's folder. A missing folder is fine. Never throws (resolves false when it could not be removed). */
export async function removeSelfReportFiles(dataDir: string, runId: string): Promise<boolean> {
  try {
    await fsp.rm(runMcpDir(dataDir, runId), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the folder of every run that is not live (`isLive`), as left by a crash. Only folders named like a run id;
 * anything else in `run-mcp` is left. Links are not followed (lstat). Never throws; resolves the number removed.
 */
export async function sweepSelfReportFiles(dataDir: string, isLive: (runId: string) => boolean): Promise<number> {
  const root = runMcpRoot(dataDir);
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!RUN_DIR.test(name) || isLive(name)) continue;
    try {
      if (!(await fsp.lstat(path.join(root, name))).isDirectory()) continue;
      if (await removeSelfReportFiles(dataDir, name)) removed += 1;
    } catch {
      // gone already
    }
  }
  return removed;
}
