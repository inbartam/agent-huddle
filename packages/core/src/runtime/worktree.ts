/**
 * Git worktrees for managed runs (F20, ADR-020 §2).
 *
 * The Huddle makes its own worktree with `git worktree add` (not Claude Code's `--worktree`), so the path, branch and
 * base commit are known: `<dataDir>/worktrees/<runId>` on branch `huddle/<runId>`, where `dataDir` is
 * `%LOCALAPPDATA%/agent-huddle` (`defaultWorktreeDataDir`). Every worktree it makes is written to
 * `<dataDir>/worktrees.json` before git is asked to make it, so ownership survives a restart or a crash part way.
 *
 * Discard removes the worktree **and** its branch, and refuses unless all of these hold: the path is the run's own
 * folder inside the Huddle worktrees root, the registry has it, the branch is `huddle/<runId>`, and the run's process
 * is not alive. Locked worktrees (Claude Code `-p` leaves its own locked) are unlocked first.
 *
 * This module only returns facts. HuddleCore turns them into `worktree.*` events (WP6). It never reads file contents:
 * the summary comes from `git status` and `git diff --numstat` / `--name-status`, line counts only.
 *
 * The agent works inside the worktree and can write any file there, including the `.git` link file, so after create
 * the Huddle trusts nothing the worktree says about where its repository is. Every later git call gets hardening config
 * (`hardeningConfigArgs`: no fsmonitor, no hooks, no external diff, no pager, no credential helper, no network, no
 * recursing into a nested repository, whose own config git would obey) and
 * `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`. Before reading a worktree, its `.git` must be a file whose `gitdir:`
 * is the git folder recorded at create, and that folder's `commondir` must lead back to the recorded repository;
 * summarize then runs with explicit `--git-dir`/`--work-tree` instead of following `.git`. A worktree whose link was
 * changed is refused for summarize; discard then skips `worktree remove` and deletes the folder itself (after the
 * same ownership guards), then prunes from the repository.
 *
 * Side effects (git, file system, clock) come in through `WorktreeManagerOptions`. git always runs with an args array,
 * `shell: false`, a timeout and `GIT_TERMINAL_PROMPT=0`; nothing is interpolated into a command string.
 * Errors: `createWorktree` and `summarizeWorktree` throw a `WorktreeError` (with a `code`); `keepWorktree` and
 * `discardWorktree` return a result, because a refusal or a partial failure is a normal answer to a user's command.
 */
import { execFile } from 'node:child_process';
import { promises as fsp, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  CLIP_LIMITS,
  MAX_WORKTREE_FILES,
  type WorktreeFile,
  type WorktreeFileStatus,
  type WorktreeSummary,
} from '@huddle/shared';
import { RUN_ID_PATTERN } from '../contracts/m4-schemas.js';
import { clip } from '../text.js';
import { maskSecrets } from '../privacy/index.js';
import { isLocalAbsolutePath } from './paths.js';
import { removeTreeNoFollow } from './safe-remove.js';
import { writeTextAtomic } from './atomic-file.js';

export const WORKTREES_DIRNAME = 'worktrees';
export const WORKTREE_REGISTRY_FILENAME = 'worktrees.json';
export const WORKTREE_BRANCH_PREFIX = 'huddle/';
const REGISTRY_VERSION = 1;

// --- git runner ---------------------------------------------------------------------------------------------------

export interface GitResult {
  /** Exit code; null when git did not run to an exit (not found, timed out, killed). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why git did not run to an exit (for example "git was not found on PATH"); null when it exited. */
  error: string | null;
}

export interface GitRunOptions {
  timeoutMs?: number;
  /** Extra environment for this call. */
  env?: Record<string, string>;
}

/** Runs git with an args array. Resolves with the outcome; never rejects. */
export type GitRunner = (args: readonly string[], options?: GitRunOptions) => Promise<GitResult>;

export interface GitRunnerOptions {
  /** Default `git`, found on PATH (`git.exe` on Windows). */
  gitPath?: string;
  /** Put in front of every call, for example `['-c', 'core.hooksPath=…']` in tests. */
  configArgs?: readonly string[];
  /** Extra environment for every call. */
  env?: Record<string, string>;
  /** Default 60 s per call. */
  timeoutMs?: number;
}

/** git variables a parent process (a git hook, a terminal inside a repo) may have set; they would redirect `-C`. */
const INHERITED_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
];
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The default runner: `child_process.execFile`, `shell: false`, `windowsHide: true`, a timeout, no prompts. */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const gitPath = options.gitPath ?? 'git';
  const prefix = options.configArgs ?? [];
  const baseTimeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return (args, run = {}) =>
    new Promise<GitResult>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of INHERITED_GIT_VARS) Reflect.deleteProperty(env, name);
      Object.assign(env, options.env, run.env, { GIT_TERMINAL_PROMPT: '0' });
      const timeout = run.timeoutMs ?? baseTimeout;
      execFile(
        gitPath,
        [...prefix, ...args],
        {
          env,
          // Never the process cwd: on Windows a git.exe there would be found before PATH. Every call passes -C <repo>.
          cwd: os.tmpdir(),
          shell: false,
          windowsHide: true,
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: GIT_MAX_BUFFER,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr, error: null });
            return;
          }
          const code: unknown = (error as { code?: unknown }).code;
          if (typeof code === 'number') {
            resolve({ code, stdout, stderr, error: null });
            return;
          }
          let why = error.message;
          if (code === 'ENOENT') why = 'git was not found on PATH';
          else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') why = 'git printed more output than the Huddle reads';
          else if (error.killed) why = `git did not finish within ${String(Math.round(timeout / 1000))} s`;
          resolve({ code: null, stdout, stderr, error: why });
        },
      );
    });
}

