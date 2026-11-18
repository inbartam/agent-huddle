/**
 * Keep and Discard on a run that is no longer in the live state (M5 WP5, fix a): a managed run that ended days ago is
 * not replayed at start, so its root is not in the state; the core rebuilds it from its stored run and worktree events,
 * or, when those were deleted too, finds it in the worktree registry. Every M4 check still applies (the manager's
 * ownership and `.git` link checks, kept or discarded refused). Real git in a temp repository (hooks and global config
 * off); skipped when git is not on PATH.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventOfType, HuddleEvent } from '@huddle/shared';
import { SqliteEventStore } from '../store/sqlite-store.js';
import { HuddleCore } from './huddle-core.js';
import { createGitRunner, WorktreeManager, type GitRunner, type WorktreeEntry } from './worktree.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function gitOnPath(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitOnPath();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  root: string;
  dataDir: string;
  worktreeData: string;
  repo: string;
  git: GitRunner;
}

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-old-wt-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = createGitRunner({
    configArgs: [
      '-c',
      `core.hooksPath=${path.join(root, 'no-such-hooks-dir')}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Huddle Test',
      '-c',
      'user.email=huddle-test@example.invalid',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.autocrlf=false',
    ],
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-gitconfig') },
  });
  const env: Env = {
    root,
    dataDir: path.join(root, 'data'),
    worktreeData: path.join(root, 'local'),
    repo: path.join(root, 'repo'),
    git,
  };
  await fsp.mkdir(path.join(root, 'claude'), { recursive: true });
  await fsp.mkdir(env.dataDir, { recursive: true });
  await fsp.mkdir(env.repo, { recursive: true });
  await fsp.writeFile(path.join(root, 'f.mjs'), '// forwarder\n');
  await fsp.writeFile(path.join(env.repo, 'README.md'), 'hello\n');
  for (const args of [['init'], ['add', '.'], ['commit', '-m', 'first']]) {
    const r = await git(['-C', env.repo, ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
  return env;
}

function makeCore(env: Env): HuddleCore {
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: path.join(env.root, 'claude'),
    cwd: null,
    userAgentsDir: null,
    port: 0,
    now: () => NOW,
    forwarderSource: path.join(env.root, 'f.mjs'),
    newToken: () => 'test-token-0123456789',
    launch: { worktreeDataDir: env.worktreeData, git: env.git },
    history: { backfillAtStart: false, retentionAtStart: false },
  });
  cleanups.push(() => core.dispose());
  return core;
}

/** The events a run with a worktree leaves, ended `daysAgo` days ago by run.exited (taskkill: no SessionEnd). */
function runLog(runId: string, wt: WorktreeEntry, daysAgo: number): HuddleEvent[] {
  const t = NOW - daysAgo * DAY;
  const base = { sessionId: runId, agentKey: runId, source: 'huddle' as const };
  const created: EventOfType<'worktree.created'> = {
    ...base,
    id: `${runId}:wt`,
    type: 'worktree.created',
    ts: t,
    runId,
    path: wt.path,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    repoRoot: wt.repoRoot,
  };
  const launched: EventOfType<'run.launched'> = {
    ...base,
    id: `${runId}:launched`,
    type: 'run.launched',
    ts: t + 1,
    runId,
    claudeSessionId: runId,
    templateId: null,
    cwd: wt.path,
    model: 'sonnet',
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: { path: wt.path, branch: wt.branch },
  };
  const exited: EventOfType<'run.exited'> = {
    ...base,
    id: `${runId}:exited`,
    type: 'run.exited',
    ts: t + 60_000,
    runId,
    exitCode: null,
    how: 'stopped',
    error: null,
  };
  return [created, launched, exited];
}

async function seed(env: Env, events: readonly HuddleEvent[]): Promise<void> {
  const store = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite'), flushDelayMs: 1 });
  try {
    const done = store.append(events);
    await store.flush();
    await done;
  } finally {
    await store.close();
  }
}

describe.skipIf(!HAS_GIT)('worktree commands on runs no longer in the live state', () => {
  it('discards the worktree of a run that ended 3 days ago, after a restart', async () => {
    const env = await makeEnv();
    const runId = randomUUID();
    const wt = await new WorktreeManager({ dataDir: env.worktreeData, git: env.git }).createWorktree({
      repoDir: env.repo,
      runId,
    });
    await seed(env, runLog(runId, wt, 3));
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(core.getState().agents[runId]).toBeUndefined();

    const result = await core.command({ type: 'run.discardWorktree', runId });
    expect(result).toEqual({ ok: true });
    expect(existsSync(wt.path)).toBe(false);
    const branch = await env.git(['-C', env.repo, 'show-ref', '--verify', '--quiet', `refs/heads/${wt.branch}`]);
    expect(branch.code).not.toBe(0);
    // Discarded once: a second discard is refused by the M4 rules (the stored worktree.closed says discarded).
    expect(await core.command({ type: 'run.discardWorktree', runId })).toMatchObject({ ok: false });
  }, 60_000);

  it('keeps it, and then refuses to discard a kept one, as for a run in the state', async () => {
    const env = await makeEnv();
    const runId = randomUUID();
    const wt = await new WorktreeManager({ dataDir: env.worktreeData, git: env.git }).createWorktree({
      repoDir: env.repo,
      runId,
    });
    await seed(env, runLog(runId, wt, 5));
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(await core.command({ type: 'run.keepWorktree', runId })).toEqual({ ok: true });
    expect(await core.command({ type: 'run.discardWorktree', runId })).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(existsSync(wt.path)).toBe(true);
  }, 60_000);

  it('finds the run in the worktree registry when its events were deleted, and still checks the .git link', async () => {
    const env = await makeEnv();
    const runId = randomUUID();
    const manager = new WorktreeManager({ dataDir: env.worktreeData, git: env.git });
    const wt = await manager.createWorktree({ repoDir: env.repo, runId });
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    // A changed .git link (pointing elsewhere) is not followed: the folder is deleted directly and that is reported.
    // Git for Windows makes .git hidden, and overwriting a hidden file is EPERM, so it is removed first.
    await fsp.rm(path.join(wt.path, '.git'));
    await fsp.writeFile(path.join(wt.path, '.git'), `gitdir: ${path.join(env.root, 'elsewhere')}\n`);
    const result = await core.command({ type: 'run.discardWorktree', runId });
    expect(result.ok).toBe(true);
    expect(result.ok && result.detail).toMatch(/link had been changed/);
    expect(existsSync(wt.path)).toBe(false);
    expect((await manager.listWorktrees()).some((r) => r.runId === runId)).toBe(false);
  }, 60_000);

  it('answers not_found for a run nobody knows', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(await core.command({ type: 'run.discardWorktree', runId: randomUUID() })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  }, 60_000);
});
