/**
 * worktree.ts against a real git repository in os.tmpdir(). Every git call runs with the user's global and system
 * config switched off and hooks pointed at a folder that does not exist, so nothing of the user's runs.
 */
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorktreeError,
  WorktreeManager,
  createGitRunner,
  samePath,
  type GitRunner,
  type WorktreeEntry,
} from './worktree.js';

function gitOnPath(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitOnPath();

let tmp: string;
let repo: string;
let dataDir: string;
let git: GitRunner;

function isolatedGit(): GitRunner {
  const nowhere = path.join(tmp, 'no-such-hooks-dir');
  return createGitRunner({
    configArgs: [
      '-c',
      `core.hooksPath=${nowhere}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      '-c',
      'user.name=Huddle Test',
      '-c',
      'user.email=huddle-test@example.invalid',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.autocrlf=false',
      // No core.fsmonitor override here: the hardening tests need this plain runner to run a planted fsmonitor.
    ],
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'no-global-gitconfig') },
  });
}

/** Run git in `cwd`; fail the test on a non-zero exit. */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(['-C', cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${String(r.code)}): ${r.stderr}${r.error ?? ''}`);
  return r.stdout;
}

async function branchExists(name: string): Promise<boolean> {
  return (await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0;
}

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(
    () => true,
    () => false,
  );
}

async function listedWorktrees(): Promise<string[]> {
  const out = await g(repo, 'worktree', 'list', '--porcelain');
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

function manager(runner: GitRunner = git): WorktreeManager {
  let t = 1000;
  return new WorktreeManager({ dataDir, git: runner, now: () => (t += 1) });
}

const notAlive = { isProcessAlive: () => false };

describe.skipIf(!HAS_GIT)('worktrees against a real git repository (skipped when git is not on PATH)', () => {
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-wt-'));
    repo = path.join(tmp, 'repo');
    dataDir = path.join(tmp, 'data');
    git = isolatedGit();
    await fsp.mkdir(repo);
    await g(repo, 'init', '--quiet');
    await fsp.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    await fsp.writeFile(path.join(repo, 'b.txt'), 'bee\nbee\nbee\nbee\n');
    await fsp.writeFile(path.join(repo, 'gone.txt'), 'x\ny\n');
    await fsp.writeFile(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await g(repo, 'add', '-A');
    await g(repo, 'commit', '--quiet', '-m', 'base');
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('creates the worktree on huddle/<runId> from HEAD and records it', async () => {
    const m = manager();
    const entry = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const head = (await g(repo, 'rev-parse', 'HEAD')).trim();
    expect(entry.runId).toBe('run-1');
    expect(entry.branch).toBe('huddle/run-1');
    expect(entry.baseCommit).toBe(head);
    expect(samePath(entry.path, path.join(dataDir, 'worktrees', 'run-1'))).toBe(true);
    expect(samePath(await fsp.realpath(entry.repoRoot), await fsp.realpath(repo))).toBe(true);
    expect(await fsp.readFile(path.join(entry.path, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(await branchExists('huddle/run-1')).toBe(true);
    expect((await g(entry.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('huddle/run-1');
    const records = await m.listWorktrees();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ runId: 'run-1', branch: 'huddle/run-1', baseCommit: head, state: 'active' });
    // Ownership survives a restart: a new manager reads the same registry.
    expect(await manager().listWorktrees()).toEqual(records);
  });

  it('creating from a subfolder uses the repository root; a second create for the run is refused', async () => {
    await fsp.mkdir(path.join(repo, 'sub'));
    const m = manager();
    const entry = await m.createWorktree({ repoDir: path.join(repo, 'sub'), runId: 'run-1' });
    expect(samePath(await fsp.realpath(entry.repoRoot), await fsp.realpath(repo))).toBe(true);
    await expect(m.createWorktree({ repoDir: repo, runId: 'run-1' })).rejects.toMatchObject({ code: 'exists' });
    expect(await m.listWorktrees()).toHaveLength(1);
  });

  it('refuses a target folder or branch that already exists, and records nothing', async () => {
    const m = manager();
    await fsp.mkdir(path.join(dataDir, 'worktrees', 'taken'), { recursive: true });
    await expect(m.createWorktree({ repoDir: repo, runId: 'taken' })).rejects.toMatchObject({ code: 'exists' });
    await g(repo, 'branch', 'huddle/has-branch');
    await expect(m.createWorktree({ repoDir: repo, runId: 'has-branch' })).rejects.toMatchObject({ code: 'exists' });
    expect(await m.listWorktrees()).toEqual([]);
  });

  it('summarizes committed, uncommitted, renamed, deleted, binary and untracked changes against the base', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    // committed on the run's branch
    await fsp.writeFile(path.join(wt.path, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await g(wt.path, 'commit', '--quiet', '-am', 'run change');
    // uncommitted on top
    await fsp.writeFile(path.join(wt.path, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    await g(wt.path, 'mv', 'b.txt', 'b2.txt');
    await fsp.rm(path.join(wt.path, 'gone.txt'));
    await fsp.writeFile(path.join(wt.path, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 255, 7]));
    await fsp.writeFile(path.join(wt.path, 'staged.txt'), 'new\n');
    await g(wt.path, 'add', 'staged.txt');
    await fsp.mkdir(path.join(wt.path, 'notes'));
    await fsp.writeFile(path.join(wt.path, 'notes', 'todo.md'), 'untracked\nlines\n');

    const summary = await m.summarizeWorktree(wt);
    expect(summary.files).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b2.txt', status: 'renamed' },
      { path: 'bin.dat', status: 'modified' },
      { path: 'gone.txt', status: 'deleted' },
      { path: 'notes/todo.md', status: 'untracked' },
      { path: 'staged.txt', status: 'added' },
    ]);
    expect(summary.filesChanged).toBe(6);
    expect(summary.untracked).toBe(1);
    // a.txt +2, staged.txt +1; gone.txt -2; rename 0; binary 0; untracked lines are never read.
    expect(summary.insertions).toBe(3);
    expect(summary.deletions).toBe(2);
    expect(summary.summarizedAt).toBeGreaterThan(1000);
    // Reading never left a lock behind.
    expect(await exists(path.join(repo, '.git', 'worktrees', 'run-1', 'index.lock'))).toBe(false);
  });

  it('a clean worktree summarizes to nothing; more than 50 files are counted but not all listed', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    expect(await m.summarizeWorktree(wt)).toMatchObject({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      untracked: 0,
      files: [],
    });
    await fsp.mkdir(path.join(wt.path, 'gen'));
    for (let i = 0; i < 60; i++) {
      await fsp.writeFile(path.join(wt.path, 'gen', `f${String(i).padStart(2, '0')}.txt`), 'x\n');
    }
    const summary = await m.summarizeWorktree(wt);
    expect(summary.filesChanged).toBe(60);
    expect(summary.untracked).toBe(60);
    expect(summary.files).toHaveLength(50);
    expect(summary.files[0]).toEqual({ path: 'gen/f00.txt', status: 'untracked' });
  });

  it('keep marks the record kept and leaves folder and branch', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    expect(await m.keepWorktree(wt)).toEqual({ outcome: 'kept', error: null });
    expect(await m.keepWorktree(wt)).toEqual({ outcome: 'kept', error: null });
    expect((await m.listWorktrees())[0]).toMatchObject({ runId: 'run-1', state: 'kept' });
    expect(await exists(wt.path)).toBe(true);
    expect(await branchExists('huddle/run-1')).toBe(true);
    expect(await m.keepWorktree({ runId: 'other', path: path.join(m.root, 'other') })).toMatchObject({
      outcome: 'refused',
    });
  });

  it('discard removes the folder, the worktree entry and the branch, even with changes and a lock', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    await fsp.writeFile(path.join(wt.path, 'a.txt'), 'changed\n');
    await fsp.writeFile(path.join(wt.path, 'untracked.txt'), 'u\n');
    await g(repo, 'worktree', 'lock', '--reason', 'like claude -p', wt.path);

    expect(await m.discardWorktree(wt, notAlive)).toEqual({ outcome: 'discarded', error: null });
    expect(await exists(wt.path)).toBe(false);
    expect(await branchExists('huddle/run-1')).toBe(false);
    const listed = await listedWorktrees();
    expect(listed).toHaveLength(1);
    expect(listed.some((p) => samePath(p, wt.path))).toBe(false);
    expect(await m.listWorktrees()).toEqual([]);
    // Gone from the registry: a second discard is refused, not repeated.
    expect(await m.discardWorktree(wt, notAlive)).toMatchObject({ outcome: 'refused' });
    // The main checkout is untouched.
    expect(await fsp.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('discard succeeds when a process holds a file in the worktree for a moment after the run (M4 exit run 1)', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const held = path.join(wt.path, 'held.json');
    await fsp.writeFile(held, '{}');
    // On Windows an open handle blocks the delete (EBUSY/EPERM) until it closes; elsewhere it does not block at all.
    const handle = await fsp.open(held, 'r');
    const release = setTimeout(() => void handle.close(), 1200);
    try {
      const result = await m.discardWorktree(wt, notAlive);
      expect(result.outcome).toBe('discarded');
      expect(await exists(wt.path)).toBe(false);
      expect(await branchExists('huddle/run-1')).toBe(false);
      expect((await listedWorktrees()).some((p) => samePath(p, wt.path))).toBe(false);
    } finally {
      clearTimeout(release);
      await handle.close().catch(() => undefined);
    }
  }, 30_000);

  it('discard removes a junction inside the worktree as a link and never touches its target (A2-03)', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const target = await fsp.mkdtemp(path.join(tmp, 'junction-target-'));
    const precious = path.join(target, 'precious.txt');
    await fsp.writeFile(precious, 'keep me\n');
    await fsp.symlink(target, path.join(wt.path, 'link'), 'junction');
    // A repository that is gone sends the discard to the direct folder delete, the path that must not follow links.
    await fsp.rm(repo, { recursive: true, force: true });

    await m.discardWorktree(wt, notAlive);
    expect(await exists(wt.path)).toBe(false);
    expect(await fsp.readFile(precious, 'utf8')).toBe('keep me\n');
  });

  it('discard of a kept worktree works too', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    await m.keepWorktree(wt);
    expect(await m.discardWorktree(wt, notAlive)).toEqual({ outcome: 'discarded', error: null });
    expect(await exists(wt.path)).toBe(false);
  });

  it('discard refuses a path outside the worktrees root, also when the registry was edited', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const outside = await m.discardWorktree({ runId: 'run-1', path: repo }, notAlive);
    expect(outside).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/outside/) as unknown });
    expect(await exists(path.join(repo, '.git'))).toBe(true);

    // Someone points the record at the main checkout: still refused.
    const file = JSON.parse(await fsp.readFile(m.registryPath, 'utf8')) as { worktrees: { path: string }[] };
    const [first] = file.worktrees;
    if (first === undefined) throw new Error('no record');
    first.path = repo;
    await fsp.writeFile(m.registryPath, JSON.stringify(file));
    expect(await m.discardWorktree({ runId: 'run-1', path: repo }, notAlive)).toMatchObject({ outcome: 'refused' });
    expect(await m.discardWorktree(wt, notAlive)).toMatchObject({ outcome: 'refused' });
    expect(await exists(wt.path)).toBe(true);
    expect(await exists(path.join(repo, 'a.txt'))).toBe(true);
    expect(await branchExists('huddle/run-1')).toBe(true);
  });

  it('discard refuses a worktree in the root that the Huddle did not record', async () => {
    const m = manager();
    const manual = path.join(m.root, 'manual');
    await fsp.mkdir(m.root, { recursive: true });
    await g(repo, 'worktree', 'add', '--quiet', '-b', 'huddle/manual', manual);
    const result = await m.discardWorktree({ runId: 'manual', path: manual }, notAlive);
    expect(result).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/not created/) as unknown });
    expect(await exists(manual)).toBe(true);
    expect(await branchExists('huddle/manual')).toBe(true);
    await expect(m.summarizeWorktree({ runId: 'manual', path: manual })).rejects.toMatchObject({ code: 'refused' });
  });

  it('discard refuses while the run process is alive, or when that cannot be told', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    expect(await m.discardWorktree(wt, { isProcessAlive: () => true })).toMatchObject({ outcome: 'refused' });
    expect(await m.discardWorktree(wt, { isProcessAlive: () => Promise.resolve(true) })).toMatchObject({
      outcome: 'refused',
    });
    const throws = await m.discardWorktree(wt, {
      isProcessAlive: () => {
        throw new Error('no pid');
      },
    });
    expect(throws).toMatchObject({ outcome: 'refused' });
    expect(await exists(wt.path)).toBe(true);
    expect(await branchExists('huddle/run-1')).toBe(true);
    expect(await m.listWorktrees()).toHaveLength(1);
  });

  it('a branch that cannot be deleted gives discarded with an error', async () => {
    const failBranchDelete: GitRunner = (args, options) =>
      args.includes('branch') && args.includes('-D')
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'error: simulated branch failure\n', error: null })
        : git(args, options);
    const m = manager(failBranchDelete);
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const result = await m.discardWorktree(wt, notAlive);
    expect(result.outcome).toBe('discarded');
    expect(result).toMatchObject({ error: expect.stringMatching(/branch huddle\/run-1 was not deleted/) as unknown });
    expect(await exists(wt.path)).toBe(false);
    expect(await branchExists('huddle/run-1')).toBe(true);
    expect(await m.listWorktrees()).toEqual([]);
  });

  it('a worktree remove that fails falls through to deleting the folder, then prunes (busy folder, M4 exit run 1)', async () => {
    const flaky: GitRunner = (args, options) =>
      args.includes('remove')
        ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: simulated busy folder\n', error: null })
        : git(args, options);
    const m = manager(flaky);
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const result = await m.discardWorktree(wt, notAlive);
    expect(result).toMatchObject({ outcome: 'discarded', error: expect.stringMatching(/simulated busy/) as unknown });
    expect(await exists(wt.path)).toBe(false);
    expect((await listedWorktrees()).some((p) => samePath(p, wt.path))).toBe(false);
    expect(await branchExists('huddle/run-1')).toBe(false);
    expect(await m.listWorktrees()).toEqual([]);
  });

  it('discard of a recorded worktree whose folder is already gone still deletes the branch', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    await fsp.rm(wt.path, { recursive: true, force: true });
    expect(await m.discardWorktree(wt, notAlive)).toEqual({ outcome: 'discarded', error: null });
    expect(await branchExists('huddle/run-1')).toBe(false);
    expect(await listedWorktrees()).toHaveLength(1);
  });

  it('fails cleanly for a folder that is not a repository, a repository with no commits, or a missing folder', async () => {
    const m = manager();
    const plain = path.join(tmp, 'plain');
    await fsp.mkdir(plain);
    // A plain folder under tmp could still be inside some repo if tmp were; use a ceiling so discovery stops at tmp.
    const ceiling: GitRunner = (args, options) =>
      git(args, { ...options, env: { ...options?.env, GIT_CEILING_DIRECTORIES: tmp } });
    const mc = manager(ceiling);
    const err = await mc.createWorktree({ repoDir: plain, runId: 'run-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ code: 'not_a_repo', message: 'folder is not a git repository' });

    const empty = path.join(tmp, 'empty');
    await fsp.mkdir(empty);
    await g(empty, 'init', '--quiet');
    await expect(mc.createWorktree({ repoDir: empty, runId: 'run-1' })).rejects.toMatchObject({
      code: 'no_commits',
    });
    await expect(m.createWorktree({ repoDir: path.join(tmp, 'missing'), runId: 'run-1' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await m.listWorktrees()).toEqual([]);
    expect(await exists(path.join(m.root, 'run-1'))).toBe(false);
  });

  it('rejects run ids with "..", slashes or device names before running git', async () => {
    const calls: string[][] = [];
    const spy: GitRunner = (args, options) => {
      calls.push([...args]);
      return git(args, options);
    };
    const m = manager(spy);
    for (const runId of ['..', '../escape', 'a/b', 'a\\b', 'a..b', 'con', 'x.lock', '.git']) {
      await expect(m.createWorktree({ repoDir: repo, runId }), runId).rejects.toMatchObject({ code: 'bad_run_id' });
    }
    expect(calls).toEqual([]);
    expect(await exists(path.join(tmp, 'escape'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'refuses a UNC, device or relative repository folder before any git call (L3)',
    async () => {
      const calls: string[][] = [];
      const spy: GitRunner = (args, options) => {
        calls.push([...args]);
        return git(args, options);
      };
      const m = manager(spy);
      for (const repoDir of ['\\\\host\\share\\repo', '\\\\?\\C:\\repo', '\\??\\UNC\\host\\share', 'relative\\repo']) {
        await expect(m.createWorktree({ repoDir, runId: 'run-1' }), repoDir).rejects.toMatchObject({
          code: 'refused',
        });
      }
      expect(calls).toEqual([]);
      expect(await m.listWorktrees()).toEqual([]);
    },
  );

  it('reports a missing git as git_missing', async () => {
    const m = manager(createGitRunner({ gitPath: path.join(tmp, 'no-such-git') }));
    await expect(m.createWorktree({ repoDir: repo, runId: 'run-1' })).rejects.toMatchObject({
      code: 'git_missing',
    });
  });

  it('two creates at once for different runs both land in the registry', async () => {
    const m = manager();
    const results: WorktreeEntry[] = await Promise.all([
      m.createWorktree({ repoDir: repo, runId: 'run-a' }),
      m.createWorktree({ repoDir: repo, runId: 'run-b' }),
    ]);
    expect(results.map((r) => r.branch).sort()).toEqual(['huddle/run-a', 'huddle/run-b']);
    expect((await m.listWorktrees()).map((r) => r.runId).sort()).toEqual(['run-a', 'run-b']);
  });

  // --- an agent that can write files in its worktree must not make the Huddle's own git calls run its code ---

  /** A core.fsmonitor value that runs node and writes `marker` (git runs the hook through sh, also on Windows). */
  async function plantFsmonitor(marker: string): Promise<string> {
    const script = path.join(tmp, 'fsmonitor-hook.cjs');
    await fsp.writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const fwd = (p: string): string => p.split(path.sep).join('/');
    return `"${fwd(process.execPath)}" "${fwd(script)}"`;
  }

  /** A second repository whose config runs the planted fsmonitor; returns its .git folder. */
  async function fakeGitDir(command: string): Promise<string> {
    const fake = path.join(tmp, 'fake');
    await fsp.mkdir(fake);
    await g(fake, 'init', '--quiet');
    await g(fake, 'config', 'core.fsmonitor', command);
    return path.join(fake, '.git');
  }

  /** Point the worktree's .git link elsewhere. Git for Windows makes it hidden, and overwriting a hidden file is EPERM. */
  async function repoint(worktree: string, gitDir: string): Promise<void> {
    await fsp.rm(path.join(worktree, '.git'));
    await fsp.writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  }

  it('a worktree whose .git was repointed is refused for summarize; the fake fsmonitor never runs', async () => {
    const marker = path.join(tmp, 'marker-repointed.txt');
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const fake = await fakeGitDir(await plantFsmonitor(marker));
    await repoint(wt.path, fake);

    // Control: plain git that follows the link does run it, so the test below means something.
    await git(['-C', wt.path, 'status', '--porcelain']);
    expect(await exists(marker)).toBe(true);
    await fsp.rm(marker);

    const err = await m.summarizeWorktree(wt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ code: 'refused', message: expect.stringMatching(/\.git/) as unknown });
    expect(await exists(marker)).toBe(false);

    // Discard still works: the folder is removed directly and the entry pruned from the repository.
    const result = await m.discardWorktree(wt, notAlive);
    expect(result).toMatchObject({
      outcome: 'discarded',
      error: expect.stringMatching(/link had been changed/) as unknown,
    });
    expect(await exists(wt.path)).toBe(false);
    expect(await branchExists('huddle/run-1')).toBe(false);
    expect(await listedWorktrees()).toHaveLength(1);
    expect(await m.listWorktrees()).toEqual([]);
    expect(await exists(marker)).toBe(false);
    expect(await exists(path.join(tmp, 'fake', '.git', 'HEAD'))).toBe(true);
  });

  it("an fsmonitor in the repository's shared config is overridden by the Huddle's own git calls", async () => {
    const marker = path.join(tmp, 'marker-shared.txt');
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    await fsp.writeFile(path.join(wt.path, 'new.txt'), 'n\n');
    await g(repo, 'config', 'core.fsmonitor', await plantFsmonitor(marker));

    await git(['-C', wt.path, 'status', '--porcelain']);
    expect(await exists(marker)).toBe(true);
    await fsp.rm(marker);

    const summary = await m.summarizeWorktree(wt);
    expect(summary.files).toEqual([{ path: 'new.txt', status: 'untracked' }]);
    expect(await exists(marker)).toBe(false);
    expect(await m.discardWorktree(wt, notAlive)).toEqual({ outcome: 'discarded', error: null });
    expect(await exists(marker)).toBe(false);
  });

  it('records the git folder at create and refuses a commondir that points to another repository', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const [record] = await m.listWorktrees();
    expect(record?.gitDir).toBeDefined();
    expect(
      samePath(
        await fsp.realpath(record?.gitDir ?? ''),
        await fsp.realpath(path.join(repo, '.git', 'worktrees', 'run-1')),
      ),
    ).toBe(true);
    expect(samePath(await fsp.realpath(record?.commonDir ?? ''), await fsp.realpath(path.join(repo, '.git')))).toBe(
      true,
    );

    const fake = await fakeGitDir('false');
    await fsp.writeFile(path.join(record?.gitDir ?? '', 'commondir'), `${fake}\n`);
    await expect(m.summarizeWorktree(wt)).rejects.toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/another repository/) as unknown,
    });
  });

  it('refuses a .git that is a folder instead of a link file', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    await fsp.rm(path.join(wt.path, '.git'));
    await fsp.mkdir(path.join(wt.path, '.git'));
    await expect(m.summarizeWorktree(wt)).rejects.toMatchObject({ code: 'refused' });
    expect((await m.discardWorktree(wt, notAlive)).outcome).toBe('discarded');
    expect(await exists(wt.path)).toBe(false);
  });

  it('a record made before gitDir was stored is checked against the repository side', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const file = JSON.parse(await fsp.readFile(m.registryPath, 'utf8')) as { worktrees: Record<string, unknown>[] };
    for (const r of file.worktrees) {
      delete r.gitDir;
      delete r.commonDir;
    }
    await fsp.writeFile(m.registryPath, JSON.stringify(file));
    expect((await m.listWorktrees())[0]?.gitDir).toBeUndefined();

    await fsp.writeFile(path.join(wt.path, 'x.txt'), 'x\n');
    expect((await m.summarizeWorktree(wt)).untracked).toBe(1);

    const fake = await fakeGitDir('false');
    await repoint(wt.path, fake);
    await expect(m.summarizeWorktree(wt)).rejects.toMatchObject({ code: 'refused' });
  });

  it('every git call after create carries the hardening config; worktree add sets core.longpaths', async () => {
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    const spy: GitRunner = (args, options) => {
      calls.push({ args: [...args], env: { ...options?.env } });
      return git(args, options);
    };
    const m = manager(spy);
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const add = calls.find((c) => c.args.includes('add'));
    expect(add?.args.slice(0, 2)).toEqual(['-c', 'core.longpaths=true']);
    const afterCreate = calls.length;

    await m.summarizeWorktree(wt);
    await m.keepWorktree(wt);
    await m.discardWorktree(wt, notAlive);
    const later = calls.slice(afterCreate);
    expect(later.length).toBeGreaterThan(5);
    const hooksOff = path.join(dataDir, 'git-hooks-disabled');
    const attributesOff = path.join(dataDir, 'git-attributes-disabled');
    for (const call of later) {
      const pairs = call.args.join('\n');
      for (const setting of [
        'core.fsmonitor=false',
        `core.hooksPath=${hooksOff}`,
        `core.attributesFile=${attributesOff}`,
        'diff.external=',
        'core.untrackedCache=false',
        'core.pager=cat',
        'credential.helper=',
        'protocol.allow=never',
        'diff.ignoreSubmodules=all',
        'status.submoduleSummary=false',
        'submodule.recurse=false',
      ]) {
        expect(pairs, call.args.join(' ')).toContain(`-c\n${setting}`);
      }
      // status and diff never look into nested repositories (M1).
      if (call.args.includes('status') || call.args.includes('diff')) {
        expect(call.args, call.args.join(' ')).toContain('--ignore-submodules=all');
      }
      expect(call.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' });
      // Nothing runs in the worktree by following its .git file.
      const at = call.args.indexOf('-C');
      if (at >= 0 && samePath(call.args[at + 1] ?? '', wt.path)) {
        expect(call.args.some((a) => a.startsWith('--git-dir='))).toBe(true);
      }
    }
    expect(await exists(hooksOff)).toBe(false);
    expect(await exists(attributesOff)).toBe(false);
  });

  // --- clean/smudge filters: status and diff run them on changed files ---

  /** A filter command that writes `marker`, then passes its input through (a well-behaved clean filter). */
  async function plantFilter(marker: string, name: string): Promise<string> {
    const script = path.join(tmp, `filter-${name}.cjs`);
    await fsp.writeFile(
      script,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdin.pipe(process.stdout);\n`,
    );
    const fwd = (p: string): string => p.split(path.sep).join('/');
    return `"${fwd(process.execPath)}" "${fwd(script)}"`;
  }

  async function filterScenario(driver: string, marker: string): Promise<WorktreeEntry> {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    await g(repo, 'config', `filter.${driver}.clean`, await plantFilter(marker, 'f'));
    await g(repo, 'config', `filter.${driver}.required`, 'true');
    await fsp.writeFile(path.join(wt.path, '.gitattributes'), `* filter=${driver}\n`);
    await fsp.writeFile(path.join(wt.path, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    // Control: plain git status runs the clean filter on the changed file.
    await git(['-C', wt.path, 'status', '--porcelain']);
    expect(await exists(marker)).toBe(true);
    await fsp.rm(marker);
    return wt;
  }

  it('a clean filter in the shared config never runs during summarize, and the summary is still right', async () => {
    const marker = path.join(tmp, 'marker-filter.txt');
    const wt = await filterScenario('evil', marker);
    const summary = await manager().summarizeWorktree(wt);
    expect(await exists(marker)).toBe(false);
    expect(summary).toMatchObject({
      filesChanged: 2,
      insertions: 1,
      deletions: 0,
      untracked: 1,
      files: [
        { path: '.gitattributes', status: 'untracked' },
        { path: 'a.txt', status: 'modified' },
      ],
    });
  });

  it('a filter driver whose name contains dots is switched off too', async () => {
    const marker = path.join(tmp, 'marker-dots.txt');
    const wt = await filterScenario('evil.dots.v2', marker);
    const summary = await manager().summarizeWorktree(wt);
    expect(await exists(marker)).toBe(false);
    expect(summary.files).toContainEqual({ path: 'a.txt', status: 'modified' });
  });

  it('refuses to summarize with more than 64 filter drivers, or one whose name has "="', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const configFile = path.join(repo, '.git', 'config');
    const original = await fsp.readFile(configFile, 'utf8');
    const many = Array.from({ length: 65 }, (_, i) => `[filter "f${String(i)}"]\n\tclean = cat\n`).join('');
    await fsp.writeFile(configFile, original + many);
    await expect(m.summarizeWorktree(wt)).rejects.toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/65 git filter drivers/) as unknown,
    });
    await fsp.writeFile(configFile, `${original}[filter "a=b"]\n\tclean = cat\n`);
    await expect(m.summarizeWorktree(wt)).rejects.toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/cannot be overridden/) as unknown,
    });
    await fsp.writeFile(configFile, original);
    expect((await m.summarizeWorktree(wt)).filesChanged).toBe(0);
  });

  it('refuses to summarize when the filter drivers cannot be listed', async () => {
    const failConfig: GitRunner = (args, options) =>
      args.includes('--get-regexp')
        ? Promise.resolve({ code: 3, stdout: '', stderr: 'error: simulated bad config\n', error: null })
        : git(args, options);
    const calls: string[][] = [];
    const spy: GitRunner = (args, options) => {
      calls.push([...args]);
      return failConfig(args, options);
    };
    const m = manager(spy);
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    calls.length = 0;
    await expect(m.summarizeWorktree(wt)).rejects.toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/filter drivers could not be listed/) as unknown,
    });
    expect(calls.some((c) => c.includes('status') || c.includes('diff'))).toBe(false);
  });

  // --- a nested repository the agent made: status/diff must not recurse into it and run its own config (M1) ---

  /**
   * In the worktree: `git init sub`, commit a file, give `sub` its own clean filter (a driver name the Huddle never
   * sees, so `filterNeutralizerArgs` cannot blank it) and `* filter=x`, then stage `sub` as a gitlink. Returns a
   * function that changes the nested file without changing its size (so git must hash it, running the filter).
   */
  async function plantNestedRepo(worktree: string, marker: string): Promise<() => Promise<void>> {
    const sub = path.join(worktree, 'sub');
    await fsp.mkdir(sub);
    await g(sub, 'init', '--quiet');
    await fsp.writeFile(path.join(sub, 's.txt'), 's\n');
    await g(sub, 'add', 's.txt');
    await g(sub, 'commit', '--quiet', '-m', 'nested');
    await g(sub, 'config', 'filter.nested-only.clean', await plantFilter(marker, 'nested'));
    await fsp.writeFile(path.join(sub, '.gitattributes'), '* filter=nested-only\n');
    await g(worktree, 'add', 'sub');
    let n = 0;
    return async () => {
      const file = path.join(sub, 's.txt');
      await fsp.writeFile(file, `${String.fromCharCode(97 + (n % 26))}\n`);
      // Same size, a different mtime: the stat check fails and git re-reads (and cleans) the file.
      const t = new Date(Date.now() + 60_000 * (n + 1));
      await fsp.utimes(file, t, t);
      n += 1;
    };
  }

  it('a nested repository staged as a gitlink: its own filter never runs during summarize', async () => {
    const marker = path.join(tmp, 'marker-nested.txt');
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const touch = await plantNestedRepo(wt.path, marker);
    await fsp.writeFile(path.join(wt.path, 'a.txt'), 'one\ntwo\nthree\nfour\n');

    // Control: plain recursive git status and diff do run the nested repository's filter.
    await touch();
    await git(['-C', wt.path, 'status', '--porcelain']);
    expect(await exists(marker), 'plain status recursed into the gitlink').toBe(true);
    await fsp.rm(marker);
    await touch();
    await git(['-C', wt.path, 'diff', '--numstat', 'HEAD', '--']);
    expect(await exists(marker), 'plain diff recursed into the gitlink').toBe(true);
    await fsp.rm(marker);

    await touch();
    const summary = await m.summarizeWorktree(wt);
    expect(await exists(marker)).toBe(false);
    // The nested repository is not looked into (and so not listed); the rest of the summary is still right.
    expect(summary.files).toEqual([{ path: 'a.txt', status: 'modified' }]);
    expect(summary.insertions).toBe(1);

    await touch();
    expect(await m.discardWorktree(wt, notAlive)).toEqual({ outcome: 'discarded', error: null });
    expect(await exists(marker)).toBe(false);
    expect(await exists(wt.path)).toBe(false);
  });

  // --- links the agent planted inside its worktree must never lead discard to delete what they point at ---

  /** Two folders outside the worktree, each with a marker file. */
  async function outsideFolders(): Promise<{ outside: string; outside2: string; markers: string[] }> {
    const outside = path.join(tmp, 'outside');
    const outside2 = path.join(tmp, 'outside2');
    await fsp.mkdir(path.join(outside, 'deep'), { recursive: true });
    await fsp.mkdir(outside2);
    const markers = [
      path.join(outside, 'keep-me.txt'),
      path.join(outside, 'deep', 'keep-me-too.txt'),
      path.join(outside2, 'keep-me.txt'),
    ];
    for (const marker of markers) await fsp.writeFile(marker, 'precious\n');
    return { outside, outside2, markers };
  }

  /** A junction at the worktree root and one two levels deep (junctions need no Developer Mode on Windows). */
  async function plantJunctions(worktree: string, outside: string, outside2: string): Promise<void> {
    await fsp.symlink(outside, path.join(worktree, 'link'), 'junction');
    await fsp.mkdir(path.join(worktree, 'a', 'b'), { recursive: true });
    await fsp.symlink(outside2, path.join(worktree, 'a', 'b', 'link2'), 'junction');
    // Sanity: the links lead outside.
    expect(await exists(path.join(worktree, 'link', 'keep-me.txt'))).toBe(true);
    expect(await exists(path.join(worktree, 'a', 'b', 'link2', 'keep-me.txt'))).toBe(true);
  }

  async function expectOutsideIntact(markers: string[]): Promise<void> {
    for (const marker of markers) {
      expect(await exists(marker), marker).toBe(true);
      expect(await fsp.readFile(marker, 'utf8')).toBe('precious\n');
    }
  }

  it('discard (git worktree remove path) never deletes what a junction in the worktree points to', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const { outside, outside2, markers } = await outsideFolders();
    await plantJunctions(wt.path, outside, outside2);

    expect(await m.discardWorktree(wt, notAlive)).toEqual({ outcome: 'discarded', error: null });
    expect(await exists(wt.path)).toBe(false);
    expect(await branchExists('huddle/run-1')).toBe(false);
    await expectOutsideIntact(markers);
  });

  it('discard (tampered .git, fs.rm path) never deletes what a junction in the worktree points to', async () => {
    const m = manager();
    const wt = await m.createWorktree({ repoDir: repo, runId: 'run-1' });
    const { outside, outside2, markers } = await outsideFolders();
    await plantJunctions(wt.path, outside, outside2);
    await repoint(wt.path, await fakeGitDir('false'));

    const result = await m.discardWorktree(wt, notAlive);
    expect(result).toMatchObject({
      outcome: 'discarded',
      error: expect.stringMatching(/link had been changed/) as unknown,
    });
    expect(await exists(wt.path)).toBe(false);
    expect(await branchExists('huddle/run-1')).toBe(false);
    await expectOutsideIntact(markers);
  });

  it('discard never deletes the target of a file symlink in the worktree (both paths)', async (ctx) => {
    const target = path.join(tmp, 'outside-file.txt');
    await fsp.writeFile(target, 'precious\n');
    const probe = path.join(tmp, 'symlink-probe');
    try {
      await fsp.symlink(target, probe, 'file');
      await fsp.rm(probe);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EPERM') {
        ctx.skip('file symlinks need Developer Mode or admin rights on this machine (EPERM)');
        return;
      }
      throw error;
    }
    const m = manager();
    for (const [runId, tamper] of [
      ['run-intact', false],
      ['run-tampered', true],
    ] as const) {
      const wt = await m.createWorktree({ repoDir: repo, runId });
      await fsp.symlink(target, path.join(wt.path, 'file-link.txt'), 'file');
      await fsp.mkdir(path.join(wt.path, 'x', 'y'), { recursive: true });
      await fsp.symlink(target, path.join(wt.path, 'x', 'y', 'file-link2.txt'), 'file');
      if (tamper) await repoint(wt.path, await fakeGitDir('false').catch(() => path.join(tmp, 'fake', '.git')));
      expect((await m.discardWorktree(wt, notAlive)).outcome, runId).toBe('discarded');
      expect(await exists(wt.path), runId).toBe(false);
      expect(await fsp.readFile(target, 'utf8'), runId).toBe('precious\n');
    }
  });
});