/**
 * Pure: `-c` pairs for every git call made after a worktree exists. Command-line config wins over the repository's
 * own (and over a config file a tampered `.git` could lead to). `hooksDir` must be a folder that does not exist.
 */
export function hardeningConfigArgs(hooksDir: string, attributesFile: string): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${hooksDir}`,
    '-c',
    `core.attributesFile=${attributesFile}`,
    '-c',
    'diff.external=',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.pager=cat',
    '-c',
    'credential.helper=',
    '-c',
    'protocol.allow=never',
    // A nested repository the agent made (`git init sub`, staged as a gitlink) has its own config, and a filter
    // driver there has a name the neutralizer never sees: git must not recurse into it (security review M1).
    '-c',
    'diff.ignoreSubmodules=all',
    '-c',
    'status.submoduleSummary=false',
    '-c',
    'submodule.recurse=false',
  ];
}

/** Environment for every hardened git call. */
export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
};

/** Folder under the data dir given as `core.hooksPath` to hardened calls. The Huddle never creates it. */
export const DISABLED_HOOKS_DIRNAME = 'git-hooks-disabled';
/** File under the data dir given as `core.attributesFile` to hardened calls. The Huddle never creates it. */
export const DISABLED_ATTRIBUTES_FILENAME = 'git-attributes-disabled';

/** The most filter drivers summarize neutralizes; with more it refuses, so the command line stays bounded. */
export const MAX_FILTER_DRIVERS = 64;

/**
 * Pure: filter driver names in `git config -z --get-regexp ^filter\.` output (`key\nvalue\0`, or `key\0` for a key
 * without a value). A key is `filter.<name>.<variable>`; the name may contain dots, so it is everything between the
 * first `filter.` and the last `.`. Deduplicated, in first-seen order.
 */
export function parseFilterDriverNames(text: string): string[] {
  const names: string[] = [];
  for (const record of text.split('\0')) {
    const key = record.split('\n', 1)[0] ?? '';
    if (!key.toLowerCase().startsWith('filter.')) continue;
    const last = key.lastIndexOf('.');
    if (last <= 'filter'.length) continue; // `filter.<variable>`: no driver name
    const name = key.slice('filter.'.length, last);
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Pure: why these drivers cannot be neutralized with `-c`, or null. Too many (argv must stay bounded), or a name with
 * `=` (git splits `-c key=value` at the first `=`, so the override would land on the wrong key) or a control character.
 */
export function filterDriversProblem(names: readonly string[]): string | null {
  if (names.length > MAX_FILTER_DRIVERS) {
    return `the repository defines ${String(names.length)} git filter drivers (at most ${String(MAX_FILTER_DRIVERS)})`;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (names.some((n) => n.includes('=') || /[\x00-\x1f\x7f]/.test(n))) {
    return 'the repository defines a git filter driver whose name cannot be overridden safely';
  }
  return null;
}

/** Pure: `-c` pairs that switch each filter driver off (no clean, smudge or process command; not required). */
export function filterNeutralizerArgs(names: readonly string[]): string[] {
  return names.flatMap((n) => [
    '-c',
    `filter.${n}.clean=`,
    '-c',
    `filter.${n}.smudge=`,
    '-c',
    `filter.${n}.process=`,
    '-c',
    `filter.${n}.required=false`,
  ]);
}

/** Pure: the target of a `.git` link file (`gitdir: <path>`), or null when the text is not one. */
export function parseGitLinkFile(text: string): string | null {
  const first = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/, 1)[0] ?? '';
  const m = /^gitdir:[ \t]*(.*?)[ \t]*$/.exec(first);
  const target = m?.[1] ?? '';
  return target === '' ? null : target;
}

// --- pure helpers: names and paths --------------------------------------------------------------------------------

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Pure: why this runId cannot name a worktree folder and a branch, or null when it can. On top of RUN_ID_PATTERN:
 * no `..`, no trailing `.` and no `.lock` ending (git ref rules), and no Windows device name (`con`, `nul.txt`).
 */
export function worktreeRunIdProblem(runId: string): string | null {
  if (!RUN_ID_PATTERN.test(runId)) {
    return 'run id may only use letters, digits, ".", "_" and "-", must not start with "." and is at most 128 characters';
  }
  if (runId.includes('..')) return 'run id must not contain ".."';
  if (runId.endsWith('.')) return 'run id must not end with "."';
  if (runId.toLowerCase().endsWith('.lock')) return 'run id must not end with ".lock"';
  if (WINDOWS_RESERVED_NAME.test(runId)) return 'run id is a reserved Windows device name';
  return null;
}

/** Pure: the branch the Huddle makes for a run. */
export function worktreeBranchName(runId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${runId}`;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function comparable(p: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Pure: the same path once resolved (case-insensitive on Windows, where `/` and `\` are the same separator). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/** Pure: is `candidate` strictly inside `root` (not the root itself), after resolving `..`? Case-insensitive on win32. */
export function isPathInside(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = pathApi(platform);
  const rel = api.relative(comparable(root, platform), comparable(candidate, platform));
  if (rel === '' || api.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${api.sep}`);
}

/**
 * Where the Huddle keeps worktrees and their registry: `%LOCALAPPDATA%/agent-huddle` on Windows (local, not roaming:
 * a checkout is machine-specific). Elsewhere the platform's usual local data folder.
 */
export function defaultWorktreeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== '' ? env.LOCALAPPDATA : null;
    return path.win32.join(local ?? path.win32.join(home, 'AppData', 'Local'), 'agent-huddle');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'agent-huddle');
  const xdg = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== '' ? env.XDG_DATA_HOME : null;
  return path.posix.join(xdg ?? path.posix.join(home, '.local', 'share'), 'agent-huddle');
}

