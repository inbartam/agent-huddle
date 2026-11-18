import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS, MAX_WORKTREE_FILES } from '@huddle/shared';
import {
  buildWorktreeSummary,
  defaultWorktreeDataDir,
  filterDriversProblem,
  filterNeutralizerArgs,
  hardeningConfigArgs,
  MAX_FILTER_DRIVERS,
  parseFilterDriverNames,
  parseGitLinkFile,
  isPathInside,
  ownershipProblem,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainZ,
  parseWorktreeListPaths,
  parseWorktreeRegistry,
  porcelainStatus,
  samePath,
  serializeWorktreeRegistry,
  worktreeBranchName,
  worktreeRunIdProblem,
  type WorktreeRecord,
} from './worktree.js';

const SHA = 'a'.repeat(40);

describe('worktree run ids', () => {
  it('accepts ids that are a safe folder name and branch name', () => {
    for (const id of ['run-1', 'a', 'A_b-9', '0f8e2c3a-1b2c-4d5e-8f90-123456789abc', 'v1.2']) {
      expect(worktreeRunIdProblem(id)).toBeNull();
    }
    expect(worktreeBranchName('run-1')).toBe('huddle/run-1');
  });

  it('rejects traversal, separators, git ref violations and Windows device names', () => {
    for (const id of [
      '',
      '..',
      '.hidden',
      'a..b',
      'a/b',
      'a\\b',
      '../x',
      'x.',
      'x.lock',
      'X.LOCK',
      'con',
      'NUL',
      'nul.txt',
      'com1',
      'LPT9',
      'a b',
      'a:b',
      'x'.repeat(129),
    ]) {
      expect(worktreeRunIdProblem(id), id).not.toBeNull();
    }
  });
});

