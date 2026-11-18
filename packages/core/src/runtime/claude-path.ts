/**
 * Where the `claude` a managed run starts lives (security review M2).
 *
 * A run is spawned with `cwd` set to the template folder or its worktree, both of which hold files the agent or the
 * repository's authors wrote. Spawning the bare name `claude` lets the OS search for it, and on Windows that search
 * can look in the spawn's working folder before PATH, so a repository that commits `claude.exe` or `claude.com`
 * would run on launch. So the Huddle finds `claude` itself, once, and spawns the absolute path:
 *  - only PATH entries that are local absolute paths (`isLocalAbsolutePath`): empty, `.`, relative, drive-relative,
 *    rooted-without-drive, UNC and device entries are skipped; the process cwd and the spawn cwd are never searched;
 *  - on Windows only `claude.com` and `claude.exe`, in that order in each folder (the default PATHEXT order, so the
 *    same file a terminal would run). `shell: false` cannot run `.cmd`, `.bat` or `.ps1` (npm's shims), so when only
 *    those exist the answer is a clear error rather than a spawn that fails with ENOENT;
 *  - elsewhere `claude`, a regular file with the execute bit.
 *
 * File system access only (stat, access); no process runs. The PATH comes from the env the run will get.
 */
import { constants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { isLocalAbsolutePath } from './paths.js';

export const CLAUDE_SHIM_ONLY_MESSAGE = 'claude was found only as a .cmd shim; install the native Claude Code';
export const CLAUDE_NOT_FOUND_MESSAGE = 'claude was not found on PATH; install Claude Code';

export type ClaudeResolution =
  { ok: true; path: string } | { ok: false; reason: 'not_found' | 'shim_only'; message: string };

/** Windows: what `shell: false` can start, in the default PATHEXT order. */
const WIN_EXECUTABLES = ['claude.com', 'claude.exe'] as const;
/** Windows: npm and other shims that need a shell. */
const WIN_SHIMS = ['claude.cmd', 'claude.bat', 'claude.ps1'] as const;

function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env.PATH ?? '';
  // Windows env names are case-insensitive (`Path` is usual); a copied env object is not.
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === 'PATH' && value !== undefined) return value;
  }
  return '';
}

/** Pure: the PATH folders that may be searched, in order. Quotes around a Windows entry are removed. */
export function claudePathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  const out: string[] = [];
  for (const raw of pathValue(env, platform).split(delimiter)) {
    const entry = platform === 'win32' ? raw.replace(/^"(.*)"$/, '$1') : raw;
    if (isLocalAbsolutePath(entry, platform)) out.push(entry);
  }
  return out;
}

async function isRegularFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(p: string): Promise<boolean> {
  if (!(await isRegularFile(p))) return false;
  try {
    await fsp.access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveClaudeOptions {
  /** The env whose PATH is searched (the run's env). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Finds `claude` on PATH as an absolute path. Never throws. */
export async function resolveClaudeExecutable(options: ResolveClaudeOptions = {}): Promise<ClaudeResolution> {
  const platform = options.platform ?? process.platform;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const entries = claudePathEntries(options.env ?? process.env, platform);
  let shimSeen = false;
  for (const dir of entries) {
    if (platform === 'win32') {
      for (const name of WIN_EXECUTABLES) {
        const candidate = api.join(dir, name);
        if (await isRegularFile(candidate)) return { ok: true, path: candidate };
      }
      if (!shimSeen) {
        for (const name of WIN_SHIMS) {
          if (await isRegularFile(api.join(dir, name))) {
            shimSeen = true;
            break;
          }
        }
      }
    } else {
      const candidate = api.join(dir, 'claude');
      if (await isExecutableFile(candidate)) return { ok: true, path: candidate };
    }
  }
  return shimSeen
    ? { ok: false, reason: 'shim_only', message: CLAUDE_SHIM_ONLY_MESSAGE }
    : { ok: false, reason: 'not_found', message: CLAUDE_NOT_FOUND_MESSAGE };
}

/**
 * Finds `node` on PATH as an absolute path, by the same rules as `resolveClaudeExecutable` (local absolute PATH entries
 * only; Windows `node.exe`, elsewhere an executable `node`). The Huddle's MCP server (F27) is started by Claude Code
 * from the agent's folder, so its `command` is this absolute path, never the bare name (M2). Null when not found.
 */
export async function resolveNodeExecutable(options: ResolveClaudeOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const api = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of claudePathEntries(options.env ?? process.env, platform)) {
    if (platform === 'win32') {
      const candidate = api.join(dir, 'node.exe');
      if (await isRegularFile(candidate)) return candidate;
    } else {
      const candidate = api.join(dir, 'node');
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