// --- pure helpers: parsing git output -----------------------------------------------------------------------------

/** One entry of `git status --porcelain=v1 -z`. */
export interface PorcelainEntry {
  /** Index status (X) and work tree status (Y), one character each. */
  x: string;
  y: string;
  path: string;
  /** The path before a rename or copy; null otherwise. */
  origPath: string | null;
}

/**
 * Pure: parse `git status --porcelain=v1 -z`. Each entry is `XY PATH\0`; a rename or copy is followed by its
 * original path as the next field (`XY NEW\0OLD\0`). Malformed fields are skipped.
 */
export function parsePorcelainZ(text: string): PorcelainEntry[] {
  const fields = text.split('\0');
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    if (field.length < 4 || field[2] !== ' ') continue;
    const x = field.charAt(0);
    const y = field.charAt(1);
    let origPath: string | null = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1;
      origPath = fields[i] ?? null;
    }
    out.push({ x, y, path: field.slice(3), origPath });
  }
  return out;
}

/** One entry of `git diff --name-status -z`. */
export interface NameStatusEntry {
  /** The status field as git printed it, for example `M` or `R100`. */
  status: string;
  path: string;
  origPath: string | null;
}

/** Pure: parse `git diff --name-status -z`: `S\0PATH\0`, or `R<score>\0OLD\0NEW\0` (also `C`). */
export function parseNameStatusZ(text: string): NameStatusEntry[] {
  const fields = text.split('\0');
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i] ?? '';
    i += 1;
    if (status === '') continue;
    const letter = status.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const origPath = fields[i] ?? '';
      const newPath = fields[i + 1] ?? '';
      i += 2;
      if (newPath !== '') out.push({ status, path: newPath, origPath });
    } else {
      const p = fields[i] ?? '';
      i += 1;
      if (p !== '') out.push({ status, path: p, origPath: null });
    }
  }
  return out;
}

/** One entry of `git diff --numstat -z`. A binary file has 0 insertions and deletions and `binary: true`. */
export interface NumstatEntry {
  path: string;
  origPath: string | null;
  insertions: number;
  deletions: number;
  binary: boolean;
}

const NUMSTAT_FIELD = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

/** Pure: parse `git diff --numstat -z`: `ADD\tDEL\tPATH\0`, or for a rename `ADD\tDEL\t\0OLD\0NEW\0`; binary is `-`. */
export function parseNumstatZ(text: string): NumstatEntry[] {
  const fields = text.split('\0');
  const out: NumstatEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const field = fields[i] ?? '';
    i += 1;
    const m = NUMSTAT_FIELD.exec(field);
    if (m === null) continue;
    const added = m[1] ?? '-';
    const deleted = m[2] ?? '-';
    let p = m[3] ?? '';
    let origPath: string | null = null;
    if (p === '') {
      origPath = fields[i] ?? '';
      p = fields[i + 1] ?? '';
      i += 2;
    }
    if (p === '') continue;
    const binary = added === '-' || deleted === '-';
    out.push({
      path: p,
      origPath,
      insertions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary,
    });
  }
  return out;
}

/** Pure: a diff status letter (`A`, `M`, `D`, `R`, `C`, `T`, `U`) as a WorktreeFileStatus. */
export function diffLetterStatus(letter: string): WorktreeFileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type_changed';
    case 'U':
      return 'unmerged';
    default:
      return 'unknown';
  }
}

/** Pure: a porcelain XY pair as a WorktreeFileStatus. The index letter wins over the work tree letter. */
export function porcelainStatus(x: string, y: string): WorktreeFileStatus {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'unmerged';
  return diffLetterStatus(x !== ' ' ? x : y);
}

export interface WorktreeGitFacts {
  /** `git diff --name-status -z <base>`: committed and uncommitted changes to tracked files against the base. */
  nameStatus: readonly NameStatusEntry[];
  /** `git diff --numstat -z <base>`: line counts for the same files. */
  numstat: readonly NumstatEntry[];
  /** `git status --porcelain=v1 -z --untracked-files=all`: untracked and unmerged files. */
  porcelain: readonly PorcelainEntry[];
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pure: the summary from git's facts. `filesChanged` counts every distinct path (changed against the base, or
 * untracked); `untracked` counts the untracked ones (their lines are not counted: contents are never read);
 * `insertions`/`deletions` come from numstat, binary files count 0. `files` is sorted by path, at most
 * MAX_WORKTREE_FILES, paths clipped to CLIP_LIMITS.path.
 */
export function buildWorktreeSummary(facts: WorktreeGitFacts, summarizedAt: number): WorktreeSummary {
  const statuses = new Map<string, WorktreeFileStatus>();
  for (const entry of facts.nameStatus) statuses.set(entry.path, diffLetterStatus(entry.status.charAt(0)));
  let insertions = 0;
  let deletions = 0;
  for (const entry of facts.numstat) {
    insertions += entry.insertions;
    deletions += entry.deletions;
    if (!statuses.has(entry.path)) statuses.set(entry.path, 'modified');
  }
  let untracked = 0;
  for (const entry of facts.porcelain) {
    const status = porcelainStatus(entry.x, entry.y);
    if (status === 'untracked') {
      untracked += 1;
      if (!statuses.has(entry.path)) statuses.set(entry.path, 'untracked');
    } else if (status === 'unmerged') {
      statuses.set(entry.path, 'unmerged');
    }
  }
  const files: WorktreeFile[] = [...statuses.keys()]
    .sort(byCodePoint)
    .slice(0, MAX_WORKTREE_FILES)
    .map((p) => ({ path: clip(p, CLIP_LIMITS.path), status: statuses.get(p) ?? 'unknown' }));
  return { filesChanged: statuses.size, insertions, deletions, untracked, files, summarizedAt };
}