describe('paths', () => {
  it('isPathInside: strict descendant, resolved, case-insensitive on win32', () => {
    const root = 'C:\\Users\\u\\AppData\\Local\\agent-huddle\\worktrees';
    expect(isPathInside(root, `${root}\\run-1`, 'win32')).toBe(true);
    expect(isPathInside(root, 'c:/users/U/appdata/local/agent-huddle/worktrees/run-1', 'win32')).toBe(true);
    expect(isPathInside(root, root, 'win32')).toBe(false);
    expect(isPathInside(root, `${root}\\`, 'win32')).toBe(false);
    expect(isPathInside(root, `${root}\\..\\other`, 'win32')).toBe(false);
    expect(isPathInside(root, `${root}2\\run-1`, 'win32')).toBe(false);
    expect(isPathInside(root, 'D:\\agent-huddle\\worktrees\\run-1', 'win32')).toBe(false);
    expect(isPathInside(root, `${root}\\..foo`, 'win32')).toBe(true);
    // posix is case-sensitive
    expect(isPathInside('/data/worktrees', '/data/worktrees/run', 'linux')).toBe(true);
    expect(isPathInside('/data/worktrees', '/Data/worktrees/run', 'linux')).toBe(false);
    expect(isPathInside('/data/worktrees', '/data/worktrees/../x', 'linux')).toBe(false);
  });

  it('samePath ignores separators and case on win32 only', () => {
    expect(samePath('C:\\a\\B', 'c:/a/b/', 'win32')).toBe(true);
    expect(samePath('/a/B', '/a/b', 'linux')).toBe(false);
  });

  it('defaultWorktreeDataDir uses LOCALAPPDATA on Windows', () => {
    expect(defaultWorktreeDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Local\\agent-huddle',
    );
    expect(defaultWorktreeDataDir({}, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Local\\agent-huddle');
    expect(defaultWorktreeDataDir({}, 'linux', '/home/u')).toBe('/home/u/.local/share/agent-huddle');
    expect(defaultWorktreeDataDir({ XDG_DATA_HOME: '/x' }, 'linux', '/home/u')).toBe('/x/agent-huddle');
  });
});

describe('git output parsers', () => {
  it('parses porcelain v1 -z with renames (new path first, original next), untracked and unmerged', () => {
    const text = ' M src/a.ts\0R  src/new name.ts\0src/old name.ts\0?? notes/todo.md\0UU merge.txt\0A  added.txt\0';
    expect(parsePorcelainZ(text)).toEqual([
      { x: ' ', y: 'M', path: 'src/a.ts', origPath: null },
      { x: 'R', y: ' ', path: 'src/new name.ts', origPath: 'src/old name.ts' },
      { x: '?', y: '?', path: 'notes/todo.md', origPath: null },
      { x: 'U', y: 'U', path: 'merge.txt', origPath: null },
      { x: 'A', y: ' ', path: 'added.txt', origPath: null },
    ]);
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ('garbage\0')).toEqual([]);
  });

  it('maps porcelain pairs to statuses', () => {
    expect(porcelainStatus('?', '?')).toBe('untracked');
    expect(porcelainStatus('U', 'U')).toBe('unmerged');
    expect(porcelainStatus('A', 'A')).toBe('unmerged');
    expect(porcelainStatus('D', 'D')).toBe('unmerged');
    expect(porcelainStatus(' ', 'M')).toBe('modified');
    expect(porcelainStatus('R', 'M')).toBe('renamed');
    expect(porcelainStatus(' ', 'T')).toBe('type_changed');
    expect(porcelainStatus('X', ' ')).toBe('unknown');
  });

  it('parses name-status -z with rename and copy scores', () => {
    const text = 'M\0a.txt\0R100\0b.txt\0b2.txt\0D\0gone.txt\0C075\0src.txt\0copy.txt\0A\0new.bin\0';
    expect(parseNameStatusZ(text)).toEqual([
      { status: 'M', path: 'a.txt', origPath: null },
      { status: 'R100', path: 'b2.txt', origPath: 'b.txt' },
      { status: 'D', path: 'gone.txt', origPath: null },
      { status: 'C075', path: 'copy.txt', origPath: 'src.txt' },
      { status: 'A', path: 'new.bin', origPath: null },
    ]);
  });

  it('parses numstat -z with binary files and renames', () => {
    const text = '3\t1\ta.txt\0-\t-\timage.png\x000\t0\t\0b.txt\0b2.txt\x0010\t0\tdir/with\ttab.txt\0';
    expect(parseNumstatZ(text)).toEqual([
      { path: 'a.txt', origPath: null, insertions: 3, deletions: 1, binary: false },
      { path: 'image.png', origPath: null, insertions: 0, deletions: 0, binary: true },
      { path: 'b2.txt', origPath: 'b.txt', insertions: 0, deletions: 0, binary: false },
      { path: 'dir/with\ttab.txt', origPath: null, insertions: 10, deletions: 0, binary: false },
    ]);
  });

  it('reads worktree paths from `worktree list --porcelain`, -z or not', () => {
    const z = 'worktree C:/repo\0HEAD abc\0branch refs/heads/main\0\0worktree C:/wt/run-1\0HEAD def\0locked\0\0';
    expect(parseWorktreeListPaths(z)).toEqual(['C:/repo', 'C:/wt/run-1']);
    expect(parseWorktreeListPaths('worktree /r\r\nHEAD x\r\n\r\nworktree /w\n')).toEqual(['/r', '/w']);
  });
});

describe('buildWorktreeSummary', () => {
  it('combines diff against the base with untracked and unmerged files; binary counts 0 lines', () => {
    const summary = buildWorktreeSummary(
      {
        nameStatus: parseNameStatusZ('M\0a.txt\0R100\0b.txt\0b2.txt\0D\0c.txt\0M\0image.png\0'),
        numstat: parseNumstatZ('3\t1\ta.txt\x000\t0\t\0b.txt\0b2.txt\x000\t5\tc.txt\0-\t-\timage.png\0'),
        porcelain: parsePorcelainZ(' M a.txt\0?? new.md\0?? z/other.md\0UU a.txt\0'),
      },
      1234,
    );
    expect(summary).toEqual({
      filesChanged: 6,
      insertions: 3,
      deletions: 6,
      untracked: 2,
      files: [
        { path: 'a.txt', status: 'unmerged' },
        { path: 'b2.txt', status: 'renamed' },
        { path: 'c.txt', status: 'deleted' },
        { path: 'image.png', status: 'modified' },
        { path: 'new.md', status: 'untracked' },
        { path: 'z/other.md', status: 'untracked' },
      ],
      summarizedAt: 1234,
    });
  });

  it(`lists at most ${String(MAX_WORKTREE_FILES)} files, keeps the true count and clips long paths`, () => {
    const many = Array.from({ length: 75 }, (_, i) => `?? f${String(i).padStart(3, '0')}.txt`).join('\0');
    const long = `${'d/'.repeat(CLIP_LIMITS.path)}x.txt`;
    const summary = buildWorktreeSummary(
      { nameStatus: [{ status: 'A', path: long, origPath: null }], numstat: [], porcelain: parsePorcelainZ(many) },
      0,
    );
    expect(summary.filesChanged).toBe(76);
    expect(summary.untracked).toBe(75);
    expect(summary.files).toHaveLength(MAX_WORKTREE_FILES);
    expect(summary.files[0]?.path.length).toBe(CLIP_LIMITS.path);
    expect(summary.files[0]?.status).toBe('added');
    expect(summary.files[1]).toEqual({ path: 'f000.txt', status: 'untracked' });
  });
});

describe('worktree registry', () => {
  const record: WorktreeRecord = {
    runId: 'run-1',
    path: 'C:\\data\\worktrees\\run-1',
    branch: 'huddle/run-1',
    baseCommit: SHA,
    repoRoot: 'C:\\repo',
    createdAt: 1,
    state: 'active',
  };

  it('treats no file as empty and unreadable content as corrupt', () => {
    expect(parseWorktreeRegistry(null)).toEqual({ records: [], invalid: [], extra: {}, corrupt: false });
    expect(parseWorktreeRegistry('{nope').corrupt).toBe(true);
    expect(parseWorktreeRegistry('[]').corrupt).toBe(true);
    expect(parseWorktreeRegistry('{"worktrees": 3}').corrupt).toBe(true);
  });

  it('keeps unknown fields and invalid entries through a round trip; the first record per run wins', () => {
    const text = `\ufeff${JSON.stringify({
      version: 1,
      future: { a: 1 },
      worktrees: [{ ...record, note: 'kept' }, { runId: '../evil' }, { ...record, path: 'C:\\dup' }],
    })}`;
    const parsed = parseWorktreeRegistry(text);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.records).toEqual([{ ...record, note: 'kept' }]);
    expect(parsed.invalid).toHaveLength(2);
    expect(parsed.extra).toEqual({ future: { a: 1 } });
    const again = parseWorktreeRegistry(serializeWorktreeRegistry(parsed));
    expect(again).toEqual(parsed);
  });

  it('ownershipProblem allows only the run folder directly in the root, on record, on the huddle branch', () => {
    const root = 'C:\\data\\worktrees';
    const ref = { runId: 'run-1', path: record.path };
    expect(ownershipProblem(root, ref, record, 'win32')).toBeNull();
    expect(ownershipProblem(root, { ...ref, path: 'c:/DATA/worktrees/run-1/' }, record, 'win32')).toBeNull();
    expect(ownershipProblem(root, ref, undefined, 'win32')).toMatch(/not created by Agent Huddle/);
    expect(ownershipProblem(root, { ...ref, path: 'C:\\repo' }, record, 'win32')).toMatch(/outside/);
    expect(ownershipProblem(root, ref, { ...record, path: 'C:\\repo' }, 'win32')).toMatch(/outside/);
    expect(ownershipProblem(root, { ...ref, path: `${root}\\run-1\\sub` }, record, 'win32')).toMatch(/not this run/);
    expect(ownershipProblem(root, ref, { ...record, path: `${root}\\run-2` }, 'win32')).toMatch(/not this run/);
    expect(ownershipProblem(root, ref, { ...record, branch: 'main' }, 'win32')).toMatch(/branch/);
    expect(ownershipProblem(root, { ...ref, runId: '..' }, record, 'win32')).not.toBeNull();
  });
});

describe('hardening', () => {
  it('reads the target of a .git link file', () => {
    expect(parseGitLinkFile('gitdir: C:/repo/.git/worktrees/run-1\n')).toBe('C:/repo/.git/worktrees/run-1');
    expect(parseGitLinkFile('\ufeffgitdir:   ../.git/worktrees/a b  \r\nextra\n')).toBe('../.git/worktrees/a b');
    expect(parseGitLinkFile('gitdir:\n')).toBeNull();
    expect(parseGitLinkFile('ref: refs/heads/main\n')).toBeNull();
    expect(parseGitLinkFile('')).toBeNull();
  });

  it('turns off every config that can run a program or reach the network', () => {
    const args = hardeningConfigArgs('C:/data/git-hooks-disabled', 'C:/data/git-attributes-disabled');
    expect(args.filter((_, i) => i % 2 === 0).every((a) => a === '-c')).toBe(true);
    expect(args.filter((_, i) => i % 2 === 1)).toEqual([
      'core.fsmonitor=false',
      'core.hooksPath=C:/data/git-hooks-disabled',
      'core.attributesFile=C:/data/git-attributes-disabled',
      'diff.external=',
      'core.untrackedCache=false',
      'core.pager=cat',
      'credential.helper=',
      'protocol.allow=never',
      'diff.ignoreSubmodules=all',
      'status.submoduleSummary=false',
      'submodule.recurse=false',
    ]);
  });

  it('reads filter driver names, dots included, from config -z output', () => {
    const text = [
      'filter.lfs.clean\ngit-lfs clean -- %f',
      'filter.lfs.smudge\ngit-lfs smudge -- %f',
      'filter.evil.dots.v2.clean\nnode x.js',
      'filter.Mixed.Case.required', // a key without a value
      'filter.clean\nno driver name',
      'core.editor\nvim',
      '',
    ].join('\0');
    expect(parseFilterDriverNames(text)).toEqual(['lfs', 'evil.dots.v2', 'Mixed.Case']);
    expect(parseFilterDriverNames('')).toEqual([]);
  });

  it('switches each driver off and refuses sets it cannot override safely', () => {
    expect(filterNeutralizerArgs(['a.b'])).toEqual([
      '-c',
      'filter.a.b.clean=',
      '-c',
      'filter.a.b.smudge=',
      '-c',
      'filter.a.b.process=',
      '-c',
      'filter.a.b.required=false',
    ]);
    expect(filterDriversProblem([])).toBeNull();
    expect(filterDriversProblem(Array.from({ length: MAX_FILTER_DRIVERS }, (_, i) => `f${String(i)}`))).toBeNull();
    expect(filterDriversProblem(Array.from({ length: MAX_FILTER_DRIVERS + 1 }, (_, i) => `f${String(i)}`))).toMatch(
      /at most 64/,
    );
    expect(filterDriversProblem(['a=b'])).toMatch(/cannot be overridden/);
    expect(filterDriversProblem(['a\tb'])).toMatch(/cannot be overridden/);
  });
});