/** Pure: the worktree paths in `git worktree list --porcelain` output (`-z` or newline separated). */
export function parseWorktreeListPaths(text: string): string[] {
  return text
    .split(/[\0\n]/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).replace(/\r$/, ''));
}

// --- registry -----------------------------------------------------------------------------------------------------

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const recordSchema = z.looseObject({
  runId: z.string().regex(RUN_ID_PATTERN),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().regex(COMMIT),
  repoRoot: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  /** active: in use or not decided. kept: the user kept it. A discarded worktree leaves the registry. */
  state: z.enum(['active', 'kept']),
  keptAt: z.number().int().nonnegative().optional(),
  /** The worktree's git folder (`<commonDir>/worktrees/<id>`), recorded at create. Absent in records made before. */
  gitDir: z.string().min(1).optional(),
  /** The repository's common git folder (usually `<repoRoot>/.git`), recorded at create. */
  commonDir: z.string().min(1).optional(),
});

/** A worktree the Huddle made, as recorded in worktrees.json. Unknown fields are kept. */
export type WorktreeRecord = z.output<typeof recordSchema>;

/** The parsed registry file. `invalid` keeps entries that did not validate so a write never drops them. */
export interface WorktreeRegistry {
  records: WorktreeRecord[];
  invalid: unknown[];
  /** Other top-level fields, kept as they are. */
  extra: Record<string, unknown>;
  /** The file exists but is not JSON of the expected shape; it is kept aside before the next write. */
  corrupt: boolean;
}

/** Pure: registry file text (null: no file) to records. Never throws. */
export function parseWorktreeRegistry(text: string | null): WorktreeRegistry {
  const empty: WorktreeRegistry = { records: [], invalid: [], extra: {}, corrupt: false };
  if (text === null) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ...empty, corrupt: true };
  }
  if (!isRecord(raw) || !Array.isArray(raw.worktrees)) return { ...empty, corrupt: true };
  const { worktrees, version: _version, ...extra } = raw;
  const records: WorktreeRecord[] = [];
  const invalid: unknown[] = [];
  const seen = new Set<string>();
  for (const item of worktrees as unknown[]) {
    const parsed = recordSchema.safeParse(item);
    if (parsed.success && !seen.has(parsed.data.runId)) {
      seen.add(parsed.data.runId);
      records.push(parsed.data);
    } else {
      invalid.push(item);
    }
  }
  return { records, invalid, extra, corrupt: false };
}

export function serializeWorktreeRegistry(registry: WorktreeRegistry): string {
  return `${JSON.stringify(
    { ...registry.extra, version: REGISTRY_VERSION, worktrees: [...registry.records, ...registry.invalid] },
    null,
    2,
  )}\n`;
}

/** What identifies a worktree in calls: its run and the path the caller believes it has. */
export interface WorktreeRef {
  runId: string;
  path: string;
}

/**
 * Pure: why the Huddle must not touch this worktree, or null when it may. The record must exist, both the caller's
 * path and the recorded path must be the run's own folder directly inside the worktrees root, and the branch must be
 * the Huddle's `huddle/<runId>`.
 */
export function ownershipProblem(
  root: string,
  ref: WorktreeRef,
  record: WorktreeRecord | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const idProblem = worktreeRunIdProblem(ref.runId);
  if (idProblem !== null) return idProblem;
  if (!isPathInside(root, ref.path, platform)) return 'path is outside the Huddle worktrees folder';
  if (record === undefined) return 'this worktree was not created by Agent Huddle';
  if (!isPathInside(root, record.path, platform)) return 'recorded path is outside the Huddle worktrees folder';
  const own = pathApi(platform).join(root, ref.runId);
  if (!samePath(record.path, own, platform) || !samePath(ref.path, own, platform)) {
    return "path is not this run's worktree folder";
  }
  if (record.branch !== worktreeBranchName(ref.runId)) return `branch is not ${worktreeBranchName(ref.runId)}`;
  return null;
}

// --- results and errors -------------------------------------------------------------------------------------------

export type WorktreeErrorCode =
  | 'bad_run_id'
  | 'not_found'
  | 'not_a_repo'
  | 'no_commits'
  | 'exists'
  | 'path_too_long'
  | 'git_missing'
  | 'git_failed'
  | 'registry'
  | 'refused';

/** A worktree could not be made or read. `message` is plain text for the user, clipped to CLIP_LIMITS.error. */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  constructor(code: WorktreeErrorCode, message: string) {
    super(clip(message, CLIP_LIMITS.error));
    this.name = 'WorktreeError';
    this.code = code;
  }
}

/** What createWorktree made. Paths are absolute, in the platform's form. */
export interface WorktreeEntry {
  runId: string;
  path: string;
  branch: string;
  baseCommit: string;
  repoRoot: string;
}

/** keepWorktree: kept (error is always null today), or refused with a reason. */
export type KeepWorktreeResult = { outcome: 'kept'; error: null } | { outcome: 'refused'; reason: string };

/**
 * discardWorktree:
 *  - refused: nothing was touched (not the Huddle's, process alive, …);
 *  - failed: the worktree folder is still there (registry unchanged, discard can be tried again);
 *  - discarded: the folder is gone; `error` says what went wrong part way (for example the branch was not deleted),
 *    matching `worktree.closed` semantics; null when clean.
 */
export type DiscardWorktreeResult =
  | { outcome: 'discarded'; error: string | null }
  | { outcome: 'failed'; error: string }
  | { outcome: 'refused'; reason: string };

export interface DiscardOptions {
  /** True while the run's `claude` process is alive. A throw counts as alive. */
  isProcessAlive: () => boolean | Promise<boolean>;
}

export interface WorktreeManagerOptions {
  /** The app's local data folder (`defaultWorktreeDataDir()`); worktrees go in `<dataDir>/worktrees`. */
  dataDir: string;
  /** Default `createGitRunner()`. */
  git?: GitRunner;
  now?: () => number;
  platform?: NodeJS.Platform;
}

function gitFailure(what: string, result: GitResult): string {
  const detail = (result.error ?? result.stderr).trim().split(/\r?\n/).slice(0, 4).join(' ').trim();
  return clip(maskSecrets(detail === '' ? what : `${what}: ${detail}`), CLIP_LIMITS.error);
}

function errorText(error: unknown): string {
  return clip(maskSecrets(error instanceof Error ? error.message : String(error)), CLIP_LIMITS.error);
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : '';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The long, real form of a path when it exists (resolves 8.3 short names on Windows); the input otherwise. */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * The long, real form of a folder that may not exist yet: its deepest existing ancestor in canonical form, with the
 * rest appended. Local paths only (resolving a network path would contact its host); other input is returned as is.
 */
function canonicalFolder(p: string, platform: NodeJS.Platform): string {
  if (platform !== process.platform || !isLocalAbsolutePath(p, platform)) return p;
  const rest: string[] = [];
  let head = p;
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...rest);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

// --- the manager --------------------------------------------------------------------------------------------------

/** Makes, summarizes, keeps and discards the Huddle's worktrees. One instance per data folder. */
export class WorktreeManager {
  /** `<dataDir>/worktrees`: every worktree the Huddle makes is a direct child named after its run. */
  readonly root: string;
  readonly registryPath: string;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  /** `core.hooksPath` for hardened calls: a folder that is never created. */
  private readonly hooksOff: string;
  /** `core.attributesFile` for hardened calls: a file that is never created. */
  private readonly attributesOff: string;
  /** Registry read-modify-write and git changes run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorktreeManagerOptions) {
    this.platform = options.platform ?? process.platform;
    const dataDir = pathApi(this.platform).resolve(options.dataDir);
    // Canonical (8.3 short names expanded, junctions resolved): a worktree's path is the agent's cwd and its trusted
    // session folder, and the allow rules refuse short names.
    this.root = pathApi(this.platform).join(canonicalFolder(dataDir, this.platform), WORKTREES_DIRNAME);
    this.registryPath = pathApi(this.platform).join(dataDir, WORKTREE_REGISTRY_FILENAME);
    this.hooksOff = pathApi(this.platform).join(dataDir, DISABLED_HOOKS_DIRNAME);
    this.attributesOff = pathApi(this.platform).join(dataDir, DISABLED_ATTRIBUTES_FILENAME);
    this.git = options.git ?? createGitRunner();
    this.now = options.now ?? Date.now;
  }

  /** The worktrees on record. */
  async listWorktrees(): Promise<WorktreeRecord[]> {
    return (await this.readRegistry()).records;
  }

  /**
   * Make `<root>/<runId>` on a new branch `huddle/<runId>` from the repository's current HEAD commit. Throws a
   * WorktreeError: bad_run_id, not_found (no such folder), not_a_repo, no_commits, exists (record, folder or branch),
   * path_too_long, git_missing, git_failed, registry.
   */
  async createWorktree(input: { repoDir: string; runId: string }): Promise<WorktreeEntry> {
    const { runId } = input;
    const idProblem = worktreeRunIdProblem(runId);
    if (idProblem !== null) throw new WorktreeError('bad_run_id', idProblem);
    // Before any file system or git call: a UNC or device path would make Windows contact another host (L3).
    if (!isLocalAbsolutePath(input.repoDir, this.platform)) {
      throw new WorktreeError('refused', 'the folder must be a full local path, not a network or device path');
    }
    const dir = path.resolve(input.repoDir);
    if (!(await isDirectory(dir))) throw new WorktreeError('not_found', 'folder does not exist');

    const top = await this.git(['-C', dir, 'rev-parse', '--show-toplevel']);
    if (top.code === null) throw new WorktreeError('git_missing', gitFailure('git could not run', top));
    const topLevel = top.stdout.trim();
    if (top.code !== 0 || topLevel === '') throw new WorktreeError('not_a_repo', 'folder is not a git repository');
    const repoRoot = path.resolve(topLevel);

    const head = await this.git(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const baseCommit = head.stdout.trim();
    if (head.code !== 0 || !COMMIT.test(baseCommit)) {
      throw new WorktreeError('no_commits', 'the repository has no commits yet');
    }

    const common = await this.git(['-C', repoRoot, 'rev-parse', '--git-common-dir']);
    const commonText = common.stdout.trim();
    if (common.code !== 0 || commonText === '') {
      throw new WorktreeError('git_failed', gitFailure('git rev-parse --git-common-dir failed', common));
    }
    const commonDir = path.resolve(repoRoot, commonText);

    const target = path.join(this.root, runId);
    const branch = worktreeBranchName(runId);
    if (target.length > CLIP_LIMITS.path || repoRoot.length > CLIP_LIMITS.path) {
      throw new WorktreeError('path_too_long', 'the worktree or repository path is too long');
    }

    return this.exclusive(async () => {
      const registry = await this.readRegistry();
      if (registry.records.some((r) => r.runId === runId)) {
        throw new WorktreeError('exists', 'a worktree for this run already exists');
      }
      if (await exists(target)) throw new WorktreeError('exists', 'the worktree folder already exists');
      const branchRef = await this.git(['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (branchRef.code === 0) throw new WorktreeError('exists', `branch ${branch} already exists`);

      // Record first: if the app dies while git works, the folder is still known to be the Huddle's.
      const record: WorktreeRecord = {
        runId,
        path: target,
        branch,
        baseCommit,
        repoRoot,
        createdAt: this.now(),
        state: 'active',
      };
      try {
        await fsp.mkdir(this.root, { recursive: true });
        await this.writeRegistry({ ...registry, records: [...registry.records, record] });
      } catch (error) {
        throw new WorktreeError('registry', `could not record the worktree: ${errorText(error)}`);
      }

      // core.longpaths: a deep repository under %LOCALAPPDATA% can pass MAX_PATH (260) on Windows.
      const add = await this.git(
        ['-c', 'core.longpaths=true', '-C', repoRoot, 'worktree', 'add', '-b', branch, target, baseCommit],
        { timeoutMs: 10 * 60_000 },
      );
      if (add.code !== 0) {
        await this.forgetRecord(runId);
        throw new WorktreeError(
          add.code === null ? 'git_missing' : 'git_failed',
          gitFailure('git worktree add failed', add),
        );
      }
      // Remember where git put the worktree's git folder, before the agent can touch anything. If this fails the
      // record still works: later calls look the folder up from the repository side.
      const gitDir = await this.findGitDir(commonDir, target);
      if (gitDir !== null) {
        try {
          const now = await this.readRegistry();
          await this.writeRegistry({
            ...now,
            records: now.records.map((r) => (r.runId === runId ? { ...r, gitDir, commonDir } : r)),
          });
        } catch {
          // Keep going; see above.
        }
      }
      return { runId, path: target, branch, baseCommit, repoRoot };
    });
  }

  /**
   * What the run changed in its worktree against the base commit: committed and uncommitted changes plus untracked
   * files. Never reads file contents. Throws a WorktreeError: refused (not the Huddle's), not_found, git_failed.
   */
  async summarizeWorktree(ref: WorktreeRef): Promise<WorktreeSummary> {
    const record = await this.ownedRecord(ref);
    if (!(await isDirectory(record.path))) throw new WorktreeError('not_found', 'the worktree folder is missing');
    const link = await this.checkLink(record);
    if (!link.ok) throw new WorktreeError('refused', `the worktree was not read: ${link.problem}`);
    // The verified git folder is named explicitly; the worktree's own `.git` file is not followed.
    const where = ['-C', record.path, `--git-dir=${link.gitDir}`, `--work-tree=${record.path}`];
    // status and diff run clean filters on changed files: every configured driver is switched off first.
    const filters = await this.filterNeutralizers(record, where);
    if (!filters.ok) throw new WorktreeError('refused', `the worktree was not read: ${filters.problem}`);
    // `--ignore-submodules=all` (with `diff.ignoreSubmodules=all` in the hardening config): git never runs inside a
    // nested repository, whose own config could name a filter (M1). A gitlink the agent added is not listed.
    const diffArgs = [
      ...filters.args,
      ...where,
      'diff',
      '-z',
      '-M',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--ignore-submodules=all',
    ];
    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'];
    const [nameStatus, numstat, status] = await Promise.all([
      this.hardGit([...diffArgs, '--name-status', record.baseCommit, '--']),
      this.hardGit([...diffArgs, '--numstat', record.baseCommit, '--']),
      this.hardGit([...filters.args, ...where, ...statusArgs]),
    ]);
    for (const [what, result] of [
      ['git diff --name-status', nameStatus],
      ['git diff --numstat', numstat],
      ['git status', status],
    ] as const) {
      if (result.code !== 0) throw new WorktreeError('git_failed', gitFailure(`${what} failed`, result));
    }
    return buildWorktreeSummary(
      {
        nameStatus: parseNameStatusZ(nameStatus.stdout),
        numstat: parseNumstatZ(numstat.stdout),
        porcelain: parsePorcelainZ(status.stdout),
      },
      this.now(),
    );
  }

  /** Keep the worktree: folder and branch stay, the registry says kept. Refused for a worktree not the Huddle's. */
  async keepWorktree(ref: WorktreeRef): Promise<KeepWorktreeResult> {
    return this.exclusive(async () => {
      let registry: WorktreeRegistry;
      try {
        registry = await this.readRegistry();
      } catch (error) {
        return { outcome: 'refused', reason: errorText(error) };
      }
      const record = registry.records.find((r) => r.runId === ref.runId);
      const problem = ownershipProblem(this.root, ref, record, this.platform);
      if (problem !== null || record === undefined) {
        return { outcome: 'refused', reason: problem ?? 'not recorded' };
      }
      if (record.state !== 'kept') {
        const kept: WorktreeRecord = { ...record, state: 'kept', keptAt: this.now() };
        try {
          await this.writeRegistry({
            ...registry,
            records: registry.records.map((r) => (r.runId === ref.runId ? kept : r)),
          });
        } catch (error) {
          return { outcome: 'refused', reason: `could not record the change: ${errorText(error)}` };
        }
      }
      return { outcome: 'kept', error: null };
    });
  }

  /**
   * Remove the worktree and its branch. Refused unless the worktree is the Huddle's (see ownershipProblem) and
   * `isProcessAlive()` is false. Steps, in the repository: `worktree unlock` (a "not locked" failure is ignored),
   * `worktree remove --force`, `worktree prune`, then `branch -D huddle/<runId>`.
   */
  async discardWorktree(ref: WorktreeRef, options: DiscardOptions): Promise<DiscardWorktreeResult> {
    return this.exclusive(async () => {
      let registry: WorktreeRegistry;
      try {
        registry = await this.readRegistry();
      } catch (error) {
        return { outcome: 'refused', reason: errorText(error) };
      }
      const record = registry.records.find((r) => r.runId === ref.runId);
      const problem = ownershipProblem(this.root, ref, record, this.platform);
      if (problem !== null || record === undefined) {
        return { outcome: 'refused', reason: problem ?? 'not recorded' };
      }
      let alive: boolean;
      try {
        alive = await options.isProcessAlive();
      } catch {
        alive = true;
      }
      if (alive) return { outcome: 'refused', reason: "the run's process is still running" };

      const problems: string[] = [];
      const repoKnown = await isDirectory(record.repoRoot);
      // Every git call below runs in the repository, never in the worktree.
      if (repoKnown && (await this.isListedWorktree(record.repoRoot, record.path))) {
        // `-p` worktrees and `git worktree lock` keep a lock; remove --force and prune skip a locked one.
        await this.hardGit(['-C', record.repoRoot, 'worktree', 'unlock', record.path]);
        const link = (await exists(record.path)) ? await this.checkLink(record) : null;
        if (link !== null && !link.ok) {
          // git would refuse (or follow) a changed link; the folder is removed below and the entry pruned.
          problems.push(`the worktree's .git link had been changed (${link.problem}); its folder was deleted directly`);
        } else {
          const removed = await this.hardGit(['-C', record.repoRoot, 'worktree', 'remove', '--force', record.path], {
            timeoutMs: 5 * 60_000,
          });
          // A process that outlived the run (a user's SessionEnd hook, M4 exit run 1) can still hold a file for a few
          // seconds: git then fails with "Permission denied". The guards above have passed, so fall through to the
          // folder delete below, which retries, and prune the entry after it.
          if (removed.code !== 0 && (await exists(record.path))) {
            problems.push(`${gitFailure('git worktree remove failed', removed)}; the folder was deleted directly`);
          }
        }
      }
      // Left over: a changed link, a folder git no longer knew about, ignored files git left, or a repository that
      // is gone. The ownership guards above have passed.
      if (await exists(record.path)) {
        try {
          // Links in the tree (the agent wrote it) are removed as links, never followed. removeTreeNoFollow retries a
          // locked file for a moment itself; the outer retries keep the older tolerance for a slow holder (about 9 s).
          for (let attempt = 0; ; attempt++) {
            try {
              await removeTreeNoFollow(record.path);
              break;
            } catch (error) {
              if (attempt >= 8) throw error;
              await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
            }
          }
        } catch (error) {
          return { outcome: 'failed', error: `the worktree folder could not be removed: ${errorText(error)}` };
        }
      }
      if (repoKnown) {
        const pruned = await this.hardGit(['-C', record.repoRoot, 'worktree', 'prune']);
        if (pruned.code !== 0) problems.push(gitFailure('git worktree prune failed', pruned));
      }
      if (!repoKnown) {
        problems.push(`the repository was not found; branch ${record.branch} was not deleted`);
      } else {
        const branchRef = await this.hardGit([
          '-C',
          record.repoRoot,
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${record.branch}`,
        ]);
        if (branchRef.code === 0) {
          const deleted = await this.hardGit(['-C', record.repoRoot, 'branch', '-D', record.branch]);
          if (deleted.code !== 0) {
            problems.push(gitFailure(`the worktree was removed, but branch ${record.branch} was not deleted`, deleted));
          }
        }
      }
      try {
        await this.writeRegistry({ ...registry, records: registry.records.filter((r) => r.runId !== ref.runId) });
      } catch (error) {
        problems.push(`the Huddle's worktree list was not updated: ${errorText(error)}`);
      }
      const error = problems.length === 0 ? null : clip(problems.join('; '), CLIP_LIMITS.error);
      return { outcome: 'discarded', error };
    });
  }

  // --- internals ---

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ownedRecord(ref: WorktreeRef): Promise<WorktreeRecord> {
    let registry: WorktreeRegistry;
    try {
      registry = await this.readRegistry();
    } catch (error) {
      throw new WorktreeError('registry', errorText(error));
    }
    const record = registry.records.find((r) => r.runId === ref.runId);
    const problem = ownershipProblem(this.root, ref, record, this.platform);
    if (problem !== null || record === undefined) throw new WorktreeError('refused', problem ?? 'not recorded');
    return record;
  }

  /** Is `worktreePath` one of the repository's worktrees? Compared in long, real form. */
  private async isListedWorktree(repoRoot: string, worktreePath: string): Promise<boolean> {
    let list = await this.hardGit(['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z']);
    if (list.code !== 0) list = await this.hardGit(['-C', repoRoot, 'worktree', 'list', '--porcelain']); // git < 2.36
    if (list.code !== 0) return false;
    const want = canonical(worktreePath);
    return parseWorktreeListPaths(list.stdout).some((p) => this.same(p, want));
  }

  /**
   * `-c` pairs that switch off every filter driver git would see for this worktree: from the repository and from the
   * worktree's verified git folder (its own `config.worktree` can add drivers). Any failure or an unsafe set refuses.
   */
  private async filterNeutralizers(
    record: WorktreeRecord,
    where: readonly string[],
  ): Promise<{ ok: true; args: string[] } | { ok: false; problem: string }> {
    const names: string[] = [];
    for (const context of [['-C', record.repoRoot], where]) {
      const listed = await this.hardGit([...context, 'config', '-z', '--get-regexp', '^filter\\.']);
      // Exit 1 with no output: no key matched.
      const none = listed.code === 1 && listed.stdout === '';
      if (listed.code !== 0 && !none) {
        return { ok: false, problem: gitFailure('its git filter drivers could not be listed', listed) };
      }
      for (const name of parseFilterDriverNames(listed.stdout)) if (!names.includes(name)) names.push(name);
    }
    const problem = filterDriversProblem(names);
    return problem === null ? { ok: true, args: filterNeutralizerArgs(names) } : { ok: false, problem };
  }

  /** git with the hardening config and environment; for every call made after a worktree exists. */
  private hardGit(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    return this.git([...hardeningConfigArgs(this.hooksOff, this.attributesOff), ...args], {
      ...options,
      env: { ...HARDENED_GIT_ENV, ...options.env },
    });
  }

  /** Same path as given, or in long, real form (8.3 short names, symlinked temp folders). */
  private same(a: string, b: string): boolean {
    return samePath(a, b, this.platform) || samePath(canonical(a), canonical(b), this.platform);
  }

  /**
   * The repository's git folder for this worktree: the `<commonDir>/worktrees/<id>` whose `gitdir` file points at
   * `<worktreePath>/.git`. Read from the repository side, never from the worktree.
   */
  private async findGitDir(commonDir: string, worktreePath: string): Promise<string | null> {
    const base = path.join(commonDir, 'worktrees');
    let names: string[];
    try {
      names = await fsp.readdir(base);
    } catch {
      return null;
    }
    const want = path.join(worktreePath, '.git');
    for (const name of names) {
      const dir = path.join(base, name);
      let text: string;
      try {
        text = await fsp.readFile(path.join(dir, 'gitdir'), 'utf8');
      } catch {
        continue;
      }
      const target = text.trim();
      if (target !== '' && this.same(path.resolve(dir, target), want)) return dir;
    }
    return null;
  }

  /** Where the worktree's git folder and the repository's common folder must be: as recorded, else looked up. */
  private async expectedLink(record: WorktreeRecord): Promise<{ gitDir: string; commonDir: string } | null> {
    if (record.gitDir !== undefined && record.commonDir !== undefined) {
      return { gitDir: record.gitDir, commonDir: record.commonDir };
    }
    // A record made before gitDir was stored: ask the repository, not the worktree.
    const common = await this.hardGit(['-C', record.repoRoot, 'rev-parse', '--git-common-dir']);
    const commonText = common.stdout.trim();
    if (common.code !== 0 || commonText === '') return null;
    const commonDir = path.resolve(record.repoRoot, commonText);
    if (!(await this.isListedWorktree(record.repoRoot, record.path))) return null;
    const gitDir = await this.findGitDir(commonDir, record.path);
    return gitDir === null ? null : { gitDir, commonDir };
  }

  /**
   * Does the worktree still lead to its own repository? Its `.git` must be a plain file whose `gitdir:` is the
   * expected git folder, that folder must sit in `<commonDir>/worktrees/`, and its `commondir` must lead back to the
   * expected common folder. Only file reads; no git runs in the worktree.
   */
  private async checkLink(
    record: WorktreeRecord,
  ): Promise<{ ok: true; gitDir: string } | { ok: false; problem: string }> {
    const expected = await this.expectedLink(record);
    if (expected === null) return { ok: false, problem: 'its repository does not list it as a worktree' };
    const dotGit = path.join(record.path, '.git');
    let text: string;
    try {
      const stat = await fsp.lstat(dotGit);
      if (!stat.isFile()) return { ok: false, problem: 'its .git is not a plain file' };
      text = await fsp.readFile(dotGit, 'utf8');
    } catch {
      return { ok: false, problem: 'its .git file is missing' };
    }
    const target = parseGitLinkFile(text);
    if (target === null) return { ok: false, problem: 'its .git file is not a git link' };
    if (!this.same(path.resolve(record.path, target), expected.gitDir)) {
      return { ok: false, problem: 'its .git file points to another git folder' };
    }
    const worktreesDir = path.join(expected.commonDir, 'worktrees');
    if (
      !isPathInside(worktreesDir, expected.gitDir, this.platform) &&
      !isPathInside(canonical(worktreesDir), canonical(expected.gitDir), this.platform)
    ) {
      return { ok: false, problem: 'its git folder is not inside the repository' };
    }
    let commondir: string;
    try {
      commondir = (await fsp.readFile(path.join(expected.gitDir, 'commondir'), 'utf8')).trim();
    } catch {
      return { ok: false, problem: 'its git folder has no commondir file' };
    }
    if (commondir === '' || !this.same(path.resolve(expected.gitDir, commondir), expected.commonDir)) {
      return { ok: false, problem: 'its git folder points to another repository' };
    }
    return { ok: true, gitDir: expected.gitDir };
  }

  /** Remove a record written before `git worktree add` failed. Best effort. */
  private async forgetRecord(runId: string): Promise<void> {
    try {
      const registry = await this.readRegistry();
      await this.writeRegistry({ ...registry, records: registry.records.filter((r) => r.runId !== runId) });
    } catch {
      // The record stays; discard of a worktree that was never made only removes the record.
    }
  }

  /** The registry; a missing file is empty. Throws when the file exists but cannot be read. */
  private async readRegistry(): Promise<WorktreeRegistry> {
    let text: string | null;
    try {
      text = await fsp.readFile(this.registryPath, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      text = null;
    }
    return parseWorktreeRegistry(text);
  }

  private async writeRegistry(registry: WorktreeRegistry): Promise<void> {
    if (registry.corrupt) {
      // Keep the unreadable file for the owner instead of overwriting it.
      await fsp.rename(this.registryPath, `${this.registryPath}.bad-${String(this.now())}`).catch(() => undefined);
    }
    await writeTextAtomic(this.registryPath, serializeWorktreeRegistry({ ...registry, corrupt: false }));
  }
}
